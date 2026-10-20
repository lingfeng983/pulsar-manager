//! 凭据加密。与 Electron 版共用同一套密钥文件与密文格式，
//! 这样 Rust 版第一次启动就能解出老库里的 authParams / 通知渠道 URL。
//!
//! 密文格式：`v2:` + base64(iv(12) || tag(16) || ciphertext)
//! 密钥文件：`.encryption-key.v2`，内容为 Chromium OSCrypt 的 Windows 形态
//! `v10` + DPAPI(hex 密钥)。DPAPI 不可用时按 fail-closed 处理，
//! 只有显式设置 `ALLOW_PLAINTEXT_KEY=1` 才退回明文密钥文件。

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use pm_core::{AppError, AppResult};

const CIPHER_PREFIX: &str = "v2:";
const KEY_FILE: &str = ".encryption-key.v2";
const LEGACY_KEY_FILE: &str = ".encryption-key";
const GCM_IV_BYTES: usize = 12;

pub struct SecretBox {
    key: [u8; 32],
    dir: PathBuf,
    /// 密钥文件无法解密而被迫轮换时给出的提示，由界面显示成横幅。
    warning: Option<String>,
}

impl SecretBox {
    pub fn load_or_create(dir: impl AsRef<Path>) -> AppResult<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        let (key, warning) = load_key(&dir)?;
        Ok(Self { key, dir, warning })
    }

    pub fn warning(&self) -> Option<&str> {
        self.warning.as_deref()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn encrypt(&self, plaintext: &str) -> AppResult<String> {
        if plaintext.is_empty() {
            return Ok(String::new());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| AppError::Other("凭据密钥长度不合法".into()))?;
        let mut iv = [0u8; GCM_IV_BYTES];
        rand::Rng::fill(&mut rand::rng(), &mut iv[..]);
        let nonce = Nonce::try_from(&iv[..]).map_err(|_| AppError::Other("IV 长度不合法".into()))?;
        let sealed = cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|_| AppError::Other("加密凭据失败".into()))?;
        // aes-gcm 把 tag 附在密文尾部，这里改写成 iv||tag||ciphertext 以对齐 Node 版
        let (ciphertext, tag) = sealed.split_at(sealed.len().saturating_sub(16));
        let mut combined = Vec::with_capacity(GCM_IV_BYTES + 16 + ciphertext.len());
        combined.extend_from_slice(&iv);
        combined.extend_from_slice(tag);
        combined.extend_from_slice(ciphertext);
        Ok(format!(
            "{CIPHER_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(combined)
        ))
    }

    pub fn decrypt(&self, payload: &str) -> AppResult<String> {
        if payload.is_empty() {
            return Ok(String::new());
        }
        let Some(encoded) = payload.strip_prefix(CIPHER_PREFIX) else {
            return Err(AppError::Other(
                "该凭据是旧版 AES-CBC 格式，请先用 Electron 版打开一次以完成迁移".into(),
            ));
        };
        let combined = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| AppError::Other("凭据密文不是合法 base64".into()))?;
        if combined.len() < GCM_IV_BYTES + 16 {
            return Err(AppError::Other("凭据密文长度不合法".into()));
        }
        let iv = &combined[..GCM_IV_BYTES];
        let tag = &combined[GCM_IV_BYTES..GCM_IV_BYTES + 16];
        let ciphertext = &combined[GCM_IV_BYTES + 16..];

        // 还原成 aes-gcm 期望的 ciphertext||tag
        let mut sealed = Vec::with_capacity(ciphertext.len() + 16);
        sealed.extend_from_slice(ciphertext);
        sealed.extend_from_slice(tag);
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| AppError::Other("凭据密钥长度不合法".into()))?;
        let nonce = Nonce::try_from(iv).map_err(|_| AppError::Other("IV 长度不合法".into()))?;
        let plaintext = cipher
            .decrypt(&nonce, sealed.as_ref())
            .map_err(|_| AppError::Other("解密凭据失败：密钥或密文已损坏".into()))?;
        String::from_utf8(plaintext).map_err(|_| AppError::Other("凭据明文不是 UTF-8".into()))
    }

    pub fn decrypt_opt(&self, payload: Option<&str>) -> AppResult<Option<String>> {
        match payload {
            Some(value) if !value.is_empty() => Ok(Some(self.decrypt(value)?)),
            _ => Ok(None),
        }
    }
}

fn load_key(dir: &Path) -> AppResult<([u8; 32], Option<String>)> {
    let protected = dir.join(KEY_FILE);
    if protected.exists() {
        let raw = std::fs::read(&protected)?;
        match unprotect_key(&raw) {
            Ok(hex_key) => return Ok((parse_hex_key(&hex_key)?, None)),
            Err(error) => {
                // 密钥文件已经解不开了（典型原因：Windows 账户密码被重置、配置文件被搬到另一台机器）。
                // 既不能让整个程序起不来，也不能装作解开了：备份旧文件、换新密钥，并把后果说清楚。
                let backup = dir.join(format!(
                    "{KEY_FILE}.broken-{}",
                    chrono::Local::now().format("%Y%m%d%H%M%S")
                ));
                let backed_up = std::fs::rename(&protected, &backup).is_ok();
                let key = create_key(dir)?;
                let warning = if backed_up {
                    format!(
                        "原有凭据密钥已无法解密（{error}），旧文件备份为 {} 并生成了新密钥。\
                         已保存的集群认证参数、通知渠道密钥需要重新填写。",
                        backup.file_name().and_then(|name| name.to_str()).unwrap_or("备份文件")
                    )
                } else {
                    format!(
                        "原有凭据密钥已无法解密（{error}），且旧文件未能备份，已生成新密钥。\
                         已保存的集群认证参数、通知渠道密钥需要重新填写。"
                    )
                };
                return Ok((key, Some(warning)));
            }
        }
    }

    let legacy = dir.join(LEGACY_KEY_FILE);
    if legacy.exists() {
        let hex_key = std::fs::read_to_string(&legacy)?.trim().to_string();
        let key = parse_hex_key(&hex_key)?;
        persist_key(dir, &hex_key)?;
        let _ = std::fs::remove_file(&legacy);
        return Ok((key, None));
    }

    Ok((create_key(dir)?, None))
}

fn create_key(dir: &Path) -> AppResult<[u8; 32]> {
    let mut key = [0u8; 32];
    rand::Rng::fill(&mut rand::rng(), &mut key[..]);
    persist_key(dir, &hex::encode(key))?;
    Ok(key)
}

fn parse_hex_key(value: &str) -> AppResult<[u8; 32]> {
    let bytes = hex::decode(value.trim()).map_err(|_| AppError::Other("密钥不是合法十六进制".into()))?;
    if bytes.len() != 32 {
        return Err(AppError::Other(format!("密钥长度应为 32 字节，实际 {}", bytes.len())));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn persist_key(dir: &Path, hex_key: &str) -> AppResult<()> {
    let path = dir.join(KEY_FILE);
    match protect_key(hex_key.as_bytes()) {
        Ok(blob) => {
            // Chromium / Electron safeStorage 的 Windows 形态：`v10` + DPAPI blob
            let mut payload = b"v10".to_vec();
            payload.extend_from_slice(&blob);
            std::fs::write(&path, payload)?;
            Ok(())
        }
        Err(error) => {
            if std::env::var("ALLOW_PLAINTEXT_KEY").ok().as_deref() != Some("1") {
                return Err(AppError::Other(format!(
                    "系统密钥库不可用（{error}）。如需退回明文密钥文件，请设置 ALLOW_PLAINTEXT_KEY=1（不安全）。"
                )));
            }
            std::fs::write(dir.join(LEGACY_KEY_FILE), hex_key)?;
            Ok(())
        }
    }
}

#[cfg(windows)]
fn protect_key(data: &[u8]) -> Result<Vec<u8>, String> {
    dpapi::protect(data)
}

#[cfg(windows)]
fn unprotect_key(raw: &[u8]) -> AppResult<String> {
    let body = raw.strip_prefix(b"v10").unwrap_or(raw);
    // Chromium / Electron 的 OSCrypt 在 `v10` 之后放的是 base64(DPAPI blob)；
    // 本项目早期自己写的文件则是裸 blob，两种都试一遍。
    let mut candidates: Vec<Vec<u8>> = Vec::new();
    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(body) {
        candidates.push(decoded);
    }
    candidates.push(body.to_vec());

    let mut reason = "密钥文件不是合法的 DPAPI 数据".to_string();
    for candidate in candidates {
        match dpapi::unprotect(&candidate) {
            Ok(plain) => {
                return String::from_utf8(plain)
                    .map_err(|_| AppError::Other("密钥文件不是 UTF-8".into()))
            }
            Err(error) => reason = error,
        }
    }
    Err(AppError::Other(reason))
}

#[cfg(not(windows))]
fn protect_key(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("非 Windows 平台暂未接入系统密钥库".to_string())
}

#[cfg(not(windows))]
fn unprotect_key(_raw: &[u8]) -> AppResult<String> {
    Err(AppError::Other("非 Windows 平台暂未接入系统密钥库".into()))
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *const c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *const c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = DataBlob {
                cb_data: data.len() as u32,
                pb_data: data.as_ptr() as *mut u8,
            };
            let mut output = DataBlob {
                cb_data: 0,
                pb_data: std::ptr::null_mut(),
            };
            let ok = CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                0,
                &mut output,
            );
            if ok == 0 {
                return Err("CryptProtectData 调用失败".to_string());
            }
            let bytes = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
            LocalFree(output.pb_data as *mut c_void);
            Ok(bytes)
        }
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = DataBlob {
                cb_data: data.len() as u32,
                pb_data: data.as_ptr() as *mut u8,
            };
            let mut output = DataBlob {
                cb_data: 0,
                pb_data: std::ptr::null_mut(),
            };
            let ok = CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                0,
                &mut output,
            );
            if ok == 0 {
                return Err("CryptUnprotectData 调用失败（可能不是同一 Windows 用户）".to_string());
            }
            let bytes = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
            LocalFree(output.pb_data as *mut c_void);
            Ok(bytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_v2_prefix() {
        let dir = std::env::temp_dir().join(format!("pm-crypto-{}", pm_core::new_id()));
        let secrets = SecretBox::load_or_create(&dir).unwrap();
        let cipher = secrets.encrypt("sensitive-token").unwrap();
        assert!(cipher.starts_with("v2:"));
        assert_eq!(secrets.decrypt(&cipher).unwrap(), "sensitive-token");
        // 换一个实例（重新读密钥文件）仍能解开
        let reopened = SecretBox::load_or_create(&dir).unwrap();
        assert_eq!(reopened.decrypt(&cipher).unwrap(), "sensitive-token");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_values_stay_empty() {
        let dir = std::env::temp_dir().join(format!("pm-crypto-{}", pm_core::new_id()));
        let secrets = SecretBox::load_or_create(&dir).unwrap();
        assert_eq!(secrets.encrypt("").unwrap(), "");
        assert_eq!(secrets.decrypt("").unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
