import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import fs from 'fs-extra'
import { getDb } from './db'

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'
type LogModule = 'upload' | 'ai' | 'confirm' | 'obsidian' | 'tag' | 'system'
  | 'image' | 'vault' | 'storage' | 'pdf_gen' | 'knowledge' | 'auto_induct' | 'test' | 'retry'

interface LogEntry {
  timestamp: string
  level: LogLevel
  module: LogModule
  event: string
  message: string
  detail?: string | object | null
  trace_id?: string | null
  resolved?: number
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
}

class Logger {
  private logDir: string
  private notifyEnabled = true
  private levelThreshold: LogLevel = 'WARN'
  private configLoaded = false

  constructor() {
    this.logDir = join(app.getPath('userData'), 'logs')
    fs.ensureDirSync(this.logDir)
  }

  private ensureConfig(): void {
    if (this.configLoaded) return
    this.configLoaded = true
    try {
      const db = getDb()
      if (!db) return
      const rows = db.prepare("SELECT key, value FROM config WHERE key IN ('error_notify', 'log_level', 'log_retention')").all() as { key: string; value: string }[]
      for (const row of rows) {
        if (row.key === 'error_notify') {
          this.notifyEnabled = row.value === 'true'
        } else if (row.key === 'log_level') {
          if ((['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as string[]).includes(row.value)) {
            this.levelThreshold = row.value as LogLevel
          }
        }
      }
    } catch {
      // DB not initialized yet, use defaults
    }
  }

  log(level: LogLevel, module: LogModule, event: string, message: string, detail: string | object | null = null, traceId: string | null = null): void {
    this.ensureConfig()
    // 日志级别过滤（低于阈值不记录，PRD：仅记录该级别及以上）
    if (!this.shouldLog(level, this.levelThreshold)) return
    const timestamp = new Date().toISOString()
    const detailStr = detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null
    const row: LogEntry = { timestamp, level, module, event, message, detail: detailStr, trace_id: traceId }

    try {
      // SQLite
      const db = getDb()
      if (!db) return
      db.prepare(`
        INSERT INTO error_logs (timestamp, level, module, event, message, detail, trace_id)
        VALUES (@timestamp, @level, @module, @event, @message, @detail, @trace_id)
      `).run(row)

      // File
      const today = new Date().toISOString().slice(0, 10)
      const logFile = join(this.logDir, `app-${today}.log`)
      const line = `[${timestamp}] [${level.padEnd(5)}] [${module}] ${event}: ${message}`
        + (detailStr ? ` | detail: ${detailStr}` : '') + '\n'
      fs.appendFileSync(logFile, line, 'utf-8')

      // Roll old files (keep 7 days)
      this.rotateFiles()

      // Notify renderer for ERROR/FATAL
      if ((level === 'ERROR' || level === 'FATAL') && this.notifyEnabled) {
        this._notifyRenderer(row)
      }
    } catch {
      // Logging itself should never crash the app
    }
  }

  debug(module: LogModule, event: string, message: string, detail?: string | object | null, traceId?: string | null): void {
    this.log('DEBUG', module, event, message, detail, traceId)
  }
  info(module: LogModule, event: string, message: string, detail?: string | object | null, traceId?: string | null): void {
    this.log('INFO', module, event, message, detail, traceId)
  }
  warn(module: LogModule, event: string, message: string, detail?: string | object | null, traceId?: string | null): void {
    this.log('WARN', module, event, message, detail, traceId)
  }
  error(module: LogModule, event: string, message: string, detail?: string | object | null, traceId?: string | null): void {
    this.log('ERROR', module, event, message, detail, traceId)
  }
  fatal(module: LogModule, event: string, message: string, detail?: string | object | null, traceId?: string | null): void {
    this.log('FATAL', module, event, message, detail, traceId)
  }

  shouldLog(currentLevel: LogLevel, threshold?: LogLevel): boolean {
    if (!threshold) return true
    return LEVEL_ORDER[currentLevel] >= LEVEL_ORDER[threshold]
  }

  private _notifyRenderer(row: LogEntry): void {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('log:error', row)
    })
  }

  private rotateFiles(): void {
    try {
      const files = fs.readdirSync(this.logDir).filter(f => f.startsWith('app-') && f.endsWith('.log')).sort()
      if (files.length > 7) {
        files.slice(0, files.length - 7).forEach(f => {
          fs.removeSync(join(this.logDir, f))
        })
      }
    } catch {
      // ignore rotation errors
    }
  }

  cleanupOldLogs(retentionDays: number): void {
    const db = getDb()
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString()
    db.prepare('DELETE FROM error_logs WHERE timestamp < ?').run(cutoff)
  }
}

export const logger = new Logger()
