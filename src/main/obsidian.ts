import crypto from 'crypto'
import { readConfig } from './config'
import { logger } from './logger'
import { getDb } from './db'
import fs from 'fs-extra'
import path from 'path'
import { resolveInside, sanitizePathSegment } from './path-safety'
import { questionFileName } from './question-data'

// ─── Direct vault file writer (no plugin needed) ───
export function writeToVault(questionData: any): { success: boolean; vaultPath?: string; relativePath?: string } {
  const vaultRoot = readConfig('obsidian_vault')
  if (!vaultRoot) return { success: false }

  const level1 = sanitizePathSegment(questionData.level1, '其他')
  const level2 = questionData.level2 ? sanitizePathSegment(questionData.level2, '') : ''
  const level3 = questionData.level3 ? sanitizePathSegment(questionData.level3, '') : ''
  // Always use full category path
  const subdir = level3 ? `${level1}/${level2}/${level3}` : level2 ? `${level1}/${level2}` : level1

  const fileName = questionFileName(questionData.id)
  const relativePath = subdir ? `${subdir}/${fileName}` : fileName
  let fullPath = ''
  const markdown = questionData.markdown || ''
  const traceId = questionData.traceId || null

  try {
    fullPath = resolveInside(vaultRoot, relativePath)
    const dirPath = path.dirname(fullPath)
    // Handle case where a file exists at the directory path (e.g. from old writes)
    if (fs.existsSync(dirPath) && !fs.statSync(dirPath).isDirectory()) {
      throw new Error(`目标目录被同名文件占用: ${dirPath}`)
    }
    fs.ensureDirSync(dirPath)
    if (fs.existsSync(fullPath)) {
      const existing = fs.readFileSync(fullPath, 'utf-8')
      const owner = existing.match(/^question_id:\s*(.+)$/m)?.[1]
      if (owner !== JSON.stringify(String(questionData.id))) throw new Error('目标笔记不属于当前题目，已保留原文件')
    }
    const temporary = `${fullPath}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, markdown, { encoding: 'utf-8', flag: 'wx' })
      fs.renameSync(temporary, fullPath)
    } finally { if (fs.existsSync(temporary)) fs.removeSync(temporary) }
    logger.info('vault', 'write_success', `写入 vault: ${fullPath}`, null, traceId)
    return { success: true, vaultPath: fullPath, relativePath }
  } catch (err: any) {
    logger.error('vault', 'write_failed', `写入失败: ${err.message}`, { path: fullPath }, traceId)
    return { success: false }
  }
}

export function vaultOnline(): boolean {
  const vaultRoot = readConfig('obsidian_vault')
  if (!vaultRoot) return false
  try {
    return fs.existsSync(vaultRoot)
  } catch { return false }
}

// Reorganize existing vault files to match current category structure
export function reorganizeVault(): { moved: number; skipped: number } {
  const vaultRoot = readConfig('obsidian_vault')
  if (!vaultRoot) return { moved: 0, skipped: 0 }

  const db = getDb()
  const questions = db.prepare("SELECT id, level1, level2, level3, obsidian_path FROM questions WHERE obsidian_path IS NOT NULL AND obsidian_path != ''").all() as any[]
  let moved = 0; let skipped = 0

  for (const q of questions) {
    const oldFullPath = resolveInside(vaultRoot, q.obsidian_path)
    if (!fs.existsSync(oldFullPath)) { skipped++; continue }
    const owners = db.prepare('SELECT COUNT(*) c FROM questions WHERE obsidian_path = ?').get(q.obsidian_path) as { c: number }
    if (owners.c > 1) { skipped++; continue }

    const level1 = sanitizePathSegment(q.level1, '其他')
    const level2 = q.level2 ? sanitizePathSegment(q.level2, '') : ''
    const level3 = q.level3 ? sanitizePathSegment(q.level3, '') : ''
    const subdir = level3 ? `${level1}/${level2}/${level3}` : level2 ? `${level1}/${level2}` : level1
    const fileName = path.basename(q.obsidian_path)
    const newRelativePath = `${subdir}/${fileName}`
    const newFullPath = resolveInside(vaultRoot, newRelativePath)

    if (oldFullPath === newFullPath) { skipped++; continue }

    try {
      const newDir = path.dirname(newFullPath)
      if (fs.existsSync(newDir) && !fs.statSync(newDir).isDirectory()) {
        throw new Error('目标目录被文件占用，已保留原文件')
      }
      fs.ensureDirSync(newDir)
      fs.moveSync(oldFullPath, newFullPath, { overwrite: false })
      db.prepare('UPDATE questions SET obsidian_path = ? WHERE id = ?').run(newRelativePath, q.id)
      logger.info('vault', 'reorganize', `移动: ${q.obsidian_path} → ${newRelativePath}`)
      moved++
    } catch (err: any) {
      logger.warn('vault', 'reorganize_skip', `跳过: ${q.obsidian_path} (${err.message})`)
      skipped++
    }
  }

  return { moved, skipped }
}
