//! 日志的落点。
//!
//! release 构建带 `windows_subsystem = "windows"`，进程没有控制台：只靠 eprintln!
//! 等于出问题时一个字节都留不下。这里给出一个进程级 sink，由主进程装成
//! 「追加到 `<userData>/logs/main.log`」，各 crate 用 `pm_log!` 写即可两边都有。
//!
//! 刻意不引第三方日志框架：这里只需要「带时间戳的一行」，链路上没有级别过滤、
//! 没有结构化字段，多引一层依赖换不来什么。

use std::sync::OnceLock;

type Sink = Box<dyn Fn(&str) + Send + Sync>;

static SINK: OnceLock<Sink> = OnceLock::new();

/// 安装落盘目标。只能装一次：重复安装会让同一行写去两个地方，
/// 排查时反而分不清哪份是最新的。
pub fn set_sink(sink: impl Fn(&str) + Send + Sync + 'static) {
    let _ = SINK.set(Box::new(sink));
}

/// 一行日志的实际出口：始终打 stderr（开发态直接可见），再交给 sink 落盘。
pub fn emit(line: &str) {
    eprint!("{line}");
    if let Some(sink) = SINK.get() {
        sink(line);
    }
}

/// 时间戳用 UTC。Electron 版写的就是这个形状（`[2026-10-18T07:04:42.659Z]`），
/// 两个版本共用同一份 main.log，格式必须对得上，否则按时间排序会乱。
pub fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 按 TS 侧的 `[时间] [级别] 内容` 形状写一行。
pub fn emit_line(level: &str, message: &str) {
    emit(&format!("[{}] [{}] {}\n", stamp(), level, message));
}

/// 常规日志：`pm_log!("[rpc] {method}")`。
#[macro_export]
macro_rules! pm_log {
    ($($arg:tt)*) => {{
        $crate::logging::emit_line("INFO", &format!($($arg)*));
    }};
}

/// 出错的那些行。级别只是让人少读几行，调用方不需要为它改变控制流。
#[macro_export]
macro_rules! pm_warn {
    ($($arg:tt)*) => {{
        $crate::logging::emit_line("ERROR", &format!($($arg)*));
    }};
}
