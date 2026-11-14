//! 「模板内联 schema」的 JSON Schema 子集校验，规则与 `src/shared/json-schema-lite.ts` 逐条对齐：
//! 只认 type（含 integer/number 区分）、enum、const、required、properties、items（单 schema 或元组）。
//! 报文在后台逐条渲染，所以校验也必须在后台逐条做，前端那份只管编辑时的语法提示。

use pm_core::{AppError, AppResult};
use serde_json::Value;

const MAX_ISSUES: usize = 10;

#[derive(Debug, Clone, PartialEq)]
pub struct SchemaIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct SchemaValidation {
    pub issues: Vec<SchemaIssue>,
    pub truncated: bool,
}

/// 一份模板的发送前把关方式。
#[derive(Debug, Clone, Default)]
pub enum PayloadSchema {
    #[default]
    None,
    Inline(Value),
}

impl PayloadSchema {
    pub fn from_template(template: &Value) -> AppResult<Self> {
        match template.get("schemaMode").and_then(Value::as_str) {
            Some("inline") => {
                let raw = template
                    .get("schemaJson")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if raw.is_empty() {
                    return Err(AppError::other(
                        "选了内联 JSON Schema 却还没有写 schema，拒绝发送",
                    ));
                }
                let schema: Value = serde_json::from_str(raw)
                    .map_err(|_| AppError::other("schema 需要是合法的 JSON"))?;
                if !schema.is_object() {
                    return Err(AppError::other(
                        "schema 需要是 JSON 对象（如 {\"type\":\"object\",...}）",
                    ));
                }
                Ok(Self::Inline(schema))
            }
            Some("broker") => Err(AppError::Unsupported(
                "Broker Schema 校验暂未接通，不能按它发送；请改用内联 JSON Schema 或不校验".into(),
            )),
            _ => Ok(Self::None),
        }
    }

    pub fn check(&self, body: &str) -> Result<(), String> {
        let Self::Inline(schema) = self else {
            return Ok(());
        };
        let value: Value = serde_json::from_str(body)
            .map_err(|_| "报文不是合法 JSON，无法按 schema 校验".to_string())?;
        let result = validate(&value, schema);
        if result.issues.is_empty() {
            Ok(())
        } else {
            Err(format_issues(&result))
        }
    }
}

fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        Value::Number(number) => {
            let integral = number.is_i64()
                || number.is_u64()
                || number.as_f64().is_some_and(|f| f.fract() == 0.0);
            if integral {
                "integer"
            } else {
                "number"
            }
        }
    }
}

const KNOWN_TYPES: [&str; 7] = [
    "object", "array", "string", "number", "integer", "boolean", "null",
];

fn matches_type(value: &Value, expected: &str) -> bool {
    let actual = type_of(value);
    if expected == "number" {
        return actual == "number" || actual == "integer";
    }
    actual == expected
}

fn json_equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_equals(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, p)| y.get(key).is_some_and(|q| json_equals(p, q)))
        }
        _ => a == b,
    }
}

fn join_path(base: &str, key: &str) -> String {
    if base.is_empty() {
        key.to_string()
    } else {
        format!("{base}.{key}")
    }
}

struct Walker {
    result: SchemaValidation,
}

impl Walker {
    fn push(&mut self, path: &str, message: String) {
        if self.result.issues.len() < MAX_ISSUES {
            self.result.issues.push(SchemaIssue {
                path: path.to_string(),
                message,
            });
        } else {
            self.result.truncated = true;
        }
    }

    fn walk(&mut self, node: &Value, rule: &Value, path: &str) {
        if self.result.truncated || rule == &Value::Bool(true) {
            return;
        }
        if rule == &Value::Bool(false) {
            self.push(path, "该位置不允许出现值".into());
            return;
        }
        let Some(spec) = rule.as_object() else {
            return;
        };

        match spec.get("type") {
            Some(Value::String(expected)) => {
                if KNOWN_TYPES.contains(&expected.as_str()) && !matches_type(node, expected) {
                    self.push(path, format!("应为 {expected}，实际是 {}", type_of(node)));
                    return;
                }
            }
            Some(Value::Array(types)) => {
                let types: Vec<&str> = types.iter().filter_map(Value::as_str).collect();
                if !types.is_empty() && !types.iter().any(|t| matches_type(node, t)) {
                    self.push(
                        path,
                        format!("应为 {} 之一，实际是 {}", types.join(" / "), type_of(node)),
                    );
                    return;
                }
            }
            _ => {}
        }

        if let Some(expected) = spec.get("const") {
            if !json_equals(node, expected) {
                self.push(path, format!("值必须恰好是 {expected}"));
            }
        }
        if let Some(Value::Array(options)) = spec.get("enum") {
            if !options.iter().any(|option| json_equals(node, option)) {
                self.push(
                    path,
                    format!("值应属于枚举 {}", Value::Array(options.clone())),
                );
            }
        }

        if let Value::Object(current) = node {
            if let Some(Value::Array(required)) = spec.get("required") {
                for key in required.iter().filter_map(Value::as_str) {
                    if !current.contains_key(key) {
                        self.push(&join_path(path, key), "必填字段缺失".into());
                    }
                }
            }
            if let Some(Value::Object(props)) = spec.get("properties") {
                for (key, sub) in props {
                    if let Some(child) = current.get(key) {
                        self.walk(child, sub, &join_path(path, key));
                    }
                }
            }
        }

        if let Value::Array(items) = node {
            match spec.get("items") {
                Some(Value::Array(tuple)) => {
                    for (i, item) in items.iter().enumerate() {
                        if let Some(sub) = tuple.get(i) {
                            self.walk(item, sub, &join_path(path, &format!("[{i}]")));
                        }
                    }
                }
                Some(sub) => {
                    for (i, item) in items.iter().enumerate() {
                        self.walk(item, sub, &join_path(path, &format!("[{i}]")));
                    }
                }
                None => {}
            }
        }
    }
}

pub fn validate(value: &Value, schema: &Value) -> SchemaValidation {
    let mut walker = Walker {
        result: SchemaValidation::default(),
    };
    walker.walk(value, schema, "");
    walker.result
}

pub fn format_issues(result: &SchemaValidation) -> String {
    let describe = |issue: &SchemaIssue| {
        if issue.path.is_empty() {
            format!("根对象：{}", issue.message)
        } else {
            format!("{}：{}", issue.path, issue.message)
        }
    };
    let shown = result
        .issues
        .iter()
        .take(3)
        .map(describe)
        .collect::<Vec<_>>()
        .join("；");
    if result.truncated {
        format!(
            "schema 校验不通过：{shown}（仅显示前 {} 处，还有更多）",
            result.issues.len()
        )
    } else if result.issues.len() > 3 {
        format!(
            "schema 校验不通过：{shown}（共 {} 处）",
            result.issues.len()
        )
    } else {
        format!("schema 校验不通过：{shown}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn messages(value: Value, schema: Value) -> Vec<String> {
        validate(&value, &schema)
            .issues
            .into_iter()
            .map(|issue| format!("{}|{}", issue.path, issue.message))
            .collect()
    }

    #[test]
    fn integer_is_a_number_but_not_the_other_way_round() {
        assert!(messages(json!(3), json!({"type": "number"})).is_empty());
        assert_eq!(
            messages(json!(3.5), json!({"type": "integer"})),
            vec!["|应为 integer，实际是 number"]
        );
    }

    #[test]
    fn required_and_nested_properties_report_dotted_paths() {
        let schema = json!({
            "type": "object",
            "required": ["id", "ts"],
            "properties": {
                "user": {"type": "object", "properties": {"age": {"type": "integer"}}},
                "tags": {"type": "array", "items": {"type": "string"}}
            }
        });
        let value = json!({"id": "a", "user": {"age": "x"}, "tags": ["ok", 1]});
        let mut found = messages(value, schema);
        found.sort();
        assert_eq!(
            found,
            vec![
                "tags.[1]|应为 string，实际是 integer",
                "ts|必填字段缺失",
                "user.age|应为 integer，实际是 string",
            ]
        );
    }

    #[test]
    fn enum_and_const_compare_by_json_value() {
        assert!(messages(json!({"b": 1, "a": 2}), json!({"const": {"a": 2, "b": 1}})).is_empty());
        assert_eq!(
            messages(json!("c"), json!({"enum": ["a", "b"]})),
            vec![r#"|值应属于枚举 ["a","b"]"#]
        );
    }

    #[test]
    fn issues_are_capped_and_flagged_as_truncated() {
        let required: Vec<String> = (0..12).map(|i| format!("f{i}")).collect();
        let result = validate(&json!({}), &json!({"required": required}));
        assert_eq!(result.issues.len(), MAX_ISSUES);
        assert!(result.truncated);
        assert!(format_issues(&result).contains("还有更多"));
    }

    #[test]
    fn broker_mode_is_refused_instead_of_pretending_to_validate() {
        let error = PayloadSchema::from_template(&json!({"schemaMode": "broker"})).unwrap_err();
        assert!(error.to_string().contains("Broker Schema"));
    }

    #[test]
    fn inline_mode_needs_a_parseable_object_schema() {
        assert!(PayloadSchema::from_template(&json!({"schemaMode": "inline"})).is_err());
        assert!(PayloadSchema::from_template(
            &json!({"schemaMode": "inline", "schemaJson": "[1]"})
        )
        .is_err());
        assert!(matches!(
            PayloadSchema::from_template(&json!({"schemaMode": "none", "schemaJson": "{"}))
                .unwrap(),
            PayloadSchema::None
        ));
    }

    #[test]
    fn inline_check_rejects_non_json_and_mismatches() {
        let schema = PayloadSchema::from_template(&json!({
            "schemaMode": "inline",
            "schemaJson": r#"{"type":"object","required":["id"]}"#
        }))
        .unwrap();
        assert!(schema.check(r#"{"id": 1}"#).is_ok());
        assert_eq!(
            schema.check("{}").unwrap_err(),
            "schema 校验不通过：id：必填字段缺失"
        );
        assert!(schema
            .check("not json")
            .unwrap_err()
            .contains("不是合法 JSON"));
        assert!(PayloadSchema::None.check("not json").is_ok());
    }
}
