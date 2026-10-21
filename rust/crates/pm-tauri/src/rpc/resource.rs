//! 资源类 RPC：租户、命名空间、topic、订阅、权限、schema。
//!
//! 全部走 Admin REST，参数顺序与 `src/preload.ts` 逐项对齐（前端按位置传参）。

use pm_core::{AppError, AppResult, Tenant};
use pm_pulsar::AdminClient;
use serde::Serialize;
use serde_json::{json, Value};

use crate::bridge::{fail, ok, Shared};

pub async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Option<Value> {
    let cluster = text(&args, 0);
    let tenant = text(&args, 1);
    let namespace = text(&args, 2);
    let topic = text(&args, 3);
    let persistent = boolean(&args, 4, true);

    // 未覆盖的方法直接返回 None，交给后面的模块继续匹配。
    let handled = matches!(
        method,
        "resources:getTenants"
            | "resources:getNamespaces"
            | "resources:getTopics"
            | "resources:getTopicStats"
            | "resources:getSubscriptions"
            | "resources:getTenantInfo"
            | "resources:createSubscription"
            | "resources:deleteSubscription"
            | "resources:resetCursor"
            | "resources:skipMessages"
            | "resources:deleteTopic"
            | "resources:createTopic"
            | "resources:getSchema"
            | "resources:deleteSchema"
            | "resources:setSchemaStrategy"
            | "resources:getSchemaStrategy"
            | "resources:createSchemaVersion"
            | "resources:getNamespacePermissions"
            | "resources:grantNamespacePermission"
            | "resources:revokeNamespacePermission"
            | "resources:getTopicPermissions"
            | "resources:grantTopicPermission"
            | "resources:revokeTopicPermission"
            | "resources:getTopicConfig"
            | "resources:updateTopicConfig"
            | "resources:getPulsarClusters"
            | "resources:createTenant"
            | "resources:updateTenant"
            | "resources:deleteTenant"
            | "resources:createNamespace"
            | "resources:deleteNamespace"
    );
    if !handled {
        return None;
    }

    let client = match admin(&context, &cluster).await {
        Ok(client) => client,
        Err(payload) => return Some(payload),
    };

    Some(match method {
        "resources:getTenants" => settle(client.tenants().await),
        "resources:getPulsarClusters" => settle(client.pulsar_clusters().await),
        "resources:getNamespaces" => settle(client.namespaces(&tenant).await),
        "resources:getTenantInfo" => settle(client.tenant_info(&tenant).await),
        "resources:getTopics" => settle(client.topics(&tenant, &namespace).await),
        "resources:getTopicStats" => {
            settle(client.topic_stats(&tenant, &namespace, &topic, persistent).await)
        }
        "resources:getSubscriptions" => {
            settle(client.subscriptions(&tenant, &namespace, &topic, persistent).await)
        }

        "resources:createSubscription" => {
            let name = text(&args, 4);
            let position = args
                .get(5)
                .and_then(Value::as_str)
                .unwrap_or("Latest")
                .to_string();
            let persistent = boolean(&args, 6, true);
            settle(
                client
                    .create_subscription(&tenant, &namespace, &topic, &name, persistent, &position)
                    .await,
            )
        }
        "resources:deleteSubscription" => {
            let name = text(&args, 4);
            let persistent = boolean(&args, 5, true);
            settle(
                client
                    .delete_subscription(&tenant, &namespace, &topic, &name, persistent)
                    .await,
            )
        }
        "resources:resetCursor" => {
            let subscription = text(&args, 4);
            let position = text(&args, 5);
            let timestamp = args.get(6).and_then(Value::as_i64);
            let persistent = boolean(&args, 7, true);
            // 按时间戳和按 earliest/latest 是两个不同的端点，不能混着发
            let result = if position == "timestamp" {
                client
                    .reset_cursor(
                        &tenant,
                        &namespace,
                        &topic,
                        &subscription,
                        timestamp.unwrap_or(0),
                        persistent,
                    )
                    .await
            } else {
                client
                    .reset_cursor_to(
                        &tenant,
                        &namespace,
                        &topic,
                        &subscription,
                        &position,
                        persistent,
                    )
                    .await
            };
            settle(result)
        }
        "resources:skipMessages" => {
            let subscription = text(&args, 4);
            let count = args.get(5).and_then(Value::as_i64).unwrap_or(0);
            let persistent = boolean(&args, 6, true);
            settle(
                client
                    .skip_messages(&tenant, &namespace, &topic, &subscription, count, persistent)
                    .await,
            )
        }

        "resources:deleteTopic" => {
            let force = boolean(&args, 5, false);
            settle(
                client
                    .delete_topic(&tenant, &namespace, &topic, persistent, force)
                    .await,
            )
        }
        "resources:createTopic" => {
            let name = text(&args, 3);
            let persistent = boolean(&args, 4, true);
            // 0 与 null 都表示"不分片"，交给服务端按默认处理
            let partitions = args.get(5).and_then(Value::as_i64).filter(|count| *count > 0);
            settle(
                client
                    .create_topic(&tenant, &namespace, &name, persistent, partitions)
                    .await,
            )
        }

        "resources:getSchema" => {
            settle(client.schema_info(&tenant, &namespace, &topic, persistent).await)
        }
        "resources:deleteSchema" => {
            settle(client.delete_schema(&tenant, &namespace, &topic, persistent).await)
        }
        "resources:setSchemaStrategy" => {
            let strategy = text(&args, 4);
            let persistent = boolean(&args, 5, true);
            settle(
                client
                    .set_schema_strategy(&tenant, &namespace, &topic, &strategy, persistent)
                    .await,
            )
        }
        "resources:getSchemaStrategy" => settle(
            client
                .compatibility_strategy(&tenant, &namespace, &topic, persistent)
                .await,
        ),
        "resources:createSchemaVersion" => {
            let schema_type = text(&args, 4);
            let definition = text(&args, 5);
            let persistent = boolean(&args, 6, true);
            settle(
                client
                    .create_schema(&tenant, &namespace, &topic, &schema_type, &definition, persistent)
                    .await,
            )
        }

        "resources:getNamespacePermissions" => {
            settle(client.namespace_permissions(&tenant, &namespace).await)
        }
        "resources:grantNamespacePermission" => {
            let role = text(&args, 3);
            let actions = strings(&args, 4);
            settle(
                client
                    .grant_namespace_permission(&tenant, &namespace, &role, &actions)
                    .await,
            )
        }
        "resources:revokeNamespacePermission" => {
            let role = text(&args, 3);
            settle(
                client
                    .revoke_namespace_permission(&tenant, &namespace, &role)
                    .await,
            )
        }
        "resources:getTopicPermissions" => {
            settle(client.topic_permissions(&tenant, &namespace, &topic, persistent).await)
        }
        "resources:grantTopicPermission" => {
            let role = text(&args, 4);
            let actions = strings(&args, 5);
            let persistent = boolean(&args, 6, true);
            settle(
                client
                    .grant_topic_permission(&tenant, &namespace, &topic, &role, &actions, persistent)
                    .await,
            )
        }
        "resources:revokeTopicPermission" => {
            let role = text(&args, 4);
            let persistent = boolean(&args, 5, true);
            settle(
                client
                    .revoke_topic_permission(&tenant, &namespace, &topic, &role, persistent)
                    .await,
            )
        }

        "resources:getTopicConfig" => {
            settle(client.topic_config(&tenant, &namespace, &topic, persistent).await)
        }
        "resources:updateTopicConfig" => {
            let config = args.get(4).cloned().unwrap_or_else(|| json!({}));
            let persistent = boolean(&args, 5, true);
            settle(
                client
                    .update_topic_config(&tenant, &namespace, &topic, &config, persistent)
                    .await,
            )
        }

        "resources:createTenant" | "resources:updateTenant" => {
            // 两个通道的第 2 个参数都是名字：create 是新建的名字，update 是改名后的名字
            let name = text(&args, 1);
            let admin_roles = strings(&args, 2);
            let allowed_clusters = strings(&args, 3);
            settle(
                client
                    .create_tenant(&Tenant {
                        name,
                        admin_roles,
                        allowed_clusters,
                    })
                    .await,
            )
        }
        "resources:deleteTenant" => settle(client.delete_tenant(&tenant).await),
        "resources:createNamespace" => {
            let name = text(&args, 2);
            settle(client.create_namespace(&tenant, &name).await)
        }
        "resources:deleteNamespace" => settle(client.delete_namespace(&tenant, &namespace).await),

        other => json!({
            "success": false,
            "error": format!("尚未迁移的方法：{other}"),
        }),
    })
}

/// `admin_for` 要读一次 SQLite，放到阻塞线程池里，别卡住 tokio worker。
async fn admin(context: &Shared, cluster_id: &str) -> Result<AdminClient, Value> {
    let context = context.clone();
    let id = cluster_id.to_string();
    match tokio::task::spawn_blocking(move || context.admin_for(&id)).await {
        Ok(Ok(client)) => Ok(client),
        Ok(Err(error)) => Err(fail(error)),
        Err(error) => Err(json!({ "success": false, "error": format!("任务失败：{error}") })),
    }
}

fn settle<T: Serialize>(result: AppResult<T>) -> Value {
    match result {
        Ok(value) => ok(value),
        Err(error) => fail(error),
    }
}

fn text(args: &[Value], index: usize) -> String {
    args.get(index)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn boolean(args: &[Value], index: usize, fallback: bool) -> bool {
    args.get(index).and_then(Value::as_bool).unwrap_or(fallback)
}

fn strings(args: &[Value], index: usize) -> Vec<String> {
    args.get(index)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 供其他模块复用的错误构造。
#[allow(dead_code)]
fn unsupported(message: &str) -> Value {
    fail(AppError::Unsupported(message.to_string()))
}
