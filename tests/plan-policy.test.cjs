const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function compile(file, imports = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in imports)) throw new Error(`Unexpected dependency: ${name}`)
    return imports[name]
  }, module, module.exports)
  return module.exports
}
const policy = compile('src/main/plan-policy.ts')
const task = (title, minutes, kind = 'practice', done = 0) => ({ id: title, title, minutes, kind, module: kind === 'review' ? '复盘' : '其他', detail: title, done })
const minutes = tasks => tasks.filter(t => !t.done).reduce((n, t) => n + t.minutes, 0)

test('两套试卷只保留一类，并给复盘同等时间', () => {
  const res = policy.fitPlanTasks([task('行测全真模拟', 120), task('申论完整套题', 120), task('政治刷题', 15), task('对答案', 30, 'review')], { remainingMinutes: 240, reviewRatio: 1 })
  assert.deepEqual(res.tasks.map(t => t.title), ['行测全真模拟', '复盘与归纳总结'])
  assert.equal(res.tasks[1].minutes, 120)
  assert.equal(minutes(res.tasks), 240)
})
test('默认复盘1.5倍，只有90分钟时不能塞完整套题', () => {
  const res = policy.fitPlanTasks([task('行测全真模拟', 120), task('少量专项练习', 30)], { remainingMinutes: 90, reviewRatio: 1.5 })
  assert.equal(res.tasks.some(t => policy.taskKind(t) === 'practice'), false)
  assert.ok(minutes(res.tasks) <= 90)
})
test('专项30分钟预留45分钟复盘', () => {
  const res = policy.fitPlanTasks([task('专项练习', 30)], { remainingMinutes: 90, reviewRatio: 1.5 })
  assert.equal(res.tasks[1].minutes, 45)
})
test('完成套题后不加新题，保留原ID、内容和勾选', () => {
  const done = task('行测全真模拟', 120, 'practice', 1)
  const res = policy.fitPlanTasks([task('申论完整套题', 120), task('政治刷题', 15)], { remainingMinutes: 180, reviewRatio: 1.5, completed: [done] })
  assert.deepEqual(res.tasks[0], done)
  assert.equal(res.tasks.filter(t => !t.done && policy.taskKind(t) === 'practice').length, 0)
  assert.equal(res.tasks[1].minutes, 180)
})
test('已做题两小时，只剩30分钟：只复盘并说明剩余欠账', () => {
  const res = policy.fitPlanTasks([task('专项练习', 20)], { remainingMinutes: 30, reviewRatio: 1.5, actualPracticeMinutes: 120 })
  assert.equal(minutes(res.tasks), 30)
  assert.ok(res.tasks.every(t => t.kind === 'review'))
  assert.ok(res.warnings.some(w => w.includes('150 分钟')))
})
test('休息预算0，不新增任务，已完成复盘不被重置', () => {
  const done = task('昨天错题复盘', 40, 'review', 1)
  const res = policy.fitPlanTasks([task('专项练习', 20)], { remainingMinutes: 0, reviewRatio: 1.5, completed: [done] })
  assert.deepEqual(res.tasks, [done])
})
test('旧任务不带kind仍能识别申论复盘', () => {
  assert.equal(policy.taskKind({ ...task('申论对照参考答案', 60), kind: undefined, module: '申论' }), 'review')
})

function harness({ content, actual = 0, apiKey = true } = {}) {
  const plans = new Map()
  const config = new Map(apiKey ? [['ai_api_key', 'test-only']] : [])
  let resolveAi
  const response = content === undefined ? new Promise(resolve => { resolveAi = resolve }) : Promise.resolve(content)
  const db = {
    prepare(sql) { return {
      get(date) { if (sql.includes('SUM(total_seconds)')) return { seconds: actual * 60 }; if (sql.includes('WHERE date = ?')) return plans.get(date); return undefined },
      all() { return [] },
      run(row) { if (sql.includes('INSERT OR REPLACE INTO daily_plans')) plans.set(row.date, { ...row }) }
    } },
    transaction(fn) { return fn }
  }
  class FakeOpenAI { chat = { completions: { create: async () => ({ choices: [{ message: { content: await response } }] }) } } }
  const api = compile('src/main/daily-plan.ts', {
    './ai-validation': compile('src/main/ai-validation.ts', { zod: require('zod') }),
    './study-calendar': compile('src/main/study-calendar.ts', { zod: require('zod'), './config': { readConfig: k => config.get(k), writeConfig: (k, v) => config.set(k, v) } }),
    './plan-policy': policy, './db': { getDb: () => db },
    './config': { readConfig: k => config.get(k), writeConfig: (k, v) => config.set(k, v) },
    './safe-storage': { decryptToken: k => k }, './logger': { logger: { info() {}, warn() {}, error() {} } },
    './ai-usage': { recordAiUsage() {} }, openai: FakeOpenAI
  })
  const date = api.localDateStr()
  const saved = { date, tasks_json: JSON.stringify([task('政治20题', 15, 'practice', 1), task('行测全真模拟', 120)]), status: 'partial', note: '原有反馈', ai_adjusted: 0, adjustment_reason: '', created_at: 'original-created', updated_at: 'original-version' }
  plans.set(date, saved)
  return { api, plans, date, saved, config, resolveAi }
}
const reviewResponse = JSON.stringify({ tasks: [{ title: '今天复盘', detail: '核对错因', minutes: 30, module: '复盘', kind: 'review' }], remaining_minutes: 30, review_only: true, review_ratio: 1.5, adjustment_summary: '只复盘，取消新题' })
test('一句更正端到端：只剩30分钟，仅调整未完成，留住原记录', async () => {
  const h = harness({ content: reviewResponse, actual: 120 })
  const res = await h.api.regenerateTodayPlan({ feedback: '今天只剩30分钟，只复盘' })
  assert.equal(res.success, true)
  assert.deepEqual(res.plan.tasks[0], JSON.parse(h.saved.tasks_json)[0])
  assert.equal(minutes(res.plan.tasks), 30)
  assert.equal(res.plan.created_at, 'original-created')
  assert.ok(res.plan.note.includes('原有反馈'))
  assert.ok(res.plan.note.includes('今天只剩30分钟'))
  assert.equal(h.config.has('plan_user_corrections'), false)
})
test('长期更正才记忆，不将临时疲劳当作永久规则', async () => {
  const h = harness({ content: reviewResponse })
  await h.api.regenerateTodayPlan({ feedback: '以后不要同一天做行测和申论' })
  assert.deepEqual(JSON.parse(h.config.get('plan_user_corrections')), ['以后不要同一天做行测和申论'])
})
test('无AI/截断JSON：原计划和勾选均不变', async () => {
  for (const options of [{ apiKey: false, content: '' }, { content: '{"tasks":[' }]) {
    const h = harness(options)
    const before = JSON.stringify(h.saved)
    const res = await h.api.regenerateTodayPlan({ feedback: '今天太累' })
    assert.equal(res.success, false)
    assert.equal(JSON.stringify(h.plans.get(h.date)), before)
  }
})
test('调整时勾选变化：不覆盖较新的完成状态', async () => {
  const h = harness()
  const promise = h.api.regenerateTodayPlan({ feedback: '只复盘' })
  h.plans.set(h.date, { ...h.saved, updated_at: 'new-version' })
  h.resolveAi(reviewResponse)
  const res = await promise
  assert.equal(res.success, false)
  assert.equal(h.plans.get(h.date).updated_at, 'new-version')
})
test('默认周末与节假日计划：不混排两类套题，时间受限且复盘≥做题', async () => {
  const h = harness({ apiKey: false, content: '' })
  for (const date of ['2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-14']) {
    // This scenario tests fresh default plans, not the harness's seeded "today" plan.
    h.plans.delete(date)
    const plan = await h.api.ensurePlanFor(date)
    const practice = plan.tasks.filter(t => policy.taskKind(t) === 'practice').reduce((n, t) => n + t.minutes, 0)
    const review = plan.tasks.filter(t => policy.taskKind(t) === 'review').reduce((n, t) => n + t.minutes, 0)
    assert.ok(review >= practice, date)
    assert.ok(new Set(plan.tasks.map(policy.fullPaper).filter(Boolean)).size <= 1, date)
    assert.ok(minutes(plan.tasks) <= (/10-10|10-12|10-14/.test(date) ? 90 : 240), date)
  }
})
