//! 报文模板引擎（对齐 `src/shared/template-engine.ts` 的核心语义）。
//!
//! 两条规则：
//! 1. 占位符只允许出现在 JSON 字符串值内部，因此模板本身永远是合法 JSON；
//! 2. 「整个值恰好是一个占位符」时替换整个值（保住数字/布尔类型），否则做字符串插值。

use pm_core::{AppError, AppResult, TemplateVariable};
use serde_json::Value;

/// 渲染后的正文与本次实际使用的变量值（界面回显「这次发出去的是什么」）。
pub struct Rendered {
    pub body: String,
    pub used: Vec<(String, Value)>,
}

pub fn render(template: &str, variables: &[TemplateVariable]) -> AppResult<Rendered> {
    let mut out = String::with_capacity(template.len() + 64);
    let mut used = Vec::new();
    let bytes = template.as_bytes();
    let mut cursor = 0usize;

    while cursor < bytes.len() {
        let ch = bytes[cursor] as char;
        if ch != '"' {
            out.push(ch);
            cursor += 1;
            continue;
        }
        // 进入字符串字面量：找到未被转义的收尾引号
        let start = cursor;
        cursor += 1;
        let content_start = cursor;
        while cursor < bytes.len() {
            match bytes[cursor] as char {
                '\\' => cursor += 2,
                '"' => break,
                _ => cursor += 1,
            }
        }
        if cursor >= bytes.len() {
            return Err(AppError::config("模板里的字符串没有收尾引号"));
        }
        let content = &template[content_start..cursor];
        cursor += 1; // 跳过收尾引号

        if let Some(name) = whole_placeholder(content) {
            let value = resolve(name, variables)?;
            out.push_str(&serde_json::to_string(&value)?);
            used.push((name.to_string(), value));
        } else {
            out.push_str(&template[start..cursor]);
            // 串内可能有多个占位符，逐个插值
            let interpolated = interpolate(content, variables, &mut used)?;
            if interpolated != content {
                // 回退到「引号 + 插值后内容 + 引号」
                out.truncate(out.len() - (cursor - start));
                out.push('"');
                out.push_str(&interpolated);
                out.push('"');
            }
        }
    }

    serde_json::from_str::<Value>(&out).map_err(|e| {
        AppError::config(format!(
            "模板渲染后不是合法 JSON（第 {} 行第 {} 列）：{e}",
            e.line(),
            e.column()
        ))
    })?;
    Ok(Rendered { body: out, used })
}

/// 模板里出现过的占位符名（用于校验变量表是否齐全）。
pub fn placeholders(template: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        let name = after[..end].trim();
        if !name.is_empty() && !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
        }
        rest = &after[end + 2..];
    }
    names
}

fn whole_placeholder(content: &str) -> Option<&str> {
    let trimmed = content.trim();
    let inner = trimmed.strip_prefix("{{")?.strip_suffix("}}")?;
    let name = inner.trim();
    (!name.is_empty()).then_some(name)
}

fn interpolate(content: &str, variables: &[TemplateVariable], used: &mut Vec<(String, Value)>) -> AppResult<String> {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let name = after[..end].trim();
        let value = resolve(name, variables)?;
        // 字符串插值只取标量的可读形态，不把 JSON 引号带进去
        let text = match &value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        out.push_str(&text);
        used.push((name.to_string(), value));
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

fn resolve(name: &str, variables: &[TemplateVariable]) -> AppResult<Value> {
    let variable = variables
        .iter()
        .find(|variable| variable.name == name)
        .ok_or_else(|| AppError::config(format!("模板引用了未定义的变量「{name}」")))?;
    build_value(variable)
}

fn build_value(variable: &TemplateVariable) -> AppResult<Value> {
    let raw = variable.value.trim();
    match variable.kind.as_str() {
        "number" | "int" | "integer" | "float" | "double" => {
            if raw.is_empty() {
                return Ok(Value::from(0));
            }
            // 整数字面量保留整数形态，避免 42 被序列化成 42.0。
            if let Ok(int) = raw.parse::<i64>() {
                return Ok(Value::from(int));
            }
            let parsed: f64 = raw
                .parse()
                .map_err(|_| AppError::config(format!("变量「{}」不是数字：{raw}", variable.name)))?;
            Ok(Value::from(parsed))
        }
        "boolean" | "bool" => {
            let value = matches!(raw.to_ascii_lowercase().as_str(), "true" | "1" | "yes");
            Ok(Value::from(value))
        }
        "timestamp" => {
            if raw.is_empty() {
                Ok(Value::from(pm_core::now_ms()))
            } else {
                let parsed: i64 = raw
                    .parse()
                    .map_err(|_| AppError::config(format!("变量「{}」不是时间戳：{raw}", variable.name)))?;
                Ok(Value::from(parsed))
            }
        }
        "uuid" => {
            if raw.is_empty() {
                Ok(Value::from(pm_core::new_id()))
            } else {
                Ok(Value::from(raw.to_string()))
            }
        }
        "random" => {
            let min = variable.min.unwrap_or(0.0);
            let max = variable.max.unwrap_or(100.0);
            if max <= min {
                return Err(AppError::config(format!(
                    "变量「{}」的随机范围不合法：min={min} max={max}",
                    variable.name
                )));
            }
            let value = min + rand::random::<f64>() * (max - min);
            Ok(Value::from(value))
        }
        "enum" => {
            if variable.options.is_empty() {
                return Err(AppError::config(format!("变量「{}」是枚举但没有选项", variable.name)));
            }
            if raw.is_empty() {
                Ok(Value::from(variable.options[0].clone()))
            } else if variable.options.iter().any(|option| option == raw) {
                Ok(Value::from(raw.to_string()))
            } else {
                Err(AppError::config(format!(
                    "变量「{}」的值 {raw} 不在可选项内：{}",
                    variable.name,
                    variable.options.join(", ")
                )))
            }
        }
        _ => Ok(Value::from(raw.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variable(name: &str, kind: &str, value: &str) -> TemplateVariable {
        TemplateVariable {
            name: name.into(),
            kind: kind.into(),
            value: value.into(),
            ..Default::default()
        }
    }

    #[test]
    fn whole_placeholder_keeps_numeric_type() {
        let template = r#"{"orderId":"{{id}}","count":{{count}}}"#;
        // 第二个占位符在字符串外，模板本身不合法（JSON 结构里），这里只验证字符串内的类型保持
        let rendered = render(
            r#"{"orderId":"{{id}}","count":"{{count}}"}"#,
            &[variable("id", "string", "A-1"), variable("count", "number", "42")],
        )
        .unwrap();
        assert_eq!(rendered.body, r#"{"orderId":"A-1","count":42}"#);
        let parsed: Value = serde_json::from_str(&rendered.body).unwrap();
        assert!(parsed["count"].is_number());
        let _ = template;
    }

    #[test]
    fn interpolates_inside_string() {
        let rendered = render(
            r#"{"msg":"订单 {{id}} 已创建"}"#,
            &[variable("id", "string", "A-1")],
        )
        .unwrap();
        assert_eq!(rendered.body, r#"{"msg":"订单 A-1 已创建"}"#);
    }

    #[test]
    fn rejects_undefined_variable() {
        assert!(render(r#"{"a":"{{missing}}"}"#, &[]).is_err());
    }

    #[test]
    fn rejects_escaping_quotes() {
        let rendered = render(
            r#"{"msg":"{{text}}"}"#,
            &[variable("text", "string", "a\"b")],
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&rendered.body).unwrap();
        assert_eq!(parsed["msg"], "a\"b");
    }

    #[test]
    fn lists_placeholders_once() {
        let names = placeholders(r#"{"a":"{{x}}","b":"{{x}} {{y}}"}"#);
        assert_eq!(names, vec!["x", "y"]);
    }
}
