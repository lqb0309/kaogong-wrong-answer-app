import readline from 'node:readline'
import path from 'node:path'
import { handlers, send, setSecret, nativeResult, windowEvent, mainWindow, refreshClipboard, importBrowserImages, shutdown } from './desktop-adapter'
const profile = process.env.STUDY_TAURI_DATA
if (!profile || !path.isAbsolute(profile)) throw Error('缺少独立数据目录')
// stdout is a private framed protocol, never a logging stream.
console.log = console.info = (..._args: unknown[]) => {}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let initialized: Promise<void> | undefined
async function init(secret: string) {
  setSecret(secret)
  const { initDatabase, getDb } = await import('../../src/main/db')
  initDatabase()
  const { readConfig, writeConfig } = await import('../../src/main/config')
  if (!readConfig('local_data_dir')) writeConfig('local_data_dir', path.join(profile!, 'local'))
  const { registerIpcHandlers, runAutoInductForRecentDays } = await import('../../src/main/ipc-handlers')
  registerIpcHandlers(); handlers.set('desktop:uploadBrowserImages', (_e: unknown, items: any) => importBrowserImages(items))
  const { localDateKey } = await import('../../src/main/date-utils')
  getDb().prepare('INSERT OR IGNORE INTO login_days(date) VALUES (?)').run(localDateKey())
  if (!process.env.STUDY_TAURI_TEST) {
    const { startFenbiAnalysisQueue } = await import('../../src/main/fenbi-import'); startFenbiAnalysisQueue()
    const { flushVaultQueue } = await import('../../src/main/retry-queue'); flushVaultQueue(); setInterval(flushVaultQueue, 60000).unref()
    const { createDatabaseBackup } = await import('../../src/main/backup'); void createDatabaseBackup('startup').catch(() => {})
    const { refreshStudyCalendar } = await import('../../src/main/study-calendar'); void refreshStudyCalendar().catch(() => {})
    const { logger } = await import('../../src/main/logger')
    const retention = Number(readConfig('log_retention') || 30); if (retention > 0) logger.cleanupOldLogs(retention)
    const { ensureTodayPlan } = await import('../../src/main/daily-plan'); void ensureTodayPlan().catch(() => {})
    setTimeout(() => { void runAutoInductForRecentDays().then(results => { for (const result of results) if (result.inducted) mainWindow.webContents.send('knowledge:autoInductComplete', {date:result.date,success:true}) }).catch(() => {}) }, 3000).unref()
  }
  send({ kind: 'ready', channels: [...handlers.keys()] })
}
lines.on('line', line => {
  if (line.length > 120_000_000) { process.exitCode = 1; lines.close(); return }
  let message: any
  try { message = JSON.parse(line) } catch { return }
  if (message.kind === 'init') { initialized ||= init(message.secret).catch(error => { send({ kind: 'fatal', error: String(error.message) }); process.exitCode = 1; lines.close() }); return }
  if (message.kind === 'native-result') { nativeResult(message); return }
  if (message.kind === 'window') { windowEvent(message); return }
  if (message.kind === 'call') void (async () => {
    try {
      await initialized
      const handler = handlers.get(message.channel)
      if (!handler) throw Error('未知接口')
      if (message.channel === 'clipboard:pasteImage') await refreshClipboard()
      const result = await handler({ sender: mainWindow.webContents }, ...(message.args || []))
      send({ kind: 'result', id: message.id, result: result ?? null })
    } catch (error: any) { send({ kind: 'result', id: message.id, error: error.message || '操作失败' }) }
  })()
})
lines.on('close', async () => { shutdown(); try { (await import('../../src/main/db')).getDb()?.close() } catch {}; process.exit(process.exitCode || 0) })
