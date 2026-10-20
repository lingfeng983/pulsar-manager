//! 插件：只贡献数据（压测预设、Topic 模板），不加载、不执行任何插件代码。
//!
//! 与 Electron 版 `plugin-service.ts` 一一对应：**同一个目录** `<userData>/plugins`、同一份
//! OFFICIAL 目录内容、同一个 `disabledPlugins` 设置键、同一份清单校验规则。一个坏插件最多
//! 让它自己那条预设消失，并在列表页给出失败原因，不可能把应用带崩。
//!
//! 两端最难对齐的一点是**列表排序**：界面用的是 `localeCompare(zh-CN)`，中文必须按拼音比，
//! 直接按 Unicode 码位排会把「常用 Topic 模板」排到完全不同的位置。所以这里把每个汉字换成
//! 拼音再比。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use pinyin::ToPinyin;
use pm_core::AppResult;
use pm_store::{settings, Store};
use serde_json::{json, Map, Value};

/// 与 Electron 版同一个设置键：被停用（但仍安装着）的插件 id 列表。
const DISABLED_KEY: &str = "disabledPlugins";

/// 官方目录。内容取自原 Electron 版的 official-plugins.ts（已随 Electron 删除，
/// 需要对照时查 git 历史），只在这里落一份，
/// 改官网目录时这里与文档要同步——这是刻意的冗余：它随安装包发布，不该被运行时文件改写。
const OFFICIAL_PLUGINS_JSON: &str = r#"[
    {
        "id": "pm-smoke-benchmarks",
        "name": "冒烟与吞吐预设",
        "version": "1.0.0",
        "author": "Pulsar Manager",
        "description": "从\"链路通不通\"到\"能打多快\"的四档压测预设",
        "contributions": {
            "benchmarkPresets": [
                {
                    "name": "快速冒烟",
                    "description": "1000 条小消息全速发完，验证集群可用",
                    "params": {
                        "producers": 1,
                        "totalMessages": 1000,
                        "messageSizeBytes": 128,
                        "ratePerSecond": 0,
                        "maxInFlightPerProducer": 100,
                        "batchingEnabled": true,
                        "compression": "None",
                        "consumeBacklog": false
                    }
                },
                {
                    "name": "吞吐洪峰",
                    "description": "8 生产者各 1000 条在途，LZ4 压缩，看峰值吞吐",
                    "params": {
                        "producers": 8,
                        "totalMessages": 200000,
                        "messageSizeBytes": 1024,
                        "ratePerSecond": 0,
                        "maxInFlightPerProducer": 1000,
                        "batchingEnabled": true,
                        "compression": "LZ4",
                        "consumeBacklog": false
                    }
                },
                {
                    "name": "延迟探测",
                    "description": "单在途 + 关批，测到的基本就是真实 RTT",
                    "params": {
                        "producers": 1,
                        "totalMessages": 20000,
                        "messageSizeBytes": 256,
                        "ratePerSecond": 1000,
                        "maxInFlightPerProducer": 1,
                        "batchingEnabled": false,
                        "compression": "None",
                        "consumeBacklog": false
                    }
                },
                {
                    "name": "大消息",
                    "description": "1 MB 消息体，观察大包下的带宽与确认延迟",
                    "params": {
                        "producers": 2,
                        "totalMessages": 2000,
                        "messageSizeBytes": 1048576,
                        "ratePerSecond": 0,
                        "maxInFlightPerProducer": 10,
                        "batchingEnabled": false,
                        "compression": "ZSTD",
                        "consumeBacklog": false
                    }
                }
            ]
        }
    },
    {
        "id": "pm-end-to-end-benchmarks",
        "name": "端到端读写预设",
        "version": "1.0.0",
        "author": "Pulsar Manager",
        "description": "边压边消费，跑完整的写入—积压—消费链路",
        "contributions": {
            "benchmarkPresets": [
                {
                    "name": "恒定速率读写",
                    "description": "限速 5000 msg/s 写入并同时消费，看稳态",
                    "params": {
                        "producers": 4,
                        "totalMessages": 100000,
                        "messageSizeBytes": 512,
                        "ratePerSecond": 5000,
                        "maxInFlightPerProducer": 200,
                        "batchingEnabled": true,
                        "compression": "None",
                        "consumeBacklog": true
                    }
                },
                {
                    "name": "积压追赶",
                    "description": "先全速灌 30 万条再消费，看积压追赶速率",
                    "params": {
                        "producers": 6,
                        "totalMessages": 300000,
                        "messageSizeBytes": 2048,
                        "ratePerSecond": 0,
                        "maxInFlightPerProducer": 500,
                        "batchingEnabled": true,
                        "compression": "ZSTD",
                        "consumeBacklog": true
                    }
                }
            ]
        }
    },
    {
        "id": "pm-topic-templates",
        "name": "常用 Topic 模板",
        "version": "1.0.0",
        "author": "Pulsar Manager",
        "description": "新建 Topic 时一键套用分区数与持久化选择",
        "contributions": {
            "topicTemplates": [
                {
                    "name": "标准分区",
                    "description": "持久 + 4 分区，多数业务 topic 的默认选择",
                    "persistent": true,
                    "partitions": 4
                },
                {
                    "name": "单分区持久",
                    "description": "持久 + 0 分区，需要严格顺序时用它",
                    "persistent": true,
                    "partitions": 0
                },
                {
                    "name": "非持久事件流",
                    "description": "丢得起的埋点/日志类流量",
                    "persistent": false,
                    "partitions": 8,
                    "namePrefix": "evt-"
                },
                {
                    "name": "高分区",
                    "description": "持久 + 16 分区，多消费者横向扩",
                    "persistent": true,
                    "partitions": 16
                }
            ]
        }
    },
    {
        "id": "pm-batch-tuning",
        "name": "批量化对比预设",
        "version": "1.0.0",
        "author": "Pulsar Manager",
        "description": "同一份流量下开关批量与压缩，用于对照",
        "contributions": {
            "benchmarkPresets": [
                {
                    "name": "关批量",
                    "description": "batching 关闭，逐条发送",
                    "params": {
                        "producers": 4,
                        "totalMessages": 50000,
                        "messageSizeBytes": 256,
                        "ratePerSecond": 0,
                        "maxInFlightPerProducer": 300,
                        "batchingEnabled": false,
                        "compression": "None",
                        "consumeBacklog": false
                    }
                },
                {
                    "name": "开批量",
                    "description": "其余参数与\"关批量\"完全一致，只开批",
                    "params": {
                        "producers": 4,
                        "totalMessages": 50000,
                        "messageSizeBytes": 256,
                        "ratePerSecond": 0,
                        "maxInFlightPerProducer": 300,
                        "batchingEnabled": true,
                        "compression": "None",
                        "consumeBacklog": false
                    }
                },
                {
                    "name": "开批量 + Snappy",
                    "description": "再叠一层压缩，看 CPU 换带宽的收益",
                    "params": {
                        "producers": 4,
                        "totalMessages": 50000,
                        "messageSizeBytes": 256,
                        "ratePerSecond": 0,
                        "maxInFlightPerProducer": 300,
                        "batchingEnabled": true,
                        "compression": "SNAPPY",
                        "consumeBacklog": false
                    }
                }
            ]
        }
    }
]"#;

fn official_catalog() -> &'static Vec<Value> {
    static CATALOG: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    CATALOG.get_or_init(|| serde_json::from_str(OFFICIAL_PLUGINS_JSON).unwrap_or_default())
}

pub fn plugins_dir() -> PathBuf {
    pm_store::default_db_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("plugins")
}

// ========== 清单校验 ==========

/// 解析并校验一份插件 JSON。通过时返回**只含已知字段**的规范形态（多余的键会被丢掉，
/// 和 zod `.parse()` 之后的形状一致）；不通过时返回人话的原因。
pub fn parse_manifest(raw: &str) -> Result<Value, String> {
    let json: Value = serde_json::from_str(raw).map_err(|error| format!("不是合法的 JSON：{error}"))?;
    validate_manifest(&json)
}

fn validate_manifest(value: &Value) -> Result<Value, String> {
    let Some(object) = value.as_object() else {
        return Err("插件：需要是一个 JSON 对象".into());
    };
    let id = required_str(object, "id")?;
    check_id(id).map_err(|message| format!("id：{message}"))?;

    let name = required_str(object, "name")?;
    if name.chars().count() < 1 || name.chars().count() > 60 {
        return Err("name：需为 1~60 个字符".into());
    }

    let version = required_str(object, "version")?;
    check_version(version).map_err(|message| format!("version：{message}"))?;

    let description = optional_str(object, "description", 200, "description")?;
    let author = optional_str(object, "author", 60, "author")?;

    let Some(contributions) = object.get("contributions") else {
        return Err("contributions：必填".into());
    };
    let Some(contributions) = contributions.as_object() else {
        return Err("contributions：需要是一个对象".into());
    };
    let benchmarks = if contributions.contains_key("benchmarkPresets") {
        let list = contributions.get("benchmarkPresets").unwrap();
        let Some(list) = list.as_array() else {
            return Err("contributions.benchmarkPresets：需要是一个数组".into());
        };
        if list.len() > 20 {
            return Err("contributions.benchmarkPresets：最多 20 条".into());
        }
        let mut items = Vec::with_capacity(list.len());
        for (index, item) in list.iter().enumerate() {
            let path = format!("contributions.benchmarkPresets.{index}");
            items.push(benchmark_preset(item, &path)?);
        }
        Some(items)
    } else {
        None
    };
    let templates = if contributions.contains_key("topicTemplates") {
        let list = contributions.get("topicTemplates").unwrap();
        let Some(list) = list.as_array() else {
            return Err("contributions.topicTemplates：需要是一个数组".into());
        };
        if list.len() > 20 {
            return Err("contributions.topicTemplates：最多 20 条".into());
        }
        let mut items = Vec::with_capacity(list.len());
        for (index, item) in list.iter().enumerate() {
            let path = format!("contributions.topicTemplates.{index}");
            items.push(topic_template(item, &path)?);
        }
        Some(items)
    } else {
        None
    };

    let total = benchmarks.as_ref().map(Vec::len).unwrap_or(0) + templates.as_ref().map(Vec::len).unwrap_or(0);
    if total == 0 {
        return Err("contributions：插件至少要贡献一条压测预设或 Topic 模板".into());
    }

    // 按 zod 的定义顺序重建对象：可选字段没给就整体缺席，不给渲染层制造 null / 缺省两套形状
    let mut manifest = Map::new();
    manifest.insert("id".into(), json!(id));
    manifest.insert("name".into(), json!(name));
    manifest.insert("version".into(), json!(version));
    if let Some(text) = description {
        manifest.insert("description".into(), json!(text));
    }
    if let Some(text) = author {
        manifest.insert("author".into(), json!(text));
    }
    let mut contributions = Map::new();
    if let Some(items) = benchmarks {
        contributions.insert("benchmarkPresets".into(), json!(items));
    }
    if let Some(items) = templates {
        contributions.insert("topicTemplates".into(), json!(items));
    }
    manifest.insert("contributions".into(), Value::Object(contributions));
    Ok(Value::Object(manifest))
}

fn required_str<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    match object.get(key) {
        None => Err(format!("{key}：必填")),
        Some(Value::String(text)) => Ok(text.as_str()),
        Some(_) => Err(format!("{key}：需要是文本")),
    }
}

fn optional_str<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    max: usize,
    path: &str,
) -> Result<Option<&'a str>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= max => Ok(Some(text.as_str())),
        Some(Value::String(_)) => Err(format!("{path}：最多 {max} 个字符")),
        Some(_) => Err(format!("{path}：需要是文本")),
    }
}

/// id 会成为落盘文件名、也会被拼进卸载路径，规则必须和 TS 那条 zod 正则一致。
fn check_id(id: &str) -> Result<(), String> {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() < 2 || bytes.len() > 64 {
        return Err("id 需为 2~64 位小写字母、数字、点、下划线或连字符".into());
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return Err("id 需为 2~64 位小写字母、数字、点、下划线或连字符".into());
    }
    if !bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("id 需为 2~64 位小写字母、数字、点、下划线或连字符".into());
    }
    Ok(())
}

fn check_version(version: &str) -> Result<(), String> {
    let parts: Vec<&str> = version.split('.').collect();
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    let shape = (parts.len() == 2 || parts.len() == 3) && parts.iter().all(|part| digits(part));
    if shape {
        Ok(())
    } else {
        Err("version 需形如 1.0 或 1.0.0".into())
    }
}

fn benchmark_preset(item: &Value, path: &str) -> Result<Value, String> {
    let Some(object) = item.as_object() else {
        return Err(format!("{path}：需要是一个对象"));
    };
    let name = required_str(object, "name").map_err(|message| message.replace("name：", &format!("{path}.name：")))?;
    if name.chars().count() < 1 || name.chars().count() > 40 {
        return Err(format!("{path}.name：需为 1~40 个字符"));
    }
    let description = optional_str(object, "description", 120, &format!("{path}.description"))?;

    let Some(params) = object.get("params") else {
        return Err(format!("{path}.params：必填"));
    };
    let Some(params) = params.as_object() else {
        return Err(format!("{path}.params：需要是一个对象"));
    };
    // 校验失败的定位串要带上 params：界面上显示的是这条路径 + 原因
    let params_path = format!("{path}.params");
    let producers = int_range(params, "producers", 1, 64, &params_path)?;
    let total_messages = int_range(params, "totalMessages", 1, 10_000_000, &params_path)?;
    let message_size = int_range(params, "messageSizeBytes", 1, 10_485_760, &params_path)?;
    let rate = int_range(params, "ratePerSecond", 0, 1_000_000, &params_path)?;
    let in_flight = int_range(params, "maxInFlightPerProducer", 1, 10_000, &params_path)?;
    let batching = bool_field(params, "batchingEnabled", &params_path)?;
    let consume_backlog = bool_field(params, "consumeBacklog", &params_path)?;
    let Some(compression) = params.get("compression").and_then(Value::as_str) else {
        return Err(format!("{path}.params.compression：必填"));
    };
    if !matches!(compression, "None" | "LZ4" | "Zlib" | "SNAPPY" | "ZSTD") {
        return Err(format!(
            "{path}.params.compression：只支持 None / LZ4 / Zlib / SNAPPY / ZSTD"
        ));
    }

    let mut out = Map::new();
    out.insert("name".into(), json!(name));
    if let Some(text) = description {
        out.insert("description".into(), json!(text));
    }
    out.insert(
        "params".into(),
        json!({
            "producers": producers,
            "totalMessages": total_messages,
            "messageSizeBytes": message_size,
            "ratePerSecond": rate,
            "maxInFlightPerProducer": in_flight,
            "batchingEnabled": batching,
            "compression": compression,
            "consumeBacklog": consume_backlog,
        }),
    );
    Ok(Value::Object(out))
}

fn topic_template(item: &Value, path: &str) -> Result<Value, String> {
    let Some(object) = item.as_object() else {
        return Err(format!("{path}：需要是一个对象"));
    };
    let name = required_str(object, "name").map_err(|message| message.replace("name：", &format!("{path}.name：")))?;
    if name.chars().count() < 1 || name.chars().count() > 40 {
        return Err(format!("{path}.name：需为 1~40 个字符"));
    }
    let description = optional_str(object, "description", 120, &format!("{path}.description"))?;
    let persistent = bool_field(object, "persistent", path)?;
    let partitions = int_range(object, "partitions", 0, 128, path)?;
    let prefix = optional_str(object, "namePrefix", 40, &format!("{path}.namePrefix"))?;
    if let Some(prefix) = prefix {
        let ok = prefix.len() <= 40
            && prefix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        if !ok {
            return Err(format!(
                "{path}.namePrefix：只允许字母、数字、点、下划线和连字符"
            ));
        }
    }

    let mut out = Map::new();
    out.insert("name".into(), json!(name));
    if let Some(text) = description {
        out.insert("description".into(), json!(text));
    }
    out.insert("persistent".into(), json!(persistent));
    out.insert("partitions".into(), json!(partitions));
    if let Some(text) = prefix {
        out.insert("namePrefix".into(), json!(text));
    }
    Ok(Value::Object(out))
}

fn int_range(object: &Map<String, Value>, key: &str, min: i64, max: i64, path: &str) -> Result<i64, String> {
    let Some(value) = object.get(key) else {
        return Err(format!("{path}.{key}：必填"));
    };
    match value.as_i64() {
        Some(number) if number >= min && number <= max => Ok(number),
        // 浮点数也算「不是整数」：zod 的 int() 同样不接受 1.5
        Some(_) | None => Err(format!("{path}.{key}：需为 {min}~{max} 的整数")),
    }
}

fn bool_field(object: &Map<String, Value>, key: &str, path: &str) -> Result<bool, String> {
    match object.get(key) {
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(format!("{path}.{key}：需要是 true 或 false")),
        None => Err(format!("{path}.{key}：必填")),
    }
}

// ========== 扫描本地目录 ==========

struct Found {
    id: String,
    manifest: Value,
}

/// 扫描插件目录。返回成功读出的清单与**失败明细**——
/// 装错的插件必须出现在界面上，静默丢掉只会让用户以为「点了没反应」。
fn scan_installed(dir: &Path) -> (Vec<Found>, Vec<Value>) {
    let mut found = Vec::new();
    let mut errors = Vec::new();

    let Ok(entries) = std::fs::read_dir(dir) else {
        return (found, errors);
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_file() {
            if name.to_lowercase().ends_with(".json") {
                candidates.push(entry.path());
            }
        } else if file_type.is_dir() {
            let nested = entry.path().join("plugin.json");
            if nested.exists() {
                candidates.push(nested);
            } else {
                errors.push(load_error(&format!("{name}/plugin.json"), "目录里没有 plugin.json"));
            }
        }
    }

    for file in candidates {
        let label = file
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| file.display().to_string());
        let raw = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(error) => {
                errors.push(load_error(&label, &format!("读取失败：{error}")));
                continue;
            }
        };
        match parse_manifest(&raw) {
            Ok(manifest) => found.push(Found {
                id: manifest.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                manifest,
            }),
            Err(reason) => errors.push(load_error(&label, &reason)),
        }
    }
    (found, errors)
}

fn load_error(file: &str, reason: &str) -> Value {
    json!({ "file": file, "reason": reason })
}

// ========== 列表 / 增删改 ==========

fn read_disabled(store: &Store) -> HashSet<String> {
    let Some(raw) = settings::get(store, DISABLED_KEY).ok().flatten() else {
        return HashSet::new();
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default()
}

fn write_disabled(store: &Store, ids: Vec<String>) -> AppResult<()> {
    let list: Vec<Value> = ids.into_iter().map(Value::String).collect();
    settings::set(store, DISABLED_KEY, &serde_json::to_string(&list)?)
}

fn create_dir(dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}

fn entry(manifest: &Value, source: &str, installed: bool, enabled: bool) -> Value {
    let mut object = manifest.as_object().cloned().unwrap_or_default();
    object.insert("source".into(), json!(source));
    object.insert("installed".into(), json!(installed));
    object.insert("enabled".into(), json!(enabled));
    Value::Object(object)
}

/// 把 `localeCompare(zh-CN)` 换成能比的键：汉字 → 拼音，其余原样转小写。
fn collation_key(text: &str) -> String {
    let mut key = String::with_capacity(text.len() * 2);
    for ch in text.chars() {
        match ch.to_pinyin() {
            Some(pinyin) => key.push_str(pinyin.plain()),
            None => key.extend(ch.to_lowercase()),
        }
    }
    key
}

pub fn list_at(dir: &Path, store: &Store) -> AppResult<Value> {
    let (found, errors) = scan_installed(dir);
    let disabled = read_disabled(store);
    let mut others: Vec<Found> = found;

    let mut entries = Vec::new();
    for official in official_catalog() {
        let official_id = official.get("id").and_then(Value::as_str).unwrap_or_default();
        let local = others
            .iter()
            .position(|item| item.id == official_id)
            .map(|index| others.remove(index).manifest);
        // 本地装了同 id 的插件就以本地文件为准（允许覆盖官方默认内容），
        // 但来源仍标官方——否则用户点完「安装」卡片会突然变成另一个来源。
        let manifest = local.clone().unwrap_or_else(|| official.clone());
        entries.push(entry(
            &manifest,
            "official",
            local.is_some(),
            local.is_some() && !disabled.contains(official_id),
        ));
    }
    for item in others {
        let id = item.id.clone();
        entries.push(entry(&item.manifest, "local", true, !disabled.contains(&id)));
    }

    entries.sort_by(|left, right| {
        let left_name = left.get("name").and_then(Value::as_str).unwrap_or_default();
        let right_name = right.get("name").and_then(Value::as_str).unwrap_or_default();
        collation_key(left_name)
            .cmp(&collation_key(right_name))
            .then_with(|| left_name.cmp(right_name))
    });

    Ok(json!({
        "entries": entries,
        "errors": errors,
        "pluginsDir": dir.display().to_string(),
    }))
}

pub fn list(store: &Store) -> AppResult<Value> {
    list_at(&plugins_dir(), store)
}

fn write_plugin_file(dir: &Path, manifest: &Value) -> AppResult<()> {
    create_dir(dir)?;
    let id = manifest.get("id").and_then(Value::as_str).unwrap_or_default();
    let text = format!("{}\n", serde_json::to_string_pretty(manifest)?);
    std::fs::write(dir.join(format!("{id}.json")), text)?;
    Ok(())
}

/// 安装后重新扫一遍：文件写歪了（比如被另一个进程拦下）要在这次调用里就暴露出来。
fn pick_entry(entries: &[Value], id: &str) -> Option<Value> {
    entries
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
}

fn entries_of(list_result: &Value) -> Vec<Value> {
    list_result
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// 入口在这里显式收一个目录：`<userData>/plugins` 的位置由底层决定，
/// 但增删改会写文件、递归删目录，测试必须能把它指向临时目录。
pub fn install_official_at(dir: &Path, store: &Store, id: &str) -> AppResult<Value> {
    let Some(official) = official_catalog()
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
    else {
        return Err(pm_core::AppError::Other(format!("官方目录里没有插件 {id}")));
    };
    write_plugin_file(dir, &official)?;
    let entries = entries_of(&list_at(dir, store)?);
    pick_entry(&entries, id).ok_or_else(|| pm_core::AppError::Other("安装后未能加载该插件".into()))
}

pub fn install_official(store: &Store, id: &str) -> AppResult<Value> {
    install_official_at(&plugins_dir(), store, id)
}

/// 渲染层把文件读成文本发过来，后端只认内容——不碰路径，避免被指到机器上的任意文件。
pub fn install_from_text_at(dir: &Path, store: &Store, raw: &str) -> AppResult<Value> {
    let manifest = parse_manifest(raw)
        .map_err(|reason| pm_core::AppError::Other(format!("插件文件无效：{reason}")))?;
    let id = manifest.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    write_plugin_file(dir, &manifest)?;
    let entries = entries_of(&list_at(dir, store)?);
    pick_entry(&entries, &id).ok_or_else(|| pm_core::AppError::Other("安装后未能加载该插件".into()))
}

pub fn install_from_text(store: &Store, raw: &str) -> AppResult<Value> {
    install_from_text_at(&plugins_dir(), store, raw)
}

/// 把相对路径钉在插件目录里：越界一律返回 None，由调用方按「没装」处理。
/// 卸载是递归删除，这一步必须做。
fn inside_plugins_dir(dir: &Path, relative: &str) -> Option<PathBuf> {
    let root = std::fs::canonicalize(dir).ok()?;
    let target = std::fs::canonicalize(root.join(relative)).ok()?;
    if target.starts_with(&root) {
        Some(target)
    } else {
        None
    }
}

pub fn uninstall_at(dir: &Path, store: &Store, id: &str) -> AppResult<Value> {
    // id 会被拼进文件名，先按同一条规则验一遍
    if check_id(id).is_err() {
        return Err(pm_core::AppError::Other(
            "插件 id 需为 2~64 位小写字母、数字、点、下划线或连字符".into(),
        ));
    }
    create_dir(dir)?;
    let flat = inside_plugins_dir(dir, &format!("{id}.json"));
    let nested = inside_plugins_dir(dir, id);
    let mut removed = false;
    if let Some(path) = flat {
        if path.is_file() {
            std::fs::remove_file(&path)?;
            removed = true;
        }
    }
    if let Some(path) = nested {
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
            removed = true;
        }
    }
    if !removed {
        return Err(pm_core::AppError::Other(format!("{id} 没有安装在本机，无需卸载")));
    }
    let disabled: Vec<String> = read_disabled(store).into_iter().filter(|item| item != id).collect();
    write_disabled(store, disabled)?;
    Ok(json!({ "id": id }))
}

pub fn uninstall(store: &Store, id: &str) -> AppResult<Value> {
    uninstall_at(&plugins_dir(), store, id)
}

pub fn set_enabled_at(dir: &Path, store: &Store, id: &str, enabled: bool) -> AppResult<Value> {
    let entries = entries_of(&list_at(dir, store)?);
    let Some(found) = pick_entry(&entries, id) else {
        return Err(pm_core::AppError::Other(format!("插件 {id} 不存在")));
    };
    if found.get("installed").and_then(Value::as_bool) != Some(true) {
        return Err(pm_core::AppError::Other("先安装后才能启用".into()));
    }
    let mut disabled = read_disabled(store);
    if enabled {
        disabled.remove(id);
    } else {
        disabled.insert(id.to_string());
    }
    write_disabled(store, disabled.into_iter().collect())?;

    let refreshed = entries_of(&list_at(dir, store)?);
    pick_entry(&refreshed, id).ok_or_else(|| pm_core::AppError::Other("状态更新后未能加载该插件".into()))
}

pub fn set_enabled(store: &Store, id: &str, enabled: bool) -> AppResult<Value> {
    set_enabled_at(&plugins_dir(), store, id, enabled)
}

#[cfg(test)]
#[path = "plugins_tests.rs"]
mod tests;
