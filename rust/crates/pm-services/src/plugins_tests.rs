use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

/// 每个用例一份独立的插件目录：这些操作要真写文件、真删目录，
/// 指向 `<userData>/plugins` 会让单测在开发者机器上留下垃圾（并互相打架）。
fn scratch_dir() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = format!(
        "pm-plugins-{}-{}",
        pm_core::now_ms(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let dir = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn example() -> &'static str {
    r#"{
        "id": "pm-demo",
        "name": "演示预设",
        "version": "1.2",
        "author": "测试",
        "contributions": {
            "benchmarkPresets": [
                {
                    "name": "小流量",
                    "params": {
                        "producers": 2,
                        "totalMessages": 10000,
                        "messageSizeBytes": 512,
                        "ratePerSecond": 0,
                        "maxInFlightPerProducer": 100,
                        "batchingEnabled": true,
                        "compression": "LZ4",
                        "consumeBacklog": false
                    }
                }
            ]
        }
    }"#
}

#[test]
fn rejects_bad_manifests_with_path_and_reason() {
    assert!(parse_manifest("{oops").unwrap_err().starts_with("不是合法的 JSON："));
    // 校验顺序跟 zod 的定义顺序一致：id → name → version → description/author → contributions
    assert_eq!(
        parse_manifest(r#"{"id":"A","name":"x","version":"1.0"}"#).unwrap_err(),
        "id：id 需为 2~64 位小写字母、数字、点、下划线或连字符"
    );
    assert_eq!(
        parse_manifest(r#"{"id":"a.b","name":"","version":"1.0"}"#).unwrap_err(),
        "name：需为 1~60 个字符"
    );
    assert_eq!(
        parse_manifest(r#"{"id":"a.b","name":"x","version":"1"}"#).unwrap_err(),
        "version：version 需形如 1.0 或 1.0.0"
    );
    assert_eq!(
        parse_manifest(r#"{"id":"a.b","name":"x","version":"1.0","contributions":{}}"#).unwrap_err(),
        "contributions：插件至少要贡献一条压测预设或 Topic 模板"
    );
}

#[test]
fn strips_unknown_fields_and_keeps_optionals_absent() {
    let manifest = parse_manifest(
        r#"{"id":"a.b","name":"x","version":"1.0.0","evil":{"code":"rm -rf"},"contributions":{"topicTemplates":[{"name":"t","persistent":true,"partitions":4}]}}"#,
    )
    .unwrap();
    let mut keys: Vec<&String> = manifest.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["contributions", "id", "name", "version"]);
    let template = &manifest["contributions"]["topicTemplates"][0];
    // description / namePrefix 没给，就不该出现在对象里
    assert!(template.get("description").is_none());
    assert!(template.get("namePrefix").is_none());
}

#[test]
fn rejects_out_of_range_params() {
    let raw = example().replace("\"totalMessages\": 10000", "\"totalMessages\": 1000000000");
    let error = parse_manifest(&raw).unwrap_err();
    assert_eq!(
        error,
        "contributions.benchmarkPresets.0.params.totalMessages：需为 1~10000000 的整数"
    );
    // 浮点数不接受：界面上是整数字段，1.5 个生产者没有意义
    let fractional = example().replace("\"producers\": 2", "\"producers\": 1.5");
    assert!(parse_manifest(&fractional).unwrap_err().contains("需为 1~64 的整数"));
}

#[test]
fn official_catalog_is_listed_as_installable() {
    let dir = scratch_dir();
    let entries = list_at(&dir, &store()).unwrap()["entries"].as_array().cloned().unwrap();
    assert_eq!(entries.len(), official_catalog().len());
    for entry in &entries {
        assert_eq!(entry["source"], "official");
        assert_eq!(entry["installed"], false);
        assert_eq!(entry["enabled"], false);
    }
}

#[test]
fn install_official_reports_installed_and_enabled() {
    let dir = scratch_dir();
    let store = store();
    let id = official_catalog()[0]["id"].as_str().unwrap().to_string();

    let installed = install_official_at(&dir, &store, &id).unwrap();
    assert_eq!(installed["installed"], true);
    assert_eq!(installed["enabled"], true);
    assert_eq!(installed["source"], "official");

    let disabled = set_enabled_at(&dir, &store, &id, false).unwrap();
    assert_eq!(disabled["enabled"], false);
    assert_eq!(disabled["installed"], true);

    let uninstalled = uninstall_at(&dir, &store, &id).unwrap();
    assert_eq!(uninstalled["id"], id);
    let back = list_at(&dir, &store).unwrap()["entries"].as_array().cloned().unwrap();
    let entry = back.iter().find(|item| item["id"] == id.as_str()).unwrap();
    assert_eq!(entry["installed"], false);
    assert_eq!(entry["enabled"], false);
}

#[test]
fn installed_official_plugin_overrides_catalog_content() {
    let dir = scratch_dir();
    let store = store();
    let id = official_catalog()[0]["id"].as_str().unwrap().to_string();
    install_official_at(&dir, &store, &id).unwrap();
    // 本地同名文件改了名字：列表要以本地为准，但来源仍是官方
    let custom = example().replace("pm-demo", &id).replace("演示预设", "改过的名字");
    install_from_text_at(&dir, &store, &custom).unwrap();
    let entries = list_at(&dir, &store).unwrap()["entries"].as_array().cloned().unwrap();
    let entry = entries.iter().find(|item| item["id"] == id.as_str()).unwrap();
    assert_eq!(entry["name"], "改过的名字");
    assert_eq!(entry["source"], "official");
}

#[test]
fn broken_files_show_up_as_errors_not_silence() {
    let dir = scratch_dir();
    std::fs::write(dir.join("bad.json"), "{not json").unwrap();
    std::fs::create_dir_all(dir.join("half-baked")).unwrap();
    let errors = list_at(&dir, &store()).unwrap()["errors"].as_array().cloned().unwrap();
    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0]["file"], "half-baked/plugin.json");
    assert_eq!(errors[0]["reason"], "目录里没有 plugin.json");
    assert_eq!(errors[1]["file"], "bad.json");
    assert!(errors[1]["reason"].as_str().unwrap().starts_with("不是合法的 JSON："));
}

#[test]
fn uninstall_rejects_uninstalled_and_path_smuggling() {
    let dir = scratch_dir();
    let store = store();
    assert!(uninstall_at(&dir, &store, "not.installed").is_err());
    assert!(uninstall_at(&dir, &store, "../escape").is_err());
}

#[test]
fn sorting_follows_pinyin_not_codepoints() {
    // 「常用」chang 要排在「端到端」duan 之前；按 Unicode 码位排的话两者前后颠倒
    let names = ["端到端读写预设", "常用 Topic 模板", "批量化对比预设", "冒烟与吞吐预设"];
    let mut sorted = names.to_vec();
    sorted.sort_by_key(|name| collation_key(name));
    assert_eq!(
        sorted,
        ["常用 Topic 模板", "端到端读写预设", "冒烟与吞吐预设", "批量化对比预设"]
    );
}
