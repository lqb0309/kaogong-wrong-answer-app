import { readConfig } from './config'
import { logger } from './logger'
import { getDb } from './db'
import { uploadToEasyImage } from './easyimage'
import { writeToVault } from './obsidian'
import { enqueueVaultWrite, removeVaultRetry } from './retry-queue'
import fs from 'fs-extra'
import path from 'path'
import dayjs from 'dayjs'
import { app } from 'electron'
import sharp from 'sharp'
import { resolveInside, sanitizePathSegment } from './path-safety'
import { questionData, questionFileName, renderQuestionMarkdown } from './question-data'

// ─── Local base directory ───
export function getLocalDataDir(): string {
  const configured = readConfig('local_data_dir')
  if (configured && configured.trim()) return configured.trim()
  const home = app.getPath('home')
  return path.join(home, '考公错题')
}

function ensureDirs(): { dataDir: string; imagesDir: string; notesDir: string } {
  const dataDir = getLocalDataDir()
  const imagesDir = path.join(dataDir, 'images')
  const notesDir = path.join(dataDir, 'notes')
  fs.ensureDirSync(imagesDir)
  fs.ensureDirSync(notesDir)
  return { dataDir, imagesDir, notesDir }
}

// ─── Image compression ───
async function compressIfNeeded(sourcePath: string, destPath: string, traceId: string): Promise<boolean> {
  const thresholdKB = Number(readConfig('image_compress_threshold') || 0)
  if (thresholdKB <= 0) return false
  const quality = Number(readConfig('image_compress_quality') || 0.7)
  const stat = fs.statSync(sourcePath)
  const sizeKB = stat.size / 1024
  if (sizeKB <= thresholdKB) return false
  try {
    const srcExt = path.extname(sourcePath).toLowerCase()
    const destExt = path.extname(destPath).toLowerCase()
    if (srcExt === '.webp' && sizeKB < thresholdKB * 2) return false
    let pipeline = sharp(sourcePath)
    const metadata = await pipeline.metadata()
    // Screenshots and charts are usually PNG. Never downscale or quantize them:
    // small text and chart labels become unreadable on long material screenshots.
    if (destExt === '.png') {
      await pipeline.png({ compressionLevel: 6 }).toFile(destPath)
    } else {
      const maxDim = 4096
      if ((metadata.width && metadata.width > maxDim) || (metadata.height && metadata.height > maxDim)) {
        pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
      }
      const highQuality = Math.max(90, Math.round(quality * 100))
      if (destExt === '.webp') await pipeline.webp({ quality: highQuality }).toFile(destPath)
      else await pipeline.jpeg({ quality: highQuality, mozjpeg: true }).toFile(destPath)
    }
    const newStat = fs.statSync(destPath)
    const newSizeKB = newStat.size / 1024
    const savedPct = Math.round((1 - newSizeKB / sizeKB) * 100)
    logger.info('upload', 'image_compressed', `图片优化: ${Math.round(sizeKB)}KB → ${Math.round(newSizeKB)}KB (${savedPct}%)`, {
      originalSize: Math.round(sizeKB), compressedSize: Math.round(newSizeKB), savedPct,
      width: metadata.width, height: metadata.height, losslessScreenshot: destExt === '.png'
    }, traceId)
    return true
  } catch (err: any) {
    logger.warn('upload', 'compress_failed', `压缩失败，使用原图`, { error: err.message }, traceId)
    return false
  }
}

// ─── Image storage ───
export async function storeImage(sourcePath: string, traceId: string, fileHash?: string): Promise<{ imageUrl: string; localAbsPath: string; localRelPath: string; fileHash?: string }> {
  const { imagesDir } = ensureDirs()
  const ext = path.extname(sourcePath)
  const destName = `${dayjs().format('YYYYMMDD-HHmmss')}-${Math.random().toString(36).slice(2, 6)}${ext}`
  const destPath = path.join(imagesDir, destName)
  const compressed = await compressIfNeeded(sourcePath, destPath, traceId)
  if (!compressed) fs.copyFileSync(sourcePath, destPath)
  logger.info('upload', 'local_image_saved', `图片已保存到本地`, { destPath, compressed }, traceId)
  const localRelPath = `images/${destName}`
  const easyimageUrl = readConfig('easyimage_url')
  const easyimageToken = readConfig('easyimage_token')
  if (easyimageUrl && easyimageToken) {
    try {
      const { url } = await uploadToEasyImage(destPath, traceId)
      return { imageUrl: url, localAbsPath: destPath, localRelPath, fileHash }
    } catch (err: any) {
      logger.warn('upload', 'easyimage_fallback', `EasyImage 上传失败，使用本地图片`, { error: err.message }, traceId)
    }
  }
  return { imageUrl: `file://${destPath}`, localAbsPath: destPath, localRelPath, fileHash }
}

// ─── Markdown builder ───
export function buildMarkdown(data: any): string {
  return renderQuestionMarkdown(data)
}

// 生成不冲突的文件名（避免同一秒批量入库互相覆盖）
export function loadQuestionData(id: string): any {
  const row = getDb().prepare(`SELECT questions.*,
    (SELECT passage_text FROM question_groups WHERE id = questions.group_id) AS group_passage_text
    FROM questions WHERE id = ?`).get(id)
  if (!row) throw new Error('题目不存在或已删除')
  return questionData(row)
}

/** Rebuild from the latest row; never move/delete an older or shared note. */
export function syncQuestionNotes(id: string): { localPath: string; obsidianPath?: string; vaultWrite: boolean } {
  const data = loadQuestionData(id)
  if (data.status !== 'confirmed') throw new Error('只有已确认题目可以写入笔记')
  const { notesDir } = ensureDirs()
  const subDir = resolveInside(notesDir, sanitizePathSegment(data.level1))
  fs.ensureDirSync(subDir)
  const localPath = resolveInside(subDir, questionFileName(id))
  const markdown = buildMarkdown(data)
  if (fs.existsSync(localPath) && !fs.readFileSync(localPath, 'utf8').includes(`question_id: ${JSON.stringify(id)}`)) {
    throw new Error('本地目标文件不属于本题，已取消覆盖')
  }
  fs.writeFileSync(localPath, markdown, 'utf8')
  const result = writeToVault({ ...data, markdown })
  const db = getDb()
  if (result.success) {
    removeVaultRetry(id)
    db.prepare("UPDATE questions SET obsidian_path = ?, sync_status = 'synced', sync_error = NULL, last_synced_at = ? WHERE id = ?")
      .run(result.relativePath, new Date().toISOString(), id)
  } else {
    enqueueVaultWrite(data, markdown)
    db.prepare("UPDATE questions SET sync_status = 'pending', sync_error = ? WHERE id = ?")
      .run('Vault 暂不可用，已进入重试队列', id)
  }
  return { localPath, obsidianPath: result.vaultPath, vaultWrite: result.success }
}

/** Repair legacy/shared/missing notes only after an explicit user action. */
export async function repairQuestionNotes(): Promise<{ repaired: number; failed: number; backupPath: string }> {
  const db = getDb()
  const vaultRoot = readConfig('obsidian_vault')
  if (!vaultRoot) throw new Error('请先配置 Obsidian Vault')
  const rows = db.prepare("SELECT id, obsidian_path, sync_status FROM questions WHERE status = 'confirmed'").all() as any[]
  const candidates = rows.filter(row => {
    try {
      return !row.obsidian_path || path.basename(row.obsidian_path) !== questionFileName(row.id)
        || row.sync_status !== 'synced' || !fs.existsSync(resolveInside(vaultRoot, row.obsidian_path))
    } catch { return true }
  })
  if (!candidates.length) return { repaired: 0, failed: 0, backupPath: '' }
  const backupPath = path.join(app.getPath('userData'), 'note-repairs', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.ensureDirSync(backupPath)
  await db.backup(path.join(backupPath, 'data.db'))
  for (const relative of new Set(candidates.map(row => row.obsidian_path).filter(Boolean))) {
    const source = resolveInside(vaultRoot, relative as string)
    if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      const destination = resolveInside(backupPath, 'notes', relative as string)
      fs.ensureDirSync(path.dirname(destination))
      fs.copyFileSync(source, destination)
    }
  }
  let repaired = 0, failed = 0
  for (const row of candidates) {
    try { if (syncQuestionNotes(row.id).vaultWrite) repaired++; else failed++ }
    catch (error: any) { failed++; logger.warn('storage', 'note_repair_failed', error.message, { id: row.id }) }
  }
  return { repaired, failed, backupPath }
}

// ─── Unified save ───
export async function saveMarkdown(questionData: any): Promise<{ success: boolean; localPath: string; obsidianPath?: string; vaultWrite: boolean }> {
  const traceId = questionData.traceId || null
  const db = getDb()

  // Write to SQLite（无论 pending/classified/confirmed 都记录）
  if (db) {
    db.prepare(`
      INSERT INTO questions (id, image_url, level1, level2, level3, confidence, ocr_text, reasoning,
        status, error_count, source, obsidian_path, local_image_path, reflection, error_type, has_graphics, graphic_image_path, trace_id, file_hash, created_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        image_url = excluded.image_url, level1 = excluded.level1, level2 = excluded.level2,
        level3 = excluded.level3, confidence = excluded.confidence, ocr_text = excluded.ocr_text,
        reasoning = excluded.reasoning, status = excluded.status, error_count = excluded.error_count,
        source = excluded.source,
        local_image_path = COALESCE(excluded.local_image_path, questions.local_image_path),
        reflection = COALESCE(excluded.reflection, questions.reflection),
        error_type = COALESCE(excluded.error_type, questions.error_type),
        has_graphics = excluded.has_graphics,
        graphic_image_path = COALESCE(excluded.graphic_image_path, questions.graphic_image_path),
        trace_id = COALESCE(excluded.trace_id, questions.trace_id),
        file_hash = COALESCE(excluded.file_hash, questions.file_hash),
        confirmed_at = COALESCE(questions.confirmed_at, excluded.confirmed_at)
    `).run(
      questionData.id, questionData.imageUrl || '', questionData.level1 || '未分类',
      questionData.level2 || '', questionData.level3 || null, questionData.confidence || 0,
      questionData.ocrText || '', questionData.reasoning || '', questionData.status || 'pending',
      questionData.errorCount ?? 1, questionData.source || '',
      null, questionData.localAbsPath || null, questionData.reflection || null, questionData.errorType || null,
      questionData.hasGraphics ? 1 : 0, questionData.graphicImagePath || null,
      traceId, questionData.fileHash || null,
      new Date().toISOString(), questionData.status === 'confirmed' ? new Date().toISOString() : null
    )
  }

  // 仅 confirmed 才写本地 Markdown 与 Vault，避免 pending 阶段产生孤儿「未分类」笔记
  let localFilePath = ''
  let obsidianPath: string | undefined
  let vaultWrite = false

  if (questionData.status === 'confirmed') {
    const result = syncQuestionNotes(questionData.id)
    localFilePath = result.localPath
    obsidianPath = result.obsidianPath
    vaultWrite = result.vaultWrite
  }

  return { success: true, localPath: localFilePath, obsidianPath, vaultWrite }
}
