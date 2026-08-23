import { getDb } from './db'
import { resolveModelPrice } from './cc-switch-adapter'

type UsageResponse = { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null }

export function recordAiUsage(response: UsageResponse, feature: string, provider: 'vision' | 'reason', model: string): void {
  const usage = response.usage
  if (!usage) return
  const prompt = usage.prompt_tokens || 0
  const completion = usage.completion_tokens || 0
  const price = resolveModelPrice(model)
  const inputPrice = price?.input || 0
  const outputPrice = price?.output || 0
  const estimatedCost = prompt / 1_000_000 * inputPrice + completion / 1_000_000 * outputPrice
  getDb().prepare(`INSERT INTO ai_usage
    (feature, provider, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost, created_at, cost_source, price_input, price_output)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(feature, provider, model, prompt, completion, usage.total_tokens || prompt + completion, estimatedCost, new Date().toISOString(), price?.source || 'unpriced', inputPrice, outputPrice)
}

export function getCostOverview() {
  const db = getDb()
  const row = (period: 'day' | 'month') => db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(total_tokens), 0) tokens,
    COALESCE(SUM(estimated_cost), 0) cost, SUM(CASE WHEN cost_source = 'unpriced' THEN 1 ELSE 0 END) unpriced
    FROM ai_usage WHERE datetime(created_at, 'localtime') >= datetime('now', 'localtime', ?)`)
    .get(period === 'day' ? 'start of day' : 'start of month')
  return { today: row('day'), month: row('month') }
}

export function getAiUsageSummary(days = 30) {
  const safeDays = Math.min(365, Math.max(1, Number(days) || 30))
  const db = getDb()
  const totals = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(prompt_tokens), 0) prompt_tokens,
    COALESCE(SUM(completion_tokens), 0) completion_tokens, COALESCE(SUM(total_tokens), 0) total_tokens,
    COALESCE(SUM(estimated_cost), 0) estimated_cost
    FROM ai_usage WHERE created_at >= datetime('now', ?)`
  ).get(`-${safeDays} days`)
  const byFeature = db.prepare(`SELECT feature, COUNT(*) calls, SUM(total_tokens) total_tokens,
    SUM(estimated_cost) estimated_cost FROM ai_usage WHERE created_at >= datetime('now', ?)
    GROUP BY feature ORDER BY total_tokens DESC`).all(`-${safeDays} days`)
  return { days: safeDays, totals, byFeature }
}
