import { getDb } from './db'
import { readConfig, writeConfig } from './config'
import { decryptToken } from './safe-storage'
import { logger } from './logger'
import OpenAI from 'openai'
import { recordAiUsage } from './ai-usage'
import { fitPlanTasks, taskKind, type PlanTask } from './plan-policy'
import { aiOutputOptions, adjustmentSchema, forwardSchema, parseValidatedAi } from './ai-validation'
import { studyCalendarDay } from './study-calendar'
export type { PlanTask } from './plan-policy'

// ============ 每日备考计划（AI 动态调整） ============

export interface PlanAdjustmentInput { feedback?: string }

export type PlanStatus = 'pending' | 'partial' | 'completed'

export interface DailyPlan {
  date: string
  tasks: PlanTask[]
  status: PlanStatus
  note: string
  ai_adjusted: boolean
  adjustment_reason: string
  created_at: string
  updated_at: string
}

export interface PlanHistoryItem {
  date: string
  status: PlanStatus
  note: string
  ai_adjusted: boolean
  adjustment_reason: string
  tasks_total: number
  tasks_done: number
}

const MODULES = ['资料分析', '判断推理', '言语理解', '数量关系', '常识判断', '政治理论', '申论', '复盘', '其他'] as const

/** 本地时区日期字符串 YYYY-MM-DD（计划按"本地天"算，不能用 toISOString 的 UTC） */
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 距离国考笔试的天数（config: plan_exam_date，默认 2026-11-25，可在页面修改） */
export function getExamInfo(): { exam_date: string; days_until: number } {
  const examDate = readConfig('plan_exam_date') || '2026-11-25'
  const target = parseDate(examDate)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.max(0, Math.round((target.getTime() - todayStart.getTime()) / 86400000))
  return { exam_date: examDate, days_until: days }
}

/** 从某个日期算起到国考还有多少天 */
function daysUntilFrom(dateStr: string, examDate?: string): number {
  const exam = examDate || (readConfig('plan_exam_date') || '2026-11-25')
  return Math.max(0, Math.round((parseDate(exam).getTime() - parseDate(dateStr).getTime()) / 86400000))
}

function addDaysStr(dateStr: string, days: number): string {
  const d = parseDate(dateStr)
  d.setDate(d.getDate() + days)
  return localDateStr(d)
}

/** 倒排阶段：基础阶段(>60天) → 强化阶段(31-60天) → 冲刺阶段(≤30天) → 已到考前 */
export type PlanPhaseName = '基础阶段' | '强化阶段' | '冲刺阶段' | '已到考前'

export interface ExamPhase {
  name: PlanPhaseName
  days_left: number
  phase_start: string
  phase_end: string
  phase_days_left: number
  focus: string
  milestones: Array<{ date: string; label: string; type: 'phase' | 'exam' | 'info' }>
}

const PHASE_FOCUS: Record<string, string> = {
  '基础阶段': '模块轮换打基础，做题后留足复盘；优先弄懂薄弱点，不按固定题量堆任务',
  '强化阶段': '专项提速与套题交替；行测、申论套题分天，做题与复盘时间 1:1 至 1:1.5',
  '冲刺阶段': '套题检验节奏，复盘优先；时间不够就减量或单独复盘，不补偿式加练'
}

export function getExamPhase(): ExamPhase {
  const { exam_date, days_until } = getExamInfo()
  const strongStart = addDaysStr(exam_date, -60)
  const sprintStart = addDaysStr(exam_date, -30)

  const name: PlanPhaseName = days_until > 60 ? '基础阶段' : days_until > 30 ? '强化阶段' : days_until > 0 ? '冲刺阶段' : '已到考前'
  const phase_start = name === '基础阶段' ? localDateStr() : name === '强化阶段' ? strongStart : sprintStart
  const phase_end = name === '基础阶段' ? strongStart : name === '强化阶段' ? sprintStart : exam_date
  const phase_days_left = Math.max(0, Math.round((parseDate(phase_end).getTime() - parseDate(localDateStr()).getTime()) / 86400000))

  const milestones: ExamPhase['milestones'] = [
    { date: strongStart, label: '基础阶段结束 → 进入强化阶段', type: 'phase' },
    { date: sprintStart, label: '强化阶段结束 → 进入冲刺阶段', type: 'phase' },
    { date: exam_date, label: '国考笔试', type: 'exam' },
    { date: '2026-10-15', label: '国考报名开始（预计 10 月 15-24 日，勿错过）', type: 'info' }
  ]

  return {
    name,
    days_left: days_until,
    phase_start,
    phase_end,
    phase_days_left,
    focus: PHASE_FOCUS[name] || '',
    milestones
  }
}

function weekDayName(dateStr: string): string {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[parseDate(dateStr).getDay()]
}

const calendarDayInfo = studyCalendarDay

function calendarDayDescription(dateStr: string): string {
  const info = calendarDayInfo(dateStr)
  return `${weekDayName(dateStr)}，${info.label}，建议总时长 ≤ ${info.maxMinutes} 分钟`
}

// ============ 默认计划（规则生成，无需 AI） ============

function buildDefaultPlan(dateStr: string): DailyPlan {
  const day = calendarDayInfo(dateStr)
  const dayIndex = Math.floor(parseDate(dateStr).getTime() / 86400000)
  const now = new Date().toISOString()
  let tasks: PlanTask[]
  if (day.kind !== 'workday') {
    // 行测、申论分天；假期交替，普通周六行测、周日申论。
    const essay = day.kind === 'weekend' ? day.scheduleWeekDay === 0 : dayIndex % 2 !== 0
    const review = day.maxMinutes >= 300 ? 180 : 120
    tasks = [
      { id: 't1', title: essay ? '申论完整套题' : '行测全真模拟', detail: '只做这一套题，按所选试卷时限完成；若试卷时限更长，应另留足复盘时间或分日复盘，不追加模块训练。', minutes: 120, module: essay ? '申论' : '其他', kind: 'practice', done: 0 },
      { id: 't2', title: essay ? '申论复盘与归纳' : '行测复盘与归纳', detail: essay ? '对照参考答案核对采分点、材料提炼与表达，归纳下次的作答框架，不抄整篇答案。' : '核对错题与耗时点，区分知识缺口、方法和节奏问题，选重点归纳；不是只记录正确率。', minutes: review, module: '复盘', kind: 'review', done: 0 }
    ]
  } else if (day.scheduleWeekDay === 3) {
    tasks = [
      { id: 't1', title: '申论小题练习', detail: '只练一类小题，控字数、提炼材料要点。', minutes: 30, module: '申论', kind: 'practice', done: 0 },
      { id: 't2', title: '申论小题复盘', detail: '对照采分点，归纳漏点与表达问题，练习后留足复盘。', minutes: 45, module: '复盘', kind: 'review', done: 0 }
    ]
  } else {
    const module = dayIndex % 2 === 0 ? '判断推理' : '政治理论'
    tasks = [
      { id: 't1', title: '资料分析一组训练', detail: '按整组计时，题量根据当前熟练程度选择，不追求凑题数。', minutes: 15, module: '资料分析', kind: 'practice', done: 0 },
      { id: 't2', title: module + '少量专项练习', detail: '集中一个薄弱点，到时停止，把时间留给复盘。', minutes: 20, module, kind: 'practice', done: 0 },
      { id: 't3', title: '复盘与归纳总结', detail: '核对答案，重点分析错题与耗时点，归纳下次做法；不逐题抄解析。', minutes: 53, module: '复盘', kind: 'review', done: 0 }
    ]
  }
  // 较短休息日采用最低 1:1，300 分钟套题日与工作日默认 1:1.5。
  const fitted = fitPlanTasks(tasks, { remainingMinutes: day.maxMinutes, reviewRatio: day.kind !== 'workday' && day.maxMinutes < 300 ? 1 : 1.5 })
  return { date: dateStr, tasks: fitted.tasks, status: 'pending', note: '', ai_adjusted: false,
    adjustment_reason: fitted.warnings.join(' '), created_at: now, updated_at: now }
}

// ============ 数据存取 ============

function rowToPlan(row: any): DailyPlan {
  return {
    date: row.date,
    tasks: JSON.parse(row.tasks_json || '[]') as PlanTask[],
    status: row.status as PlanStatus,
    note: row.note || '',
    ai_adjusted: !!row.ai_adjusted,
    adjustment_reason: row.adjustment_reason || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

function insertPlan(plan: DailyPlan): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO daily_plans (date, tasks_json, status, note, ai_adjusted, adjustment_reason, created_at, updated_at)
    VALUES (@date, @tasks_json, @status, @note, @ai_adjusted, @adjustment_reason, @created_at, @updated_at)
  `).run({
    date: plan.date,
    tasks_json: JSON.stringify(plan.tasks),
    status: plan.status,
    note: plan.note,
    ai_adjusted: plan.ai_adjusted ? 1 : 0,
    adjustment_reason: plan.adjustment_reason,
    created_at: plan.created_at,
    updated_at: plan.updated_at
  })
}

function loadPlan(dateStr: string): DailyPlan | null {
  const row = getDb().prepare('SELECT * FROM daily_plans WHERE date = ?').get(dateStr)
  return row ? rowToPlan(row) : null
}

/** 查找今天之前最近的一条计划 */
function loadPreviousPlan(before: string): DailyPlan | null {
  const row = getDb().prepare('SELECT * FROM daily_plans WHERE date < ? ORDER BY date DESC LIMIT 1').get(before)
  return row ? rowToPlan(row) : null
}

function isCompleted(plan: DailyPlan): boolean {
  if (plan.status === 'completed') return true
  const total = plan.tasks.length
  if (total === 0) return false
  const done = plan.tasks.filter(t => t.done).length
  return done === total
}

function gapDays(prevDate: string, today: string): number {
  const diff = (parseDate(today).getTime() - parseDate(prevDate).getTime()) / 86400000
  return Math.max(0, Math.round(diff))
}

// ============ 结构化计划记忆（滚动归纳，不向 AI 倾倒原始历史） ============

const DEFAULT_PLAN_MEMORY_PREFERENCES = '在职备考；工作日约 90 分钟；一天只安排行测或申论其中一类完整套题；复盘优先，做题与复盘时间 1:1 至 1:1.5；补任务替换新任务，不叠加；状态不好时主动减量，不要求每天所有模块都练。'

function planningRules(): string {
  return `【必须遵守的安排边界】\n一天最多一类完整套题，行测与申论分开。套题日只做该套题与复盘，不追加每日刷题或补课。默认做题:复盘=1:1.5，最低1:1；复盘包含核对答案、错因分析、耗时点与归纳总结。时间不够则减少新题或改为复盘日，不能缩短完整套题用时来凑预算。未完成任务只替换新任务，不能叠加。用户已完成的任务不能重排；不要强制每天资料分析和政治刷题。临时反馈只影响今天；明确长期习惯才可归纳进长期偏好。`
}

function actualPracticeMinutes(date: string): number {
  const row = getDb().prepare('SELECT SUM(total_seconds) AS seconds FROM fenbi_daily_sessions WHERE practice_date = ?').get(date) as { seconds?: number } | undefined
  return Math.ceil(Number(row?.seconds || 0) / 60)
}

function remainingBudget(prev: DailyPlan, today: string): number {
  if (prev.date !== today) return calendarDayInfo(today).maxMinutes
  const done = prev.tasks.filter(t => t.done)
  const recorded = actualPracticeMinutes(today)
  const nonPractice = done.filter(t => taskKind(t) !== 'practice').reduce((n, t) => n + t.minutes, 0)
  const spent = Math.max(done.reduce((n, t) => n + t.minutes, 0), recorded + nonPractice)
  return Math.max(0, calendarDayInfo(today).maxMinutes - spent)
}

function safePlanTasks(raw: string): PlanTask[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function normalizeAnswer(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

/** 生成紧凑的近 14 天记忆，每次生成计划时自动刷新。 */
function buildPlanningMemoryText(before: string): string {
  const planRows = getDb().prepare('SELECT * FROM daily_plans WHERE date < ? ORDER BY date DESC LIMIT 14').all(before) as any[]
  let totalTasks = 0
  let doneTasks = 0
  const unfinishedModules = new Map<string, number>()
  const feedback: string[] = []
  let completedDays = 0
  let partialDays = 0
  let missedDays = 0

  for (const row of planRows) {
    const tasks = safePlanTasks(row.tasks_json)
    totalTasks += tasks.length
    doneTasks += tasks.filter(task => task.done).length
    if (row.status === 'completed') completedDays++
    else if (row.status === 'partial') partialDays++
    else missedDays++
    for (const task of tasks.filter(item => !item.done)) {
      const module = task.module || '其他'
      unfinishedModules.set(module, (unfinishedModules.get(module) || 0) + 1)
    }
    if (row.note?.trim() && feedback.length < 3) feedback.push(`${row.date}：${String(row.note).trim().slice(0, 100)}`)
  }

  const questionRows = getDb().prepare(`
    SELECT level1, error_type, original_answer FROM questions
    WHERE status = 'confirmed' AND created_at >= datetime(?, '-14 days') AND created_at < datetime(?, '+1 day')
  `).all(before, before) as Array<{ level1?: string; error_type?: string; original_answer?: string }>
  const modules = new Map<string, { total: number; wrong: number; overtime: number }>()
  for (const row of questionRows) {
    const module = row.level1?.trim() || '待确认'
    const item = modules.get(module) || { total: 0, wrong: 0, overtime: 0 }
    let answer: any = {}
    try { answer = JSON.parse(row.original_answer || '{}') } catch { /* 旧数据无结构化答案 */ }
    const correct = normalizeAnswer(answer.correct)
    const user = normalizeAnswer(answer.user)
    const type = row.error_type || answer.weaknessType || ''
    const isWrong = (correct && user && correct !== user) || /结果错误|错误且超时/.test(type)
    const isOvertime = Number(answer.overtimeSeconds || 0) > 0 || /超时/.test(type)
    item.total++
    if (isWrong) item.wrong++
    if (isOvertime) item.overtime++
    modules.set(module, item)
  }

  const completionRate = totalTasks ? Math.round(doneTasks / totalTasks * 100) : 0
  const unfinished = [...unfinishedModules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, count]) => `${name}${count}项`).join('、') || '无明显积压'
  const performance = [...modules.entries()].sort((a, b) => (b[1].wrong + b[1].overtime) - (a[1].wrong + a[1].overtime)).slice(0, 6)
    .map(([name, item]) => `${name}：收录${item.total}题，错${item.wrong}题，超时${item.overtime}题`).join('\n') || '（近 14 天无已确认题目）'
  const preferences = readConfig('plan_memory_preferences')?.trim() || DEFAULT_PLAN_MEMORY_PREFERENCES
  const futureNote = readConfig('plan_future_note')?.trim() || '无'
  const corrections = readConfig('plan_user_corrections') || '[]'

  return `【固定偏好】${preferences}
【用户明确更正的长期偏好（最新更正优先）】${corrections}
【近 14 天执行概况】记录 ${planRows.length} 天；完成率 ${completionRate}%（完成 ${completedDays} 天、部分完成 ${partialDays} 天、未完成 ${missedDays} 天）
【反复未完成模块】${unfinished}
【错题与超时分布】
${performance}
【最近用户反馈（注意日期，临时情况不要当作长期限制）】${feedback.length ? feedback.join('；') : '无'}
【延续安排】${futureNote}`
}

// ============ AI 动态调整 ============

function buildAdjustPrompt(prev: DailyPlan, today: string, input: PlanAdjustmentInput = {}): string {
  const exam = getExamInfo()
  const phase = getExamPhase()
  const doneCount = prev.tasks.filter(t => t.done).length
  const gap = gapDays(prev.date, today)

  const taskLines = prev.tasks.map(t =>
    `- [${t.done ? 'x' : ' '}] ${t.title}（${t.minutes}分钟，${t.module}）${t.detail ? '——' + t.detail : ''}`
  ).join('\n')

  return `【今天的日期】${today}（${weekDayName(today)}）
【倒排目标】国考笔试 ${exam.exam_date}，距今约 ${exam.days_until} 天
【当前阶段】${phase.name}（本阶段还剩约 ${phase.phase_days_left} 天）
${phase.focus ? '【阶段重点】' + phase.focus : ''}
【距上次计划】${gap === 0 ? '今天' : gap === 1 ? '昨天' : gap + ' 天前'}

【个人计划记忆】
${buildPlanningMemoryText(today)}
${planningRules()}
【本次用户更正】${input.feedback || '无额外更正'}
【默认剩余时间预算】${remainingBudget(prev, today)} 分钟；若用户明确告知剩余时间，以用户为准，不要自己扩充预算
【今天粉笔已记录做题时长】${actualPracticeMinutes(today)} 分钟，需为实际已做题目预留复盘
${prev.date === today ? '只生成未完成任务，已完成任务将由程序原样保留。' : ''}

【上次计划与完成情况】
日期: ${prev.date}
日期类型: ${calendarDayDescription(prev.date)}
状态: ${prev.status === 'completed' ? '全部完成' : prev.status === 'partial' ? '部分完成' : '未完成'}（${doneCount}/${prev.tasks.length} 项完成）
用户备注: ${prev.note || '（无）'}
任务列表:
${taskLines}

【今天的日期类型】${calendarDayDescription(today)}

请根据以上信息，生成今天的备考计划：
- 如果最近有未完成，主动调整任务量和顺序，帮助恢复节奏（不要苛责，不要安排得过满）
- 考虑当前倒排阶段：基础阶段以模块训练为主、强化阶段提速、冲刺阶段以套卷和复盘为主
- 优先复盘；模块轮换，套题与复盘占满预算时不要安排额外模块
- 每个任务给出：title、detail、minutes、module、kind(practice/review/other)。不要把做题和复盘合并成一项
- 从用户自然语言中提取 remaining_minutes（今天还剩多少分钟；未说明则不输出，0代表休息），review_ratio（仅1或1.5，默认1.5），review_only（只复盘/今天不做新题时true）。不要安排用户明确拒绝的内容
- 只输出 JSON：{"tasks": [...], "adjustment_summary": "一句话说明调整", "future_note": "后续安排", "remaining_minutes":90, "review_ratio":1.5,"review_only":false}
- 不要输出 JSON 以外的内容`
}

/** 调用 AI 生成调整后的计划；失败返回 null（由调用方回退到默认计划） */
async function adjustWithAi(prev: DailyPlan, today: string, input: PlanAdjustmentInput = {}): Promise<{ plan: DailyPlan; summary: string; futureNote: string } | null> {
  const reasonKey = readConfig('ai_api_key')
  const reasonURL = readConfig('ai_base_url') || 'https://api.deepseek.com'
  const reasonModel = readConfig('ai_model') || 'deepseek-chat'
  const fallbackKey = readConfig('vision_api_key')

  if (!reasonKey && !fallbackKey) {
    logger.warn('daily_plan', 'no_ai', '未配置 AI，跳过计划调整，使用默认计划')
    return null
  }

  const apiKey = decryptToken(reasonKey || fallbackKey || '')
  const baseURL = reasonKey ? reasonURL : (readConfig('vision_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  const model = reasonKey ? reasonModel : (readConfig('vision_model') || 'qwen-vl-max')

  const client = new OpenAI({ apiKey, baseURL, timeout: 90_000, maxRetries: 0 })

  try {
    logger.info('daily_plan', 'adjust_start', `AI 调整 ${today} 的计划`, { model, prevDate: prev.date })
    let parsed: any = null
    for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: '你是一位务实、尊重用户精力的备考教练。优先消化已做题目，不用任务数量制造压力。不苛责、不补偿式加量。按用户更正、实际用时和时间预算安排，区分临时情况与长期习惯，只输出完整 JSON，不输出思考过程。'
        },
        { role: 'user', content: buildAdjustPrompt(prev, today, input) + (attempt ? '\n上次输出不合格，请只输出完整JSON，所有分钟必须是数字，模块使用给定中文名称。' : '') }
      ],
      response_format: { type: 'json_object' },
      ...aiOutputOptions(baseURL, model, 2500, attempt + 1)
    })
    recordAiUsage(resp, 'daily_plan', reasonKey ? 'reason' : 'vision', model)

    try {
      parsed = parseValidatedAi(resp.choices[0]?.message?.content || '', adjustmentSchema, resp.choices[0]?.finish_reason)
      break
    } catch (error: any) {
      logger.warn('daily_plan', 'adjust_parse_failed', 'AI 计划未通过字段校验', { attempt: attempt + 1, error: error.message })
    }
    }
    if (!parsed) return null

    const tasks = normalizeAiTasks(parsed.tasks)
    if (!tasks) {
      logger.warn('daily_plan', 'adjust_empty', 'AI 未返回有效任务，回退默认计划')
      return null
    }

    const feedback = input.feedback || ''
    const completed = prev.date === today ? prev.tasks.filter(t => t.done) : []
    const hasTimeCorrection = /(?:还剩|只剩|剩余|还能|可用|只有|最多|再学|再花|有).{0,8}(?:\d+|[一二三四五六七八九十半两]+)\s*(?:个)?(?:分钟|小时)/.test(feedback)
    const requestedMinutes = Number(parsed.remaining_minutes)
    const budget = requestedMinutes === 0 && /休息|没时间|收工|不学/.test(feedback) ? 0
      : hasTimeCorrection && Number.isFinite(requestedMinutes) && requestedMinutes >= 0
        ? Math.min(600, Math.floor(requestedMinutes)) : /(?:今天|今日).{0,12}(?:上班|工作日|补班)/.test(feedback) ? Math.min(90, remainingBudget(prev, today)) : remainingBudget(prev, today)
    const ratio = parsed.review_ratio === 1 ? 1 : 1.5
    const reviewOnly = parsed.review_only === true || /只.{0,8}复盘|不做(?:新)?题|不刷题/.test(feedback)
    const fitted = fitPlanTasks(reviewOnly ? tasks.filter(t => taskKind(t) !== 'practice') : tasks, {
      remainingMinutes: budget, reviewRatio: ratio, completed, actualPracticeMinutes: actualPracticeMinutes(today)
    })
    const now = new Date().toISOString()
    const plan: DailyPlan = {
      date: today,
      tasks: fitted.tasks,
      status: fitted.tasks.length > 0 && fitted.tasks.every(t => t.done) ? 'completed' : completed.length > 0 ? 'partial' : 'pending',
      note: prev.date === today ? prev.note : '',
      ai_adjusted: true,
      adjustment_reason: [typeof parsed.adjustment_summary === 'string' ? parsed.adjustment_summary : '已按实际情况调整今天的计划', ...fitted.warnings, fitted.tasks.length === completed.length ? '今天不再新增任务，可以收工。' : ''].filter(Boolean).join('\n'),
      created_at: prev.date === today ? prev.created_at : now,
      updated_at: now
    }
    logger.info('daily_plan', 'adjust_done', `AI 计划生成完成: ${tasks.length} 项任务`, { model })
    return { plan, summary: plan.adjustment_reason, futureNote: typeof parsed.future_note === 'string' ? parsed.future_note.trim() : '' }
  } catch (err: any) {
    logger.error('daily_plan', 'adjust_failed', `AI 调整失败: ${err.message}`, { model })
    return null
  }
}

function normalizeAiTasks(raw: any): PlanTask[] | null {
  if (!Array.isArray(raw)) return null
  const tasks: PlanTask[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (!title || seen.has(title)) continue
    seen.add(title)
    const minutes = Math.min(300, Math.max(5, Math.ceil(Number(item.minutes) || 30)))
    const module = MODULES.includes(item.module) ? item.module : (typeof item.module === 'string' && item.module ? item.module : '其他')
    tasks.push({
      id: `t${tasks.length + 1}`,
      title,
      detail: typeof item.detail === 'string' ? item.detail.trim() : '',
      minutes,
      module,
      kind: ['practice', 'review', 'other'].includes(item.kind) ? item.kind : undefined,
      done: 0
    })
  }
  return raw.length > 0 && tasks.length === 0 ? null : tasks
}

/** 规则回退：把昨天没完成的任务顺延到今天（最多 2 项，去掉大块套卷类） */
function carryOverUnfinished(prev: DailyPlan | null, base: DailyPlan): DailyPlan {
  if (!prev || isCompleted(prev)) return base
  const undone = prev.tasks.filter(t => !t.done && t.minutes <= 60)
  const carry = undone.slice(0, 2).map((t, i) => ({
    ...t,
    id: `c${i + 1}`,
    title: `（补）${t.title}`,
    detail: (t.detail ? t.detail + '；' : '') + '昨天未完成，今天优先补上',
    done: 0 as const
  }))
  if (carry.length === 0) return base
  // 补任务替换当天练习；套题日不补，绝不直接追加到原任务单。
  if (base.tasks.some(t => t.minutes >= 100 && taskKind(t) === 'practice')) return base
  const fitted = fitPlanTasks([...carry, ...base.tasks.filter(t => taskKind(t) === 'review')], {
    remainingMinutes: calendarDayInfo(base.date).maxMinutes, reviewRatio: 1.5
  })
  return { ...base, tasks: fitted.tasks, adjustment_reason: ['未完成任务已替换今天的新练习，不额外加量。', ...fitted.warnings].join(' ') }
}

// ============ 对外接口 ============

const pendingPlans: Record<string, Promise<DailyPlan> | undefined> = {}

/** 获取今天的计划：已存在直接返回；不存在则生成（之前未完成时走 AI 调整） */
export function ensureTodayPlan(): Promise<DailyPlan> {
  return ensurePlanFor(localDateStr())
}

/** 获取/生成指定日期的计划（可预生成明天的，让"之后的计划"也动态调整） */
export function ensurePlanFor(dateStr: string): Promise<DailyPlan> {
  const existing = pendingPlans[dateStr]
  if (existing) return existing
  const p = doEnsurePlanFor(dateStr).finally(() => { delete pendingPlans[dateStr] })
  pendingPlans[dateStr] = p
  return p
}

async function doEnsurePlanFor(dateStr: string): Promise<DailyPlan> {
  const existing = loadPlan(dateStr)
  if (existing) return existing

  const prev = loadPreviousPlan(dateStr)
  let plan: DailyPlan | null = null

  if (prev && !isCompleted(prev)) {
    // 上次未完成 → AI 动态调整
    const adjusted = await adjustWithAi(prev, dateStr)
    plan = adjusted?.plan || null
    if (adjusted?.futureNote) writeConfig('plan_future_note', adjusted.futureNote)
  }

  if (!plan) {
    // 首次使用 / 上次完成 / AI 失败 → 默认规则计划（上次未完成时顺延任务）
    plan = carryOverUnfinished(prev, buildDefaultPlan(dateStr))
  }

  insertPlan(plan)
  logger.info('daily_plan', 'plan_ready', `计划已生成: ${dateStr}（${plan.tasks.length} 项，AI调整=${plan.ai_adjusted}）`)
  return plan
}

/** 勾选/取消任务 */
export function updatePlanTask(dateStr: string, taskId: string, done: boolean): DailyPlan | null {
  const plan = loadPlan(dateStr)
  if (!plan) return null
  const task = plan.tasks.find(t => t.id === taskId)
  if (!task) return null
  task.done = done ? 1 : 0
  plan.status = plan.tasks.every(t => t.done) ? 'completed' : plan.tasks.some(t => t.done) ? 'partial' : 'pending'
  plan.updated_at = new Date().toISOString()
  insertPlan(plan)
  return plan
}

export function completePlanTaskForActivity(activity: 'review' | 'test', modules: string[], quantity: number): PlanTask | null {
  const today = localDateStr()
  const plan = loadPlan(today)
  if (!plan) return null
  const normalized = new Set(modules.filter(Boolean))
  if (quantity <= 0) return null
  const candidate = plan.tasks.find(task => {
    if (task.done) return false
    const content = `${task.title} ${task.detail}`
    // Quantity alone cannot prove a full paper or deep review was completed.
    if (/套题|套卷|全真|模拟|归纳|总结/.test(content)) return false
    const requested = Number(content.match(/(\d+)\s*(?:题|张)/)?.[1] || 0)
    if (!requested || quantity < requested) return false
    if (activity === 'review') return task.module === '复盘' && /复盘|错题/.test(task.title)
    return normalized.has(task.module) && /题|练习/.test(task.title)
  })
  if (!candidate) return null
  const updated = updatePlanTask(today, candidate.id, true)
  const completed = updated?.tasks.find(task => task.id === candidate.id) || null
  if (completed) logger.info('daily_plan', 'activity_auto_complete', `学习行为自动完成计划: ${completed.title}`, { activity, quantity, modules })
  return completed
}

export function completePlanTasksFromFenbi(moduleCounts: Record<string, number>, summary = ''): PlanTask[] {
  const today = localDateStr()
  const plan = loadPlan(today)
  if (!plan) return []
  const completed: PlanTask[] = []
  for (const task of plan.tasks) {
    if (task.done || !moduleCounts[task.module]) continue
    if (!/题|练习|刷题|模拟|套卷/.test(`${task.title} ${task.detail}`)) continue
    if (/套题|套卷|全真|模拟|复盘|归纳|总结/.test(`${task.title} ${task.detail}`)) continue
    const requested = Number(`${task.title} ${task.detail}`.match(/(\d+)\s*题/)?.[1] || 0)
    if (!requested) continue
    if (moduleCounts[task.module] < requested) continue
    task.done = 1
    completed.push(task)
  }
  if (completed.length || summary) {
    const doneCount = plan.tasks.filter(task => task.done).length
    plan.status = doneCount === plan.tasks.length ? 'completed' : doneCount > 0 ? 'partial' : plan.status
    if (summary && !plan.note.includes(summary)) plan.note = [plan.note, summary].filter(Boolean).join('\n')
    plan.updated_at = new Date().toISOString()
    insertPlan(plan)
    logger.info('daily_plan', 'fenbi_auto_complete', `粉笔同步自动完成 ${completed.length} 项任务`, { modules: moduleCounts })
  }
  return completed
}

/** 提交当天完成反馈（状态 + 备注），并预生成明天的计划（供次日 AI 调整使用） */
export function submitPlanFeedback(dateStr: string, status: PlanStatus, note: string): DailyPlan | null {
  const plan = loadPlan(dateStr)
  if (!plan) return null
  plan.status = status
  plan.note = note || ''
  plan.updated_at = new Date().toISOString()
  insertPlan(plan)
  logger.info('daily_plan', 'feedback', `收到 ${dateStr} 反馈: ${status}${note ? '，备注: ' + note.slice(0, 100) : ''}`)

  // 预生成明天的计划：今天没完成时，AI 会据此动态调整明天
  try {
    const d = parseDate(dateStr)
    d.setDate(d.getDate() + 1)
    const tomorrow = localDateStr(d)
    ensurePlanFor(tomorrow).catch(err => logger.warn('daily_plan', 'pregen_tomorrow_failed', err?.message || String(err)))
  } catch { /* ignore */ }

  return plan
}

/** 最近 N 天计划历史（含完成度），供页面展示 */
export function getPlanHistory(limit = 7): PlanHistoryItem[] {
  const rows = getDb().prepare('SELECT * FROM daily_plans ORDER BY date DESC LIMIT ?').all(limit) as any[]
  return rows.map(r => {
    const tasks = JSON.parse(r.tasks_json || '[]') as PlanTask[]
    return {
      date: r.date,
      status: r.status as PlanStatus,
      note: r.note || '',
      ai_adjusted: !!r.ai_adjusted,
      adjustment_reason: r.adjustment_reason || '',
      tasks_total: tasks.length,
      tasks_done: tasks.filter(t => t.done).length
    }
  })
}

// ============ AI 未来一周倒排安排 ============

export interface ForwardPlan {
  overview: string
  days: Array<{ date: string; title: string; detail: string }>
  generated_at: string
}

export function getStoredForwardPlan(): ForwardPlan | null {
  const raw = readConfig('plan_forward_plan')
  if (!raw) return null
  try {
    return JSON.parse(raw) as ForwardPlan
  } catch {
    return null
  }
}

/** 让 AI 根据倒排目标（国考日）生成未来 7 天安排 */
export async function generateForwardPlan(): Promise<{ success: boolean; plan?: ForwardPlan; error?: string }> {
  const reasonKey = readConfig('ai_api_key')
  const fallbackKey = readConfig('vision_api_key')
  if (!reasonKey && !fallbackKey) {
    return { success: false, error: '未配置 AI，请先在设置页填写 API Key' }
  }

  const apiKey = decryptToken(reasonKey || fallbackKey || '')
  const baseURL = reasonKey ? (readConfig('ai_base_url') || 'https://api.deepseek.com') : (readConfig('vision_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  const model = reasonKey ? (readConfig('ai_model') || 'deepseek-chat') : (readConfig('vision_model') || 'qwen-vl-max')

  const exam = getExamInfo()
  const phase = getExamPhase()
  const today = localDateStr()

  const prompt = `【倒排目标】国考笔试 ${exam.exam_date}，距今约 ${exam.days_until} 天
【当前阶段】${phase.name}（本阶段还剩 ${phase.phase_days_left} 天）
【阶段重点】${phase.focus || '（无）'}
【今天】${today}（${weekDayName(today)}）
【未来 7 天日期类型】
${Array.from({ length: 7 }, (_, index) => {
    const date = addDaysStr(today, index + 1)
    return `- ${date}：${calendarDayDescription(date)}`
  }).join('\n')}
【个人计划记忆】
${buildPlanningMemoryText(today)}
${planningRules()}

请以国考日 ${exam.exam_date} 为终点倒排，生成从明天开始的未来 7 天备考安排：
- 模块轮换，一天不同时做行测与申论套题，每次套题都留足复盘与归纳时间；时间不够就做复盘或少量专项
- 考虑用户最近完成情况和薄弱模块
- 每天 1 条安排：title(当天主题，如"申论日""套卷日""复盘日")、detail(具体做什么、预计多久)
- 每天提供tasks，最多3项；每项title/detail/minutes/module/kind(practice/review/other)，做题和复盘分项。review_ratio为1或1.5
- 输出 JSON：{"overview": "整体说明", "days": [{"date": "YYYY-MM-DD", "title": "...", "detail": "...", "review_ratio":1.5,"tasks":[{"title":"...","detail":"...","minutes":30,"module":"复盘","kind":"review"}]}]}
- 只输出 JSON，不要其他内容`

  try {
    logger.info('daily_plan', 'forward_start', 'AI 生成未来一周倒排安排', { model })
    const client = new OpenAI({ apiKey, baseURL, timeout: 90_000, maxRetries: 0 })
    let parsed: any = null
    let lastParseError = '未知错误'
    for (let attempt = 1; attempt <= 2; attempt++) {
      const compactInstruction = '\n每天最多3项任务，每项detail不超过30字，overview不超过50字。' + (attempt === 1 ? '' : '\n上次输出被截断。禁止展示思考过程，直接输出单行紧凑 JSON，每天detail不超过40字。')
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: '你是一位考公备考教练。只输出紧凑、完整、可解析的 JSON，不展示推理过程。' },
          { role: 'user', content: prompt + compactInstruction }
        ],
        response_format: { type: 'json_object' },
        ...aiOutputOptions(baseURL, model, attempt === 1 ? 3200 : 4200, attempt)
      })
      recordAiUsage(resp, 'forward_plan', reasonKey ? 'reason' : 'vision', model)

      const content = resp.choices[0]?.message?.content || ''
      try {
        parsed = parseValidatedAi(content, forwardSchema, resp.choices[0]?.finish_reason)
        if (parsed.days.some((day: any, index: number) => day.date !== addDaysStr(today, index + 1))) throw new Error('未来安排日期不连续或与请求不匹配')
        break
      } catch (parseError: any) {
        lastParseError = parseError.message || 'JSON 解析失败'
        logger.warn('daily_plan', 'forward_invalid_json', `未来安排 JSON 无效，${attempt < 2 ? '准备重试' : '重试结束'}`, {
          attempt,
          finishReason: resp.choices[0]?.finish_reason,
          contentLength: content.length,
          error: lastParseError
        })
        parsed = null
      }
    }
    if (!parsed) throw new Error(`AI 返回的未来安排不完整，自动重试后仍无法解析（${lastParseError}）`)
    const days: ForwardPlan['days'] = []
    if (Array.isArray(parsed.days)) {
      const start = parseDate(today)
      for (let i = 0; i < parsed.days.slice(0, 7).length; i++) {
        const item = parsed.days[i]
        if (!item || typeof item !== 'object') continue
        const d = new Date(start)
        d.setDate(d.getDate() + i + 1)
        const date = localDateStr(d)
        const candidates = normalizeAiTasks(item.tasks) || buildDefaultPlan(date).tasks
        const fitted = fitPlanTasks(candidates, { remainingMinutes: calendarDayInfo(date).maxMinutes, reviewRatio: item.review_ratio === 1 ? 1 : 1.5 })
        days.push({
          date,
          title: fitted.tasks.map(t => t.title).join(' · ') || '休息或归纳日',
          detail: fitted.tasks.map(t => `${t.title}约${t.minutes}分钟：${t.detail}`).join('\n') + (fitted.warnings.length ? '\n' + fitted.warnings.join(' ') : '')
        })
      }
    }
    if (days.length === 0) throw new Error('AI 未返回有效安排')

    const plan: ForwardPlan = {
      overview: typeof parsed.overview === 'string' ? parsed.overview : '',
      days,
      generated_at: new Date().toISOString()
    }
    try { writeConfig('plan_forward_plan', JSON.stringify(plan)) } catch { /* ignore */ }
    logger.info('daily_plan', 'forward_done', `未来一周安排生成完成: ${days.length} 天`, { model })
    return { success: true, plan }
  } catch (err: any) {
    logger.error('daily_plan', 'forward_failed', `生成未来安排失败: ${err.message}`)
    return { success: false, error: err.message }
  }
}

/** 用户只需说一句情况；只调整未完成任务，失败不覆盖任务单。 */
const adjustingDates = new Set<string>()
export async function regenerateTodayPlan(input: PlanAdjustmentInput = {}): Promise<{ success: boolean; plan: DailyPlan; error?: string }> {
  const today = localDateStr()
  const existing = loadPlan(today) || await ensureTodayPlan()
  if (adjustingDates.has(today)) return { success: false, plan: existing, error: '正在调整今天的计划，请稍等' }
  adjustingDates.add(today)
  const feedback = typeof input.feedback === 'string' ? input.feedback.trim().slice(0, 2000) : ''
  try {
    const adjusted = await adjustWithAi(existing, today, { feedback })
    const current = loadPlan(today) || existing
    if (current.updated_at !== existing.updated_at) return { success: false, plan: current, error: '调整期间完成记录发生了变化，已保留最新记录，请重新调整' }
    if (!adjusted) return { success: false, plan: current, error: 'AI 调整失败，当前任务和已完成记录保持不变，请稍后重试' }
    if (feedback) adjusted.plan.note = [current.note, '计划更正：' + feedback].filter(Boolean).join('\n')
    getDb().transaction(() => {
      insertPlan(adjusted.plan)
      writeConfig('plan_future_note', adjusted.futureNote)
      // 只保存明确具有长期含义的原话，不让模型把“今天累”变成永久习惯。
      if (feedback && /以后|今后|每次|习惯|长期|默认|每天|一直/.test(feedback)) {
        let corrections: string[] = []
        try { corrections = JSON.parse(readConfig('plan_user_corrections') || '[]') } catch { /* 旧记录无效时重建 */ }
        if (!Array.isArray(corrections)) corrections = []
        writeConfig('plan_user_corrections', JSON.stringify([...corrections.filter(t => typeof t === 'string' && t !== feedback), feedback].slice(-5)))
      }
      // 旧的周安排可能与本次更正冲突；不在后台偷偷再调用 AI。
      writeConfig('plan_forward_plan', '')
    })()
    return { success: true, plan: adjusted.plan }
  } catch (err: any) {
    return { success: false, plan: loadPlan(today) || existing, error: `AI 调整失败：${err.message}，当前记录未被覆盖` }
  } finally { adjustingDates.delete(today) }
}
