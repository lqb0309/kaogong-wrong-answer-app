import { readConfig } from './config'
import { logger } from './logger'
import { getDb } from './db'
import { uploadToEasyImage } from './easyimage'
import { writeToVault } from './obsidian'
import { enqueueVaultWrite } from './retry-queue'
import fs from 'fs-extra'
import path from 'path'
import dayjs from 'dayjs'
import { app } from 'electron'
import sharp from 'sharp'

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
    const maxDim = 2048
    if ((metadata.width && metadata.width > maxDim) || (metadata.height && metadata.height > maxDim)) {
      pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    }
    if (destExt === '.webp') {
      await pipeline.webp({ quality: Math.round(quality * 100) }).toFile(destPath)
    } else if (destExt === '.png') {
      await pipeline.png({ quality: Math.round(quality * 100), compressionLevel: 9 }).toFile(destPath)
    } else {
      await pipeline.jpeg({ quality: Math.round(quality * 100), mozjpeg: true }).toFile(destPath)
    }
    const newStat = fs.statSync(destPath)
    const newSizeKB = newStat.size / 1024
    const savedPct = Math.round((1 - newSizeKB / sizeKB) * 100)
    logger.info('upload', 'image_compressed', `图片压缩: ${Math.round(sizeKB)}KB → ${Math.round(newSizeKB)}KB (${savedPct}%)`, { originalSize: Math.round(sizeKB), compressedSize: Math.round(newSizeKB), savedPct, quality }, traceId)
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
  const level1 = data.level1 || '未分类'
  const level2 = data.level2 || ''
  const level3 = data.level3 || ''
  const imageUrl = data.imageUrl || ''
  const tagPath = [level1, level2, level3].filter(Boolean)
  const wikiLinkPath = tagPath.map(t => `[[${t}]]`).join(' » ')
  const flatTags = ['行测/错题', ...tagPath]
  const tagYaml = flatTags.map(t => `  - ${t}`).join('\n')
  const date = dayjs().format('YYYY-MM-DD')
  const title = data.fileName?.replace('.md', '') || `${dayjs().format('YYYYMMDD-HHmmss')}`
  return `---
tags:
${tagYaml}
status: wrong
error_count: ${data.errorCount || 1}
confidence: ${data.confidence || 0}
date: ${date}
source: "${data.source || ''}"
---

# ${title}

**分类**: ${wikiLinkPath || '未分类'}
**日期**: ${date} | **错误次数**: ${data.errorCount || 1} | **置信度**: ${Math.round((data.confidence || 0) * 100)}%
${data.errorType ? `**错误类型**: ${data.errorType}\n` : ''}
${imageUrl ? `![错题图片](${imageUrl})` : ''}

${data.ocrText ? `> [!quote] OCR 原文\n> ${data.ocrText}\n` : ''}
${data.reflection ? `\n> [!danger] 复盘反思\n> ${data.reflection}\n` : ''}

---
${data.source ? `*来源: ${data.source}*` : ''}
`
}

// 生成不冲突的文件名（避免同一秒批量入库互相覆盖）
function uniqueFileName(dir: string, fileName: string): string {
  if (!fs.existsSync(path.join(dir, fileName))) return fileName
  const ext = path.extname(fileName)
  const base = fileName.slice(0, -ext.length)
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
  return `${base}-${Date.now()}${ext}`
}

// ─── Unified save ───
export async function saveMarkdown(questionData: any): Promise<{ success: boolean; localPath: string; obsidianPath?: string; vaultWrite: boolean }> {
  const traceId = questionData.traceId || null
  const db = getDb()

  // Write to SQLite（无论 pending/classified/confirmed 都记录）
  if (db) {
    db.prepare(`
      INSERT OR REPLACE INTO questions (id, image_url, level1, level2, level3, confidence, ocr_text, reasoning,
        status, error_count, source, obsidian_path, local_image_path, reflection, error_type, has_graphics, graphic_image_path, trace_id, file_hash, created_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      questionData.id, questionData.imageUrl || '', questionData.level1 || '未分类',
      questionData.level2 || '', questionData.level3 || null, questionData.confidence || 0,
      questionData.ocrText || '', questionData.reasoning || '', questionData.status || 'pending',
      questionData.errorCount || 1, questionData.source || '',
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
    const { notesDir } = ensureDirs()
    const level1 = questionData.level1 || '未分类'
    const subDir = path.join(notesDir, level1)
    fs.ensureDirSync(subDir)
    const fileName = uniqueFileName(subDir, questionData.fileName || `${dayjs().format('YYYYMMDD-HHmmss')}.md`)
    localFilePath = path.join(subDir, fileName)
    const markdown = buildMarkdown(questionData)
    fs.writeFileSync(localFilePath, markdown, 'utf-8')
    logger.info('storage', 'local_write_success', `本地写入: ${localFilePath}`, null, traceId)

    const result = writeToVault({ ...questionData, markdown })
    if (result.success) {
      obsidianPath = result.vaultPath
      vaultWrite = true
      logger.info('storage', 'vault_write_success', `Vault 写入: ${result.vaultPath}`, null, traceId)
      if (db && result.relativePath) {
        db.prepare('UPDATE questions SET obsidian_path = ? WHERE id = ?').run(result.relativePath, questionData.id)
      }
    } else {
      // Vault 不可用 → 进入离线重试队列，恢复后自动补写（PRD 离线可用）
      enqueueVaultWrite({ ...questionData, id: questionData.id, traceId }, markdown)
    }
  }

  return { success: true, localPath: localFilePath, obsidianPath, vaultWrite }
}
