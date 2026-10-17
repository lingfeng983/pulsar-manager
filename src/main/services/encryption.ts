import crypto from 'node:crypto';
import {app, safeStorage} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {createLogger} from '../utils/logger';

const log = createLogger('Encryption');

// 旧版密钥文件：明文十六进制，与数据库同目录（等同于明文存储凭据）
const LEGACY_KEY_FILE = '.encryption-key';
// 新版密钥文件：由 OS 级密钥库（DPAPI / Keychain / libsecret）保护
const KEY_FILE = '.encryption-key.v2';

// 新密文格式前缀。base64 字母表不含 ':'，因此可以据此无歧义区分新旧格式。
const CIPHER_PREFIX = 'v2:';
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CBC_IV_BYTES = 16;

// 密钥在进程内缓存，避免每次加解密都读盘
let cachedKey: Buffer | null = null;

function keyFilePath(fileName: string): string {
    return path.join(app.getPath('userData'), fileName);
}

function persistKey(keyHex: string): void {
    const protectedPath = keyFilePath(KEY_FILE);
    fs.mkdirSync(path.dirname(protectedPath), {recursive: true});

    if (safeStorage.isEncryptionAvailable()) {
        // 即便内容已被 OS 密钥库加密，也把文件权限收紧到仅属主可读写
        fs.writeFileSync(protectedPath, safeStorage.encryptString(keyHex), {mode: 0o600});
        // 迁移完成后删除明文密钥，否则等于没有加固
        const legacyPath = keyFilePath(LEGACY_KEY_FILE);
        if (fs.existsSync(legacyPath)) {
            fs.rmSync(legacyPath);
            log.info('Migrated encryption key to OS-protected storage');
        }
        return;
    }

    // 平台不支持 safeStorage（部分 Linux 环境无 keyring）时默认 fail closed：
    // 把凭据密钥落成明文等于没有加密，因此除非用户显式设置
    // ALLOW_PLAINTEXT_KEY=1 承担风险，否则直接报错而不是静默降级。
    if (process.env.ALLOW_PLAINTEXT_KEY !== '1') {
        log.error('safeStorage is unavailable; refusing to store the encryption key in plaintext');
        throw new Error(
            'OS secure storage is unavailable. Set ALLOW_PLAINTEXT_KEY=1 to allow a plaintext key file (insecure).',
        );
    }

    log.warn('safeStorage unavailable; ALLOW_PLAINTEXT_KEY=1 set, falling back to a plaintext key file');
    fs.writeFileSync(keyFilePath(LEGACY_KEY_FILE), keyHex, {mode: 0o600});
}

function getEncryptionKey(): Buffer {
    if (cachedKey) {
        return cachedKey;
    }

    const protectedPath = keyFilePath(KEY_FILE);
    if (fs.existsSync(protectedPath)) {
        try {
            const keyHex = safeStorage.decryptString(fs.readFileSync(protectedPath));
            cachedKey = Buffer.from(keyHex, 'hex');
            return cachedKey;
        } catch (error) {
            log.error('Failed to read protected key file', (error as Error).message);
            throw new Error('Failed to read encryption key');
        }
    }

    const legacyPath = keyFilePath(LEGACY_KEY_FILE);
    let keyHex: string;
    if (fs.existsSync(legacyPath)) {
        // 沿用原有密钥字节，只把密钥文件改为受保护存储；
        // 这样已存的 CBC 密文仍可解密，不需要一次性重写数据库。
        try {
            keyHex = fs.readFileSync(legacyPath, 'utf-8').trim();
        } catch (error) {
            log.error('Failed to read legacy key file', (error as Error).message);
            throw new Error('Failed to read encryption key');
        }
    } else {
        keyHex = crypto.randomBytes(32).toString('hex');
        log.info('New encryption key generated');
    }

    persistKey(keyHex);
    cachedKey = Buffer.from(keyHex, 'hex');
    return cachedKey;
}

// AES-256-GCM 加密（带完整性校验，密文被篡改时解密会失败而非静默返回错误明文）
export function encrypt(plaintext: string): string {
    if (!plaintext) {
        return '';
    }

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return CIPHER_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// 解密旧版 AES-256-CBC 密文（格式：base64(iv(16) || ciphertext)）
function decryptLegacyCbc(payload: string, key: Buffer): string {
    const combined = Buffer.from(payload, 'base64');
    const iv = combined.subarray(0, CBC_IV_BYTES);
    const ciphertext = combined.subarray(CBC_IV_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

export function decrypt(ciphertext: string): string {
    if (!ciphertext) {
        return '';
    }

    const key = getEncryptionKey();

    try {
        if (!ciphertext.startsWith(CIPHER_PREFIX)) {
            return decryptLegacyCbc(ciphertext, key);
        }

        const combined = Buffer.from(ciphertext.slice(CIPHER_PREFIX.length), 'base64');
        const iv = combined.subarray(0, GCM_IV_BYTES);
        const authTag = combined.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
        const payload = combined.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf-8');
    } catch (error) {
        log.error('Decryption failed', (error as Error).message);
        throw new Error('Decryption failed');
    }
}
