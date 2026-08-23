import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { initDatabase, getDb } from './db'
import { logger } from './logger'
import { readConfig } from './config'
import { flushVaultQueue } from './retry-queue'
import { registerIpcHandlers, runAutoInductForRecentDays } from './ipc-handlers'
import { ensureTodayPlan } from './daily-plan'
import { localDateKey } from './date-utils'
import { createDatabaseBackup } from './backup'

let mainWindow: BrowserWindow | null = null

// 主进程全局异常上报（PRD 埋点：未捕获异常 / 应用级崩溃）
process.on('uncaughtException', (err) => {
  try {
    logger.error('system', 'main_uncaught', err?.message || String(err), { stack: err?.stack?.slice(0, 800) })
  } catch { /* logger 自身故障时不再处理 */ }
})
process.on('unhandledRejection', (reason) => {
  try {
    logger.error('system', 'main_unhandled_rejection', String(reason), { type: typeof reason })
  } catch { /* ignore */ }
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '小乖的考公错题屋',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const isDev = !app.isPackaged
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initDatabase()
  // Record login day
  const today = localDateKey()
  getDb().prepare('INSERT OR IGNORE INTO login_days (date) VALUES (?)').run(today)
  logger.info('system', 'app_start', '小乖的考公错题屋启动', { version: app.getVersion() })
  registerIpcHandlers()
  createWindow()

  // Keep a small rolling set of recoverable snapshots. Failure must never block startup.
  createDatabaseBackup('startup').catch(err => logger.warn('storage', 'backup_failed', err?.message || String(err)))

  // 启动时按配置清理过期日志（PRD：日志保留天数）
  try {
    const retention = Number(readConfig('log_retention') || 30)
    if (retention > 0) logger.cleanupOldLogs(retention)
  } catch { /* ignore */ }

  // Obsidian 离线重试队列：启动即刷新 + 每 60 秒自动重试
  flushVaultQueue()
  setInterval(() => {
    if (flushVaultQueue().flushed > 0) {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        if (!win.isDestroyed()) win.webContents.send('retry:flushed', { ts: Date.now() })
      }
    }
  }, 60_000)

  // Auto-induct: scan recent 7 days for any un-inducted dates
  setTimeout(async () => {
    const results = await runAutoInductForRecentDays()
    for (const result of results) {
      if (result.inducted && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('knowledge:autoInductComplete', { date: result.date!, success: true })
      }
    }
  }, 3000)

  // 预生成今日计划：昨天未完成时调用 AI 调整，让用户一打开页面就有现成的计划
  setTimeout(() => {
    ensureTodayPlan().catch(err => logger.error('daily_plan', 'startup_generate_failed', err?.message || String(err)))
  }, 500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  try {
    if (getDb()?.open) logger.info('system', 'app_quit', '应用关闭', { uptime: process.uptime() })
  } catch { /* restore flow may already have closed the database */ }
})
