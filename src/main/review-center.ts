import crypto from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import { BrowserWindow, dialog } from 'electron'
import { getDb } from './db'
import { answerResultSql, timeStatusSql, performanceFilters } from './question-filters'
import { preparePaperSnapshot, generatePdf, type PaperSnapshot } from './pdf-generator'
import { localDateKey } from './date-utils'
import { completePlanTaskForActivity } from './daily-plan'

export interface ReviewSelection {
  count?: number; minutes?: number; ids?: string[]; excludeIds?: string[]; level1?: string; level2?: string; level3?: string
  answerResult?: string; timeStatus?: string; since?: string; until?: string; search?: string
}

export function rankReviewQuestions(rows: any[], now = Date.now()): any[] {
  return [...rows].map(row => {
    const age = Math.max(0, (now - Date.parse(row.last_reviewed_at || row.confirmed_at || row.created_at)) / 86400000) || 0
    const reason = !row.last_reviewed_at ? (row.last_read_at ? '看过解析，尚未记录独立作答' : '尚未记录独立复习') : `距上次独立复习 ${Math.floor(age)} 天`
    const recent = !!row.last_reviewed_at && age < 7
    const score = (!row.last_reviewed_at ? 100000 : Math.min(age, 365) * 30) + Math.max(0, row.error_count || 0) * 100 + Math.min(age, 365) - (recent ? 1000000 : 0)
    return { ...row, selection_reason: `${reason}${row.error_count > 1 ? ` · 曾错 ${row.error_count} 次` : ''}${row.error_count >= 3 ? ' · 先归纳易混点，再做少量针对题' : ''}`, selection_score: score }
  }).sort((a, b) => b.selection_score - a.selection_score || String(a.id).localeCompare(String(b.id)))
}

/** Keep eligible questions sharing one material together within the budget. */
export function selectReviewCandidates(rows: any[], count: number, minutes?: number) {
  const groups = new Map<string, any[]>()
  for (const row of rows) {
    const key = row.group_id ? `group:${row.group_id}` : `question:${row.id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  const picked: any[] = [], secondsBudget = minutes === undefined ? Infinity : minutes * 60
  let seconds = 0, skippedGroups = 0
  for (const unit of groups.values()) {
    const cost = unit.reduce((sum, row) => {
      let target = 90
      try { const saved = JSON.parse(row.original_answer || '{}'); if (Number.isFinite(saved.targetSeconds)) target = Math.max(30, Math.min(300, saved.targetSeconds)) } catch { /* estimate only */ }
      return sum + Math.max(120, Math.round(target * 1.5))
    }, unit[0].group_id ? 120 : 0)
    if (picked.length + unit.length > count || seconds + cost > secondsBudget) { if (unit[0].group_id) skippedGroups++; continue }
    picked.push(...unit); seconds += cost
  }
  return { picked, estimatedMinutes: Math.ceil(seconds / 60), skippedGroups }
}

export function createReviewBatch(params: ReviewSelection = {}): any {
  const db = getDb()
  const count = Math.max(1, Math.min(100, Math.floor(Number(params.count) || 20)))
  if (params.minutes !== undefined && (!Number.isInteger(params.minutes) || params.minutes < 5 || params.minutes > 180)) throw new Error('复习时间请选择 5～180 分钟')
  let ids: string[]
  let reasons: Record<string, string> = {}
  let available = 0
  let estimatedMinutes = 0, skippedGroups = 0
  if (params.ids !== undefined) {
    if (!Array.isArray(params.ids) || !params.ids.length || params.ids.length > 100 || params.ids.some(id => typeof id !== 'string' || !id)) throw new Error('请手动选择 1～100 道题')
    ids = [...new Set(params.ids)]
    available = ids.length
  } else {
    const filter = performanceFilters({ answerResult: params.answerResult || 'wrong', timeStatus: params.timeStatus })
    const conditions = ["status = 'confirmed'", ...filter.conditions]
    const values: any[] = [...filter.values]
    for (const field of ['level1', 'level2', 'level3'] as const) if (params[field]) { conditions.push(`${field} = ?`); values.push(params[field]) }
    for (const field of ['since', 'until'] as const) if (params[field]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(params[field]!)) throw new Error('日期范围无效')
      conditions.push(`date(COALESCE(confirmed_at, created_at), '+8 hours') ${field === 'since' ? '>=' : '<='} ?`)
      values.push(params[field])
    }
    if (params.search?.trim()) { conditions.push('(ocr_text LIKE ? OR source LIKE ?)'); values.push(`%${params.search.trim()}%`, `%${params.search.trim()}%`) }
    const rows = db.prepare(`SELECT questions.*, ${answerResultSql} AS answer_result, ${timeStatusSql} AS time_status,
      (SELECT MAX(completed_at) FROM review_batch_items WHERE question_id = questions.id) AS last_read_at
      FROM questions WHERE ${conditions.join(' AND ')}`).all(...values) as any[]
    // A completed paper / online speed attempt also counts as actual practice, not export.
    const lastPractice = new Map<string, string>()
    for (const attempt of db.prepare('SELECT question_ids, created_at FROM test_attempts ORDER BY created_at DESC').all() as any[]) {
      try { for (const id of JSON.parse(attempt.question_ids)) if (!lastPractice.has(id)) lastPractice.set(id, attempt.created_at) } catch { /* old record */ }
    }
    for (const attempt of db.prepare('SELECT question_id, MAX(created_at) AS created_at FROM speed_training_attempts GROUP BY question_id').all() as any[]) {
      if (!lastPractice.has(attempt.question_id) || lastPractice.get(attempt.question_id)! < attempt.created_at) lastPractice.set(attempt.question_id, attempt.created_at)
    }
    const excluded = new Set(params.excludeIds || [])
    const ranked = rankReviewQuestions(rows.filter(q => !excluded.has(q.id)).map(q => ({ ...q, last_reviewed_at: [q.last_reviewed_at, lastPractice.get(q.id)].filter(Boolean).sort().pop() || null })))
    available = ranked.length
    const selection = selectReviewCandidates(ranked, params.minutes === undefined ? count : 100, params.minutes)
    estimatedMinutes = selection.estimatedMinutes; skippedGroups = selection.skippedGroups
    ids = selection.picked.map(q => q.id)
    reasons = Object.fromEntries(selection.picked.map(q => [q.id, q.selection_reason]))
  }
  if (!ids.length) throw new Error('当前范围没有适合题量／时间预算的完整题组，请增加预算或手动选题；不会重复凑题')
  const snapshot = preparePaperSnapshot(ids)
  const batchIds = snapshot.questions.map(q => q.id)
  const id = crypto.randomUUID()
  const title = `${localDateKey()} 复习清单 · ${batchIds.length} 题`
  const createdAt = new Date().toISOString()
  db.transaction(() => {
    db.prepare('INSERT INTO review_batches (id, title, question_ids, snapshot_json, filters_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, title, JSON.stringify(batchIds), JSON.stringify(snapshot), JSON.stringify(params), createdAt)
    const insert = db.prepare('INSERT INTO review_batch_items (batch_id, question_id) VALUES (?, ?)')
    for (const questionId of batchIds) insert.run(id, questionId)
  })()
  return { ...getReviewBatch(id), available, requestedCount: params.ids || params.minutes !== undefined ? batchIds.length : count, reasons, estimatedMinutes, skippedGroups }
}

export function getReviewBatch(id: string): any {
  const row = getDb().prepare('SELECT * FROM review_batches WHERE id = ?').get(id) as any
  if (!row) throw new Error('复习清单不存在，请重新生成')
  const snapshot = JSON.parse(row.snapshot_json) as PaperSnapshot
  return { id: row.id, title: row.title, questionIds: JSON.parse(row.question_ids), questions: snapshot.questions, filters: JSON.parse(row.filters_json), groupCount: snapshot.groups.length, createdAt: row.created_at, completedAt: row.completed_at, files: JSON.parse(row.files_json) }
}

export function listReviewBatches(): any[] {
  return (getDb().prepare("SELECT id, title, question_ids, files_json, created_at, completed_at FROM review_batches WHERE files_json != '[]' OR completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 30").all() as any[]).map(row => ({ id: row.id, title: row.title, questionIds: JSON.parse(row.question_ids), files: JSON.parse(row.files_json), createdAt: row.created_at, completedAt: row.completed_at }))
}

export function completeReviewBatch(id: string): any {
  const db = getDb()
  const batch = getReviewBatch(id)
  if (batch.completedAt) return { success: true, alreadyCompleted: true, completedAt: batch.completedAt }
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('UPDATE review_batches SET completed_at = ? WHERE id = ? AND completed_at IS NULL').run(now, id)
    db.prepare('UPDATE review_batch_items SET completed_at = ? WHERE batch_id = ?').run(now, id)
  })()
  const completedPlanTask = completePlanTaskForActivity('review', ['复盘'], batch.questionIds.length)
  return { success: true, completedAt: now, completedPlanTask }
}

export async function exportReviewBatch(params: { batchId: string; format: 'pdf' | 'html'; content: 'none' | 'answer' | 'analysis' | 'full'; splitAnswers?: boolean; title?: string; pageSize?: 'A4' | 'Letter'; includeAnswerSheet?: boolean }, onProgress?: (stage: string, done?: number, total?: number) => void): Promise<any> {
  if (!['pdf', 'html'].includes(params.format) || !['none', 'answer', 'analysis', 'full'].includes(params.content)) throw new Error('导出设置无效')
  const db = getDb()
  const row = db.prepare('SELECT * FROM review_batches WHERE id = ?').get(params.batchId) as any
  if (!row) throw new Error('复习清单不存在')
  const snapshot = JSON.parse(row.snapshot_json) as PaperSnapshot
  const ids = snapshot.questions.map(q => q.id)
  const split = params.format === 'pdf' && params.content !== 'none' && params.splitAnswers !== false
  const documentTitle = String(params.title || row.title)
  const title = documentTitle.replace(/[<>:"/\\|?*]/g, '_').slice(0, 70)
  const owner = BrowserWindow.getFocusedWindow()
  const temporary: string[] = [], written: string[] = [], imageErrors: string[] = []
  let destination: string
  if (split) {
    const options = { title: '选择题目卷和解析卷的保存文件夹', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (selected.canceled || !selected.filePaths[0]) return { success: true, canceled: true, files: [] }
    destination = selected.filePaths[0]
  } else {
    const options = { defaultPath: `${title}.${params.format === 'html' ? 'html' : 'pdf'}`, filters: [{ name: params.format === 'html' ? '离线连续阅读页' : 'PDF', extensions: [params.format] }] }
    const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (selected.canceled || !selected.filePath) return { success: true, canceled: true, files: [] }
    destination = selected.filePath
  }
  try {
    const imageCache = new Map<string, string>()
    const variants = split ? [{ suffix: '题目', answerMode: 'none' as const, solutionsOnly: false }, { suffix: '答案解析', answerMode: params.content, solutionsOnly: true }] : [{ suffix: '', answerMode: params.content, solutionsOnly: false }]
    const stamp = crypto.randomUUID().slice(0, 8)
    for (const variant of variants) {
      const output = await generatePdf(ids, { title: documentTitle + (variant.suffix ? ` · ${variant.suffix}` : ''), answerMode: variant.answerMode, pageSize: params.pageSize === 'Letter' ? 'Letter' : 'A4', includeAnswerSheet: !!params.includeAnswerSheet && !variant.solutionsOnly, imageMode: 'auto', format: params.format, readerId: row.id, solutionsOnly: variant.solutionsOnly, reviewLayout: true }, onProgress, snapshot, imageCache)
      if (!output.success || !output.filePath) throw new Error(output.error || '文档生成失败')
      temporary.push(output.filePath)
      imageErrors.push(...output.imageErrors)
    }
    for (let i = 0; i < temporary.length; i++) {
      const file = split ? path.join(destination, `${title}-${stamp}-${variants[i].suffix}.pdf`) : destination
      // Save dialog confirms overwrites for a single file; split filenames are unique.
      fs.copyFileSync(temporary[i], file, split ? fs.constants.COPYFILE_EXCL : 0)
      written.push(file)
    }
    const previous = JSON.parse(row.files_json) as string[]
    db.prepare('UPDATE review_batches SET files_json = ? WHERE id = ?').run(JSON.stringify([...new Set([...previous, ...written])]), row.id)
    return { success: true, files: written, imageErrors: [...new Set(imageErrors)], questionIds: ids }
  } catch (error) {
    // Only discard newly-created split files, never a user-chosen overwrite destination.
    if (split) for (const file of written) fs.removeSync(file)
    throw error
  } finally { for (const file of temporary) fs.removeSync(file) }
}
