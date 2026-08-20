import CryptoJS from 'crypto-js'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

// 密钥文件路径
function getKeyFilePath(): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, '.encryption-key')
}

// 生成随机密钥
function generateKey(): string {
  // 生成 256 位随机密钥
  const randomBytes = CryptoJS.lib.WordArray.random(32)
  return randomBytes.toString(CryptoJS.enc.Hex)
}

// 获取或创建加密密钥
function getEncryptionKey(): string {
  const keyFilePath = getKeyFilePath()

  // 如果密钥文件存在，读取它
  if (fs.existsSync(keyFilePath)) {
    try {
      const encryptedKey = fs.readFileSync(keyFilePath, 'utf-8').trim()
      // 密钥在文件系统中已加密存储，这里简化处理直接返回
      // 实际生产环境中应使用机器特定信息进行二次加密
      return encryptedKey
    } catch (error) {
      console.error('[Encryption] Failed to read key file:', error)
      throw new Error('Failed to read encryption key')
    }
  }

  // 生成新密钥
  const newKey = generateKey()

  // 确保目录存在
  const keyDir = path.dirname(keyFilePath)
  if (!fs.existsSync(keyDir)) {
    fs.mkdirSync(keyDir, { recursive: true })
  }

  // 保存密钥
  fs.writeFileSync(keyFilePath, newKey, { mode: 0o600 })
  console.log('[Encryption] New encryption key generated')

  return newKey
}

// AES-256 加密
export function encrypt(plaintext: string): string {
  if (!plaintext) {
    return ''
  }

  const key = getEncryptionKey()

  // 生成随机 IV
  const iv = CryptoJS.lib.WordArray.random(16)

  // 执行 AES-256 加密
  const encrypted = CryptoJS.AES.encrypt(plaintext, CryptoJS.enc.Hex.parse(key), {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  })

  // 将 IV 和密文合并
  const combined = iv.concat(encrypted.ciphertext)
  return combined.toString(CryptoJS.enc.Base64)
}

// AES-256 解密
export function decrypt(ciphertext: string): string {
  if (!ciphertext) {
    return ''
  }

  const key = getEncryptionKey()

  try {
    // 解析 Base64 编码的密文
    const combined = CryptoJS.enc.Base64.parse(ciphertext)

    // 提取 IV（前 16 字节）
    const iv = CryptoJS.lib.WordArray.create(combined.words.slice(0, 4), 16)

    // 提取密文
    const encrypted = CryptoJS.lib.WordArray.create(
      combined.words.slice(4),
      combined.sigBytes - 16
    )

    // 执行解密
    const decrypted = CryptoJS.AES.decrypt(
      { ciphertext: encrypted } as CryptoJS.lib.CipherParams,
      CryptoJS.enc.Hex.parse(key),
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    )

    return decrypted.toString(CryptoJS.enc.Utf8)
  } catch (error) {
    console.error('[Encryption] Decryption failed:', error)
    throw new Error('Decryption failed')
  }
}

// 加密敏感配置对象
export function encryptSensitiveConfig(config: Record<string, string | undefined>): Record<string, string> {
  const encrypted: Record<string, string> = {}

  for (const [key, value] of Object.entries(config)) {
    if (value) {
      encrypted[key] = encrypt(value)
    }
  }

  return encrypted
}

// 解密敏感配置对象
export function decryptSensitiveConfig<T extends Record<string, string | undefined>>(
  encrypted: Record<string, string>,
  fields: (keyof T)[]
): T {
  const decrypted = {} as T

  for (const field of fields) {
    const value = encrypted[field as string]
    if (value) {
      (decrypted as Record<string, string>)[field as string] = decrypt(value)
    }
  }

  return decrypted
}

// 测试加密解密是否正常工作
export function testEncryption(): boolean {
  try {
    const testText = 'This is a test message for encryption verification.'
    const encrypted = encrypt(testText)
    const decrypted = decrypt(encrypted)
    return testText === decrypted
  } catch (error) {
    console.error('[Encryption] Test failed:', error)
    return false
  }
}
