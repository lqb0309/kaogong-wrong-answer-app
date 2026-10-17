import { createEmptyCard, fsrs, Rating, type Card } from 'ts-fsrs'
import { z } from 'zod'
import { localDateKey } from './date-utils'

const scheduler = fsrs({ enable_fuzz: false, enable_short_term: false, maximum_interval: 365 })
const cardSchema = z.object({
  due: z.string().datetime(), last_review: z.string().datetime().optional(),
  stability: z.number().finite().nonnegative(), difficulty: z.number().finite().min(0).max(10),
  elapsed_days: z.number().finite().nonnegative(), scheduled_days: z.number().finite().nonnegative(),
  learning_steps: z.number().int().nonnegative(), reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(), state: z.number().int().min(0).max(3)
})
export type RecallRating = 'wrong' | 'hard' | 'done' | 'easy'

export function scheduleCardReview(previous: { fsrs_json?: string; repetitions?: number; lapses?: number } | undefined, rating: RecallRating, now = new Date()) {
  if (!['wrong', 'hard', 'done', 'easy'].includes(rating)) throw new Error('请选择忘记、困难、记得或轻松；阅读不等于回忆成功')
  let card: Card = createEmptyCard(now)
  if (previous?.fsrs_json) {
    const saved = cardSchema.parse(JSON.parse(previous.fsrs_json))
    card = { ...saved, due: new Date(saved.due), last_review: saved.last_review ? new Date(saved.last_review) : undefined }
    if (card.last_review && card.last_review > now) throw new Error('系统时间早于上次复习，请检查时间后再记录')
  }
  // Legacy intervals are not FSRS memory states. Start a fresh state on the first
  // genuine recall, retaining historical statistics separately in the database.
  const grade = { wrong: Rating.Again, hard: Rating.Hard, done: Rating.Good, easy: Rating.Easy } as const
  const result = scheduler.next(card, now, grade[rating])
  return {
    fsrsJson: JSON.stringify(result.card), logJson: JSON.stringify(result.log),
    intervalDays: result.card.scheduled_days, dueDate: localDateKey(result.card.due),
    repetitions: (previous?.repetitions || 0) + 1, lapses: (previous?.lapses || 0) + (rating === 'wrong' ? 1 : 0)
  }
}
