export interface PlanTask {
  id: string
  title: string
  detail: string
  minutes: number
  module: string
  done: 0 | 1
  kind?: 'practice' | 'review' | 'other'
}

export function taskKind(task: PlanTask): 'practice' | 'review' | 'other' {
  if (task.module === '复盘' || /复盘|对照.*答案|对答案|归纳|重看|总结/.test(task.title)) return 'review'
  if (/刷题|练习|精练|小题|模拟|套卷|真题|\d+\s*题/.test(task.title)) return 'practice'
  if (task.kind) return task.kind
  return 'other'
}

export function fullPaper(task: PlanTask): '行测' | '申论' | null {
  if (taskKind(task) !== 'practice') return null
  if (/行测.*(?:全真|模拟|套|真题)|(?:全真|完整).*行测/.test(task.title)) return '行测'
  if (/申论/.test(task.title) && (/套|完整|全真|作文/.test(task.title) || task.minutes >= 100)) return '申论'
  if (task.minutes >= 100 && /完整|全真|套题|套卷/.test(task.title)) return '行测'
  return null
}

/** 复盘预留是硬约束；不通过缩短套卷时间伪造可执行的计划。 */
export function fitPlanTasks(candidates: PlanTask[], options: {
  remainingMinutes: number
  reviewRatio: number
  completed?: PlanTask[]
  actualPracticeMinutes?: number
}): { tasks: PlanTask[]; warnings: string[] } {
  const completed = (options.completed || []).filter(t => t.done).map(t => ({ ...t }))
  const budget = Math.max(0, Math.floor(options.remainingMinutes))
  const ratio = Math.min(1.5, Math.max(1, options.reviewRatio))
  const practiceDone = Math.max(options.actualPracticeMinutes || 0, completed.filter(t => taskKind(t) === 'practice').reduce((n, t) => n + t.minutes, 0))
  const reviewDone = completed.filter(t => taskKind(t) === 'review').reduce((n, t) => n + t.minutes, 0)
  const warnings: string[] = []
  const clean = candidates.filter(t => !t.done && !completed.some(d => d.title === t.title)).map(t => ({ ...t, minutes: Math.max(1, Math.ceil(t.minutes)) }))
  const finishedPaper = completed.map(fullPaper).find(Boolean)
  const paper = finishedPaper || clean.map(fullPaper).find(Boolean)
  const reviews = clean.filter(t => taskKind(t) === 'review')
  const selected: PlanTask[] = []
  let used = 0
  let practice = practiceDone
  for (const task of clean.filter(t => taskKind(t) !== 'review')) {
    if (paper && (finishedPaper || fullPaper(task) !== paper || selected.some(fullPaper))) {
      warnings.push('套题日只保留一类套题与复盘，其他练习不叠加。')
      continue
    }
    const nextPractice = practice + (taskKind(task) === 'practice' ? task.minutes : 0)
    const reviewReserve = Math.max(0, Math.ceil(nextPractice * ratio) - reviewDone)
    if (selected.length >= 3 || used + task.minutes + reviewReserve > budget) {
      warnings.push(`「${task.title}」暂不安排：剩余时间不足以同时完成做题和复盘。`)
      continue
    }
    selected.push(task)
    used += task.minutes
    practice = nextPractice
  }
  const requiredReview = Math.max(0, Math.ceil(practice * ratio) - reviewDone)
  const proposedReview = reviews.reduce((n, t) => n + t.minutes, 0)
  const reviewMinutes = Math.min(budget - used, Math.max(requiredReview, proposedReview))
  if (reviewMinutes > 0) selected.push({
    id: 'review', title: practice > 0 ? '复盘与归纳总结' : (reviews[0]?.title || '复盘与归纳总结'),
    detail: reviews.map(t => `${t.title}：${t.detail}`).join('\n') || '先看错题和耗时点，核对解析，归纳误区与下次做法；不要求抄写所有解析。',
    minutes: reviewMinutes, module: '复盘', kind: 'review', done: 0
  })
  if (reviewMinutes < requiredReview) warnings.push(`今天优先复盘 ${reviewMinutes} 分钟；还需约 ${requiredReview - reviewMinutes} 分钟复盘留到后续，今天不再增加新题。`)
  const ids = new Set(completed.map(t => t.id))
  const tasks = selected.map((t, i) => {
    let id = `adjust-${i + 1}`
    while (ids.has(id)) id += '-new'
    ids.add(id)
    return { ...t, id }
  })
  return { tasks: [...completed, ...tasks], warnings: [...new Set(warnings)] }
}
