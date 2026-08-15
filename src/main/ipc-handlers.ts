import { ipcMain, shell, dialog, BrowserWindow, app } from 'electron'
import { getDb } from './db'
import { logger } from './logger'
import { readConfig, writeConfig, getAllConfig } from './config'
import { encryptToken, decryptToken } from './safe-storage'
import { classifyImage, getAiSuggestion, generateReflection, generateDailyInduction } from './ai'
import { writeToVault, vaultOnline, reorganizeVault } from './obsidian'
import { storeImage, saveMarkdown, buildMarkdown, getLocalDataDir } from './storage'
import { generateTraceId } from './utils'
import { scanExistingCards, writeInductionResults, readCardContent, scanDailyNotes, readDailyNote, bumpCardError, findQuestionsForCard, findCardPathsForQuestion, parseCategoryFromPath, getReviewQueueCards } from './knowledge-cards'
import { fetchQuestionsForTest, generatePdf } from './pdf-generator'
import { queueSize, flushVaultQueue } from './retry-queue'
import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'

export function registerIpcHandlers(): void {
  // ============ Config ============
  ipcMain.handle('config:get', (_e, key: string, decrypt: boolean) => {
    const value = readConfig(key)
    if (!value) return undefined
    if (decrypt) return decryptToken(value)
    return value
  })
  ipcMain.handle('config:getAll', () => {
    const all = getAllConfig()
    const tokenKeys = ['easyimage_token', 'obsidian_token', 'vision_api_key', 'ai_api_key']
    for (const key of tokenKeys) {
      if (all[key]) all[key] = decryptToken(all[key])
    }
    return all
  })
  ipcMain.handle('config:set', (_e, key: string, value: string) => {
    const encryptKeys = ['api_key', 'token', 'easyimage_token', 'obsidian_token', 'vision_api_key', 'ai_api_key']
    const shouldEncrypt = encryptKeys.some((k) => key === k || key.endsWith(`_${k}`))
    const storedValue = (shouldEncrypt && value) ? encryptToken(value) : value
    writeConfig(key, storedValue)
    logger.info('system', 'config_updated', `配置已更新: ${key}`)
  })

  // Shell / Dialog / File
  ipcMain.handle('app:version', () => app.getVersion())

  // 渲染进程异常上报（PRD 埋点：未捕获异常）
  ipcMain.handle('log:rendererError', (_e, errorText: string) => {
    logger.error('system', 'renderer_uncaught', errorText?.slice(0, 2000) || '渲染进程未知异常')
  })

  // 网络连通性变化（PRD 埋点：在线 → 离线 / 离线 → 在线）
  ipcMain.handle('log:network', (_e, status: string) => {
    logger.warn('system', 'network_change', status === 'online' ? '网络已恢复' : '网络已断开', { status })
  })

  ipcMain.handle('shell:openPath', (_e, path: string) => {
    // Use openExternal for URIs (http, https, obsidian://, etc.), openPath for files
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      return shell.openExternal(path)
    }
    return shell.openPath(path)
  })
  ipcMain.handle('dialog:selectDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:selectFile', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:selectFiles', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string, content: string) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, content, 'utf-8')
    return result.filePath
  })
  ipcMain.handle('file:read', async (_e, filePath: string) => fs.readFileSync(filePath, 'utf-8'))
  // Crop and save graphic image locally (bypass EasyImage for reliability)
  ipcMain.handle('image:cropAndSave', async (_e, params: {
    imageUrl: string
    crop: { x: number; y: number; width: number; height: number } | null
    rotation: number
  }) => {
    try {
      // 1. Download the original image
      const resp = await fetch(params.imageUrl, { signal: AbortSignal.timeout(15000) })
      if (!resp.ok) return { success: false, error: `下载失败 HTTP ${resp.status}` }
      const imgBuf = Buffer.from(await resp.arrayBuffer())

      // 2. Apply crop/rotation with sharp
      const sharp = require('sharp')
      const metadata = await sharp(imgBuf).metadata()
      const imgW = metadata.width || 0
      const imgH = metadata.height || 0

      let pipeline = sharp(imgBuf)

      if (params.rotation && params.rotation !== 0) {
        pipeline = pipeline.rotate(params.rotation)
      }
      if (params.crop && params.crop.width > 0 && params.crop.height > 0) {
        // Clamp crop to image bounds
        const left = Math.max(0, Math.round(params.crop.x))
        const top = Math.max(0, Math.round(params.crop.y))
        const width = Math.min(Math.round(params.crop.width), imgW - left)
        const height = Math.min(Math.round(params.crop.height), imgH - top)
        logger.info('image', 'crop_apply', `裁剪: ${left},${top} ${width}×${height} (原图 ${imgW}×${imgH})`)
        pipeline = pipeline.extract({ left, top, width, height })
      } else {
        logger.info('image', 'crop_skip', `未裁剪，保存原图 (${imgW}×${imgH})`)
      }

      // 3. Save to local images directory（使用设置中配置的本地数据目录）
      const imagesDir = path.join(getLocalDataDir(), 'images')
      fs.ensureDirSync(imagesDir)
      const destName = `graphic-${Date.now()}-${Math.random().toString(36).slice(2,6)}.png`
      const destPath = path.join(imagesDir, destName)
      await pipeline.png().toFile(destPath)

      logger.info('image', 'crop_saved', `图形区域已保存: ${destPath}`)
      return { success: true, filePath: destPath }
    } catch (err: any) {
      logger.error('image', 'crop_failed', err.message)
      return { success: false, error: err.message }
    }
  })

  // Download remote image as data URL (main process, no CORS)
  ipcMain.handle('image:download', async (_e, url: string) => {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` }
      const buf = Buffer.from(await resp.arrayBuffer())
      const contentType = resp.headers.get('content-type') || 'image/png'
      return { success: true, dataUrl: `data:${contentType};base64,${buf.toString('base64')}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('file:readImage', async (_e, filePath: string) => {
    // Handle data URLs directly (for remote images fetched in renderer)
    if (filePath.startsWith('data:')) return filePath
    // Strip file:// prefix
    const cleanPath = filePath.startsWith('file://') ? filePath.slice(7) : filePath
    const buf = fs.readFileSync(cleanPath)
    const ext = cleanPath.split('.').pop()?.toLowerCase() || 'jpg'
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  // EasyImage test
  ipcMain.handle('easyimage:test', async (_e, baseURL: string, token: string) => {
    try {
      const url = `${baseURL.replace(/\/+$/, '')}/api/index.php`
      const formData = new FormData()
      formData.append('token', token)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      const res = await fetch(url, { method: 'POST', body: formData, signal: controller.signal })
      clearTimeout(timeout)
      const text = await res.text()
      try {
        const data = JSON.parse(text)
        if (data.result === 'success' || data.url || data.status === 'ok') return { success: true, message: 'EasyImage 连接正常' }
        return { success: true, message: `服务器可达 (${res.status})`, detail: text.slice(0, 200) }
      } catch { return { success: true, message: `服务器可达 (${res.status})`, detail: text.slice(0, 100) } }
    } catch (err: any) {
      if (err.name === 'AbortError') return { success: false, error: '连接超时，请检查地址和网络' }
      return { success: false, error: `无法连接: ${err.message?.slice(0, 100)}` }
    }
  })

  // Upload
  ipcMain.handle('upload:images', async (e, files: string[] | { path: string; rotation?: number; crop?: { x: number; y: number; width: number; height: number } }[]) => {
    const results: any[] = []
    const win = BrowserWindow.fromWebContents(e.sender)
    const total = files.length
    const concurrency = Math.min(8, Math.max(1, Number(readConfig('upload_concurrency') || 5)))
    let done = 0

    const emitProgress = (fileName: string, success: boolean, error?: string) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('upload:progress', { done, total, fileName, success, error, ts: Date.now() })
      }
    }

    // Pre-normalize file descriptors
    const rawFiles: (string | { path: string; rotation?: number; crop?: { x: number; y: number; width: number; height: number } })[] = Array.isArray(files) ? files : []
    const items = rawFiles.map(item => {
      const fp = typeof item === 'string' ? item : item.path
      const rotation = typeof item === 'string' ? 0 : (item.rotation || 0)
      const rawCrop = typeof item === 'string' ? null : (item.crop || null)
      const crop = rawCrop ? { x: Math.round(rawCrop.x), y: Math.round(rawCrop.y), width: Math.round(rawCrop.width), height: Math.round(rawCrop.height) } : null
      return { fp, rotation, crop }
    })

    const processOne = async (item: { fp: string; rotation: number; crop: { x: number; y: number; width: number; height: number } | null }, idx: number) => {
      const { fp, rotation, crop } = item
      const ext = fp.toLowerCase().split('.').pop()
      if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext || '')) {
        results[idx] = { success: false, filePath: fp, error: '格式不支持' }
        done++
        emitProgress(fp, false, '格式不支持')
        return
      }
      const stat = fs.statSync(fp)
      if (stat.size > 20 * 1024 * 1024) {
        results[idx] = { success: false, filePath: fp, error: '文件超过 20MB 限制' }
        done++
        emitProgress(fp, false, '文件超过 20MB 限制')
        return
      }
      const traceId = generateTraceId()
      logger.info('upload', 'upload_start', `开始存储图片: ${fp}`, { size: stat.size, rotation }, traceId)
      try {
        // 重复导入检测：对已导入但未确认的图片按内容 md5 去重
        let fileHash: string | undefined
        try {
          const fd = fs.openSync(fp, 'r')
          const chunk = Buffer.alloc(256 * 1024)
          const read = fs.readSync(fd, chunk, 0, chunk.length, 0)
          fs.closeSync(fd)
          fileHash = crypto.createHash('md5').update(chunk.subarray(0, read)).digest('hex')
          const dup = getDb().prepare("SELECT id FROM questions WHERE file_hash = ? AND status IN ('pending', 'classified') LIMIT 1").get(fileHash) as { id: string } | undefined
          if (dup) {
            results[idx] = { success: false, filePath: fp, error: '重复导入（该图片已在成品库）', duplicate: true, traceId }
            done++
            emitProgress(fp, false, '重复图片')
            return
          }
        } catch { fileHash = undefined }

        let sourcePath = fp
        const needsPreprocess = (crop && crop.width > 0 && crop.height > 0) || (rotation && rotation !== 0)
        if (needsPreprocess) {
          const sharp = require('sharp')
          const tmpDir = require('os').tmpdir()
          const tmpPath = path.join(tmpDir, `preprocess-${Date.now()}-${Math.random().toString(36).slice(2, 4)}.${ext}`)
          let pipeline = sharp(fp)
          if (rotation && rotation !== 0) {
            pipeline = pipeline.rotate(rotation)
            logger.info('upload', 'image_rotated', `图片已旋转 ${rotation}°`, null, traceId)
          }
          if (crop && crop.width > 0 && crop.height > 0) {
            pipeline = pipeline.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
            logger.info('upload', 'image_cropped', `图片已裁剪`, null, traceId)
          }
          await pipeline.toFile(tmpPath)
          sourcePath = tmpPath
        }
        const { imageUrl, localAbsPath, localRelPath, fileHash: hash } = await storeImage(sourcePath, traceId, fileHash)
        results[idx] = { success: true, filePath: fp, url: imageUrl, localAbsPath, localRelPath, traceId, fileHash: hash }
      } catch (err: any) {
        results[idx] = { success: false, filePath: fp, error: err.message, traceId }
      }
      done++
      emitProgress(fp, !!results[idx]?.success)
    }

    // Concurrent workers with progress events (PRD: 批量上传支持并行处理)
    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, async () => {
      while (cursor < total) {
        const idx = cursor++
        await processOne(items[idx], idx)
      }
    })
    await Promise.all(workers)
    return results
  })

  // AI
  ipcMain.handle('ai:classify', async (e, imageUrl: string, traceId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const onProgress = (stage: string, message: string) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId, stage, message, ts: Date.now() })
    }
    try {
      const result = await classifyImage(imageUrl, traceId, onProgress)
      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId, stage: 'done', message: '分类完成', ts: Date.now() })
      return { success: true, ...result }
    } catch (err: any) {
      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId, stage: 'error', message: err.message, ts: Date.now() })
      return { success: false, error: err.message }
    }
  })
  ipcMain.handle('ai:test', async (_e, baseURL: string, apiKey: string, model: string) => {
    try {
      const OpenAI = require('openai')
      const client = new OpenAI({ apiKey, baseURL, maxRetries: 1, timeout: 15000 })
      const start = Date.now()
      const resp = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 })
      const latency = Date.now() - start
      return { success: true, latency, modelUsed: resp.model || model, preview: resp.choices?.[0]?.message?.content?.slice(0, 100) || '' }
    } catch (err: any) {
      let error = err.message || 'Unknown error'
      if (err.status === 401 || err.status === 403) error = '认证失败，请检查 API Key'
      else if (err.status === 404) error = '模型不存在或 Base URL 错误'
      else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') error = '无法连接，请检查 Base URL 和网络'
      return { success: false, error }
    }
  })
  ipcMain.handle('ai:models', async (_e, baseURL: string, apiKey: string) => {
    try {
      const OpenAI = require('openai')
      const urlsToTry = [baseURL]
      const cleanURL = baseURL.replace(/\/+$/, '')
      if (!cleanURL.endsWith('/v1')) urlsToTry.push(`${cleanURL}/v1`)
      for (const url of urlsToTry) {
        try {
          const client = new OpenAI({ apiKey: apiKey || 'no-key', baseURL: url, maxRetries: 1, timeout: 8000 })
          const list = await client.models.list()
          const models = list.data.map((m: any) => m.id).filter((id: string) => {
            const lower = id.toLowerCase()
            return !lower.includes('embedding') && !lower.includes('moderation') && !lower.includes('dall-e') && !lower.includes('tts') && !lower.includes('whisper') && !lower.includes('audio') && !lower.startsWith('text-') && !lower.startsWith('code-')
          }).sort()
          if (models.length > 0) return { success: true, models }
        } catch { }
      }
      return { success: false, error: '该服务商不支持 /models 端点' }
    } catch { return { success: false, error: 'API 调用失败' } }
  })
  ipcMain.handle('ai:suggest', async (_e, statsData: any) => {
    try {
      const suggestion = await getAiSuggestion(statsData)
      return { success: true, suggestion }
    } catch (err: any) { return { success: false, error: err.message } }
  })
  ipcMain.handle('ai:reflect', async (e, params: { level1: string; level2?: string; level3?: string | null; ocrText: string; traceId?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const onProgress = (stage: string, message: string) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId: params.traceId || 'reflect', stage, message, ts: Date.now() })
    }
    try {
      const reflection = await generateReflection(params, onProgress)
      return { success: true, reflection }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // Vault
  ipcMain.handle('app:streak', () => {
    const db = getDb()
    const days = db.prepare('SELECT date FROM login_days ORDER BY date DESC').all() as { date: string }[]
    if (days.length === 0) return { streak: 0, total: 0 }
    let streak = 0
    // 用本地日期计算，避免 DST 导致的跨天偏移
    const now = new Date()
    for (let i = 0; i < days.length; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (days.some(x => x.date === key)) streak++
      else break
    }
    return { streak, total: days.length }
  })

  // 首页聚合概览指标
  ipcMain.handle('app:overview', () => {
    const db = getDb()
    const count = (sql: string, ...args: any[]) => (db.prepare(sql).get(...args) as { c: number }).c
    const pendingCount = count("SELECT COUNT(*) as c FROM questions WHERE status = 'pending'")
    const classifiedCount = count("SELECT COUNT(*) as c FROM questions WHERE status = 'classified'")
    const confirmedCount = count("SELECT COUNT(*) as c FROM questions WHERE status = 'confirmed'")
    const today = new Date().toISOString().slice(0, 10)
    const todayCount = count("SELECT COUNT(*) as c FROM questions WHERE status = 'confirmed' AND date(confirmed_at) = ?", today)
    const days = db.prepare('SELECT date FROM login_days ORDER BY date DESC').all() as { date: string }[]
    let streak = 0
    const now = new Date()
    for (let i = 0; i < days.length; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (days.some(x => x.date === key)) streak++
      else break
    }
    return { pendingCount, classifiedCount, confirmedCount, todayCount, streak, retryQueueSize: queueSize() }
  })

  // 手动触发重试队列刷新
  ipcMain.handle('retry:flush', () => flushVaultQueue())

  ipcMain.handle('obsidian:sync', async () => {
    const vaultRoot = readConfig('obsidian_vault') || ''
    if (!vaultRoot) return { deleted: 0, message: '未配置 Obsidian Vault' }
    const db = getDb()
    const questions = db.prepare("SELECT id, obsidian_path FROM questions WHERE obsidian_path IS NOT NULL AND obsidian_path != ''").all() as any[]
    let deleted = 0
    for (const q of questions) {
      const fullPath = `${vaultRoot}/${q.obsidian_path}`
      if (!fs.existsSync(fullPath)) {
        db.prepare('DELETE FROM questions WHERE id = ?').run(q.id)
        deleted++
      }
    }
    return { deleted, message: `校验完成：清理 ${deleted} 条孤儿记录` }
  })
  ipcMain.handle('obsidian:write', async (_e, questionData: any) => saveMarkdown(questionData))
  ipcMain.handle('obsidian:check', async () => vaultOnline())
  ipcMain.handle('obsidian:reorganize', async () => reorganizeVault())

  // Questions
  ipcMain.handle('questions:list', (_e, params: any) => {
    const db = getDb()
    const { page = 1, pageSize = 20, level1, level2, level3, search, status = 'confirmed', sortBy = 'created_at', sortOrder = 'desc' } = params || {}
    const conditions: string[] = []
    const values: any[] = []
    if (status && status !== 'all') { conditions.push('status = ?'); values.push(status) }
    if (level1) { conditions.push('level1 = ?'); values.push(level1) }
    if (level2) { conditions.push('level2 = ?'); values.push(level2) }
    if (level3) { conditions.push('level3 = ?'); values.push(level3) }
    if (search) { conditions.push('(ocr_text LIKE ? OR source LIKE ?)'); const s = `%${search}%`; values.push(s, s) }
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM questions${whereClause}`).get(...values) as { cnt: number }
    const total = countRow.cnt
    const offset = (page - 1) * pageSize
    const sortCol = ['created_at', 'confidence', 'error_count', 'level1'].includes(sortBy) ? sortBy : 'created_at'
    const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC'
    const items = db.prepare(`SELECT id, image_url, level1, level2, level3, confidence, ocr_text, reasoning, status, error_count, source, obsidian_path, local_image_path, reflection, error_type, group_id, has_graphics, graphic_image_path, match_type, ai_raw_level1, ai_raw_level2, ai_raw_level3, trace_id, created_at, confirmed_at FROM questions${whereClause} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...values, pageSize, offset)
    return { items, total }
  })
  ipcMain.handle('questions:get', (_e, id: string) => getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id) || null)
  ipcMain.handle('questions:delete', (_e, id: string) => {
    const db = getDb()
    const row = db.prepare('SELECT obsidian_path FROM questions WHERE id = ?').get(id) as { obsidian_path: string } | undefined
    if (row?.obsidian_path) {
      const vaultRoot = readConfig('obsidian_vault') || ''
      try { fs.removeSync(`${vaultRoot}/${row.obsidian_path}`) } catch { }
    }
    db.prepare('DELETE FROM questions WHERE id = ?').run(id)
    logger.info('confirm', 'question_deleted', `错题已删除: ${id}`)
  })
  ipcMain.handle('questions:updateStatus', (_e, id: string, status: string) => {
    getDb().prepare('UPDATE questions SET status = ? WHERE id = ?').run(status, id)
  })

  ipcMain.handle('questions:update', async (_e, id: string, updates: any) => {
    const db = getDb()
    const allowed = ['level1', 'level2', 'level3', 'error_count', 'error_type', 'source', 'ocr_text', 'reflection', 'has_graphics', 'graphic_image_path',
      'confidence', 'match_type', 'ai_raw_level1', 'ai_raw_level2', 'ai_raw_level3']
    const sets: string[] = []
    const values: any[] = []
    for (const field of allowed) {
      if (updates[field] !== undefined) {
        sets.push(`${field} = ?`)
        values.push(updates[field])
      }
    }
    if (sets.length === 0) return { success: false }
    values.push(id)
    db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...values)

    // 分类变更后迁移 vault 中的 .md 文件到新目录
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as any
    const vaultRoot = readConfig('obsidian_vault') || ''
    if (row?.obsidian_path && vaultRoot) {
      const level1 = row.level1 || '其他'
      const level2 = row.level2 || ''
      const level3 = row.level3 || ''
      const subdir = level3 ? `${level1}/${level2}/${level3}` : level2 ? `${level1}/${level2}` : level1
      const fileName = path.basename(row.obsidian_path)
      const newRelativePath = `${subdir}/${fileName}`

      if (newRelativePath !== row.obsidian_path) {
        const oldFullPath = path.join(vaultRoot, row.obsidian_path)
        const newFullPath = path.join(vaultRoot, newRelativePath)
        if (fs.existsSync(oldFullPath)) {
          try {
            const newDir = path.dirname(newFullPath)
            if (fs.existsSync(newDir) && !fs.statSync(newDir).isDirectory()) fs.removeSync(newDir)
            fs.ensureDirSync(newDir)
            fs.moveSync(oldFullPath, newFullPath, { overwrite: false })
            db.prepare('UPDATE questions SET obsidian_path = ? WHERE id = ?').run(newRelativePath, id)
            logger.info('vault', 'moved_on_edit', `编辑后迁移: ${row.obsidian_path} → ${newRelativePath}`)
          } catch (err: any) {
            logger.warn('vault', 'move_on_edit_failed', `编辑后迁移失败: ${err.message}`, { oldPath: row.obsidian_path })
          }
        }
      }

      // Regenerate vault markdown content
      const fullPath = path.join(vaultRoot, newRelativePath)
      if (fs.existsSync(fullPath)) {
        const md = buildMarkdown({ ...row, imageUrl: row.image_url, status: 'confirmed', errorCount: row.error_count })
        fs.writeFileSync(fullPath, md, 'utf-8')
      }
    }
    logger.info('confirm', 'question_updated', `错题已更新: ${id}`)
    return { success: true }
  })

  ipcMain.handle('questions:pendingCount', () => {
    const row = getDb().prepare("SELECT COUNT(*) as cnt FROM questions WHERE status IN ('pending', 'classified')").get() as { cnt: number }
    return row.cnt
  })
  ipcMain.handle('questions:stats', () => {
    const db = getDb()
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM questions').get() as { cnt: number }).cnt
    const byLevel1 = db.prepare('SELECT level1, COUNT(*) as cnt FROM questions GROUP BY level1 ORDER BY cnt DESC').all()
    const byLevel1WithPct = (byLevel1 as any[]).map((l: any) => ({ ...l, pct: total > 0 ? Math.round((l.cnt / total) * 100) : 0 }))
    const byLevel2 = db.prepare('SELECT level1, level2, COUNT(*) as cnt, AVG(error_count) as avg_err, SUM(error_count) as total_err FROM questions GROUP BY level1, level2 ORDER BY cnt DESC').all()
    const byLevel3 = db.prepare("SELECT level1, level2, level3, COUNT(*) as cnt, AVG(error_count) as avg_err, SUM(error_count) as total_err FROM questions WHERE level3 IS NOT NULL AND level3 != '' GROUP BY level1, level2, level3 ORDER BY cnt DESC LIMIT 80").all()
    const dailyStats = db.prepare('SELECT date(created_at) as day, COUNT(*) as cnt FROM questions GROUP BY day ORDER BY day ASC LIMIT 180').all()
    const weeklyStats = db.prepare("SELECT strftime('%Y-W%W', created_at) as week, COUNT(*) as cnt FROM questions GROUP BY week ORDER BY week DESC LIMIT 12").all()
    const monthlyStats = db.prepare("SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as cnt FROM questions GROUP BY month ORDER BY month DESC LIMIT 12").all()
    const topErrors = db.prepare('SELECT id, level1, level2, level3, error_count, image_url, obsidian_path, created_at FROM questions ORDER BY error_count DESC LIMIT 30').all()
    const recent7 = (db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE created_at >= date('now', '-7 days')").get() as { cnt: number }).cnt
    const prev7 = (db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE created_at >= date('now', '-14 days') AND created_at < date('now', '-7 days')").get() as { cnt: number }).cnt
    const recent30 = (db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE created_at >= date('now', '-30 days')").get() as { cnt: number }).cnt
    const prev30 = (db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE created_at >= date('now', '-60 days') AND created_at < date('now', '-30 days')").get() as { cnt: number }).cnt
    const errorDist = db.prepare("SELECT CASE WHEN error_count >= 3 THEN '3+' ELSE CAST(error_count AS TEXT) END as err_level, COUNT(*) as cnt FROM questions GROUP BY err_level ORDER BY err_level").all()
    const errorTypeDist = db.prepare("SELECT error_type, COUNT(*) as cnt FROM questions WHERE error_type IS NOT NULL AND error_type != '' GROUP BY error_type ORDER BY cnt DESC LIMIT 12").all()
    const confidenceDist = db.prepare('SELECT SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END) as low, SUM(CASE WHEN confidence >= 0.6 AND confidence < 0.8 THEN 1 ELSE 0 END) as mid, SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) as high FROM questions').get()
    const todayCount = (db.prepare("SELECT COUNT(*) as c FROM questions WHERE status = 'confirmed' AND date(confirmed_at) = date('now', 'localtime')").get() as { c: number }).c
    const firstRecord = db.prepare('SELECT MIN(created_at) as d FROM questions').get() as { d: string }
    const daysSinceFirst = total > 0 ? Math.max(1, (Date.now() - new Date(firstRecord?.d || new Date().toISOString()).getTime()) / (1000 * 86400)) : 1
    const dailyAvg = total > 0 ? Math.round(total / daysSinceFirst) : 0
    return { total, dailyAvg, todayCount, recent7, prev7, recent30, prev30, byLevel1: byLevel1WithPct, byLevel2, byLevel3, dailyStats, weeklyStats, monthlyStats, topErrors, errorDist, errorTypeDist, confidenceDist }
  })

  // Tags
  ipcMain.handle('tags:getTree', () => {
    const row = getDb().prepare('SELECT data FROM tag_tree ORDER BY id DESC LIMIT 1').get() as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  })
  ipcMain.handle('tags:saveTree', (_e, data: any) => {
    getDb().prepare('INSERT INTO tag_tree (data, updated_at) VALUES (?, ?)').run(JSON.stringify(data), new Date().toISOString())
    logger.info('tag', 'tree_updated', '分类树已更新')
  })
  ipcMain.handle('tags:getCustom', () => {
    try {
      const row = getDb().prepare("SELECT value FROM config WHERE key = 'custom_tags'").get() as { value: string } | undefined
      return row ? JSON.parse(row.value) : []
    } catch { return [] }
  })
  ipcMain.handle('tags:addCustom', (_e, tag: any) => {
    const db = getDb()
    const existing = db.prepare("SELECT value FROM config WHERE key = 'custom_tags'").get() as { value: string } | undefined
    const tags = existing ? JSON.parse(existing.value) : []
    tags.push({ ...tag, id: `custom-${Date.now()}`, createdAt: new Date().toISOString() })
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('custom_tags', ?)").run(JSON.stringify(tags))
  })

  // Clipboard paste
  ipcMain.handle('clipboard:pasteImage', async () => {
    const { clipboard, nativeImage } = require('electron')
    const img = clipboard.readImage()
    if (img.isEmpty()) return { success: false, error: '剪贴板中没有图片' }
    const pngBuffer = img.toPNG()
    const tmpDir = require('os').tmpdir()
    const tmpPath = require('path').join(tmpDir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
    fs.writeFileSync(tmpPath, pngBuffer)
    const traceId = generateTraceId()
    logger.info('upload', 'clipboard_paste', '从剪贴板粘贴图片', { size: pngBuffer.length }, traceId)
    try {
      const { imageUrl, localAbsPath, localRelPath } = await storeImage(tmpPath, traceId)
      // Clean up temp
      try { fs.removeSync(tmpPath) } catch { }
      return { success: true, url: imageUrl, localAbsPath, localRelPath, traceId }
    } catch (err: any) {
      try { fs.removeSync(tmpPath) } catch { }
      return { success: false, error: err.message }
    }
  })

  // Error types
  ipcMain.handle('errorTypes:getAll', () => {
    try {
      const row = getDb().prepare("SELECT value FROM config WHERE key = 'error_types'").get() as { value: string } | undefined
      if (row) return JSON.parse(row.value)
    } catch { }
    // Return defaults
    const defaults = ['粗心大意', '知识点未掌握', '凭语感做题，需调整']
    getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('error_types', ?)").run(JSON.stringify(defaults))
    return defaults
  })
  ipcMain.handle('errorTypes:save', (_e, types: string[]) => {
    getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('error_types', ?)").run(JSON.stringify(types))
    logger.info('tag', 'error_types_updated', '错误类型已更新')
  })

  // Logs
  ipcMain.handle('logs:list', (_e, params: any) => {
    const db = getDb()
    const { page = 1, pageSize = 50, level, module, resolved, search } = params || {}
    const conditions: string[] = []
    const values: any[] = []
    if (level) { conditions.push('level = ?'); values.push(level) }
    if (module) { conditions.push('module = ?'); values.push(module) }
    if (resolved !== undefined && resolved !== null) { conditions.push('resolved = ?'); values.push(resolved) }
    if (search) { conditions.push('(message LIKE ? OR detail LIKE ? OR event LIKE ?)'); const s = `%${search}%`; values.push(s, s, s) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM error_logs ${where}`).get(...values) as { cnt: number }
    const total = countRow.cnt
    const offset = (page - 1) * pageSize
    const items = db.prepare(`SELECT * FROM error_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...values, pageSize, offset)
    return { items, total }
  })
  ipcMain.handle('logs:resolve', (_e, id: number) => {
    getDb().prepare('UPDATE error_logs SET resolved = 1 WHERE id = ?').run(id)
  })
  ipcMain.handle('logs:trace', (_e, traceId: string) => {
    return getDb().prepare('SELECT * FROM error_logs WHERE trace_id = ? ORDER BY timestamp ASC').all(traceId)
  })
  ipcMain.handle('logs:clean', (_e, days: number) => {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
    const result = getDb().prepare('DELETE FROM error_logs WHERE timestamp < ?').run(cutoff)
    return { deleted: result.changes }
  })
  ipcMain.handle('logs:export', () => {
    const items = getDb().prepare("SELECT * FROM error_logs WHERE level IN ('ERROR', 'FATAL', 'WARN') ORDER BY id DESC LIMIT 1000").all() as any[]
    const lines = items.map((item: any) => `[${item.timestamp}] [${item.level}] [${item.module}] ${item.event}: ${item.message}` + (item.detail ? ` | detail: ${item.detail}` : ''))
    return lines.join('\n')
  })

  // ============ Knowledge Induction (PRD v0.2) ============

  ipcMain.handle('knowledge:overview', (_e, date?: string) => {
    const db = getDb()
    const targetDate = date || new Date().toISOString().slice(0, 10)

    // 1. Today's confirmed questions
    const todayQuestions = db.prepare(`
      SELECT id, level1, level2, level3, error_count, error_type,
             ocr_text, obsidian_path, confirmed_at, created_at, reflection
      FROM questions
      WHERE date(confirmed_at) = ? AND status = 'confirmed'
      ORDER BY created_at DESC
    `).all(targetDate) as any[]

    // 2. Knowledge point aggregation (all time)
    const knowledgePoints = db.prepare(`
      SELECT level1, level2, level3,
             COUNT(*) as question_count,
             SUM(error_count) as total_errors,
             MIN(date(confirmed_at)) as first_seen,
             MAX(date(confirmed_at)) as last_seen
      FROM questions
      WHERE status = 'confirmed'
      GROUP BY level1, level2, COALESCE(level3, '')
      ORDER BY total_errors DESC, last_seen DESC
    `).all() as any[]

    // 3. Stats
    const todayPointKeys = new Set(
      todayQuestions.map(q => `${q.level1}|${q.level2}|${q.level3 || ''}`)
    )

    const newPointsToday = knowledgePoints.filter(
      p => p.first_seen === targetDate
    ).length

    const highFreqPoints = knowledgePoints.filter(
      p => p.total_errors >= 3
    ).length

    // 4. Scan existing knowledge cards from vault
    let existingCardCount = 0
    try {
      existingCardCount = scanExistingCards().length
    } catch { /* vault may not be configured */ }

    // 5. Enrich todayQuestions with knowledge point history
    const enrichedQuestions = todayQuestions.map(q => {
      const key = `${q.level1}|${q.level2}|${q.level3 || ''}`
      const kp = knowledgePoints.find(
        p => `${p.level1}|${p.level2}|${p.level3 || ''}` === key
      )
      return {
        ...q,
        knowledge_total_errors: kp?.total_errors || q.error_count,
        knowledge_first_seen: kp?.first_seen || '',
        knowledge_question_count: kp?.question_count || 1,
        is_first_time: kp?.first_seen === targetDate && kp?.question_count === 1
      }
    })

    return {
      today: {
        questionCount: todayQuestions.length,
        knowledgePointCount: todayPointKeys.size,
        newPointsCount: newPointsToday,
        highFreqCount: highFreqPoints,
        existingCardCount
      },
      todayQuestions: enrichedQuestions,
      priorityList: knowledgePoints.slice(0, 50).map(p => ({
        level1: p.level1,
        level2: p.level2,
        level3: p.level3 || null,
        question_count: p.question_count,
        total_errors: p.total_errors,
        first_seen: p.first_seen,
        last_seen: p.last_seen,
        priority: p.total_errors >= 5 ? 'high'
                : p.total_errors >= 3 ? 'medium'
                : p.total_errors >= 2 ? 'low'
                : 'new'
      }))
    }
  })

  ipcMain.handle('knowledge:induct', async (e, date?: string) => {
    const db = getDb()
    const targetDate = date || new Date().toISOString().slice(0, 10)

    // Get target date's confirmed questions
    const todayQuestions = db.prepare(`
      SELECT id, level1, level2, level3, error_count, error_type,
             ocr_text, obsidian_path, confirmed_at, created_at, reflection
      FROM questions
      WHERE date(confirmed_at) = ? AND status = 'confirmed'
      ORDER BY created_at DESC
    `).all(targetDate) as any[]

    if (todayQuestions.length === 0) {
      return { success: false, error: `${targetDate === new Date().toISOString().slice(0, 10) ? '今天' : targetDate} 还没有已确认的错题。` }
    }

    // Scan existing knowledge cards from vault
    const existingCards = scanExistingCards().map(c => ({
      title: c.title,
      file_path: c.file_path,
      knowledge_type: c.knowledge_type,
      level1: c.level1,
      level2: c.level2,
      level3: c.level3
    }))

    const win = BrowserWindow.fromWebContents(e.sender)
    const onProgress = (stage: string, message: string, progress?: number, tokens?: number) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId: 'induct', stage, message, ts: Date.now(), progress, tokens })
    }

    try {
      const result = await generateDailyInduction(
        { todayQuestions, existingCards },
        onProgress
      )

      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId: 'induct', stage: 'done', message: '归纳完成', ts: Date.now() })

      return { success: true, ...result }
    } catch (err: any) {
      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId: 'induct', stage: 'error', message: err.message, ts: Date.now() })
      return { success: false, error: err.message }
    }
  })

  // Auto-induct: scan recent un-inducted days (or specific date)
  ipcMain.handle('knowledge:autoInduct', async (_e, date?: string) => {
    if (date) {
      return [await runAutoInduct(date)]
    }
    return runAutoInductForRecentDays()
  })

  ipcMain.handle('knowledge:writeToVault', async (_e, data: {
    daily_note_markdown: string
    date: string
    new_cards: any[]
    updated_cards: any[]
    moc_updates: any[]
  }) => {
    try {
      const result = writeInductionResults(
        data.daily_note_markdown,
        data.date,
        data.new_cards,
        data.updated_cards,
        data.moc_updates
      )
      return { success: true, ...result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Browse knowledge cards
  ipcMain.handle('knowledge:cards', () => {
    try {
      const cards = scanExistingCards()
      return { success: true, cards }
    } catch (err: any) {
      return { success: false, error: err.message, cards: [] }
    }
  })

  ipcMain.handle('knowledge:cardContent', (_e, filePath: string) => {
    return readCardContent(filePath)
  })

  // Daily notes
  ipcMain.handle('knowledge:dailyNotes', () => {
    try {
      const notes = scanDailyNotes()
      return { success: true, notes }
    } catch (err: any) {
      return { success: false, error: err.message, notes: [] }
    }
  })

  ipcMain.handle('knowledge:dailyNoteContent', (_e, date: string) => {
    return readDailyNote(date)
  })

  // 加权复习队列：错误次数×3 + 距上次复习天数 + 易错点加成，排除今日已复习（学习闭环核心）
  ipcMain.handle('knowledge:reviewQueue', (_e, count?: number) => {
    try {
      const { cards, reviewedToday } = getReviewQueueCards(count)
      return { success: true, cards, reviewedToday }
    } catch (err: any) {
      return { success: false, error: err.message, cards: [], reviewedToday: [] }
    }
  })

  // 复习反馈：记录 review_log；做错 → 卡片错误计数 +1
  ipcMain.handle('knowledge:reviewDone', (_e, cardPath: string, result: string) => {
    try {
      const db = getDb()
      const today = new Date().toISOString().slice(0, 10)
      db.prepare('INSERT INTO review_log (card_path, date, result, created_at) VALUES (?, ?, ?, ?)')
        .run(cardPath, today, result || 'done', new Date().toISOString())
      let cardBumped = false
      if (result === 'wrong') {
        const r = bumpCardError(cardPath)
        cardBumped = r.success
      }
      logger.info('knowledge', 'review_done', `复习完成: ${cardPath}`, { result, cardBumped })
      return { success: true, cardBumped }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // 卡片 ↔ 错题双向链：查看与卡片分类匹配的错题
  ipcMain.handle('knowledge:cardQuestions', (_e, cardPath: string) => {
    try {
      return { success: true, questions: findQuestionsForCard(cardPath) }
    } catch (err: any) {
      return { success: false, error: err.message, questions: [] }
    }
  })

  // ============ Test Builder (组卷导出) ============

  // 从复习队列选题（卡片分类 → 匹配错题，每卡最多 3 题）
  ipcMain.handle('test:selectFromReviewQueue', (_e, count?: number) => {
    try {
      const { cards: queueCards } = getReviewQueueCards(count)
      const db = getDb()

      const ids: string[] = []
      for (const card of queueCards) {
        const [l1, l2, l3] = parseCategoryFromPath(card.file_path)
        const rows = db.prepare(
          `SELECT id FROM questions
           WHERE status = 'confirmed' AND level1 = ?
             AND (? = '' OR level2 = ?)
             AND (? = '' OR COALESCE(level3, '') = ?)
           ORDER BY error_count DESC, created_at DESC LIMIT 3`
        ).all(l1, l2 || '', l2 || '', l3 || '', l3 || '') as { id: string }[]
        for (const r of rows) ids.push(r.id)
      }
      return { success: true, ids: Array.from(new Set(ids)), cards: queueCards }
    } catch (err: any) {
      return { success: false, error: err.message, ids: [] }
    }
  })

  // 对答案回填：做错的题错误计数 +1，并同步到匹配的知识卡片（闭环）
  ipcMain.handle('test:markAnswers', (_e, wrongIds: string[]) => {
    try {
      const db = getDb()
      const ids = Array.isArray(wrongIds) ? wrongIds : []
      let updated = 0
      let cardBumps = 0
      const bumpedCards = new Set<string>()
      for (const id of ids) {
        const row = db.prepare('SELECT id, level1, level2, level3, error_count FROM questions WHERE id = ?').get(id) as any
        if (!row) continue
        db.prepare('UPDATE questions SET error_count = error_count + 1 WHERE id = ?').run(id)
        updated++
        // 匹配知识卡片并同步错误计数
        const cardPaths = findCardPathsForQuestion(row)
        for (const p of cardPaths) {
          if (bumpedCards.has(p)) continue
          bumpedCards.add(p)
          const r = bumpCardError(p)
          if (r.success) cardBumps++
        }
      }
      logger.info('test', 'answers_marked', `对答案回填完成: ${updated} 道错题`, { cardBumps })
      return { success: true, updated, cardBumps }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('test:selectQuestions', (_e, params: {
    ids?: string[]
    level1?: string; level2?: string; level3?: string
    search?: string; limit?: number; random?: boolean
  }) => {
    try {
      const questions = fetchQuestionsForTest(params.ids || [], {
        level1: params.level1,
        level2: params.level2,
        level3: params.level3,
        search: params.search,
        limit: params.limit,
        random: params.random
      })
      return { success: true, questions }
    } catch (err: any) {
      return { success: false, error: err.message, questions: [] }
    }
  })

  ipcMain.handle('test:generatePdf', async (e, questionIds: string[], options: any) => {
    try {
      const senderWin = BrowserWindow.fromWebContents(e.sender)
      const onProgress = (stage: string, done?: number, total?: number) => {
        if (senderWin && !senderWin.isDestroyed()) senderWin.webContents.send('pdf:progress', { stage, done, total, ts: Date.now() })
      }
      const result = await generatePdf(questionIds, options, onProgress)
      if (!result.success || !result.filePath) return result

      // Open save dialog for the user to choose final location
      const win = BrowserWindow.getFocusedWindow()
      if (win && result.filePath) {
        const saveResult = await dialog.showSaveDialog(win, {
          defaultPath: `${options?.title || '错题练习卷'}.pdf`,
          filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
        })
        if (!saveResult.canceled && saveResult.filePath) {
          fs.copyFileSync(result.filePath, saveResult.filePath)
          // Clean up temp
          try { fs.removeSync(result.filePath) } catch { }
          return { ...result, filePath: saveResult.filePath }
        }
        // User cancelled - still return success so they can retry
        try { fs.removeSync(result.filePath) } catch { }
        return { ...result, filePath: null }
      }

      return result
    } catch (err: any) {
      return { success: false, error: err.message, imageErrors: [] }
    }
  })
}

// ============ Exported Auto-Induct Logic ============

export async function runAutoInduct(dateStr?: string): Promise<{ inducted: boolean; date?: string; reason?: string }> {
  const db = getDb()
  if (!dateStr) {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    dateStr = yesterday.toISOString().slice(0, 10)
  }

  // Check if date has confirmed questions
  const dayQuestions = db.prepare(`
    SELECT id FROM questions
    WHERE date(confirmed_at) = ? AND status = 'confirmed'
    LIMIT 1
  `).all(dateStr) as any[]

  if (dayQuestions.length === 0) {
    return { inducted: false, reason: `${dateStr} 无已确认错题` }
  }

  // Check if daily note already exists
  const existingNotes = scanDailyNotes()
  const hasNote = existingNotes.some(n => n.date === dateStr)
  if (hasNote) {
    return { inducted: false, reason: `${dateStr} 已有每日笔记` }
  }

  // Run induction
  const questions = db.prepare(`
    SELECT id, level1, level2, level3, error_count, error_type,
           ocr_text, obsidian_path, confirmed_at, created_at, reflection
    FROM questions
    WHERE date(confirmed_at) = ? AND status = 'confirmed'
    ORDER BY created_at DESC
  `).all(dateStr) as any[]

  if (questions.length === 0) {
    return { inducted: false, reason: `${dateStr} 无已确认错题` }
  }

  const existingCards = scanExistingCards().map(c => ({
    title: c.title,
    file_path: c.file_path,
    knowledge_type: c.knowledge_type,
    level1: c.level1,
    level2: c.level2,
    level3: c.level3
  }))

  try {
    logger.info('auto_induct', 'start', `开始自动归纳 ${dateStr} 的 ${questions.length} 道错题`)

    const result = await generateDailyInduction(
      { todayQuestions: questions, existingCards },
      (stage, message) => logger.info('auto_induct', stage, message)
    )

    // Auto-write to vault
    writeInductionResults(
      result.daily_note.full_markdown,
      result.daily_note.date,
      result.card_operations.new_cards,
      result.card_operations.updated_cards,
      result.card_operations.moc_updates
    )

    logger.info('auto_induct', 'done', `自动归纳完成: ${dateStr}, 新卡片 ${result.card_operations.new_cards.length}, 更新 ${result.card_operations.updated_cards.length}`)
    return { inducted: true, date: dateStr }
  } catch (err: any) {
    logger.error('auto_induct', 'failed', err.message)
    return { inducted: false, reason: err.message }
  }
}

/**
 * Scan the last 7 days for confirmed questions that haven't been inducted yet.
 * Runs induction for each un-inducted day, oldest first.
 */
export async function runAutoInductForRecentDays(): Promise<Array<{ inducted: boolean; date?: string; reason?: string }>> {
  const results: Array<{ inducted: boolean; date?: string; reason?: string }> = []
  const existingNotes = scanDailyNotes()
  const db = getDb()

  // Find dates in the last 7 days that have confirmed questions but no daily note
  const recentDates = db.prepare(`
    SELECT DISTINCT date(confirmed_at) as d
    FROM questions
    WHERE status = 'confirmed'
      AND date(confirmed_at) >= date('now', '-7 days')
      AND date(confirmed_at) < date('now')
    ORDER BY d ASC
  `).all() as { d: string }[]

  for (const { d } of recentDates) {
    const hasNote = existingNotes.some(n => n.date === d)
    if (hasNote) {
      results.push({ inducted: false, date: d, reason: `${d} 已有每日笔记` })
      continue
    }

    // Run induction for this date
    const result = await runAutoInduct(d)
    results.push(result)

    // Small delay between days to avoid rate limiting
    if (result.inducted) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  if (results.every(r => !r.inducted)) {
    logger.info('auto_induct', 'all_caught_up', '最近一周无遗漏的归纳')
  }

  return results
}
