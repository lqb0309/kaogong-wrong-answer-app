import { getDb } from './db'

export function readConfig(key: string): string | undefined {
  const db = getDb()
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function writeConfig(key: string, value: string): void {
  const db = getDb()
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value)
}

export function getAllConfig(): Record<string, string> {
  const db = getDb()
  const rows = db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[]
  const result: Record<string, string> = {}
  for (const row of rows) {
    result[row.key] = row.value
  }
  return result
}
