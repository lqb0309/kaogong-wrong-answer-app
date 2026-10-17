const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')
const mod = { exports: {} }
const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main/question-filters.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
new Function('module', 'exports', output)(mod, mod.exports)
const { answerResultSql, timeStatusSql, performanceFilters } = mod.exports
const quote = value => value == null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'"
const row = (id, type, answer, count = 1) => ({ id, type, raw: typeof answer === 'string' ? answer : JSON.stringify(answer ?? {}), count })
const fixtures = [
  row('wrong', '结果错误', { correct: 'D', user: 'B', overtimeSeconds: 0, targetSeconds: 90, answerTime: '40秒' }),
  row('wrong-slow', '错误且超时', { correct: 'D', user: 'B' }),
  row('correct-slow', '正确但超时', { correct: 'D', user: 'D' }),
  row('correct', '', { correct: 'd', user: 'D', targetSeconds: 90, overtimeSeconds: 0, answerTime: '40秒' }, 0),
  row('legacy-count', '计算错误', {}, 2),
  row('legacy-tag', '', { weaknessType: '错误且超时' }),
  row('legacy-correct', '', { weaknessType: '正确但超时' }),
  row('unknown', '', {}, 0),
  row('malformed', '', '{broken', 0),
  row('json-null', '', 'null', 0),
  row('partial-answer', '', { correct: 'D' }),
  row('missing-time', '结果错误', { correct: 'D', user: 'B', targetSeconds: 90, overtimeSeconds: 0 }),
  // A slow individual question is NOT overdue when its material group stayed within budget.
  row('group-within', '结果错误', { correct: 'D', user: 'B', targetSeconds: 90, overtimeSeconds: 0, answerTime: '3分', timingBasis: 'group', groupActualSeconds: 400, groupTargetSeconds: 450 }),
  row('group-unknown', '结果错误', { correct: 'D', user: 'B', answerTime: '3分', timingBasis: 'group', groupActualSeconds: 0 }),
  row('correct-count-legacy', '', { correct: 'A', user: 'A' }, 4),
  row('metadata-overdue', '粗心', { correct: 'C', user: 'B', overtimeSeconds: 20, targetSeconds: 90, answerTime: '110秒' }),
  row('explicit-within', '', { correct: 'A', user: 'B', isOvertime: false }),
  row('explicit-overdue', '', { correct: 'A', user: 'A', isOvertime: true }, 0)
]
function evaluate(params = {}, suffix = '', rows = fixtures) {
  const filter = performanceFilters(params)
  let index = 0
  const where = filter.conditions.length ? ' WHERE ' + filter.conditions.join(' AND ').replaceAll('?', () => quote(filter.values[index++])) : ''
  const sql = 'CREATE TABLE questions (id TEXT, error_type TEXT, original_answer TEXT, error_count INTEGER);\n' +
    rows.map(r => `INSERT INTO questions VALUES (${quote(r.id)}, ${quote(r.type)}, ${quote(r.raw)}, ${r.count});`).join('\n') +
    `\nSELECT id, ${answerResultSql} AS answer_result, ${timeStatusSql} AS time_status FROM questions${where} ORDER BY id${suffix};`
  const result = spawnSync('sqlite3', ['-json', ':memory:'], { input: sql, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || '[]')
}
test('答错包含普通错题、错误且超时、历史错误标签及记录，不混入答对题', () => {
  const ids = evaluate({ answerResult: 'wrong' }).map(r => r.id)
  for (const id of ['wrong', 'wrong-slow', 'legacy-count', 'legacy-tag', 'group-within', 'metadata-overdue']) assert.ok(ids.includes(id), id)
  for (const id of ['correct', 'correct-slow', 'legacy-correct', 'correct-count-legacy', 'partial-answer', 'unknown']) assert.ok(!ids.includes(id), id)
})
test('答题结果和用时可以组合，未评估不被归入未超时', () => {
  const slow = evaluate({ answerResult: 'wrong', timeStatus: 'overtime' }).map(r => r.id)
  assert.deepEqual(slow, ['legacy-tag', 'metadata-overdue', 'wrong-slow'])
  const within = evaluate({ answerResult: 'wrong', timeStatus: 'within' }).map(r => r.id)
  assert.deepEqual(within, ['explicit-within', 'group-within', 'wrong'])
  const unknown = evaluate({ answerResult: 'wrong', timeStatus: 'unknown' }).map(r => r.id)
  assert.deepEqual(unknown, ['group-unknown', 'legacy-count', 'missing-time'])
})
test('答对包含超时和未超时；缺少个人答案或损坏 JSON 不误判为答对', () => {
  assert.deepEqual(evaluate({ answerResult: 'correct' }).map(r => r.id), ['correct', 'correct-count-legacy', 'correct-slow', 'explicit-overdue', 'legacy-correct'])
  assert.deepEqual(evaluate({ answerResult: 'correct', timeStatus: 'overtime' }).map(r => r.id), ['correct-slow', 'explicit-overdue', 'legacy-correct'])
  assert.deepEqual(evaluate({ answerResult: 'unknown' }).map(r => r.id), ['json-null', 'malformed', 'partial-answer', 'unknown'])
})
test('资料题组沿用保存的用时结论，不用单题固定 90 秒重新判超时', () => {
  const data = evaluate().find(r => r.id === 'group-within')
  assert.equal(data.time_status, 'within')
  assert.equal(evaluate().find(r => r.id === 'group-unknown').time_status, 'unknown')
})
test('筛选在数据库分页前生效，跨页不漏掉错误且超时的题目', () => {
  const rows = Array.from({ length: 65 }, (_, i) => row('test-' + String(i).padStart(2, '0'), i % 2 ? '错误且超时' : '结果错误', { correct: 'A', user: 'B' }))
  assert.equal(evaluate({ answerResult: 'wrong' }, '', rows).length, 65)
  assert.equal(evaluate({ answerResult: 'wrong' }, ' LIMIT 30 OFFSET 30', rows).length, 30)
})
test('筛选条件仅允许定义好的值，不接受 SQL 注入', () => {
  assert.throws(() => performanceFilters({ answerResult: "wrong' OR 1=1" }))
  assert.throws(() => performanceFilters({ timeStatus: 'arbitrary' }))
  assert.deepEqual(performanceFilters({}), { conditions: [], values: [] })
})
