//! SSH / Kubernetes 端口转发：拉起系统 `ssh` / `kubectl` 子进程，退出时收拾干净。
//!
//! 不做协议实现：隧道只是「把远端端口搬到本地」，交给用户机器上已经配好的客户端最稳，
//! 也顺带继承了它们对 ProxyJump、kubeconfig 上下文、证书插件的支持。
//! 代价是密码登录无法自动化（ssh 从终端读密码），这种情况明确报错让人改用密钥或 agent。

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use pm_core::{AppError, AppResult};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TunnelEndpoint {
    pub tunnel_id: String,
    pub local_admin_port: u16,
    pub local_broker_port: u16,
}

#[derive(Debug, Clone, Default)]
pub struct SshSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key: Option<String>,
    pub remote_host: String,
    pub remote_admin_port: u16,
    pub remote_broker_port: u16,
}

#[derive(Debug, Clone, Default)]
pub struct K8sSpec {
    pub namespace: String,
    pub resource: String,
    pub context: Option<String>,
    pub kubeconfig_path: Option<String>,
    pub kubectl_path: Option<String>,
    pub remote_admin_port: u16,
    pub remote_broker_port: u16,
}

struct Handle {
    child: Child,
    key_file: Option<std::path::PathBuf>,
}

fn tunnels() -> &'static Mutex<HashMap<String, Handle>> {
    static TUNNELS: OnceLock<Mutex<HashMap<String, Handle>>> = OnceLock::new();
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn free_port() -> AppResult<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::Other(format!("找不到可用的本地端口：{e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Other(format!("读取本地端口失败：{e}")))?
        .port();
    drop(listener);
    Ok(port)
}

fn port_ready(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:1".parse().unwrap()),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn wait_ready(child: &mut Child, port: u16, name: &str) -> AppResult<()> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(AppError::Other(format!(
                "{name} 提前退出了（{status}）：检查主机名、账号与凭据是否正确"
            )));
        }
        if port_ready(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(AppError::Other(format!(
        "{name} 8 秒内没有就绪：远端端口可能不通，或权限不足"
    )))
}

pub fn start_ssh(spec: &SshSpec) -> AppResult<TunnelEndpoint> {
    if spec.host.trim().is_empty() || spec.username.trim().is_empty() {
        return Err(AppError::config("SSH 主机与账号都要填"));
    }
    let local_admin = free_port()?;
    let local_broker = free_port()?;
    let tunnel_id = pm_core::new_id();

    let mut command = Command::new("ssh");
    let mut key_file = None;
    command
        .arg("-N")
        // 任一转发建不起来就整体失败，而不是留一条「只通了 admin 口」的半残隧道
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-L")
        .arg(format!(
            "127.0.0.1:{local_admin}:{}:{}",
            spec.remote_host, spec.remote_admin_port
        ))
        .arg("-L")
        .arg(format!(
            "127.0.0.1:{local_broker}:{}:{}",
            spec.remote_host, spec.remote_broker_port
        ))
        .arg("-p")
        .arg(spec.port.to_string());

    if let Some(key) = spec.private_key.as_deref().filter(|value| !value.trim().is_empty()) {
        // 私钥落在用户临时目录里，权限收窄到本人可读；隧道停掉就删
        let path = std::env::temp_dir().join(format!("pm-tunnel-{tunnel_id}.key"));
        std::fs::write(&path, key).map_err(|e| AppError::Other(format!("写入临时私钥失败：{e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        command.arg("-i").arg(&path);
        key_file = Some(path);
    }

    command
        .arg(format!("{}@{}", spec.username, spec.host))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| AppError::Other(format!("拉起 ssh 失败（系统里没有 ssh 命令？）：{e}")))?;
    if let Err(error) = wait_ready(&mut child, local_admin, "SSH 隧道") {
        let _ = child.kill();
        if let Some(path) = key_file {
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }

    tunnels()
        .lock()
        .unwrap()
        .insert(tunnel_id.clone(), Handle { child, key_file });
    Ok(TunnelEndpoint {
        tunnel_id,
        local_admin_port: local_admin,
        local_broker_port: local_broker,
    })
}

pub fn start_k8s(spec: &K8sSpec) -> AppResult<TunnelEndpoint> {
    if spec.namespace.trim().is_empty() || spec.resource.trim().is_empty() {
        return Err(AppError::config("命名空间与资源（service/名称）都要填"));
    }
    let local_admin = free_port()?;
    let local_broker = free_port()?;
    let tunnel_id = pm_core::new_id();

    let kubectl = spec
        .kubectl_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("kubectl");
    let mut command = Command::new(kubectl);
    command
        .arg("port-forward")
        .arg(&spec.resource)
        .arg(format!("{local_admin}:{}", spec.remote_admin_port))
        .arg(format!("{local_broker}:{}", spec.remote_broker_port))
        .arg("-n")
        .arg(&spec.namespace);
    if let Some(context) = spec.context.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        command.arg("--context").arg(context);
    }
    if let Some(path) = spec
        .kubeconfig_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg("--kubeconfig").arg(path);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| AppError::Other(format!("拉起 kubectl 失败（路径没配或不在 PATH 里？）：{e}")))?;
    if let Err(error) = wait_ready(&mut child, local_admin, "Kubernetes 端口转发") {
        let _ = child.kill();
        return Err(error);
    }

    tunnels()
        .lock()
        .unwrap()
        .insert(tunnel_id.clone(), Handle { child, key_file: None });
    Ok(TunnelEndpoint {
        tunnel_id,
        local_admin_port: local_admin,
        local_broker_port: local_broker,
    })
}

/// 断开：先礼后兵——kill 完再 wait，避免留下僵尸进程。
pub fn stop(tunnel_id: &str) -> bool {
    let handle = tunnels().lock().unwrap().remove(tunnel_id);
    match handle {
        Some(mut handle) => {
            let _ = handle.child.kill();
            let _ = handle.child.wait();
            if let Some(path) = handle.key_file {
                let _ = std::fs::remove_file(path);
            }
            true
        }
        None => false,
    }
}

/// 进程退出前统一收尾：隧道进程不能比应用活得久。
pub fn stop_all() {
    let ids: Vec<String> = tunnels().lock().unwrap().keys().cloned().collect();
    for id in ids {
        stop(&id);
    }
}
