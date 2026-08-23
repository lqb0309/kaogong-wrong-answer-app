import { getDb } from './db'
import { readConfig, writeConfig } from './config'
import { decryptToken } from './safe-storage'
import { logger } from './logger'
import OpenAI from 'openai'

// ============ 每日备考计划（AI 动态调整） ============

export interface PlanTask {
  id: string
  title: string
  detail: string
  minutes: number
  module: string
  done: 0 | 1
}

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
  '基础阶段': '打地基：资料分析每天必练（正确率目标 12/20→16/20）、判断/言语轮换刷题、政治理论每天刷 20 题、申论每周 2-3 次小题',
  '强化阶段': '提速：资料分析提速到 8 分钟/组、每周 1-2 套全真套卷、申论每周 1 套完整、政治理论开始冲刺背诵',
  '冲刺阶段': '全真模拟：每周 2 套套卷（严格按考试时间）、只复盘错题不再学新知识、政治时政冲刺背诵、调整作息保持状态'
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

// ============ 默认计划（规则生成，无需 AI） ============

function buildDefaultPlan(dateStr: string): DailyPlan {
  const wd = parseDate(dateStr).getDay()
  const dayIndex = Math.floor(parseDate(dateStr).getTime() / 86400000)
  const alt = dayIndex % 2 === 0 ? '判断推理' : '言语理解'
  const now = new Date().toISOString()

  // 倒排阶段：离国考越近，任务重心越往"套卷 + 复盘"倾斜
  const daysToExam = daysUntilFrom(dateStr)
  const phase: 'base' | 'strong' | 'sprint' = daysToExam > 60 ? 'base' : daysToExam > 30 ? 'strong' : 'sprint'

  let tasks: PlanTask[]

  if (wd === 6) {
    // 周六：套卷日（冲刺阶段更强调全真模拟节奏）
    tasks = [
      { id: 't1', title: phase === 'sprint' ? '行测全真模拟（严格按考试时间 2 小时）' : '行测真题全真模拟（135题）', detail: phase === 'sprint' ? '按考试时间 9:00-11:00 全真模拟，用答题卡，中间不休息，模拟考场节奏。' : '严格计时 2 小时，用答题卡，含涂卡。资→判→言→常→数顺序，超时即停。', minutes: 120, module: '资料分析', done: 0 },
      { id: 't2', title: '对答案并记录各模块正确率', detail: '整理一张正确率表，标注波动最大的模块，与上周对比。', minutes: 30, module: '复盘', done: 0 },
      { id: 't3', title: '申论真题（小题 + 大作文）', detail: '作文必须写完；小题逐条抄材料、分条列点、控字数。', minutes: 120, module: '申论', done: 0 },
      { id: 't4', title: phase === 'sprint' ? '政治理论：时政冲刺背诵' : '政治理论：专题背诵', detail: phase === 'sprint' ? '背机构时政冲刺 PDF 要点 + 本周刷题错题。' : '从《政治理论基础知识点手册》挑 1 个专题，睡前过一遍。', minutes: 30, module: '政治理论', done: 0 }
    ]
  } else if (wd === 0) {
    // 周日：复盘日（冲刺阶段增加错题清零）
    tasks = [
      { id: 't1', title: '行测错题逐题复盘（本周末套卷）', detail: '错题三问：知识点不会？速度不够？粗心？完全不懂的考点看 10-20 分钟短视频并做 3 道同类题。', minutes: 90, module: '复盘', done: 0 },
      { id: 't2', title: '申论对照参考答案', detail: '重点学小题的"点"怎么从材料里挖出来，抄写规范表达。', minutes: 60, module: '申论', done: 0 },
      { id: 't3', title: phase === 'sprint' ? '错题本清零式复盘' : '本周错题本重做', detail: phase === 'sprint' ? '会的删、不会的当天弄懂，只留"真不会"的题。' : '做对的删掉，只留"真不会"的题。', minutes: 60, module: '复盘', done: 0 },
      { id: 't4', title: '政治理论：本周错题重看 + 专题快背', detail: '把本周刷题错过的政治/时政题重新看一遍。', minutes: 30, module: '政治理论', done: 0 }
    ]
  } else if (wd === 3) {
    // 周三：申论日（强化/冲刺阶段申论频率更高）
    const shenlunTypes = ['归纳概括', '综合分析', '贯彻执行（应用文）']
    const slType = shenlunTypes[dayIndex % 3]
    tasks = [
      { id: 't1', title: '资料分析 1 组（4 题）计时 + 复盘', detail: phase === 'strong' || phase === 'sprint' ? '限时 8 分钟（提速），超时即停；复盘错题三问。' : '限时 10 分钟，超时即停；复盘错题三问。', minutes: 20, module: '资料分析', done: 0 },
      { id: 't2', title: `申论小题 1 道（${slType}）`, detail: '严格控字数、分条列点、只抄材料，不自由发挥。', minutes: 35, module: '申论', done: 0 },
      { id: 't3', title: '对照参考答案 + 抄规范表达', detail: '学"点"怎么从材料里挖出来，积累规范词。', minutes: 20, module: '申论', done: 0 },
      { id: 't4', title: '政治理论：背诵 1 个专题', detail: phase === 'sprint' ? '改背时政冲刺要点。' : '按手册专题顺序，每天一个，睡前过一遍。', minutes: 15, module: '政治理论', done: 0 }
    ]
  } else {
    // 周一/二/四/五：工作日（共 90 分钟，任务随阶段变化）
    if (phase === 'strong') {
      tasks = [
        { id: 't1', title: '资料分析 2 组（4 题 ×2）计时 + 复盘', detail: '每组限时 8 分钟；目标正确率 ≥14/20，这是上 70 分的地基。', minutes: 40, module: '资料分析', done: 0 },
        { id: 't2', title: `${alt} 1 组（15 题）计时 + 复盘`, detail: '限时 22 分钟（提速）；不懂的考点看短视频后立刻做 3 道同类题。', minutes: 25, module: alt, done: 0 },
        { id: 't3', title: '政治理论/时政刷题 20 题', detail: '错题记进本子，周末集中重看。', minutes: 15, module: '政治理论', done: 0 },
        { id: 't4', title: '错题三问归档', detail: '标原因：①知识点不会 ②速度不够 ③粗心。', minutes: 10, module: '复盘', done: 0 }
      ]
    } else if (phase === 'sprint') {
      tasks = [
        { id: 't1', title: '资料分析 1 组（4 题）计时 + 复盘', detail: '限时 8 分钟，保持手感；错题三问。', minutes: 20, module: '资料分析', done: 0 },
        { id: 't2', title: `${alt} 混合 15 题计时（限时 20 分钟）`, detail: '冲刺期只练速度和准确率，不再学新技巧。', minutes: 22, module: alt, done: 0 },
        { id: 't3', title: '政治理论：时政冲刺背诵', detail: '背时政冲刺 PDF + 刷题错题重看。', minutes: 18, module: '政治理论', done: 0 },
        { id: 't4', title: '错题本清零式复盘', detail: '只重做本周错题，会的删，不会的当天弄懂。', minutes: 30, module: '复盘', done: 0 }
      ]
    } else {
      tasks = [
        { id: 't1', title: '资料分析 1 组（4 题）计时 + 复盘', detail: '限时 10 分钟，超时即停；复盘错题三问：知识点/速度/粗心。', minutes: 30, module: '资料分析', done: 0 },
        { id: 't2', title: `${alt} 1 组（15 题）计时 + 复盘`, detail: '限时 25 分钟；不懂的考点看短视频后立刻做 3 道同类题。', minutes: 30, module: alt, done: 0 },
        { id: 't3', title: '政治理论/时政刷题 20 题', detail: '用粉笔 App 刷政治理论题库，错题记进本子。', minutes: 15, module: '政治理论', done: 0 },
        { id: 't4', title: '错题三问归档', detail: '今天所有错题标原因：①知识点不会 ②速度不够 ③粗心，写进错题本。', minutes: 15, module: '复盘', done: 0 }
      ]
    }
  }

  return {
    date: dateStr,
    tasks,
    status: 'pending',
    note: '',
    ai_adjusted: false,
    adjustment_reason: '',
    created_at: now,
    updated_at: now
  }
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

// ============ 最近错题统计（喂给 AI 做数据依据） ============

function recentWrongStats(): { byLevel1: string[]; total: number } {
  const rows = getDb().prepare(`
    SELECT level1, COUNT(*) as cnt FROM questions
    WHERE status = 'confirmed' AND created_at >= date('now', '-7 days')
    GROUP BY level1 ORDER BY cnt DESC
  `).all() as { level1: string; cnt: number }[]
  const total = rows.reduce((s, r) => s + r.cnt, 0)
  const byLevel1 = rows.map(r => `${r.level1}: ${r.cnt} 题`)
  return { byLevel1, total }
}

// ============ AI 动态调整 ============

/** 最近 N 条计划（含今天之前的所有，用于给 AI 看连续完成情况） */
function recentPlansText(before: string, limit = 3): string {
  const rows = getDb().prepare('SELECT * FROM daily_plans WHERE date < ? ORDER BY date DESC LIMIT ?').all(before, limit) as any[]
  if (rows.length === 0) return '（无历史记录，今天是第一次使用）'
  return rows.map(r => {
    const tasks = JSON.parse(r.tasks_json || '[]') as PlanTask[]
    const done = tasks.filter(t => t.done).length
    return `- ${r.date}：${r.status === 'completed' ? '全部完成' : r.status === 'partial' ? '部分完成' : '未完成'}（${done}/${tasks.length} 项）${r.note ? '，备注: ' + r.note : ''}`
  }).join('\n')
}

function buildAdjustPrompt(prev: DailyPlan, today: string): string {
  const stats = recentWrongStats()
  const exam = getExamInfo()
  const phase = getExamPhase()
  const doneCount = prev.tasks.filter(t => t.done).length
  const gap = gapDays(prev.date, today)
  const futureNote = readConfig('plan_future_note') || ''

  const taskLines = prev.tasks.map(t =>
    `- [${t.done ? 'x' : ' '}] ${t.title}（${t.minutes}分钟，${t.module}）${t.detail ? '——' + t.detail : ''}`
  ).join('\n')

  return `【今天的日期】${today}（${weekDayName(today)}）
【倒排目标】国考笔试 ${exam.exam_date}，距今约 ${exam.days_until} 天
【当前阶段】${phase.name}（本阶段还剩约 ${phase.phase_days_left} 天）
${phase.focus ? '【阶段重点】' + phase.focus : ''}
【距上次计划】${gap === 1 ? '昨天' : gap + ' 天前'}

【最近完成情况】（倒序，最近的在最上面）
${recentPlansText(today, 3)}

【上次计划与完成情况】
日期: ${prev.date}
状态: ${prev.status === 'completed' ? '全部完成' : prev.status === 'partial' ? '部分完成' : '未完成'}（${doneCount}/${prev.tasks.length} 项完成）
用户备注: ${prev.note || '（无）'}
任务列表:
${taskLines}

【最近 7 天已确认错题分布】
${stats.byLevel1.length ? stats.byLevel1.join('\n') : '（无）'}（共 ${stats.total} 题）

【此前 AI 对未来的安排提示】${futureNote || '（无）'}

【今天的星期类型】${weekDayName(today)}
${[6].includes(parseDate(today).getDay()) ? '（周六：建议总时长 ≤ 300 分钟）' : [0].includes(parseDate(today).getDay()) ? '（周日：建议总时长 ≤ 240 分钟）' : '（工作日：建议总时长 ≤ 90 分钟）'}

请根据以上信息，生成今天的备考计划：
- 如果最近有未完成，主动调整任务量和顺序，帮助恢复节奏（不要苛责，不要安排得过满）
- 考虑当前倒排阶段：基础阶段以模块训练为主、强化阶段提速、冲刺阶段以套卷和复盘为主
- 资料分析是每天必练的地基，政治理论每天都要刷题
- 每个任务给出：title(简短标题)、detail(具体怎么做)、minutes(预计分钟数)、module(资料分析/判断推理/言语理解/数量关系/常识判断/政治理论/申论/复盘/其他)
- 只输出 JSON：{"tasks": [...], "adjustment_summary": "一句话说明你调整了什么、为什么", "future_note": "对接下来几天安排的简短提示，如明天申论日、后天套卷日"}
- 不要输出 JSON 以外的内容`
}

/** 调用 AI 生成调整后的计划；失败返回 null（由调用方回退到默认计划） */
async function adjustWithAi(prev: DailyPlan, today: string): Promise<{ plan: DailyPlan; summary: string } | null> {
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

  const client = new OpenAI({ apiKey, baseURL })

  try {
    logger.info('daily_plan', 'adjust_start', `AI 调整 ${today} 的计划`, { model, prevDate: prev.date })
    const resp = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: '你是一位严厉又务实的考公备考教练。用户在职备考，每天最多约 90 分钟（周末除外），目标是国考（副省级，行测 135 题），需要从考试日倒排安排每天任务。你的任务是：根据用户最近的完成情况和错题数据，结合倒排阶段，生成今天的备考计划。计划要具体、可执行、不过满。用中文回复。'
        },
        { role: 'user', content: buildAdjustPrompt(prev, today) }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2500
    })

    const content = resp.choices[0]?.message?.content || ''
    let parsed: any
    try {
      parsed = JSON.parse(content)
    } catch {
      logger.warn('daily_plan', 'adjust_parse_failed', 'AI 返回非 JSON，回退默认计划', { raw: content.slice(0, 200) })
      return null
    }

    const tasks = normalizeAiTasks(parsed.tasks)
    if (!tasks || tasks.length === 0) {
      logger.warn('daily_plan', 'adjust_empty', 'AI 未返回有效任务，回退默认计划')
      return null
    }

    // 保存 AI 对未来的安排提示，供后续日子和页面使用
    if (typeof parsed.future_note === 'string' && parsed.future_note.trim()) {
      try { writeConfig('plan_future_note', parsed.future_note.trim()) } catch { /* ignore */ }
    }

    const now = new Date().toISOString()
    const plan: DailyPlan = {
      date: today,
      tasks,
      status: 'pending',
      note: '',
      ai_adjusted: true,
      adjustment_reason: typeof parsed.adjustment_summary === 'string' ? parsed.adjustment_summary : 'AI 已根据最近完成情况调整了今天的计划',
      created_at: now,
      updated_at: now
    }
    logger.info('daily_plan', 'adjust_done', `AI 计划生成完成: ${tasks.length} 项任务`, { model })
    return { plan, summary: plan.adjustment_reason }
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
    const minutes = Math.min(300, Math.max(5, Number(item.minutes) || 30))
    const module = MODULES.includes(item.module) ? item.module : (typeof item.module === 'string' && item.module ? item.module : '其他')
    tasks.push({
      id: `t${tasks.length + 1}`,
      title,
      detail: typeof item.detail === 'string' ? item.detail.trim() : '',
      minutes,
      module,
      done: 0
    })
  }
  return tasks.length > 0 ? tasks : null
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
  return { ...base, tasks: [...carry, ...base.tasks], adjustment_reason: '昨天有任务未完成，已自动顺延到今天' }
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
    plan = (await adjustWithAi(prev, dateStr))?.plan || null
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
  plan.updated_at = new Date().toISOString()
  insertPlan(plan)
  return plan
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
  const stats = recentWrongStats()
  const today = localDateStr()
  const futureNote = readConfig('plan_future_note') || ''

  const prompt = `【倒排目标】国考笔试 ${exam.exam_date}，距今约 ${exam.days_until} 天
【当前阶段】${phase.name}（本阶段还剩 ${phase.phase_days_left} 天）
【阶段重点】${phase.focus || '（无）'}
【今天】${today}（${weekDayName(today)}）
【最近完成情况】
${recentPlansText(today, 5)}
【最近 7 天已确认错题分布】
${stats.byLevel1.length ? stats.byLevel1.join('\n') : '（无）'}（共 ${stats.total} 题）
【此前 AI 的未来安排提示】${futureNote || '（无）'}

请以国考日 ${exam.exam_date} 为终点倒排，生成从明天开始的未来 7 天备考安排：
- 结合当前阶段（基础/强化/冲刺）安排每天重心：资料分析必练、判断/言语轮换、政治理论每天、申论每周 2-3 次、周末安排套卷和复盘
- 考虑用户最近完成情况和薄弱模块
- 每天 1 条安排：title(当天主题，如"申论日""套卷日""复盘日")、detail(具体做什么、预计多久)
- 输出 JSON：{"overview": "对整体安排的一句话说明", "days": [{"date": "YYYY-MM-DD", "title": "...", "detail": "..."}]}
- 只输出 JSON，不要其他内容`

  try {
    logger.info('daily_plan', 'forward_start', 'AI 生成未来一周倒排安排', { model })
    const client = new OpenAI({ apiKey, baseURL })
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: '你是一位考公备考教练，擅长从考试日倒排制定备考计划。用户在职，每天最多约 90 分钟（周末可多）。用中文回复。' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2500
    })

    const content = resp.choices[0]?.message?.content || ''
    const parsed = JSON.parse(content)
    const days: ForwardPlan['days'] = []
    if (Array.isArray(parsed.days)) {
      const start = parseDate(today)
      for (let i = 0; i < parsed.days.slice(0, 7).length; i++) {
        const item = parsed.days[i]
        if (!item || typeof item !== 'object') continue
        const d = new Date(start)
        d.setDate(d.getDate() + i + 1)
        days.push({
          date: item.date || localDateStr(d),
          title: typeof item.title === 'string' ? item.title : `第 ${i + 1} 天`,
          detail: typeof item.detail === 'string' ? item.detail : ''
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

/** 手动让 AI 重新调整今天的计划（失败则保留现有计划） */
export async function regenerateTodayPlan(): Promise<{ success: boolean; plan: DailyPlan; error?: string }> {
  const today = localDateStr()
  const prev = loadPlan(today) || loadPreviousPlan(today)
  try {
    const adjusted = prev ? await adjustWithAi(prev, today) : null
    if (adjusted) {
      insertPlan(adjusted.plan)
      return { success: true, plan: adjusted.plan }
    }
    // AI 失败：保留现有计划，标记说明
    const existing = loadPlan(today)
    if (existing) {
      existing.adjustment_reason = existing.adjustment_reason || 'AI 调整失败，沿用当前计划'
      existing.updated_at = new Date().toISOString()
      insertPlan(existing)
      return { success: false, plan: existing, error: 'AI 调整失败（未配置 API Key 或网络异常），沿用当前计划' }
    }
    const fallback = carryOverUnfinished(prev, buildDefaultPlan(today))
    insertPlan(fallback)
    return { success: false, plan: fallback, error: 'AI 调整失败，已使用默认计划' }
  } catch (err: any) {
    const existing = loadPlan(today) || carryOverUnfinished(prev, buildDefaultPlan(today))
    insertPlan(existing)
    return { success: false, plan: existing, error: `AI 调整失败: ${err.message}` }
  }
}
