import { safeStorage } from 'electron'

export function encryptToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(token).toString('base64')
  }
  // Fallback: plain base64 (no encryption, just not plaintext)
  return Buffer.from(token).toString('base64')
}

export function decryptToken(encrypted: string): string {
  if (!encrypted) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    }
    return Buffer.from(encrypted, 'base64').toString('utf-8')
  } catch {
    // Not encrypted — return as plaintext (backward compatibility)
    return encrypted
  }
}
