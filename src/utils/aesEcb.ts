import { createCipheriv, createDecipheriv } from 'crypto'

/**
 * 与前端 `src/utils/common.ts` 完全一致的 AES-128-ECB + PKCS7 方案。
 *
 * 前端约定：`const KEY = 'hite4329dsadfg56'`，加密结果输出 16 进制字符串。
 * 登录接口的 password 字段必须是这个密文，所以这里必须逐字节对齐。
 */
const KEY = 'hite4329dsadfg56'
const ALGO = 'aes-128-ecb'

export function encryptEcb(plain: string): string {
  const cipher = createCipheriv(ALGO, Buffer.from(KEY, 'utf8'), null)
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex')
}

export function decryptEcb(hex: string): string {
  const decipher = createDecipheriv(ALGO, Buffer.from(KEY, 'utf8'), null)
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8')
}

/** 约定：以 `enc:` 开头的值视为密文，其余按明文处理 */
export const isEncrypted = (value: string) => value.startsWith('enc:')

export function encryptField(value: string): string {
  return isEncrypted(value) ? value.slice(4) : encryptEcb(value)
}

export function decryptField(value: string): string {
  return isEncrypted(value) ? decryptEcb(value.slice(4)) : value
}
