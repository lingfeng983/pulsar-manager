//! 显示层格式化。单位换算只在显示侧做，落库与判定一律用原生单位。

pub fn format_bytes(value: f64) -> String {
    if !value.is_finite() || value <= 0.0 {
        return "0 B".to_string();
    }
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let mut size = value;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{size:.0} {}", UNITS[unit])
    } else {
        format!("{size:.2} {}", UNITS[unit])
    }
}

pub fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return "-".to_string();
    }
    let abs = value.abs();
    if abs >= 1e9 {
        format!("{:.2}B", value / 1e9)
    } else if abs >= 1e6 {
        format!("{:.2}M", value / 1e6)
    } else if abs >= 1e3 {
        format!("{:.2}K", value / 1e3)
    } else if abs < 10.0 && abs.fract() != 0.0 {
        format!("{value:.2}")
    } else {
        format!("{value:.0}")
    }
}

/// 表格里截断长文本（按字符而非字节，避免切坏 UTF-8）。
pub fn truncate(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_use_binary_units() {
        assert_eq!(format_bytes(0.0), "0 B");
        assert_eq!(format_bytes(1024.0), "1.00 KB");
        assert_eq!(format_bytes(1536.0), "1.50 KB");
    }

    #[test]
    fn truncate_keeps_utf8_boundaries() {
        assert_eq!(truncate("中文标题很长", 3), "中文…");
    }
}
