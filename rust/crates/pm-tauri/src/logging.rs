//! 主进程日志落盘。
//!
//! 默认路径与 Electron 版保持一致（`<userData>/logs/main.log`，即
//! `%APPDATA%\pulsar-manager\logs`），用户升级过来以后按老习惯就能找到同一份文件。
//! 设置页可以把目录改到别处（`user_settings.logDirectory`）：启动时先只读查一次库，
//! 运行中改目录走 `set_dir`，不需要重启进程。
//!
//! 轮转策略：单个文件 2 MB，滚成 `main.1.log`…`main.5.log`，保留最近 5 份备份
//! （最多约 12 MB）。日志是排查用的，无限增长只会把磁盘吃掉，真要长期留存
//! 应该接外部采集而不是靠本地文件。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use pm_core::{AppError, AppResult};

/// 单文件上限。超出后滚成 `main.1.log`。
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 备份份数：`main.1.log` ~ `main.5.log`，最旧的一份被覆盖。
const MAX_BACKUPS: usize = 5;

/// 当前日志文件全路径。空串表示还没初始化，`path()` 会回落到默认目录。
static PATH: RwLock<PathBuf> = RwLock::new(PathBuf::new());
static FILE: Mutex<Option<File>> = Mutex::new(None);
/// 已写入字节数。每行都去 stat 一次太浪费，自己记账即可。
static BYTES: AtomicU64 = AtomicU64::new(0);

fn default_path() -> PathBuf {
    pm_store::default_log_dir().join("main.log")
}

/// 装上文件 sink 并接管 panic。返回日志文件路径（诊断模式下会打出来）。
///
/// 库里的 `logDirectory` 是启动早期的唯一来源：这时 Store 还没打开，读失败
/// （首次启动、库损坏、权限不足）就退回默认目录，不能因为日志配置把启动挡掉。
pub fn init() -> PathBuf {
    pm_core::logging::set_sink(append);
    install_panic_hook();

    let configured = pm_store::settings::configured("logDirectory")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(dir) = configured {
        match set_dir(&dir) {
            Ok(path) => return path,
            Err(error) => {
                // 目录被删/变成只读：退回默认目录，至少保证日志还在写
                let _ = error;
            }
        }
    }
    set_dir(&pm_store::default_log_dir()).unwrap_or_else(|_| {
        let fallback = default_path();
        if let Ok(mut slot) = PATH.write() {
            *slot = fallback.clone();
        }
        fallback
    })
}

/// 日志文件路径。启动失败时对话框里要显示这条路径，用户才知道去哪找原因。
pub fn path() -> PathBuf {
    let current = PATH.read().map(|path| path.clone()).unwrap_or_default();
    if current.as_os_str().is_empty() {
        default_path()
    } else {
        current
    }
}

/// 切换日志目录（设置页选完目录后调用）。先试写一次 `main.log`，
/// 写不进去就原样报错，避免把设置改成"看起来成功、实际不落盘"。
pub fn set_dir(dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|error| {
        AppError::config(format!("无法创建日志目录 {}：{error}", dir.display()))
    })?;
    if !dir.is_dir() {
        return Err(AppError::config(format!(
            "日志目录不是文件夹：{}",
            dir.display()
        )));
    }
    let path = dir.join("main.log");
    let probe = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| AppError::config(format!("日志目录不可写 {}：{error}", dir.display())))?;
    drop(probe);

    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    {
        let mut slot = FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 丢掉旧句柄，下一行会写到新目录
        *slot = None;
    }
    if let Ok(mut slot) = PATH.write() {
        *slot = path.clone();
    }
    BYTES.store(size, Ordering::Relaxed);
    pm_core::pm_log!("[logging] 日志目录切换为 {}", dir.display());
    Ok(path)
}

fn open(path: &Path) -> Option<File> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn append(line: &str) {
    let path = PATH.read().map(|path| path.clone()).unwrap_or_default();
    if path.as_os_str().is_empty() {
        return;
    }
    let mut slot = FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        *slot = open(&path);
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
        rotate(&path, &mut slot);
    }
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    path.with_file_name(format!("main.{index}.log"))
}

fn rotate(path: &Path, slot: &mut Option<File>) {
    *slot = None;
    // 从最旧的一份开始腾位置：删 main.5，main.4→main.5……main.1→main.2，
    // 再把当前文件滚成 main.1。任何一步失败都不阻断后续写入。
    let _ = std::fs::remove_file(backup_path(path, MAX_BACKUPS));
    for index in (1..MAX_BACKUPS).rev() {
        let _ = std::fs::rename(backup_path(path, index), backup_path(path, index + 1));
    }
    let _ = std::fs::rename(path, backup_path(path, 1));
    BYTES.store(0, Ordering::Relaxed);
    *slot = open(path);
}

/// 导出用：按时间顺序拼接最旧的备份到当前文件。
pub fn merged_text() -> String {
    let path = path();
    let mut text = String::new();
    for index in (1..=MAX_BACKUPS).rev() {
        if let Ok(part) = std::fs::read_to_string(backup_path(&path, index)) {
            text.push_str(&part);
        }
    }
    if let Ok(part) = std::fs::read_to_string(&path) {
        text.push_str(&part);
    }
    if text.is_empty() {
        text.push_str("（还没有运行时日志）\n");
    }
    text
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_keeps_five_backups_and_drops_the_oldest() {
        let dir = std::env::temp_dir().join(format!("pm-log-rotate-{}", pm_core::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("main.log");
        std::fs::write(&path, "current").unwrap();
        for index in 1..=MAX_BACKUPS {
            std::fs::write(backup_path(&path, index), format!("backup-{index}")).unwrap();
        }

        let mut slot = None;
        rotate(&path, &mut slot);

        assert_eq!(
            std::fs::read_to_string(backup_path(&path, 1)).unwrap(),
            "current"
        );
        assert_eq!(
            std::fs::read_to_string(backup_path(&path, 2)).unwrap(),
            "backup-1"
        );
        // 最旧的 backup-5 被删掉，backup-4 顶到第 5 份
        assert_eq!(
            std::fs::read_to_string(backup_path(&path, 5)).unwrap(),
            "backup-4"
        );
        assert!(slot.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
