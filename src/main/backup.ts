import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import dayjs from 'dayjs'
import { getDb } from './db'
import { logger } from './logger'

export interface BackupInfo {
  name: string
  path: string
  createdAt: string
  size: number
}

function backupDir(): string {
  return path.join(app.getPath('userData'), 'backups')
}

export async function createDatabaseBackup(reason = 'manual'): Promise<BackupInfo> {
  const dir = backupDir()
  fs.ensureDirSync(dir)
  const name = `data-${dayjs().format('YYYYMMDD-HHmmss')}-${reason.replace(/[^a-z0-9_-]/gi, '') || 'backup'}.db`
  const target = path.join(dir, name)
  await getDb().backup(target)
  const stat = fs.statSync(target)
  logger.info('storage', 'backup_created', `数据库备份已创建: ${name}`, { reason, size: stat.size })
  pruneBackups(14)
  return { name, path: target, createdAt: stat.birthtime.toISOString(), size: stat.size }
}

export function listDatabaseBackups(): BackupInfo[] {
  const dir = backupDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(name => /^data-.*\.db$/.test(name))
    .map(name => {
      const filePath = path.join(dir, name)
      const stat = fs.statSync(filePath)
      return { name, path: filePath, createdAt: stat.birthtime.toISOString(), size: stat.size }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function pruneBackups(keep = 14): void {
  for (const item of listDatabaseBackups().slice(Math.max(1, keep))) {
    fs.removeSync(item.path)
  }
}

export async function restoreDatabaseBackup(name: string): Promise<void> {
  const backup = listDatabaseBackups().find(item => item.name === name)
  if (!backup) throw new Error('备份不存在或不属于本应用')
  const restoreSource = path.join(app.getPath('userData'), 'restore-source.db')
  fs.copyFileSync(backup.path, restoreSource)
  await createDatabaseBackup('before-restore')
  const dbPath = path.join(app.getPath('userData'), 'data.db')
  const db = getDb()
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
  fs.copyFileSync(restoreSource, dbPath)
  fs.removeSync(restoreSource)
  fs.removeSync(`${dbPath}-wal`)
  fs.removeSync(`${dbPath}-shm`)
}
