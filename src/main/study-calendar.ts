import { z } from 'zod'
import { readConfig, writeConfig } from './config'

const schema = z.object({ year: z.number().int(), papers: z.array(z.string().url()).min(1), days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().min(1), isOffDay: z.boolean() })).max(100) })
// Offline cache derived from holiday-cn (MIT); source State Council notice.
const bundled2026 = {
  year: 2026, papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
  days: [
    ...[['01-01','01-03','元旦'], ['02-15','02-23','春节'], ['04-04','04-06','清明节'], ['05-01','05-05','劳动节'], ['06-19','06-21','端午节'], ['09-25','09-27','中秋节'], ['10-01','10-07','国庆节']].flatMap(([start, end, name]) => Array.from({ length: Number(end.slice(3)) - Number(start.slice(3)) + 1 }, (_, i) => ({ date: `2026-${start.slice(0, 3)}${String(Number(start.slice(3)) + i).padStart(2, '0')}`, name, isOffDay: true }))),
    ...['01-04','02-14','02-28','05-09','09-20','10-10'].map(day => ({ date: `2026-${day}`, name: '调休补班', isOffDay: false }))
  ]
}
export function validateHolidayData(data: unknown, year: number) {
  const result = schema.parse(data)
  if (result.year !== year || result.days.some(d => !d.date.startsWith(`${year}-`) || new Date(`${d.date}T12:00:00Z`).toISOString().slice(0, 10) !== d.date) || new Set(result.days.map(d => d.date)).size !== result.days.length) throw new Error('日历年份或日期不匹配')
  if (result.papers.some(p => new URL(p).hostname !== 'www.gov.cn')) throw new Error('日历缺少可核验的国务院来源')
  return result
}
export function studyCalendarDay(date: string) {
  const year = Number(date.slice(0, 4)), day = new Date(`${date}T12:00:00+08:00`).getUTCDay()
  let calendar = year === 2026 ? bundled2026 : null
  try { const raw = readConfig(`holiday_cache_${year}`); if (raw) calendar = validateHolidayData(JSON.parse(raw), year) } catch { /* keep verified offline data */ }
  const entry = calendar?.days.find(d => d.date === date)
  const known = !!calendar
  if (entry) return entry.isOffDay
    ? { kind: 'holiday' as const, label: `${entry.name}假期`, maxMinutes: 240, scheduleWeekDay: day === 0 ? 0 : 6, verified: true }
    : { kind: 'workday' as const, label: '调休补班工作日', maxMinutes: 90, scheduleWeekDay: 1, verified: true }
  if (!known) return { kind: 'workday' as const, label: '尚无已核验调休日历，暂按工作日保守安排，可用一句话更正', maxMinutes: 90, scheduleWeekDay: 1, verified: false }
  return { kind: day === 0 || day === 6 ? 'weekend' as const : 'workday' as const, label: day === 0 ? '普通周日' : day === 6 ? '普通周六' : '正常工作日', maxMinutes: day === 6 ? 300 : day === 0 ? 240 : 90, scheduleWeekDay: day, verified: true }
}
/** Download public calendar data only, never user activity or account data. */
export async function refreshStudyCalendar(year = new Date().getFullYear()): Promise<void> {
  const key = `holiday_checked_${year}`, today = new Date().toISOString().slice(0, 10)
  if (readConfig(key) === today) return
  try {
    const response = await fetch(`https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return
    const text = await response.text()
    if (text.length > 100000) return
    const data = validateHolidayData(JSON.parse(text), year)
    writeConfig(`holiday_cache_${year}`, JSON.stringify(data))
  } catch { /* offline or unpublished year: conservative fallback, no invented dates */ }
  finally { writeConfig(key, today) }
}
