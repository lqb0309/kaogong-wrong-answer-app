import { safeStorage } from './desktop-adapter'
// A migration database is independent: never misread Electron ciphertext as
// plaintext, and never silently downgrade credential storage to base64.
export function encryptToken(token: string): string {
  if (!token) return ''
  if (!safeStorage.isEncryptionAvailable()) throw Error('系统密钥不可用，未保存凭据')
  return safeStorage.encryptString(token).toString('base64')
}
export function decryptToken(encrypted: string): string {
  if (!encrypted) return ''
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}
