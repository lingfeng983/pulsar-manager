//! 主进程日志落盘。
//!
//! 路径与 Electron 版保持一致（`<userData>/logs/main.log`，即 `%APPDATA%\
//! pulsar-manager\logs`），用户升级过来以后按老习惯就能找到同一份文件。
//!
//! 轮转策略只保留一份备份：日志是排查用的，无限增长只会把磁盘吃掉，
//! 真要长期留存应该接外部采集而不是靠本地文件。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// 单文件上限。超出后滚成 `main.1.log`，只留一份。
const MAX_BYTES: u64 = 2 * 1024 * 1024;

static PATH: OnceLock<PathBuf> = OnceLock::new();
static FILE: Mutex<Option<File>> = Mutex::new(None);
/// 已写入字节数。每行都去 stat 一次太浪费，自己记账即可。
static BYTES: AtomicU64 = AtomicU64::new(0);

/// 装上文件 sink 并接管 panic。返回日志文件路径（诊断模式下会打出来）。
pub fn init() -> PathBuf {
    let dir = pm_store::default_db_path()
        .parent()
        .map(|parent| parent.join("logs"))
        .unwrap_or_else(|| PathBuf::from("logs"));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("main.log");

    // 接着上次的文件写，不截断：崩溃后重启要能看到崩溃前那几行
    BYTES.store(
        std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
        Ordering::Relaxed,
    );
    let _ = PATH.set(path.clone());

    pm_core::logging::set_sink(append);
    install_panic_hook();
    path
}

/// 日志文件路径。启动失败时对话框里要显示这条路径，用户才知道去哪找原因。
pub fn path() -> PathBuf {
    PATH.get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("logs/main.log"))
}

fn open(path: &Path) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn append(line: &str) {
    let Some(path) = PATH.get() else {
        return;
    };
    let mut slot = FILE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        *slot = open(path);
    }
    let Some(file) = slot.as_mut() else {
        return;
    };
    if file.write_all(line.as_bytes()).is_err() {
        // 磁盘满或权限变更：丢掉句柄等下次重开。不能让一次失败把日志永久封住。
        *slot = None;
        return;
    }
    let _ = file.flush();

    let total = BYTES.fetch_add(line.len() as u64, Ordering::Relaxed) + line.len() as u64;
    if total > MAX_BYTES {
        rotate(path, &mut slot);
    }
}

fn rotate(path: &Path, slot: &mut Option<File>) {
    *slot = None;
    let backup = path.with_file_name("main.1.log");
    // 上一个备份直接覆盖：只保留最近一轮
    let _ = std::fs::rename(path, &backup);
    BYTES.store(0, Ordering::Relaxed);
    *slot = open(path);
}

/// panic 是「没有返回值」的那类错误，不接管就只剩一句 stderr 消失在无控制台的
/// release 里。先写日志再交给默认 hook，开发态的栈回溯不受影响。
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        pm_core::pm_warn!("[panic] {info}");
        previous(info);
    }));
}
