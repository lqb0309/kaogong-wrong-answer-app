import { ipcMain, shell, dialog, BrowserWindow, app } from 'electron'
import { getDb } from './db'
import { logger } from './logger'
import { readConfig, writeConfig, getAllConfig } from './config'
import { encryptToken, decryptToken } from './safe-storage'
import { fetchModelCatalog } from './model-catalog'
import { classifyImage, analyzeMaterialGroup, getAiSuggestion, generateReflection, generateDailyInduction } from './ai'
import { writeToVault, vaultOnline, reorganizeVault } from './obsidian'
import { storeImage, saveMarkdown, syncQuestionNotes, loadQuestionData, repairQuestionNotes, getLocalDataDir } from './storage'
import { generateTraceId } from './utils'
import { scanExistingCards, writeInductionResults, readCardContent, scanDailyNotes, readDailyNote, bumpCardError, findQuestionsForCard, findCardPathsForQuestion, parseCategoryFromPath, getReviewQueueCards } from './knowledge-cards'
import { fetchQuestionsForTest, generatePdf } from './pdf-generator'
import { queueSize, flushVaultQueue, removeVaultRetry } from './retry-queue'
import { readImageBuffer } from './image-assets'
import { deleteQueueItems } from './queue-deletion'
import { answerResultSql, timeStatusSql, performanceFilters } from './question-filters'
import { createReviewBatch, getReviewBatch, listReviewBatches, completeReviewBatch, exportReviewBatch } from './review-center'
import { scheduleCardReview, type RecallRating } from './card-scheduler'
import { questionData, parseJson, questionFileName } from './question-data'
import { resolveInside } from './path-safety'
import { ensureTodayPlan, updatePlanTask, submitPlanFeedback, getPlanHistory, regenerateTodayPlan, getExamInfo, getExamPhase, getStoredForwardPlan, generateForwardPlan, completePlanTaskForActivity } from './daily-plan'
import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'
import { localDateKey } from './date-utils'
import { createDatabaseBackup, listDatabaseBackups, restoreDatabaseBackup } from './backup'
import dayjs from 'dayjs'
import { getAiUsageSummary } from './ai-usage'
import { getBillingOverview } from './billing'
import { openFenbiImporter, previewFenbiReport, importFenbiQuestions, syncFenbiToday, syncFenbiCurrentReport, syncFenbiWrongQuestions, getFenbiTodaySummary, repairStoredFenbiCategories, fenbiAnalysisStatus, controlFenbiAnalysis, getFenbiGroupEfficiencyRecords } from './fenbi-import'

export function registerIpcHandlers(): void {
  repairStoredFenbiCategories()
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
  ipcMain.handle('backup:create', async () => ({ success: true, backup: await createDatabaseBackup('manual') }))
  ipcMain.handle('backup:list', () => listDatabaseBackups())
  ipcMain.handle('backup:restore', async (_e, name: string) => {
    await restoreDatabaseBackup(name)
    setTimeout(() => { app.relaunch(); app.exit(0) }, 500)
    return { success: true, restarting: true }
  })
  ipcMain.handle('ai:usage', (_e, days?: number) => getAiUsageSummary(days))
  ipcMain.handle('billing:overview', () => getBillingOverview())
  let fenbiBusy = false
  const withFenbi = async <T>(work: () => Promise<T>): Promise<T> => {
    if (fenbiBusy) throw new Error('粉笔正在同步或读取报告，请等待当前任务完成')
    fenbiBusy = true
    try { return await work() }
    catch (error: any) {
      logger.warn('fenbi', 'operation_failed', error?.message || '粉笔同步失败')
      throw error
    } finally { fenbiBusy = false }
  }
  ipcMain.handle('fenbi:open', () => withFenbi(() => openFenbiImporter()))
  ipcMain.handle('fenbi:preview', () => withFenbi(() => previewFenbiReport()))
  ipcMain.handle('fenbi:import', (_e, params: any) => withFenbi(() => importFenbiQuestions(params)))
  ipcMain.handle('fenbi:syncToday', () => withFenbi(() => syncFenbiToday()))
  ipcMain.handle('fenbi:syncCurrent', () => withFenbi(() => syncFenbiCurrentReport()))
  ipcMain.handle('fenbi:syncWrongQuestions', (_e, params: any) => withFenbi(() => syncFenbiWrongQuestions(params || {})))
  ipcMain.handle('fenbi:todaySummary', () => getFenbiTodaySummary())
  ipcMain.handle('fenbi:analysisStatus', () => fenbiAnalysisStatus())
  ipcMain.handle('fenbi:groupEfficiency', () => getFenbiGroupEfficiencyRecords())
  ipcMain.handle('fenbi:analysisControl', (_e, action: 'pause' | 'resume' | 'retry-failed') => controlFenbiAnalysis(action))

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
      const { buffer: originalBuffer } = await readImageBuffer(params.imageUrl)
      const sharp = require('sharp')
      const imgBuf = params.rotation ? await sharp(originalBuffer).rotate(params.rotation).toBuffer() : originalBuffer

      // 2. Apply crop/rotation with sharp
      const metadata = await sharp(imgBuf).metadata()
      const imgW = metadata.width || 0
      const imgH = metadata.height || 0

      let pipeline = sharp(imgBuf)

      if (params.crop && params.crop.width > 0 && params.crop.height > 0) {
        // Clamp crop to image bounds
        const left = Math.max(0, Math.round(params.crop.x))
        const top = Math.max(0, Math.round(params.crop.y))
        const width = Math.min(Math.round(params.crop.width), imgW - left)
        const height = Math.min(Math.round(params.crop.height), imgH - top)
        if (width <= 0 || height <= 0) throw new Error('裁剪区域超出图片范围')
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
      const { buffer: buf, mime: contentType } = await readImageBuffer(url)
      return { success: true, dataUrl: `data:${contentType};base64,${buf.toString('base64')}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('file:readImage', async (_e, filePath: string) => {
    if (filePath.startsWith('data:image/')) return filePath
    const { buffer, mime } = await readImageBuffer(filePath)
    return `data:${mime};base64,${buffer.toString('base64')}`
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
            results[idx] = { success: false, filePath: fp, error: '重复导入（该图片已经导入）', duplicate: true, traceId }
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

  ipcMain.handle('materialGroup:create', async (
    e,
    images: Array<{ url: string; localAbsPath?: string }>,
    sourceQuestionIds?: string[]
  ) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const traceId = generateTraceId()
    const onProgress = (stage: string, message: string) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId, stage, message, ts: Date.now() })
    }
    try {
      const db = getDb()
      let resolvedImages = Array.isArray(images) ? images : []
      const sourceIds = Array.isArray(sourceQuestionIds) ? Array.from(new Set(sourceQuestionIds)) : []
      if (resolvedImages.length === 0 && sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => '?').join(',')
        const rows = db.prepare(`SELECT id, image_url, local_image_path FROM questions WHERE id IN (${placeholders})`).all(...sourceIds) as Array<{ id: string; image_url: string; local_image_path?: string }>
        const byId = new Map(rows.map(row => [row.id, row]))
        resolvedImages = sourceIds.map(id => byId.get(id)).filter((row): row is NonNullable<typeof row> => !!row)
          .map(row => ({ url: row.image_url, localAbsPath: row.local_image_path }))
      }
      if (resolvedImages.length === 0) throw new Error('请至少选择一张资料截图')
      // Prefer the locally persisted original when available. Some vision providers
      // reject otherwise valid image-host URLs (for example URLs using a custom
      // port), while a local file is converted to a data URL by `toImageUrl`.
      // Keep the public URL below for renderer/PDF display only.
      const analysisImages = resolvedImages.map(image => {
        if (image.localAbsPath && fs.existsSync(image.localAbsPath)) {
          return `file://${image.localAbsPath}`
        }
        return image.url
      })
      const analysis = await analyzeMaterialGroup(analysisImages, traceId, onProgress)
      // Renderer pages can run from an http:// origin in development, where direct
      // file:// access is blocked. Keep the accessible stored URL for UI/PDF use.
      const materialRefs = resolvedImages.map(image => image.url)
      const groupId = `material-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
      db.prepare(`INSERT INTO question_groups
        (id, title, passage_image_url, passage_text, group_type, created_at, material_images)
        VALUES (?, ?, ?, ?, 'material', ?, ?)`
      ).run(groupId, analysis.title || '资料分析题组', materialRefs[0], analysis.passage_text || '', new Date().toISOString(), JSON.stringify(materialRefs))

      const candidates = analysis.questions.filter(question => question.is_wrong !== false)
      const createdIds: string[] = []
      for (const question of candidates) {
        const indexes = question.material_image_indexes?.length
          ? question.material_image_indexes
          : resolvedImages.map((_, index) => index + 1)
        const dependencyUrls = indexes.map(index => materialRefs[index - 1]).filter(Boolean)
        const primaryImage = resolvedImages[(indexes[0] || 1) - 1] || resolvedImages[0]
        const id = `q-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
        const answerText = [
          question.ocr_text,
          question.correct_answer ? `正确答案：${question.correct_answer}` : '',
          question.user_answer ? `你的答案：${question.user_answer}` : ''
        ].filter(Boolean).join('\n')
        await saveMarkdown({
          id,
          imageUrl: primaryImage.url,
          localAbsPath: primaryImage.localAbsPath,
          level1: question.level1 || '资料分析',
          level2: question.level2 || '资料分析',
          level3: question.level3 || null,
          confidence: question.confidence || 0,
          ocrText: answerText,
          reasoning: question.is_wrong === null ? '答案识别不完整，请在待确认页面核对' : '资料题组自动拆题',
          reflection: question.reflection || '',
          errorType: question.error_type || '',
          hasGraphics: true,
          status: 'classified',
          errorCount: 1,
          traceId
        })
        db.prepare(`UPDATE questions SET group_id = ?, question_number = ?, material_image_ids = ? WHERE id = ?`)
          .run(groupId, question.question_number || '', JSON.stringify(dependencyUrls), id)
        createdIds.push(id)
      }
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM questions WHERE id IN (${placeholders}) AND status IN ('pending', 'classified')`).run(...sourceIds)
      }
      logger.info('ai', 'material_group_created', `资料题组识别完成：${analysis.questions.length} 题，${createdIds.length} 题待确认`, { groupId }, traceId)
      return {
        success: true,
        groupId,
        title: analysis.title,
        totalQuestions: analysis.questions.length,
        wrongQuestions: analysis.questions.filter(question => question.is_wrong === true).length,
        uncertainQuestions: analysis.questions.filter(question => question.is_wrong === null).length,
        createdIds
      }
    } catch (err: any) {
      logger.error('ai', 'material_group_failed', err.message, null, traceId)
      return { success: false, error: err.message, createdIds: [] }
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
    const result = await fetchModelCatalog(baseURL, apiKey)
    if (!result.success) logger.warn('ai', 'model_catalog_failed', result.error || '模型清单获取失败')
    return result
  })
  ipcMain.handle('ai:suggest', async (_e, statsData: any) => {
    try {
      const suggestion = await getAiSuggestion(statsData)
      return { success: true, suggestion }
    } catch (err: any) { return { success: false, error: err.message } }
  })
  ipcMain.handle('ai:reflect', async (e, params: { level1: string; level2?: string; level3?: string | null; ocrText: string; errorType?: string; traceId?: string; officialAnalysis?: string; correctAnswer?: string; userAnswer?: string; answerTime?: string; correctRate?: string; difficulty?: number | null; questionId?: string; materialText?: string; imageUrls?: string[] }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const onProgress = (stage: string, message: string) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { traceId: params.traceId || 'reflect', stage, message, ts: Date.now() })
    }
    try {
      const row = params.questionId ? loadQuestionData(params.questionId) : undefined
      const answer = parseJson<any>(row?.originalAnswer, {})
      const context = row ? {
        ...params, ...row,
        officialAnalysis: row.originalAnalysis,
        correctAnswer: answer.correct, userAnswer: answer.user,
        answerTime: answer.answerTime, correctRate: answer.correctRate, difficulty: answer.reportDifficulty,
        timingBasis: answer.timingBasis, groupActualSeconds: answer.groupActualSeconds,
        groupTargetSeconds: answer.groupTargetSeconds, groupGraceSeconds: answer.groupGraceSeconds,
        materialText: row.materialText,
        imageUrls: [...parseJson<string[]>(row.material_image_ids, []), ...parseJson<string[]>(row.question_images, []), ...Object.values(parseJson<Record<string, string[]>>(row.option_images, {})).filter(Array.isArray).flat()]
      } : params
      const reflection = await generateReflection(context, onProgress)
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
    const today = localDateKey()
    const todayCount = count("SELECT COUNT(*) as c FROM questions WHERE status = 'confirmed' AND date(confirmed_at, '+8 hours') = ?", today)
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

  ipcMain.handle('obsidian:repairNotes', () => repairQuestionNotes())
  ipcMain.handle('obsidian:sync', async () => {
    const vaultRoot = readConfig('obsidian_vault') || ''
    if (!vaultRoot) return { deleted: 0, message: '未配置 Obsidian Vault' }
    const db = getDb()
    const questions = db.prepare("SELECT id, obsidian_path FROM questions WHERE status = 'confirmed'").all() as any[]
    let deleted = 0
    for (const q of questions) {
      let present = false
      try { present = !!q.obsidian_path && fs.existsSync(resolveInside(vaultRoot, q.obsidian_path)) } catch { /* invalid legacy path */ }
      if (!present) {
        db.prepare("UPDATE questions SET sync_status = 'missing', sync_error = ? WHERE id = ?")
          .run('Vault 中未找到对应笔记；数据库记录已保留', q.id)
        deleted++
      }
    }
    const repairable = questions.filter(q => {
      try { return !q.obsidian_path || path.basename(q.obsidian_path) !== questionFileName(q.id) || !fs.existsSync(resolveInside(vaultRoot, q.obsidian_path)) } catch { return true }
    }).length
    return { deleted: 0, missing: deleted, repairable, message: `校验完成：发现 ${deleted} 条缺失笔记，数据库记录均已保留` }
  })
  ipcMain.handle('obsidian:write', async (_e, questionData: any) => saveMarkdown(questionData))
  ipcMain.handle('obsidian:check', async () => vaultOnline())
  ipcMain.handle('obsidian:reorganize', async () => reorganizeVault())

  // Questions
  ipcMain.handle('questions:list', (_e, params: any) => {
    const db = getDb()
    const { page: rawPage = 1, pageSize: rawPageSize = 20, level1, level2, level3, weaknessType, search, status = 'confirmed', sortBy = 'created_at', sortOrder = 'desc' } = params || {}
    const page = Math.max(1, Math.floor(Number(rawPage) || 1))
    const pageSize = Math.min(1000, Math.max(1, Math.floor(Number(rawPageSize) || 20)))
    const conditions: string[] = []
    const values: any[] = []
    if (status === 'queue') conditions.push("status != 'confirmed'")
    else if (status && status !== 'all') { conditions.push('status = ?'); values.push(status) }
    if (level1) { conditions.push('level1 = ?'); values.push(level1) }
    if (level2) { conditions.push('level2 = ?'); values.push(level2) }
    if (level3) { conditions.push('level3 = ?'); values.push(level3) }
    const performance = performanceFilters(params || {})
    conditions.push(...performance.conditions)
    values.push(...performance.values)
    for (const field of ['since', 'until'] as const) if (params?.[field]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(params[field])) throw new Error('日期筛选无效')
      conditions.push(`date(COALESCE(confirmed_at, created_at), '+8 hours') ${field === 'since' ? '>=' : '<='} ?`)
      values.push(params[field])
    }
    if (weaknessType === '__unmarked__') {
      conditions.push("COALESCE(NULLIF(error_type, ''), CASE WHEN json_valid(original_answer) THEN NULLIF(json_extract(original_answer, '$.weaknessType'), '') END, '') = ''")
    } else if (weaknessType) {
      conditions.push("COALESCE(NULLIF(error_type, ''), CASE WHEN json_valid(original_answer) THEN NULLIF(json_extract(original_answer, '$.weaknessType'), '') END, CASE WHEN json_valid(original_answer) AND json_extract(original_answer, '$.correct') != json_extract(original_answer, '$.user') THEN '结果错误' END, '') = ?")
      values.push(weaknessType)
    }
    if (search) {
      const rawSearch = String(search).trim()
      const terms = rawSearch.split(/\s+/).filter(Boolean)
      if (terms.length > 0 && terms.every(term => Array.from(term).length >= 3)) {
        conditions.push('id IN (SELECT question_id FROM question_fts_v2 WHERE question_fts_v2 MATCH ?)')
        values.push(terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' AND '))
      } else {
        conditions.push('(ocr_text LIKE ? OR reflection LIKE ? OR source LIKE ? OR error_type LIKE ? OR level1 LIKE ? OR level2 LIKE ? OR level3 LIKE ?)')
        const pattern = `%${rawSearch}%`
        values.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern)
      }
    }
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM questions${whereClause}`).get(...values) as { cnt: number }
    const total = countRow.cnt
    const offset = (page - 1) * pageSize
    const sortCol = ['created_at', 'confidence', 'error_count', 'level1'].includes(sortBy) ? sortBy : 'created_at'
    const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC'
    const items = db.prepare(`SELECT id, image_url, level1, level2, level3, confidence, ocr_text, reasoning, status, error_count, source, obsidian_path, local_image_path, reflection, error_type, group_id, has_graphics, graphic_image_path, analysis_status, analysis_error, question_number, material_image_ids, question_images, option_images, original_analysis, original_answer, match_type, ai_raw_level1, ai_raw_level2, ai_raw_level3, trace_id, created_at, confirmed_at,
      ${answerResultSql} AS answer_result, ${timeStatusSql} AS time_status,
      (SELECT title FROM question_groups WHERE id = questions.group_id) AS group_title,
      (SELECT passage_text FROM question_groups WHERE id = questions.group_id) AS group_passage_text,
      (SELECT material_images FROM question_groups WHERE id = questions.group_id) AS group_material_images
      FROM questions${whereClause} ORDER BY ${sortCol} ${sortDir}, id ${sortDir} LIMIT ? OFFSET ?`).all(...values, pageSize, offset)
    return { items, total }
  })
  ipcMain.handle('questions:get', (_e, id: string) => getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id) || null)
  ipcMain.handle('questions:groupMembers', (_e, groupId: string) => {
    if (!groupId) return []
    return getDb().prepare(`SELECT questions.*,
      (SELECT title FROM question_groups WHERE id = questions.group_id) AS group_title,
      (SELECT passage_text FROM question_groups WHERE id = questions.group_id) AS group_passage_text,
      (SELECT material_images FROM question_groups WHERE id = questions.group_id) AS group_material_images
      FROM questions WHERE group_id = ? AND status = 'confirmed'
      ORDER BY CAST(question_number AS INTEGER), created_at`).all(groupId)
  })
  ipcMain.handle('speedTraining:questions', (_e, params: any) => {
    const db = getDb()
    const count = Math.min(50, Math.max(1, Number(params?.count || 5)))
    const performance = performanceFilters({ answerResult: params?.answerResult, timeStatus: 'overtime' })
    const conditions = ["status = 'confirmed'", ...performance.conditions]
    const values: any[] = [...performance.values]
    if (params?.level1) { conditions.push('level1 = ?'); values.push(params.level1) }
    if (params?.level2) { conditions.push('level2 = ?'); values.push(params.level2) }
    if (params?.level3) { conditions.push('level3 = ?'); values.push(params.level3) }
    const rows = db.prepare(`SELECT questions.*,
      (SELECT passage_text FROM question_groups WHERE id = questions.group_id) AS group_passage_text,
      (SELECT material_images FROM question_groups WHERE id = questions.group_id) AS group_material_images
      FROM questions WHERE ${conditions.join(' AND ')}`).all(...values) as any[]
    const attempts = db.prepare('SELECT is_correct, is_on_time, elapsed_seconds, created_at FROM speed_training_attempts WHERE question_id = ? ORDER BY id DESC LIMIT 2')
    const decorated = rows.map(question => {
      const recent = attempts.all(question.id) as any[]
      const graduated = recent.length >= 2 && recent.every(item => item.is_correct && item.is_on_time)
      let original: any = {}
      try { original = JSON.parse(question.original_answer || '{}') } catch { /* ignore */ }
      return { ...question, speed_recent: recent, speed_graduated: graduated, original_overtime: Number(original.overtimeSeconds || 0) }
    }).filter(question => params?.scope === 'all' || !question.speed_graduated)
    if (params?.pickMode === 'random') decorated.sort(() => Math.random() - 0.5)
    else if (params?.pickMode === 'slowest') decorated.sort((a, b) => b.original_overtime - a.original_overtime)
    else decorated.sort((a, b) => Number(a.speed_graduated) - Number(b.speed_graduated) || a.speed_recent.length - b.speed_recent.length || b.original_overtime - a.original_overtime)
    return { items: decorated.slice(0, count), available: decorated.length }
  })
  ipcMain.handle('speedTraining:record', (_e, params: any) => {
    const db = getDb()
    const question = db.prepare("SELECT original_answer FROM questions WHERE id = ? AND status = 'confirmed'").get(params.questionId) as any
    const correctAnswer = parseJson<any>(question?.original_answer, {}).correct
    if (!correctAnswer || !params.selectedAnswer) throw new Error('题目或可靠答案不存在，未记录成绩')
    params.correctAnswer = correctAnswer
    if (!Number.isFinite(Number(params.elapsedSeconds)) || Number(params.elapsedSeconds) < 0 || !Number.isFinite(Number(params.targetSeconds)) || Number(params.targetSeconds) <= 0) throw new Error('训练时间无效')
    const isCorrect = String(params.selectedAnswer) === String(correctAnswer)
    const isOnTime = Number(params.elapsedSeconds) <= Number(params.targetSeconds)
    db.prepare(`INSERT INTO speed_training_attempts
      (question_id, selected_answer, correct_answer, elapsed_seconds, target_seconds, is_correct, is_on_time, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(params.questionId, params.selectedAnswer || '', params.correctAnswer || '', Math.max(0, Number(params.elapsedSeconds) || 0), Math.max(1, Number(params.targetSeconds) || 90), isCorrect ? 1 : 0, isOnTime ? 1 : 0, new Date().toISOString())
    const recent = db.prepare('SELECT is_correct, is_on_time FROM speed_training_attempts WHERE question_id = ? ORDER BY id DESC LIMIT 2').all(params.questionId) as any[]
    const consecutivePasses = recent.findIndex(item => !item.is_correct || !item.is_on_time) < 0 ? recent.length : recent.findIndex(item => !item.is_correct || !item.is_on_time)
    return { success: true, achieved: isCorrect && isOnTime, consecutivePasses, graduated: consecutivePasses >= 2 }
  })
  ipcMain.handle('speedTraining:recordSession', (_e, params: any) => {
    const db = getDb()
    const answers = Array.isArray(params?.answers) ? params.answers : []
    if (!answers.length) throw new Error('答题卡为空')
    if (new Set(answers.map((answer: any) => answer.questionId)).size !== answers.length) throw new Error('答题卡含重复题目')
    for (const answer of answers) {
      const question = db.prepare("SELECT original_answer FROM questions WHERE id = ? AND status = 'confirmed'").get(answer.questionId) as any
      const correct = parseJson<any>(question?.original_answer, {}).correct
      if (!correct || !answer.selectedAnswer) throw new Error('答题卡有缺失或已删除的题目，未记录成绩')
      answer.correctAnswer = correct
    }
    if (!Number.isFinite(Number(params.elapsedSeconds)) || Number(params.elapsedSeconds) < 0 || !Number.isFinite(Number(params.limitSeconds)) || Number(params.limitSeconds) <= 0) throw new Error('训练时间无效')
    const elapsedSeconds = Math.max(0, Number(params.elapsedSeconds) || 0)
    const limitSeconds = Math.max(1, Number(params.limitSeconds) || 1)
    const correctCount = answers.filter((item: any) => String(item.selectedAnswer) === String(item.correctAnswer)).length
    const accuracy = correctCount / answers.length
    const onTime = elapsedSeconds <= limitSeconds
    const achieved = onTime && accuracy * 100 >= Math.min(100, Math.max(0, Number(params.accuracyTarget ?? 80)))
    const now = new Date().toISOString()
    const transaction = db.transaction(() => {
      db.prepare(`INSERT INTO speed_training_sessions (question_count, correct_count, elapsed_seconds, limit_seconds, accuracy, is_on_time, mode, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pdf', ?)`).run(answers.length, correctCount, elapsedSeconds, limitSeconds, accuracy, onTime ? 1 : 0, now)
      const insert = db.prepare(`INSERT INTO speed_training_attempts
        (question_id, selected_answer, correct_answer, elapsed_seconds, target_seconds, is_correct, is_on_time, created_at, training_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pdf')`)
      for (const answer of answers) insert.run(answer.questionId, answer.selectedAnswer || '', answer.correctAnswer || '', 0, 0, String(answer.selectedAnswer) === String(answer.correctAnswer) ? 1 : 0, achieved ? 1 : 0, now)
    })
    transaction()
    let graduated = 0
    const recent = db.prepare('SELECT is_correct, is_on_time FROM speed_training_attempts WHERE question_id = ? ORDER BY id DESC LIMIT 2')
    for (const answer of answers) {
      const rows = recent.all(answer.questionId) as any[]
      if (rows.length >= 2 && rows.every(row => row.is_correct && row.is_on_time)) graduated++
    }
    return { success: true, correctCount, accuracy, onTime, savedSeconds: limitSeconds - elapsedSeconds, graduated }
  })
  const deleteQuestion = (id: string) => {
    const db = getDb()
    const row = db.prepare('SELECT obsidian_path FROM questions WHERE id = ?').get(id) as { obsidian_path: string } | undefined
    if (row?.obsidian_path) {
      const vaultRoot = readConfig('obsidian_vault') || ''
      const owners = db.prepare('SELECT COUNT(*) c FROM questions WHERE obsidian_path = ?').get(row.obsidian_path) as { c: number }
      if (vaultRoot && owners.c === 1) {
        try { fs.removeSync(resolveInside(vaultRoot, row.obsidian_path)) } catch (error: any) { logger.warn('vault', 'delete_note_failed', error.message) }
      }
    }
    removeVaultRetry(id)
    db.prepare('DELETE FROM questions WHERE id = ?').run(id)
    logger.info('confirm', 'question_deleted', `错题已删除: ${id}`)
  }
  ipcMain.handle('questions:delete', (_e, id: string) => deleteQuestion(id))
  ipcMain.handle('questions:deleteQueued', (_e, ids: unknown) => deleteQueueItems(ids, {
    getStatus: id => (getDb().prepare('SELECT status FROM questions WHERE id = ?').get(id) as { status: string } | undefined)?.status,
    remove: deleteQuestion
  }))
  ipcMain.handle('questions:updateStatus', (_e, id: string, status: string) => {
    if (!['pending', 'classified'].includes(status)) throw new Error('不允许此状态变更')
    const changed = getDb().prepare("UPDATE questions SET status = ? WHERE id = ? AND status != 'confirmed'").run(status, id)
    if (!changed.changes) throw new Error('题目已入库或已删除，请刷新列表')
  })
  ipcMain.handle('questions:updateDraft', (_e, id: string, updates: any) => {
    const fields = ['level1', 'level2', 'level3', 'ocr_text', 'error_type', 'error_count', 'source', 'reflection', 'has_graphics', 'graphic_image_path']
    const selected = fields.filter(field => updates[field] !== undefined)
    if (!selected.length) return { success: true }
    const result = getDb().prepare(`UPDATE questions SET ${selected.map(field => `${field} = ?`).join(', ')} WHERE id = ? AND status IN ('pending', 'classified')`).run(...selected.map(field => updates[field]), id)
    return { success: !!result.changes, error: result.changes ? undefined : '待确认题目状态已变更' }
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
    const result = db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    if (!result.changes) return { success: false, error: '题目已删除' }
    const row = loadQuestionData(id)
    if (row.status === 'confirmed') {
      try { syncQuestionNotes(id) } catch (error: any) {
        db.prepare("UPDATE questions SET sync_status = 'failed', sync_error = ? WHERE id = ?").run(error.message, id)
        logger.warn('vault', 'edit_sync_failed', error.message, { id })
        return { success: true, syncPending: true, warning: '修改已保存，笔记同步失败，可通过校验补写' }
      }
    }
    logger.info('confirm', 'question_updated', `错题已更新: ${id}`)
    return { success: true }
  })

  ipcMain.handle('questions:pendingCount', () => {
    const row = getDb().prepare("SELECT COUNT(*) as cnt FROM questions WHERE status = 'classified'").get() as { cnt: number }
    return row.cnt
  })
  ipcMain.handle('questions:createManual', async (_e, data: any) => {
    const id = `manual-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    const questionData = {
      id, imageUrl: data.imageUrl || '', level1: data.level1 || '未分类', level2: data.level2 || '',
      level3: data.level3 || null, confidence: 1, ocrText: data.ocrText || '', reasoning: '手动新建',
      errorCount: Number(data.errorCount) || 1, source: data.source || '', traceId: id, status: data.mode === 'review' ? 'classified' : 'confirmed'
    }
    if (data.mode !== 'review') return saveMarkdown(questionData)
    getDb().prepare(`INSERT INTO questions
      (id, image_url, level1, level2, level3, confidence, ocr_text, reasoning, status, error_count, source, trace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'classified', ?, ?, ?, ?)`)
      .run(id, questionData.imageUrl, questionData.level1, questionData.level2, questionData.level3, 1,
        questionData.ocrText, questionData.reasoning, questionData.errorCount, questionData.source, id, new Date().toISOString())
    logger.info('confirm', 'manual_question_created', `手动新建错题: ${id}`)
    return { success: true, id, pendingReview: true }
  })
  ipcMain.handle('questions:stats', () => {
    const db = getDb()
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM questions WHERE status = \'confirmed\'').get() as { cnt: number }).cnt
    const byLevel1 = db.prepare('SELECT level1, COUNT(*) as cnt FROM questions WHERE status = \'confirmed\' GROUP BY level1 ORDER BY cnt DESC').all()
    const byLevel1WithPct = (byLevel1 as any[]).map((l: any) => ({ ...l, pct: total > 0 ? Math.round((l.cnt / total) * 100) : 0 }))
    const byLevel2 = db.prepare('SELECT level1, level2, COUNT(*) as cnt, AVG(CASE WHEN error_type = \'正确但超时\' THEN NULL ELSE error_count END) as avg_err, SUM(CASE WHEN error_type = \'正确但超时\' THEN 0 ELSE error_count END) as total_err FROM questions WHERE status = \'confirmed\' GROUP BY level1, level2 ORDER BY cnt DESC').all()
    const byLevel3 = db.prepare("SELECT level1, level2, level3, COUNT(*) as cnt, AVG(CASE WHEN error_type = '正确但超时' THEN NULL ELSE error_count END) as avg_err, SUM(CASE WHEN error_type = '正确但超时' THEN 0 ELSE error_count END) as total_err FROM questions WHERE status = 'confirmed' AND level3 IS NOT NULL AND level3 != '' GROUP BY level1, level2, level3 ORDER BY cnt DESC LIMIT 80").all()
    const dailyStats = db.prepare("SELECT * FROM (SELECT date(confirmed_at, '+8 hours') as day, COUNT(*) as cnt FROM questions WHERE status = 'confirmed' GROUP BY day ORDER BY day DESC LIMIT 180) ORDER BY day ASC").all()
    const weeklyStats = db.prepare("SELECT strftime('%Y-W%W', confirmed_at, '+8 hours') as week, COUNT(*) as cnt FROM questions WHERE status = 'confirmed' GROUP BY week ORDER BY week DESC LIMIT 12").all()
    const monthlyStats = db.prepare("SELECT strftime('%Y-%m', confirmed_at, '+8 hours') as month, COUNT(*) as cnt FROM questions WHERE status = 'confirmed' GROUP BY month ORDER BY month DESC LIMIT 12").all()
    const topErrors = db.prepare('SELECT id, level1, level2, level3, error_count, image_url, obsidian_path, created_at FROM questions WHERE status = \'confirmed\' AND COALESCE(error_type, \'\') != \'正确但超时\' AND error_count > 0 ORDER BY error_count DESC, id LIMIT 30').all()
    const recent7 = (db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE status = 'confirmed' AND date(confirmed_at, '+8 hours') >= date('now', '+8 hours', '-7 days')").get() as { cnt: number }).cnt
    const prev7 = (db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE status = 'confirmed' AND date(confirmed_at, '+8 hours') >= date('now', '+8 hours', '-14 days') AND date(confirmed_at, '+8 hours') < date('now', '+8 hours', '-7 days')").get() as { cnt: number }).cnt
    const recent30 = (db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE status = 'confirmed' AND date(confirmed_at, '+8 hours') >= date('now', '+8 hours', '-30 days')").get() as { cnt: number }).cnt
    const prev30 = (db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE status = 'confirmed' AND date(confirmed_at, '+8 hours') >= date('now', '+8 hours', '-60 days') AND date(confirmed_at, '+8 hours') < date('now', '+8 hours', '-30 days')").get() as { cnt: number }).cnt
    const errorDist = db.prepare("SELECT CASE WHEN error_count >= 3 THEN '3+' ELSE CAST(error_count AS TEXT) END as err_level, COUNT(*) as cnt FROM questions WHERE status = 'confirmed' AND COALESCE(error_type, '') != '正确但超时' AND error_count > 0 GROUP BY err_level ORDER BY err_level").all()
    const errorTypeDist = db.prepare("SELECT error_type, COUNT(*) as cnt FROM questions WHERE status = 'confirmed' AND error_type IS NOT NULL AND error_type != '' GROUP BY error_type ORDER BY cnt DESC LIMIT 12").all()
    const confidenceDist = db.prepare('SELECT SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END) as low, SUM(CASE WHEN confidence >= 0.6 AND confidence < 0.8 THEN 1 ELSE 0 END) as mid, SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) as high FROM questions WHERE status = \'confirmed\'').get()
    const todayCount = (db.prepare("SELECT COUNT(*) as c FROM questions WHERE status = 'confirmed' AND date(confirmed_at, '+8 hours') = date('now', '+8 hours')").get() as { c: number }).c
    const firstRecord = db.prepare('SELECT MIN(created_at) as d FROM questions WHERE status = \'confirmed\'').get() as { d: string }
    const daysSinceFirst = total > 0 ? Math.max(1, (Date.now() - new Date(firstRecord?.d || new Date().toISOString()).getTime()) / (1000 * 86400)) : 1
    const dailyAvg = total > 0 ? Math.round(total / daysSinceFirst) : 0
    const reviewedThisWeek = (db.prepare("SELECT COUNT(DISTINCT card_path) c FROM review_log WHERE date >= date('now', '+8 hours', '-6 days')").get() as { c: number }).c
    const dueReviewCount = (db.prepare("SELECT COUNT(*) c FROM review_state WHERE due_date <= date('now', '+8 hours')").get() as { c: number }).c
    const review30 = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN result = 'wrong' THEN 1 ELSE 0 END) wrong FROM review_log WHERE date >= date('now', '+8 hours', '-29 days')").get() as { total: number; wrong: number }
    const reviewWrongRate = review30.total > 0 ? Math.round((review30.wrong || 0) / review30.total * 100) : 0
    const latestAttempt = db.prepare('SELECT accuracy, created_at FROM test_attempts ORDER BY created_at DESC LIMIT 1').get() as { accuracy: number; created_at: string } | undefined
    const reviewDaily = db.prepare("SELECT date, COUNT(DISTINCT card_path) cnt FROM review_log WHERE date >= date('now', '+8 hours', '-89 days') GROUP BY date ORDER BY date").all()
    const weaknessPoints = db.prepare(`SELECT level1, level2, COUNT(*) question_count, SUM(CASE WHEN error_type = '正确但超时' THEN 0 ELSE error_count END) total_errors,
      SUM(CASE WHEN error_count >= 2 AND COALESCE(error_type, '') != '正确但超时' THEN 1 ELSE 0 END) repeated_count, MAX(created_at) last_error_at
      FROM questions WHERE status = 'confirmed' GROUP BY level1, level2
      ORDER BY total_errors DESC, question_count DESC LIMIT 12`).all()
    const speedSummary = db.prepare(`SELECT COUNT(*) attempts,
      COALESCE(ROUND(100.0 * SUM(CASE WHEN is_correct = 1 AND is_on_time = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)), 0) achievement_rate,
      COALESCE(ROUND(AVG(target_seconds - elapsed_seconds)), 0) avg_saved_seconds
      FROM speed_training_attempts WHERE training_mode = 'online' AND julianday(created_at) >= julianday('now', '-7 days')`).get()
    const speedPending = db.prepare(`SELECT COUNT(*) cnt FROM questions WHERE status = 'confirmed' AND
      (error_type IN ('正确但超时','错误且超时') OR (json_valid(original_answer) AND COALESCE(json_extract(original_answer, '$.overtimeSeconds'), 0) > 0)) AND
      id NOT IN (SELECT a.question_id FROM speed_training_attempts a WHERE a.id IN (SELECT b.id FROM speed_training_attempts b WHERE b.question_id = a.question_id ORDER BY b.id DESC LIMIT 2) GROUP BY a.question_id HAVING COUNT(*) = 2 AND MIN(a.is_correct) = 1 AND MIN(a.is_on_time) = 1)`).get() as { cnt: number }
    const speedDaily = db.prepare(`SELECT date(created_at, '+8 hours') day, ROUND(AVG(elapsed_seconds), 1) avg_seconds, COUNT(*) attempts
      FROM speed_training_attempts WHERE training_mode = 'online' AND julianday(created_at) >= julianday('now', '-29 days') GROUP BY day ORDER BY day`).all()
    return { total, dailyAvg, todayCount, recent7, prev7, recent30, prev30, byLevel1: byLevel1WithPct, byLevel2, byLevel3, dailyStats, weeklyStats, monthlyStats, topErrors, errorDist, errorTypeDist, confidenceDist,
      reviewedThisWeek, dueReviewCount, reviewWrongRate, latestAttempt: latestAttempt || null, reviewDaily, weaknessPoints,
      speedTraining: { ...(speedSummary as any), pending: speedPending.cnt, daily: speedDaily } }
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
    const targetDate = date || localDateKey()

    // 1. Today's confirmed questions
    const todayQuestions = db.prepare(`
      SELECT id, level1, level2, level3, error_count, error_type,
             ocr_text, obsidian_path, confirmed_at, created_at, reflection
      FROM questions
      WHERE date(confirmed_at, '+8 hours') = ? AND status = 'confirmed'
      ORDER BY created_at DESC
    `).all(targetDate) as any[]

    // 2. Knowledge point aggregation (all time)
    const knowledgePoints = db.prepare(`
      SELECT level1, level2, level3,
             COUNT(*) as question_count,
             SUM(error_count) as total_errors,
             MIN(date(confirmed_at, '+8 hours')) as first_seen,
             MAX(date(confirmed_at, '+8 hours')) as last_seen
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
    const targetDate = date || localDateKey()

    // Get target date's confirmed questions
    const todayQuestions = db.prepare(`
      SELECT id, level1, level2, level3, error_count, error_type,
             ocr_text, obsidian_path, confirmed_at, created_at, reflection
      FROM questions
      WHERE date(confirmed_at, '+8 hours') = ? AND status = 'confirmed'
      ORDER BY created_at DESC
    `).all(targetDate) as any[]

    if (todayQuestions.length === 0) {
      return { success: false, error: `${targetDate === localDateKey() ? '今天' : targetDate} 还没有已确认的错题。` }
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
        { targetDate, todayQuestions, existingCards },
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
      const success = result.dailyNote.success && [...result.newCards, ...result.updatedCards, ...result.mocUpdates].every(item => item.success)
      return { success, ...result, error: success ? undefined : '部分笔记未写入，请查看失败项后重试' }
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
      const today = localDateKey()
      if (!['wrong', 'hard', 'done', 'easy'].includes(result)) throw new Error('请选择真实回忆结果，阅读不等于掌握')
      const content = readCardContent(cardPath)
      if (!content.success) throw new Error('知识卡片不存在或无法读取，未记录复习')
      const previous = db.prepare('SELECT * FROM review_state WHERE card_path = ?').get(cardPath) as any
      if (previous?.last_reviewed_at && Date.now() - Date.parse(previous.last_reviewed_at) < 3000) return { success: true, alreadyRecorded: true, dueDate: previous.due_date }
      const next = scheduleCardReview(previous, result as RecallRating)
      const now = new Date().toISOString()
      db.transaction(() => {
        db.prepare('INSERT INTO review_log (card_path, date, result, created_at, scheduler_log) VALUES (?, ?, ?, ?, ?)')
          .run(cardPath, today, result, now, next.logJson)
        db.prepare(`INSERT INTO review_state
          (card_path, interval_days, repetitions, lapses, last_rating, last_reviewed_at, due_date, fsrs_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(card_path) DO UPDATE SET interval_days = excluded.interval_days,
            repetitions = excluded.repetitions, lapses = excluded.lapses,
            last_rating = excluded.last_rating, last_reviewed_at = excluded.last_reviewed_at,
            due_date = excluded.due_date, fsrs_json = excluded.fsrs_json`)
          .run(cardPath, next.intervalDays, next.repetitions, next.lapses, result, now, next.dueDate, next.fsrsJson)
      })()
      const reviewedCount = (db.prepare('SELECT COUNT(DISTINCT card_path) c FROM review_log WHERE date = ?').get(today) as { c: number }).c
      let cardBumped = false
      if (result === 'wrong') {
        const r = bumpCardError(cardPath)
        cardBumped = r.success
      }
      logger.info('knowledge', 'review_done', `复习完成: ${cardPath}`, { result, cardBumped })
      const completedPlanTask = completePlanTaskForActivity('review', ['复盘'], reviewedCount)
      return { success: true, cardBumped, intervalDays: next.intervalDays, dueDate: next.dueDate, completedPlanTask }
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
  ipcMain.handle('review:createBatch', (_e, params: any) => createReviewBatch(params))
  ipcMain.handle('review:getBatch', (_e, id: string) => getReviewBatch(id))
  ipcMain.handle('review:listBatches', () => listReviewBatches())
  ipcMain.handle('review:completeBatch', (_e, id: string) => completeReviewBatch(id))
  ipcMain.handle('review:exportBatch', (e, params: any) => exportReviewBatch(params, (stage, done, total) => {
    const owner = BrowserWindow.fromWebContents(e.sender)
    if (owner && !owner.isDestroyed()) owner.webContents.send('pdf:progress', { stage, done, total, ts: Date.now() })
  }))

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
  ipcMain.handle('test:markAnswers', (_e, wrongIds: string[], questionIds?: string[]) => {
    try {
      const db = getDb()
      const vaultRoot = readConfig('obsidian_vault') || ''
      const ids = Array.isArray(wrongIds) ? wrongIds : []
      const allIds = Array.isArray(questionIds) ? Array.from(new Set(questionIds)) : ids
      let updated = 0
      let cardBumps = 0
      const bumpedCards = new Set<string>()
      for (const id of ids) {
        const row = db.prepare('SELECT id, level1, level2, level3, error_count, obsidian_path FROM questions WHERE id = ?').get(id) as any
        if (!row) continue
        db.prepare('UPDATE questions SET error_count = error_count + 1 WHERE id = ?').run(id)
        updated++
        // 同步 Obsidian 笔记 frontmatter 中的 error_count，保持 DB 与 vault 一致
        if (row.obsidian_path && vaultRoot) {
          const fullPath = path.join(vaultRoot, row.obsidian_path)
          if (fs.existsSync(fullPath)) {
            try {
              const content = fs.readFileSync(fullPath, 'utf-8')
              const next = content.replace(/^error_count:\s*\d+/m, `error_count: ${(row.error_count || 0) + 1}`)
              if (next !== content) fs.writeFileSync(fullPath, next, 'utf-8')
            } catch { /* ignore */ }
          }
        }
        // 匹配知识卡片并同步错误计数
        const cardPaths = findCardPathsForQuestion(row)
        for (const p of cardPaths) {
          if (bumpedCards.has(p)) continue
          bumpedCards.add(p)
          const r = bumpCardError(p)
          if (r.success) cardBumps++
        }
      }
      const totalCount = allIds.length
      const accuracy = totalCount > 0 ? (totalCount - ids.length) / totalCount : 0
      db.prepare(`INSERT INTO test_attempts
        (id, question_ids, wrong_ids, total_count, wrong_count, accuracy, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), JSON.stringify(allIds), JSON.stringify(ids), totalCount, ids.length, accuracy, new Date().toISOString())
      const moduleRows = allIds.length ? db.prepare(`SELECT DISTINCT level1 FROM questions WHERE id IN (${allIds.map(() => '?').join(',')})`).all(...allIds) as Array<{ level1: string }> : []
      const completedPlanTask = completePlanTaskForActivity('test', moduleRows.map(row => row.level1), totalCount)
      logger.info('test', 'answers_marked', `对答案回填完成: ${updated} 道错题`, { cardBumps, totalCount, accuracy })
      return { success: true, updated, cardBumps, totalCount, accuracy, completedPlanTask }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('test:attempts', (_e, limit?: number) => {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20))
    return getDb().prepare('SELECT * FROM test_attempts ORDER BY created_at DESC LIMIT ?').all(safeLimit)
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

  ipcMain.handle('test:smartSelect', (_e, params?: {
    mode?: 'review' | 'weak' | 'recent' | 'balanced' | 'material'
    count?: number
    level1?: string
    avoidRecentDays?: number
  }) => {
    try {
      const db = getDb()
      const mode = params?.mode || 'review'
      const count = Math.min(100, Math.max(1, Number(params?.count) || 10))
      const avoidSince = dayjs().subtract(Math.max(0, Number(params?.avoidRecentDays) || 7), 'day')

      const recentAttempts = db.prepare(
        'SELECT question_ids, created_at FROM test_attempts WHERE created_at >= ? ORDER BY created_at DESC'
      ).all(avoidSince.toISOString()) as Array<{ question_ids: string; created_at: string }>
      const practicedAt = new Map<string, string>()
      for (const attempt of recentAttempts) {
        try {
          for (const id of JSON.parse(attempt.question_ids || '[]')) {
            if (!practicedAt.has(id)) practicedAt.set(id, attempt.created_at)
          }
        } catch { /* ignore malformed legacy attempts */ }
      }

      const rows = db.prepare(`
        SELECT id, level1, level2, level3, error_count, error_type, group_id,
               has_graphics, graphic_image_path, ocr_text, source, created_at, confirmed_at
        FROM questions
        WHERE status = 'confirmed' AND (? = '' OR level1 = ?)
        ORDER BY created_at DESC
        LIMIT 1000
      `).all(params?.level1 || '', params?.level1 || '') as any[]

      const scored = rows.map(question => {
        const ageDays = Math.max(0, dayjs().diff(dayjs(question.confirmed_at || question.created_at), 'day'))
        const recentlyPracticed = practicedAt.has(question.id)
        let score = (question.error_count || 1) * 18 + Math.min(ageDays, 30)
        const reasons: string[] = []

        if ((question.error_count || 1) >= 3) reasons.push(`重复错 ${question.error_count} 次`)
        else if ((question.error_count || 1) >= 2) reasons.push('曾重复出错')
        if (ageDays >= 7) reasons.push(`${ageDays} 天未重练`)
        if (question.group_id) reasons.push('资料题组')
        if (question.has_graphics) reasons.push('图形题')

        if (mode === 'weak') score += (question.error_count || 1) * 25
        if (mode === 'recent') score += Math.max(0, 40 - ageDays * 3)
        if (mode === 'material') score += question.group_id ? 100 : -100
        if (mode === 'balanced') score += Math.min(ageDays, 14)
        if (mode === 'review') score += ageDays >= 7 ? 35 : 0
        if (recentlyPracticed) score -= 80
        if (reasons.length === 0) reasons.push('补充知识点覆盖')
        return { question, score, reasons, recentlyPracticed }
      }).sort((a, b) => b.score - a.score)

      const selected: typeof scored = []
      const categoryCounts = new Map<string, number>()
      const usedGroups = new Set<string>()
      const maxMaterialGroups = mode === 'material' ? Math.max(1, Math.ceil(count / 5)) : Math.max(1, Math.ceil(count / 4))
      const categoryCap = Math.max(2, Math.ceil(count * 0.4))
      // First pass strictly avoids recently practised questions; second pass fills
      // only when the eligible pool is smaller than the requested paper.
      for (const allowRecent of [false, true]) {
        for (const item of scored) {
          if (selected.length >= count) break
          if (selected.some(entry => entry.question.id === item.question.id)) continue
          if (!allowRecent && item.recentlyPracticed) continue
          if (mode === 'material' && !item.question.group_id) continue
          if (item.question.group_id && !usedGroups.has(item.question.group_id) && usedGroups.size >= maxMaterialGroups) continue
          const category = `${item.question.level1}|${item.question.level2}`
          if (mode === 'balanced' && (categoryCounts.get(category) || 0) >= categoryCap) continue
          selected.push(item)
          categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1)
          if (item.question.group_id) usedGroups.add(item.question.group_id)
        }
      }

      return {
        success: true,
        ids: selected.map(item => item.question.id),
        selections: selected.map(item => ({
          id: item.question.id,
          reason: item.reasons.slice(0, 2).join(' · '),
          recentlyPracticed: item.recentlyPracticed
        }))
      }
    } catch (err: any) {
      return { success: false, error: err.message, ids: [], selections: [] }
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

  // ============ 每日备考计划（AI 动态调整 + 倒排） ============
  ipcMain.handle('plan:getToday', async () => {
    try {
      const plan = await ensureTodayPlan()
      return {
        success: true,
        plan,
        exam: getExamInfo(),
        phase: getExamPhase(),
        future_note: readConfig('plan_future_note') || '',
        forward_plan: getStoredForwardPlan(),
        recent: getPlanHistory(7)
      }
    } catch (err: any) {
      logger.error('daily_plan', 'get_today_failed', err.message)
      return { success: false, error: err.message, plan: null, exam: getExamInfo(), phase: getExamPhase(), future_note: '', forward_plan: null, recent: [] }
    }
  })
  ipcMain.handle('plan:updateTask', (_e, date: string, taskId: string, done: boolean) => {
    const plan = updatePlanTask(date, taskId, done)
    return { success: !!plan, plan }
  })
  ipcMain.handle('plan:submitFeedback', (_e, date: string, status: string, note: string) => {
    const valid = (['pending', 'partial', 'completed'] as const).includes(status as any) ? status as 'pending' | 'partial' | 'completed' : 'partial'
    const plan = submitPlanFeedback(date, valid, note)
    return { success: !!plan, plan }
  })
  ipcMain.handle('plan:history', (_e, limit?: number) => getPlanHistory(limit || 7))
  ipcMain.handle('plan:regenerateToday', async (_e, input?: { feedback?: string }) => {
    const result = await regenerateTodayPlan(input && typeof input === 'object' ? input : {})
    return { ...result, exam: getExamInfo(), phase: getExamPhase() }
  })
  ipcMain.handle('plan:forward', async () => {
    const result = await generateForwardPlan()
    return { ...result, exam: getExamInfo(), phase: getExamPhase() }
  })
}

// ============ Exported Auto-Induct Logic ============

export async function runAutoInduct(dateStr?: string): Promise<{ inducted: boolean; date?: string; reason?: string }> {
  const db = getDb()
  if (!dateStr) {
    dateStr = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
  }

  // Check if date has confirmed questions
  const dayQuestions = db.prepare(`
    SELECT id FROM questions
    WHERE date(confirmed_at, '+8 hours') = ? AND status = 'confirmed'
    LIMIT 1
  `).all(dateStr) as any[]

  if (dayQuestions.length === 0) {
    return { inducted: false, reason: `${dateStr} 无已确认错题` }
  }

  // Check if daily note already exists
  const existingNotes = scanDailyNotes()
  const hasNote = existingNotes.some(n => n.date === dateStr)
  if (hasNote && !readConfig(`induction_pending:${dateStr}`)) {
    return { inducted: false, reason: `${dateStr} 已有每日笔记` }
  }

  // Run induction
  const questions = db.prepare(`
    SELECT id, level1, level2, level3, error_count, error_type,
           ocr_text, obsidian_path, confirmed_at, created_at, reflection
    FROM questions
    WHERE date(confirmed_at, '+8 hours') = ? AND status = 'confirmed'
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

    const pending = readConfig(`induction_pending:${dateStr}`)
    const result = pending ? JSON.parse(pending) : await generateDailyInduction(
      { targetDate: dateStr, todayQuestions: questions, existingCards },
      (stage, message) => logger.info('auto_induct', stage, message)
    )
    writeConfig(`induction_pending:${dateStr}`, JSON.stringify(result))

    // Auto-write to vault; preserve the payload until every operation succeeds.
    const written = writeInductionResults(
      result.daily_note.full_markdown,
      result.daily_note.date,
      result.card_operations.new_cards,
      result.card_operations.updated_cards,
      result.card_operations.moc_updates
    )

    if (!written.dailyNote.success || [...written.newCards, ...written.updatedCards, ...written.mocUpdates].some(item => !item.success)) throw new Error('归纳已生成，但部分笔记写入失败；下次将继续补写，不会重复生成或累计')
    writeConfig(`induction_pending:${dateStr}`, '')
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
    SELECT DISTINCT date(confirmed_at, '+8 hours') as d
    FROM questions
    WHERE status = 'confirmed'
      AND date(confirmed_at, '+8 hours') >= date('now', '-7 days')
      AND date(confirmed_at, '+8 hours') < date('now')
    ORDER BY d ASC
  `).all() as { d: string }[]

  for (const { d } of recentDates) {
    const hasNote = existingNotes.some(n => n.date === d)
    if (hasNote && !readConfig(`induction_pending:${d}`)) {
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
