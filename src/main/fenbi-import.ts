import { BrowserWindow, Notification, session } from 'electron'
import crypto from 'crypto'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { getDb } from './db'
import { logger } from './logger'
import { generateReflection } from './ai'
import { saveMarkdown, storeImage } from './storage'
import { generateTraceId } from './utils'
import { parseJson } from './question-data'
import { localDateKey } from './date-utils'
import { completePlanTasksFromFenbi } from './daily-plan'
import { readFenbiReportPage, readFenbiPageReadiness, validateFenbiReport } from './fenbi-page'
import { readConfig, writeConfig } from './config'
import { attachFenbiResponseReader } from './fenbi-network'

const FENBI_PARTITION = 'persist:fenbi-import'
const FENBI_HOME = 'https://www.fenbi.com/spa/tiku/report/profile/xingce/xingce/history'

let fenbiWindow: BrowserWindow | null = null
let fenbiAnalysisRunning = false
let responseReader: ReturnType<typeof attachFenbiResponseReader> | null = null

export function fenbiAnalysisStatus() {
  const db = getDb()
  const counts = db.prepare(`SELECT
    SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN status = 'classified' AND analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status = 'classified' AND analysis_status = 'complete' THEN 1 ELSE 0 END) AS ready
    FROM questions WHERE import_source = 'fenbi'`).get() as any
  return { queued: counts.queued || 0, failed: counts.failed || 0, ready: counts.ready || 0,
    running: fenbiAnalysisRunning, paused: readConfig('fenbi_analysis_paused') === 'true' }
}

export function controlFenbiAnalysis(action: 'pause' | 'resume' | 'retry-failed') {
  if (!['pause', 'resume', 'retry-failed'].includes(action)) throw new Error('无效的后台任务操作')
  if (action === 'retry-failed') getDb().prepare("UPDATE questions SET status = 'processing', analysis_status = 'queued', analysis_error = NULL WHERE import_source = 'fenbi' AND status = 'classified' AND analysis_status = 'failed'").run()
  writeConfig('fenbi_analysis_paused', action === 'pause' ? 'true' : 'false')
  if (action !== 'pause') startFenbiAnalysisQueue()
  return fenbiAnalysisStatus()
}

type FenbiAnalysisEvent = { stage: 'started' | 'progress' | 'complete' | 'paused'; total: number; done: number; failed: number; message: string }

function broadcastFenbiAnalysis(event: FenbiAnalysisEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('fenbi:analysisProgress', event)
  }
}

/**
 * Process persisted Fenbi questions after the fast capture phase. The `processing`
 * status doubles as a durable queue, so an interrupted job resumes on next launch.
 */
export function startFenbiAnalysisQueue(): void {
  if (fenbiAnalysisRunning || readConfig('fenbi_analysis_paused') === 'true') return
  fenbiAnalysisRunning = true
  void (async () => {
    const db = getDb()
    const totalRow = db.prepare("SELECT COUNT(*) AS count FROM questions WHERE import_source = 'fenbi' AND status = 'processing'").get() as { count: number }
    let total = totalRow.count
    if (!total) { fenbiAnalysisRunning = false; return }
    let done = 0
    let failed = 0
    broadcastFenbiAnalysis({ stage: 'started', total, done, failed, message: `已保存 ${total} 道题，正在后台生成复盘` })

    while (true) {
      if (readConfig('fenbi_analysis_paused') === 'true') break
      const row = db.prepare(`SELECT questions.*,
        (SELECT passage_text FROM question_groups WHERE id = questions.group_id) AS group_passage_text,
        (SELECT material_images FROM question_groups WHERE id = questions.group_id) AS group_material_images
        FROM questions WHERE import_source = 'fenbi' AND status = 'processing' ORDER BY created_at LIMIT 1`).get() as any
      if (!row) break
      try {
        let answer: any = {}
        try { answer = JSON.parse(row.original_answer || '{}') } catch { /* legacy data */ }
        const reflection = await generateReflection({
          level1: row.level1,
          level2: row.level2,
          level3: row.level3,
          ocrText: row.ocr_text || '',
          materialText: row.group_passage_text || '',
          imageUrls: [...parseJson<string[]>(row.group_material_images, []), ...parseJson<string[]>(row.question_images, []), ...Object.values(parseJson<Record<string, string[]>>(row.option_images, {})).filter(Array.isArray).flat()],
          errorType: row.error_type || answer.weaknessType || '',
          traceId: row.trace_id || row.id,
          officialAnalysis: row.original_analysis || '',
          correctAnswer: answer.correct,
          userAnswer: answer.user,
          answerTime: answer.answerTime,
          correctRate: answer.correctRate,
          difficulty: answer.reportDifficulty,
          timingBasis: answer.timingBasis,
          groupActualSeconds: answer.groupActualSeconds,
          groupTargetSeconds: answer.groupTargetSeconds,
          groupGraceSeconds: answer.groupGraceSeconds
        })
        db.prepare("UPDATE questions SET reflection = ?, status = 'classified', analysis_status = 'complete', analysis_error = NULL WHERE id = ? AND status = 'processing'").run(reflection, row.id)
      } catch (error: any) {
        failed++
        // Never leave a permanently blocked queue item. It remains reviewable and
        // the user can regenerate its reflection from the question detail later.
        db.prepare("UPDATE questions SET status = 'classified', analysis_status = 'failed', analysis_error = ? WHERE id = ? AND status = 'processing'").run(error.message || '分析失败', row.id)
        logger.warn('fenbi', 'background_reflection_failed', error.message, { questionId: row.id }, row.trace_id)
      }
      done++
      const pending = (db.prepare("SELECT COUNT(*) AS count FROM questions WHERE import_source = 'fenbi' AND status = 'processing'").get() as { count: number }).count
      total = Math.max(total, done + pending)
      broadcastFenbiAnalysis({ stage: 'progress', total, done, failed, message: `粉笔题分析 ${done}/${total}` })
    }

    if (readConfig('fenbi_analysis_paused') === 'true') {
      fenbiAnalysisRunning = false
      broadcastFenbiAnalysis({ stage: 'paused', total, done, failed, message: '后台分析已暂停，未完成题目已保留' })
      return
    }
    const ready = Math.max(0, done - failed)
    const message = `粉笔题后台分析完成，${done} 道题已进入待确认${failed ? `，${failed} 道可在详情中重新生成复盘` : ''}`
    logger.info('fenbi', 'background_analysis_complete', message, { total, done, ready, failed })
    broadcastFenbiAnalysis({ stage: 'complete', total, done, failed, message })
    if (Notification.isSupported()) new Notification({ title: '粉笔错题分析完成', body: `${done} 道题已准备好，点击应用中的“待确认”查看。` }).show()
    fenbiAnalysisRunning = false
  })().catch(error => {
    fenbiAnalysisRunning = false
    logger.error('fenbi', 'background_analysis_crashed', error?.message || String(error))
  })
}

function isFenbiWindowAlive(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed()
}

function assertFenbiWindowAlive(win: BrowserWindow | null | undefined): asserts win is BrowserWindow {
  if (!isFenbiWindowAlive(win)) throw new Error('粉笔窗口已关闭，请重新打开粉笔后再试')
}

export interface FenbiQuestionPreview {
  sourceId: string
  index: number
  materialIndex: number
  stem: string
  options: Array<{ key: string; text: string }>
  correctAnswer: string
  userAnswer: string
  isWrong: boolean | null
  analysis: string
  keypoints: string[]
  source: string
  answerTime: string
  correctRate: string
  errorProne: string
  questionType: string
  questionImages: string[]
  optionImages: Record<string, string[]>
  analysisImages?: string[]
  suggestedSeconds?: number
  isOvertime?: boolean
  overtimeSeconds?: number
  timingBasis?: 'question' | 'group'
  groupActualSeconds?: number
  groupTargetSeconds?: number
  groupGraceSeconds?: number
}

export interface FenbiPreview {
  exerciseId: string
  title: string
  url: string
  materials: Array<{ index: number; text: string; images: string[] }>
  questions: FenbiQuestionPreview[]
  duplicateIds: string[]
  summary?: { total: number | null; correct: number | null; wrong: number | null; unanswered: number | null }
  difficulty?: number | null
}

function ensureFenbiWindow(): BrowserWindow {
  if (isFenbiWindowAlive(fenbiWindow)) return fenbiWindow
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: '粉笔错题导入',
    webPreferences: {
      partition: FENBI_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  fenbiWindow = win
  responseReader = attachFenbiResponseReader(win.webContents)
  win.on('closed', () => {
    responseReader?.dispose(); responseReader = null
    if (fenbiWindow === win) fenbiWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([a-z0-9-]+\.)?fenbi\.com\//i.test(url)) {
      if (isFenbiWindowAlive(win)) void win.loadURL(url)
    }
    return { action: 'deny' }
  })
  return win
}

export async function openFenbiImporter(): Promise<{ success: boolean; url: string }> {
  const win = ensureFenbiWindow()
  if (!win.webContents.getURL()) await win.loadURL(FENBI_HOME)
  assertFenbiWindowAlive(win)
  win.show()
  win.focus()
  return { success: true, url: win.webContents.getURL() }
}

function previewFingerprint(exerciseId: string, question: Pick<FenbiQuestionPreview, 'index' | 'stem' | 'correctAnswer'>): string {
  return crypto.createHash('sha256')
    .update(`fenbi|${exerciseId}|${question.index}|${question.stem}|${question.correctAnswer}`)
    .digest('hex')
}

function compatibleFingerprints(exerciseId: string, question: Pick<FenbiQuestionPreview, 'index' | 'stem' | 'correctAnswer'>): string[] {
  // Older DOM extraction flattened paragraph boundaries. Preserve deduplication
  // for those imports while retaining readable paragraphs in new records.
  return [...new Set([question.stem, question.stem.replace(/\n+/g, ''), question.stem.replace(/\n+/g, ' ')]
    .map(stem => previewFingerprint(exerciseId, { ...question, stem })))]
}

function resolveChineseCategory(keypoints: string[], context = ''): { level1: string; level2: string; level3: string | null } {
  try {
    const row = getDb().prepare('SELECT data FROM tag_tree ORDER BY id DESC LIMIT 1').get() as { data: string } | undefined
    const tree = row ? JSON.parse(row.data)?.tree || [] : []
    const wanted = new Set(keypoints.map(point => point.trim()).filter(Boolean))
    const walk = (nodes: any[], parents: string[]): string[] | null => {
      for (const node of nodes || []) {
        const current = [...parents, String(node.name || '').trim()].filter(Boolean)
        if (wanted.has(String(node.name || '').trim())) return current
        const nested = walk(node.children || [], current)
        if (nested) return nested
      }
      return null
    }
    const matched = walk(tree, [])
    if (matched?.length) return { level1: matched[0], level2: matched[1] || keypoints[0] || '待确认', level3: matched[2] || null }
  } catch { /* fall through to keyword mapping */ }

  const joined = `${keypoints.join(' ')} ${context}`
  const mappings: Array<[RegExp, string]> = [
    [/资料|增长|比重|基期|现期|平均数|倍数/, '资料分析'],
    [/图形推理|定义判断|类比推理|逻辑判断|判断推理/, '判断推理'],
    [/言语|逻辑填空|片段阅读|语句|主旨|意图/, '言语理解'],
    [/数量|数学运算|工程|行程|概率|排列组合/, '数量关系'],
    [/常识|法律|民法|刑法|行政法|宪法|科技|化学|物理|生物|人文|地理|经济常识/, '常识判断'],
    [/政治理论|理论与政策|时政|新思想|重要会议|重要文件|党的|党史|毛中特|马克思|唯物|哲学|社会建设|生态文明建设|经济建设|其他建设|中国特色社会主义/, '政治理论']
  ]
  const level1 = mappings.find(([pattern]) => pattern.test(joined))?.[1] || '待确认'
  const useful = keypoints.filter(point => point !== level1 && !['文字资料', '统计图'].includes(point))
  return { level1, level2: useful[0] || keypoints[0] || '待确认', level3: useful[1] || null }
}

export function repairStoredFenbiCategories(): number {
  const db = getDb()
  const rows = db.prepare("SELECT id, level1, source, original_answer FROM questions WHERE import_source = 'fenbi'").all() as Array<{ id: string; level1: string; source: string; original_answer: string }>
  const update = db.prepare('UPDATE questions SET level1 = ?, level2 = ?, level3 = ? WHERE id = ?')
  let repaired = 0
  for (const row of rows) {
    try {
      const answer = JSON.parse(row.original_answer || '{}')
      const category = resolveChineseCategory(Array.isArray(answer.keypoints) ? answer.keypoints : [], row.source || '')
      if (category.level1 === '待确认' || row.level1 !== '待确认') continue
      update.run(category.level1, category.level2, category.level3, row.id)
      repaired++
    } catch { /* 忽略旧数据中的异常字段 */ }
  }
  if (repaired) logger.info('fenbi', 'category_repaired', `已修复 ${repaired} 道粉笔题的一级分类`)
  return repaired
}

function parseAnswerSeconds(value?: string): number | null {
  if (!value) return null
  const minutes = Number(value.match(/(\d+(?:\.\d+)?)\s*分/)?.[1] || 0)
  const seconds = Number(value.match(/(\d+(?:\.\d+)?)\s*秒/)?.[1] || 0)
  if (minutes || seconds) return Math.round(minutes * 60 + seconds)
  const plain = Number(value.match(/\d+(?:\.\d+)?/)?.[0])
  return Number.isFinite(plain) ? Math.round(plain) : null
}

function suggestedQuestionSeconds(question: FenbiQuestionPreview): number {
  const rate = Number(question.correctRate.match(/\d+(?:\.\d+)?/)?.[0])
  let seconds = Number.isFinite(rate)
    ? rate >= 80 ? 60 : rate >= 65 ? 75 : rate >= 45 ? 90 : rate >= 25 ? 105 : 120
    : 90
  // The site's coefficient scale is not verified. Preserve/display it, but do
  // not treat a 0..1 coefficient as a five-star rating and change time limits.
  if (question.keypoints.some(point => /综合分析/.test(point))) seconds += 15
  return Math.max(55, Math.min(135, Math.round(seconds / 5) * 5))
}

function annotateEfficiency(preview: Pick<FenbiPreview, 'title' | 'questions' | 'difficulty'>): FenbiQuestionPreview[] {
  const enriched = preview.questions.map(question => ({ ...question, suggestedSeconds: suggestedQuestionSeconds(question) }))
  const dataGroups = new Map<number, FenbiQuestionPreview[]>()
  for (const question of enriched) {
    if (question.materialIndex < 1 || resolveChineseCategory(question.keypoints, preview.title).level1 !== '资料分析') continue
    const group = dataGroups.get(question.materialIndex) || []
    group.push(question)
    dataGroups.set(question.materialIndex, group)
  }
  for (const group of dataGroups.values()) {
    const actual = group.reduce((sum, question) => sum + (parseAnswerSeconds(question.answerTime) || 0), 0)
    const target = group.reduce((sum, question) => sum + (question.suggestedSeconds || 90), 0)
    const grace = Math.max(30, Math.round(target * 0.1))
    const completeTiming = group.every(question => parseAnswerSeconds(question.answerTime) !== null)
    const groupOvertime = completeTiming && actual > target + grace
    const slowest = group.reduce<FenbiQuestionPreview | null>((current, question) => {
      const delta = (parseAnswerSeconds(question.answerTime) || 0) - (question.suggestedSeconds || 90)
      const currentDelta = current ? (parseAnswerSeconds(current.answerTime) || 0) - (current.suggestedSeconds || 90) : -Infinity
      return delta > currentDelta ? question : current
    }, null)
    for (const question of group) {
      const seconds = parseAnswerSeconds(question.answerTime)
      question.timingBasis = 'group'
      question.groupActualSeconds = completeTiming ? actual : undefined
      question.groupTargetSeconds = target
      question.groupGraceSeconds = grace
      // 整组未超时，不因组内时间分配差异惩罚单题；整组超时后只标记明显拖慢的小题。
      question.isOvertime = groupOvertime && seconds !== null && (seconds > (question.suggestedSeconds || 90) + 15 || question === slowest)
      question.overtimeSeconds = question.isOvertime && seconds !== null ? Math.max(0, seconds - (question.suggestedSeconds || 90)) : 0
    }
  }
  for (const question of enriched) {
    if (question.timingBasis === 'group') continue
    const seconds = parseAnswerSeconds(question.answerTime)
    const target = question.suggestedSeconds || 90
    question.timingBasis = 'question'
    question.isOvertime = seconds !== null && seconds > target + 15
    question.overtimeSeconds = question.isOvertime && seconds !== null ? Math.max(0, seconds - target) : 0
  }
  return enriched
}

export function getFenbiGroupEfficiencyRecords(): any[] {
  return (getDb().prepare("SELECT id, title, practice_summary, created_at FROM question_groups WHERE group_type = 'fenbi' AND practice_summary IS NOT NULL ORDER BY created_at DESC LIMIT 30").all() as any[]).flatMap(row => {
    try { return [{ id: row.id, title: row.title, ...JSON.parse(row.practice_summary) }] } catch { return [] }
  })
}

function getEfficiencyInfo(question: FenbiQuestionPreview): { seconds: number | null; targetSeconds: number; isOvertime: boolean; overtimeSeconds: number; timingBasis: 'question' | 'group'; groupActualSeconds?: number; groupTargetSeconds?: number; groupGraceSeconds?: number } {
  const seconds = parseAnswerSeconds(question.answerTime)
  const targetSeconds = question.suggestedSeconds || (question.keypoints.some(point => /综合分析/.test(point)) ? 120 : 90)
  return {
    seconds,
    targetSeconds,
    isOvertime: question.isOvertime ?? (seconds !== null && seconds > targetSeconds + 15),
    overtimeSeconds: question.overtimeSeconds ?? (seconds === null ? 0 : Math.max(0, seconds - targetSeconds)),
    timingBasis: question.timingBasis || 'question',
    groupActualSeconds: question.groupActualSeconds,
    groupTargetSeconds: question.groupTargetSeconds,
    groupGraceSeconds: question.groupGraceSeconds
  }
}

/** Reject navigation/marketing fragments accidentally captured as an answer analysis. */
function normalizeFenbiAnalysis(raw?: string): string {
  if (!raw) return ''
  const cleaned = raw
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(?:视频|粉笔(?:行测)?|会员|收藏|笔记|下载\s*APP|\d+\s*人已开通)$/i.test(line))
    .join('\n')
    .replace(/^(?:答案)?解析\s*[：:]?\s*/, '')
    .trim()
  if (cleaned.length < 20) return ''
  const hasExplanation = /(?:本题|根据|可知|因此|所以|故|选项|排除|代入|计算|正确|错误|答案|解析|题干|由此)/.test(cleaned)
  const onlyPageNoise = /(?:开通会员|人已开通|观看视频|下载.*APP|扫码|登录后|购买课程|粉笔公考)/i.test(cleaned) && !hasExplanation
  return !hasExplanation || onlyPageNoise || cleaned.length > 32000 ? '' : cleaned
}

export async function previewFenbiReport(): Promise<FenbiPreview> {
  const win = fenbiWindow
  if (!isFenbiWindowAlive(win)) throw new Error('请先打开粉笔，再进入一份已完成练习的“查看报告”页面')
  const url = win.webContents.getURL()
  if (!/fenbi\.com\/ti\/exam\/solution\//i.test(url)) {
    throw new Error('当前不是已完成练习报告。请在粉笔练习历史中打开一份“查看报告”，再点击预览')
  }

  let raw: any
  try {
    const started = Date.now()
    do {
      assertFenbiWindowAlive(win)
      raw = responseReader?.read(url) || await win.webContents.executeJavaScript('(' + readFenbiReportPage.toString() + ')()')
      if (!validateFenbiReport(raw)) break
      await new Promise(resolve => setTimeout(resolve, 400))
    } while (Date.now() - started < 15000)
    const problem = validateFenbiReport(raw)
    if (problem) {
      logger.warn('fenbi', 'report_incomplete', problem, {
        questionCount: raw?.questions?.length || 0, summary: raw?.summary,
        missingAnswers: raw?.questions?.filter((q: any) => q.isWrong === null).length || 0
      })
      throw new Error(problem)
    }
  } catch (error: any) {
    if (!isFenbiWindowAlive(win) || /destroyed/i.test(String(error?.message))) {
      throw new Error('粉笔窗口在读取报告时已关闭，请重新打开后再试')
    }
    throw error
  }

  if (!raw?.questions?.length) throw new Error('没有在当前报告中读取到题目，请等待页面加载完成后重试')
  if (raw.url !== url && raw.url) throw new Error('读取时粉笔报告已切换，请停留在同一份报告后重试')
  const exerciseId = String(url.match(/\/solution\/([^?]+)/)?.[1] || crypto.createHash('md5').update(url).digest('hex'))
  const questions = annotateEfficiency({ title: raw.title, difficulty: raw.difficulty, questions: raw.questions.map((question: any) => ({
    ...question,
    analysis: normalizeFenbiAnalysis(question.analysis),
    sourceId: previewFingerprint(exerciseId, question)
  })) })
  const db = getDb()
  const duplicateIds: string[] = []
  const findImported = db.prepare('SELECT id FROM questions WHERE import_fingerprint = ? LIMIT 1')
  // Preview is read-only; never overwrite confirmed/manual corrections.
  for (const question of questions) {
    if (!compatibleFingerprints(exerciseId, question).some(fingerprint => findImported.get(fingerprint))) continue
    duplicateIds.push(question.sourceId)

  }
  logger.info('fenbi', 'preview_success', `粉笔报告预览完成：${questions.length} 题`, { exerciseId, wrong: questions.filter(q => q.isWrong).length })
  return { exerciseId, ...raw, questions, duplicateIds }
}

export async function syncFenbiCurrentReport(practiceDate = localDateKey(), suppliedPreview?: FenbiPreview): Promise<{
  success: boolean; date: string; sessions: number; questions: number; correct: number; wrong: number; overtime: number; totalSeconds: number
  modules: Array<{ name: string; count: number; correct: number }>; summary: string; completedTasks: string[]; syncedAt: string
}> {
  const preview = suppliedPreview || await previewFenbiReport()
  const problem = validateFenbiReport(preview)
  if (problem) throw new Error(problem)
  const date = practiceDate
  const moduleStats: Record<string, { count: number; correct: number }> = {}
  let totalSeconds = 0
  let overtime = 0
  const points = new Set<string>()
  for (const question of preview.questions) {
    const category = resolveChineseCategory(question.keypoints, preview.title).level1
    moduleStats[category] ||= { count: 0, correct: 0 }
    moduleStats[category].count++
    if (question.isWrong === false) moduleStats[category].correct++
    totalSeconds += parseAnswerSeconds(question.answerTime) || 0
    if (getEfficiencyInfo(question).isOvertime) overtime++
    question.keypoints.forEach(point => points.add(point))
  }
  const correct = preview.questions.filter(question => question.isWrong === false).length
  getDb().prepare(`INSERT INTO fenbi_daily_sessions
    (exercise_id, practice_date, title, question_count, correct_count, total_seconds, wrong_count, overtime_count, modules_json, points_json, source_url, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(exercise_id) DO UPDATE SET practice_date=excluded.practice_date, title=excluded.title, question_count=excluded.question_count,
      correct_count=excluded.correct_count, total_seconds=excluded.total_seconds, wrong_count=excluded.wrong_count,
      overtime_count=excluded.overtime_count, modules_json=excluded.modules_json, points_json=excluded.points_json,
      source_url=excluded.source_url, synced_at=excluded.synced_at`)
    .run(preview.exerciseId, date, preview.title, preview.questions.length, correct, totalSeconds, preview.questions.length - correct, overtime, JSON.stringify(moduleStats), JSON.stringify([...points]), preview.url, new Date().toISOString())

  const rows = getDb().prepare('SELECT * FROM fenbi_daily_sessions WHERE practice_date = ? ORDER BY synced_at').all(date) as any[]
  const totals = { questions: 0, correct: 0, wrong: 0, overtime: 0, totalSeconds: 0 }
  const combined: Record<string, { count: number; correct: number }> = {}
  const allPoints = new Set<string>()
  for (const row of rows) {
    totals.questions += row.question_count; totals.correct += row.correct_count; totals.wrong += row.wrong_count; totals.overtime += row.overtime_count; totals.totalSeconds += row.total_seconds
    const rowModules = JSON.parse(row.modules_json || '{}')
    for (const [name, stat] of Object.entries(rowModules) as Array<[string, any]>) {
      combined[name] ||= { count: 0, correct: 0 }; combined[name].count += stat.count || 0; combined[name].correct += stat.correct || 0
    }
    try { JSON.parse(row.points_json || '[]').forEach((point: string) => allPoints.add(point)) } catch { /* ignore */ }
  }
  const modules = Object.entries(combined).map(([name, stat]) => ({ name, ...stat })).sort((a, b) => b.count - a.count)
  const accuracy = totals.questions ? Math.round(totals.correct / totals.questions * 100) : 0
  const weakModules = modules.filter(item => item.correct < item.count).map(item => `${item.name}${Math.round(item.correct / item.count * 100)}%`).join('、')
  const summary = `今天在粉笔完成 ${totals.questions} 题，正确 ${totals.correct} 题，正确率 ${accuracy}%，总用时 ${Math.floor(totals.totalSeconds / 60)} 分 ${totals.totalSeconds % 60} 秒。错题 ${totals.wrong} 道，超时题 ${totals.overtime} 道。${weakModules ? `需要优先关注：${weakModules}。` : '各模块正确率表现稳定。'}${allPoints.size ? ` 今日涉及考点：${[...allPoints].slice(0, 8).join('、')}。` : ''}`
  const completed = date === localDateKey()
    ? completePlanTasksFromFenbi(Object.fromEntries(Object.entries(combined).map(([name, stat]) => [name, stat.count])), summary)
    : []
  return { success: true, date, sessions: rows.length, ...totals, modules, summary, completedTasks: completed.map(task => task.title), syncedAt: new Date().toISOString() }
}

interface FenbiHistoryPractice {
  cardIndex: number
  date: string
  title: string
}

async function getCompletedPractices(win: BrowserWindow, startDate: string, endDate: string): Promise<FenbiHistoryPractice[]> {
  assertFenbiWindowAlive(win)
  if (!/fenbi\.com\/spa\/tiku\/report\/profile\/.*\/history/i.test(win.webContents.getURL())) {
    await win.loadURL(FENBI_HOME)
    await waitForFenbiPage(win)
  }
  const practices = await win.webContents.executeJavaScript(`(() => {
    const matches = element => /\\d{4}[.-]\\d{2}[.-]\\d{2}.*共\\s*\\d+\\s*题[，,]?\\s*答对\\s*\\d+\\s*题/.test((element.innerText || '').replace(/\\s+/g, ' '))
    return [...document.querySelectorAll('div,li')]
      .filter(matches)
      .filter(element => ![...element.children].some(matches))
      .map((element, cardIndex) => {
        const text = (element.innerText || '').replace(/\\s+/g, ' ').trim()
        const rawDate = text.match(/\\d{4}[.-]\\d{2}[.-]\\d{2}/)?.[0] || ''
        return { cardIndex, date: rawDate.replace(/\\./g, '-'), title: text }
      })
      .filter(item => item.date >= ${JSON.stringify(startDate)} && item.date <= ${JSON.stringify(endDate)})
  })()`)
  return Array.isArray(practices) ? practices : []
}

async function openCompletedPractice(win: BrowserWindow, cardIndex: number): Promise<void> {
  assertFenbiWindowAlive(win)
  const opened = await win.webContents.executeJavaScript(`(() => {
    const matches = element => /\\d{4}[.-]\\d{2}[.-]\\d{2}.*共\\s*\\d+\\s*题[，,]?\\s*答对\\s*\\d+\\s*题/.test((element.innerText || '').replace(/\\s+/g, ' '))
    const cards = [...document.querySelectorAll('div,li')]
      .filter(matches)
      .filter(element => ![...element.children].some(matches))
    const card = cards[${cardIndex}]
    if (!card) return false
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  })()`)
  if (!opened) throw new Error('粉笔练习记录已变化，请刷新后重试')
  const startedAt = Date.now()
  while (Date.now() - startedAt < 20000) {
    assertFenbiWindowAlive(win)
    if (/fenbi\.com\/ti\/exam\/solution\//i.test(win.webContents.getURL())) {
      await waitForFenbiPage(win)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error('粉笔练习报告未能打开')
}

export async function syncFenbiWrongQuestions(params: {
  startDate?: string
  endDate?: string
  includeCorrectOvertime?: boolean
}): Promise<{ scannedReports: number; failedReports: number; selected: number; imported: number; skipped: number; failed: number }> {
  const startDate = params.startDate || localDateKey()
  const endDate = params.endDate || startDate
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    throw new Error('请选择有效的同步日期范围')
  }
  const rangeDays = Math.floor((new Date(`${endDate}T00:00:00`).getTime() - new Date(`${startDate}T00:00:00`).getTime()) / 86400000) + 1
  if (rangeDays > 31) throw new Error('单次最多同步 31 天，请缩小日期范围')

  const win = ensureFenbiWindow()
  win.show()
  await win.loadURL(FENBI_HOME)
  await waitForFenbiPage(win)
  const practices = await getCompletedPractices(win, startDate, endDate)
  if (!practices.length) throw new Error('所选日期内没有找到已完成的粉笔练习')

  const totals = { scannedReports: practices.length, failedReports: 0, selected: 0, imported: 0, skipped: 0, failed: 0 }
  let firstFailure = ''
  for (const practice of practices) {
    try {
      await win.loadURL(FENBI_HOME)
      await waitForFenbiPage(win)
      await openCompletedPractice(win, practice.cardIndex)
      const preview = await previewFenbiReport()
      await syncFenbiCurrentReport(practice.date, preview)
      const selectedQuestions = preview.questions.filter(question => question.isWrong === true || (params.includeCorrectOvertime && question.isWrong === false && getEfficiencyInfo(question).isOvertime))
      totals.selected += selectedQuestions.length
      if (!selectedQuestions.length) continue
      const imported = await importFenbiQuestions({ preview, sourceIds: selectedQuestions.map(question => question.sourceId), generateReflections: true, deferQueueStart: true })
      totals.imported += imported.imported
      totals.skipped += imported.skipped
      totals.failed += imported.failed
    } catch (error: any) {
      totals.failedReports++
      firstFailure ||= error.message || '未知读取错误'
      logger.warn('fenbi', 'wrong_question_sync_failed', error.message, { practice })
    }
  }
  if (totals.failedReports === practices.length) throw new Error(`所有报告均读取失败：${firstFailure}`)
  if (totals.imported > 0) startFenbiAnalysisQueue()
  logger.info('fenbi', 'wrong_question_sync_complete', `粉笔错题同步完成：新增 ${totals.imported}，重复 ${totals.skipped}`, { startDate, endDate, ...totals })
  return totals
}

async function waitForFenbiPage(win: BrowserWindow, timeoutMs = 30000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    assertFenbiWindowAlive(win)
    try {
      const state = await win.webContents.executeJavaScript('(' + readFenbiPageReadiness.toString() + ')()')
      if (state.loginRequired) throw new Error('请先在粉笔窗口登录，再重新同步')
      if (state.ready) {
        assertFenbiWindowAlive(win)
        return
      }
    } catch (error: any) {
      if (!isFenbiWindowAlive(win) || /destroyed/i.test(String(error?.message))) {
        throw new Error('粉笔窗口已关闭，请重新打开粉笔后再试')
      }
      if (/请先在粉笔窗口登录/.test(String(error?.message))) throw error
      // 页面跳转期间脚本上下文会短暂失效，继续等待新页面即可。
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`粉笔练习记录或题目在 ${Math.round(timeoutMs / 1000)} 秒内未能加载完成，请检查登录和网络后重试`)
}

async function getTodayCompletedPracticeCount(win: BrowserWindow): Promise<number> {
  assertFenbiWindowAlive(win)
  if (!/fenbi\.com\/spa\/tiku\/report\/profile\/.*\/history/i.test(win.webContents.getURL())) {
    await win.loadURL(FENBI_HOME)
    await waitForFenbiPage(win)
  }
  assertFenbiWindowAlive(win)
  const count = await win.webContents.executeJavaScript(`(() => {
    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    const tokens = ['今天', now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()), now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()), (now.getMonth() + 1) + '月' + now.getDate() + '日']
    const matches = element => {
      const text = (element.innerText || '').replace(/\\s+/g, ' ')
      return tokens.some(token => text.includes(token)) && /共\\s*\\d+\\s*题[，,]?\\s*答对\\s*\\d+\\s*题/.test(text)
    }
    return [...document.querySelectorAll('div,li')]
      .filter(matches)
      .filter(element => ![...element.children].some(matches)).length
  })()`)
  return Number(count) || 0
}

async function openTodayCompletedPractice(win: BrowserWindow, index: number): Promise<void> {
  assertFenbiWindowAlive(win)
  const opened = await win.webContents.executeJavaScript(`(() => {
    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    const tokens = ['今天', now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()), now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()), (now.getMonth() + 1) + '月' + now.getDate() + '日']
    const matches = element => {
      const text = (element.innerText || '').replace(/\\s+/g, ' ')
      return tokens.some(token => text.includes(token)) && /共\\s*\\d+\\s*题[，,]?\\s*答对\\s*\\d+\\s*题/.test(text)
    }
    const cards = [...document.querySelectorAll('div,li')]
      .filter(matches)
      .filter(element => ![...element.children].some(matches))
    const card = cards[${index}]
    if (!card) return false
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  })()`)
  if (!opened) throw new Error(`未能打开今天的第 ${index + 1} 份练习`)
  const startedAt = Date.now()
  while (Date.now() - startedAt < 20000) {
    assertFenbiWindowAlive(win)
    if (/fenbi\.com\/ti\/exam\/solution\//i.test(win.webContents.getURL())) {
      await waitForFenbiPage(win)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`今天的第 ${index + 1} 份练习未能打开报告`)
}

export async function syncFenbiToday(): Promise<Awaited<ReturnType<typeof syncFenbiCurrentReport>> & { scannedReports: number; failedReports: number }> {
  const win = ensureFenbiWindow()
  win.show()
  const reportCount = await getTodayCompletedPracticeCount(win)
  if (!reportCount) throw new Error('今天没有找到已完成的练习。程序只统计显示“共 X 题，答对 X 题”的记录，不会统计“继续做题”。')
  let result: Awaited<ReturnType<typeof syncFenbiCurrentReport>> | null = null
  let failedReports = 0
  for (let index = 0; index < reportCount; index++) {
    try {
      assertFenbiWindowAlive(win)
      await win.loadURL(FENBI_HOME)
      await waitForFenbiPage(win)
      await openTodayCompletedPractice(win, index)
      result = await syncFenbiCurrentReport()
    } catch (error: any) {
      if (!isFenbiWindowAlive(win) || /destroyed|窗口已关闭/i.test(String(error?.message))) {
        throw new Error('自动同步已停止：粉笔窗口被关闭。请重新打开粉笔后再试')
      }
      failedReports++
      logger.warn('fenbi', 'daily_report_sync_failed', error.message, { index })
    }
  }
  if (!result) throw new Error('找到了今日练习，但未能读取报告内容。请打开其中一份“查看报告”后使用备用的“同步当前报告”。')
  return { ...result, scannedReports: reportCount, failedReports }
}

export function getFenbiTodaySummary(date = localDateKey()): any {
  const rows = getDb().prepare('SELECT * FROM fenbi_daily_sessions WHERE practice_date = ? ORDER BY synced_at').all(date) as any[]
  if (!rows.length) return null
  const modules: Record<string, { count: number; correct: number }> = {}
  let questions = 0, correct = 0, wrong = 0, overtime = 0, totalSeconds = 0
  for (const row of rows) {
    questions += row.question_count; correct += row.correct_count; wrong += row.wrong_count; overtime += row.overtime_count; totalSeconds += row.total_seconds
    const parsed = JSON.parse(row.modules_json || '{}')
    for (const [name, stat] of Object.entries(parsed) as Array<[string, any]>) { modules[name] ||= { count: 0, correct: 0 }; modules[name].count += stat.count || 0; modules[name].correct += stat.correct || 0 }
  }
  return { date, sessions: rows.length, questions, correct, wrong, overtime, totalSeconds, accuracy: questions ? Math.round(correct / questions * 100) : 0, modules: Object.entries(modules).map(([name, stat]) => ({ name, ...stat })), syncedAt: rows.at(-1)?.synced_at }
}

async function persistRemoteImage(url: string, traceId: string): Promise<{ imageUrl: string; localAbsPath?: string }> {
  if (!url || !/^https?:\/\//i.test(url)) return { imageUrl: url || '' }
  const response = await session.fromPartition(FENBI_PARTITION).fetch(url, { headers: { Referer: 'https://spa.fenbi.com/' }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`资料图片下载失败 HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') || 'image/png'
  if (!contentType.startsWith('image/')) throw new Error('粉笔图片地址未返回图片')
  if (Number(response.headers.get('content-length') || 0) > 20 * 1024 * 1024) throw new Error('粉笔图片超过20MB')
  const ext = contentType.includes('jpeg') ? '.jpg' : contentType.includes('webp') ? '.webp' : '.png'
  const tempPath = path.join(os.tmpdir(), `fenbi-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('粉笔图片为空或超过20MB')
  await fs.writeFile(tempPath, buffer)
  try {
    const stored = await storeImage(tempPath, traceId)
    return { imageUrl: stored.imageUrl, localAbsPath: stored.localAbsPath }
  } finally {
    fs.remove(tempPath).catch(() => undefined)
  }
}

export async function importFenbiQuestions(params: { preview: FenbiPreview; sourceIds: string[]; generateReflections?: boolean; deferQueueStart?: boolean }): Promise<{ imported: number; skipped: number; failed: number; ids: string[]; analysisQueued: number }> {
  const problem = validateFenbiReport(params.preview)
  if (problem) throw new Error(problem)
  const selected = new Set(params.sourceIds || [])
  const questions = params.preview.questions.filter(question => selected.has(question.sourceId))
  if (!questions.length) throw new Error('请至少选择一道题')
  const db = getDb()
  const ids: string[] = []
  let skipped = 0
  let failed = 0
  const materialCache = new Map<number, { groupId: string; imageUrls: string[]; localImage?: string }>()
  const imageCache = new Map<string, ReturnType<typeof persistRemoteImage>>()
  const storeAsset = (url: string, traceId: string) => {
    if (!imageCache.has(url)) imageCache.set(url, persistRemoteImage(url, traceId))
    return imageCache.get(url)!
  }

  for (const question of questions) {
    if (compatibleFingerprints(params.preview.exerciseId, question).some(fingerprint => db.prepare('SELECT 1 FROM questions WHERE import_fingerprint = ? LIMIT 1').get(fingerprint))) { skipped++; continue }
    const traceId = generateTraceId()
    let stagedId = ''
    try {
      let material = materialCache.get(question.materialIndex)
      if (!material) {
        const sourceMaterial = params.preview.materials.find(item => item.index === question.materialIndex)
        const storedImages: Array<{ imageUrl: string; localAbsPath?: string }> = []
        for (const image of sourceMaterial?.images || []) storedImages.push(await storeAsset(image, traceId))
        const hasSharedMaterial = !!sourceMaterial && (!!sourceMaterial.text || storedImages.length > 0)
        const groupId = hasSharedMaterial ? `fenbi-${params.preview.exerciseId}-${question.materialIndex}` : ''
        const imageUrls = storedImages.map(item => item.imageUrl)
        if (hasSharedMaterial) {
          const members = params.preview.questions.filter(q => q.materialIndex === question.materialIndex)
          const timing = members[0]
          const practiceSummary = JSON.stringify({
            questionCount: members.length, correctCount: members.filter(q => q.isWrong === false).length,
            actualSeconds: members.every(q => parseAnswerSeconds(q.answerTime) !== null) ? members.reduce((sum, q) => sum + (parseAnswerSeconds(q.answerTime) || 0), 0) : null,
            targetSeconds: timing?.groupTargetSeconds ?? members.reduce((sum, q) => sum + (q.suggestedSeconds || 90), 0),
            graceSeconds: timing?.groupGraceSeconds || 30, difficulty: params.preview.difficulty ?? null,
            capturedAt: new Date().toISOString(), ruleVersion: 'group-rate-reference-v2'
          })
          db.prepare(`INSERT OR IGNORE INTO question_groups (id, title, passage_image_url, passage_text, group_type, created_at, material_images)
            VALUES (?, ?, ?, ?, 'fenbi', ?, ?)`)
            .run(groupId, `${params.preview.title} · 资料${question.materialIndex}`, imageUrls[0] || '', sourceMaterial?.text || '', new Date().toISOString(), JSON.stringify(imageUrls))
          db.prepare('UPDATE question_groups SET practice_summary = COALESCE(practice_summary, ?) WHERE id = ?').run(practiceSummary, groupId)
        }
        material = { groupId, imageUrls, localImage: storedImages[0]?.localAbsPath }
        materialCache.set(question.materialIndex, material)
      }

      const id = `fenbi-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
      stagedId = id
      const storedQuestionImages: string[] = []
      for (const image of question.questionImages || []) storedQuestionImages.push((await storeAsset(image, traceId)).imageUrl)
      const storedOptionImages: Record<string, string[]> = {}
      for (const [key, images] of Object.entries(question.optionImages || {})) {
        storedOptionImages[key] = []
        for (const image of images) storedOptionImages[key].push((await storeAsset(image, traceId)).imageUrl)
      }
      // Keep formula images in their original position, with durable local copies.
      // An incomplete explanation is not safe reference material for AI.
      let storedAnalysis = normalizeFenbiAnalysis(question.analysis)
      for (const image of storedAnalysis ? question.analysisImages || [] : []) {
        try {
          const stored = await storeAsset(image, traceId)
          storedAnalysis = storedAnalysis.split(`<${image}>`).join(`<${stored.localAbsPath || stored.imageUrl}>`)
        } catch {
          storedAnalysis = ''
          logger.warn('fenbi', 'analysis_image_unavailable', '解析图片未能完整保存，本题不引用粉笔解析', { sourceId: question.sourceId }, traceId)
          break
        }
      }
      const optionText = question.options.map(option => `${option.key}. ${option.text}`).join('\n')
      const ocrText = [question.stem, optionText].filter(Boolean).join('\n\n')
      const efficiency = getEfficiencyInfo(question)
      const weaknessType = question.isWrong ? (efficiency.isOvertime ? '错误且超时' : '结果错误') : (efficiency.isOvertime ? '正确但超时' : '')
      const { level1, level2, level3 } = resolveChineseCategory(question.keypoints, params.preview.title)
      const queueAnalysis = params.generateReflections !== false
      await saveMarkdown({
        id,
        imageUrl: storedQuestionImages[0] || material.imageUrls[0] || '',
        localAbsPath: material.localImage,
        level1,
        level2,
        level3,
        confidence: 1,
        ocrText,
        reasoning: `粉笔结构化导入；原始考点：${question.keypoints.join(' / ')}`,
        reflection: '',
        errorCount: question.isWrong === false ? 0 : 1,
        source: question.source || `粉笔 · ${params.preview.title}`,
        errorType: weaknessType || undefined,
        traceId,
        status: 'capturing',
        hasGraphics: storedQuestionImages.length > 0 || Object.values(storedOptionImages).some(images => images.length > 0)
      })
      db.prepare(`UPDATE questions SET status = ?, source_snapshot = ?, analysis_status = ?, group_id = ?, question_number = ?, material_image_ids = ?, question_images = ?, option_images = ?, import_source = 'fenbi', import_fingerprint = ?, original_analysis = ?, original_answer = ? WHERE id = ?`)
        .run(queueAnalysis ? 'processing' : 'classified', JSON.stringify({ adapter: 'fenbi-report-v2', capturedAt: new Date().toISOString(), exerciseId: params.preview.exerciseId, question, material: params.preview.materials.find(item => item.index === question.materialIndex) || null }), queueAnalysis ? 'queued' : 'not_requested', material.groupId || null, String(question.index), JSON.stringify(material.imageUrls), JSON.stringify(storedQuestionImages), JSON.stringify(storedOptionImages), question.sourceId, storedAnalysis, JSON.stringify({ correct: question.correctAnswer, user: question.userAnswer, keypoints: question.keypoints, answerTime: question.answerTime, correctRate: question.correctRate, errorProne: question.errorProne, questionType: question.questionType, weaknessType, targetSeconds: efficiency.targetSeconds, overtimeSeconds: efficiency.overtimeSeconds, timingBasis: efficiency.timingBasis, groupActualSeconds: efficiency.groupActualSeconds, groupTargetSeconds: efficiency.groupTargetSeconds, groupGraceSeconds: efficiency.groupGraceSeconds, reportDifficulty: params.preview.difficulty }), id)
      ids.push(id)
    } catch (error: any) {
      // Only discard our incomplete staging row; never an existing imported item.
      if (stagedId) db.prepare("DELETE FROM questions WHERE id = ? AND status = 'capturing'").run(stagedId)
      failed++
      logger.error('fenbi', 'question_import_failed', error.message, { sourceId: question.sourceId }, traceId)
    }
  }
  if (ids.length > 0 && params.generateReflections !== false && !params.deferQueueStart) startFenbiAnalysisQueue()
  logger.info('fenbi', 'import_complete', `粉笔导入完成：${ids.length} 题，跳过 ${skipped} 题，失败 ${failed} 题`)
  return { imported: ids.length, skipped, failed, ids, analysisQueued: params.generateReflections === false ? 0 : ids.length }
}
