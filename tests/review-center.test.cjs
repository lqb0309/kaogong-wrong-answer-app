const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
function compile(relative, deps = {}) {
  const out = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', out)(name => Object.hasOwn(deps, name) ? deps[name] : name.startsWith('./') ? {} : require(name), mod, mod.exports)
  return mod.exports
}
const review = compile('src/main/review-center.ts', { electron: {} })
const text = compile('src/main/review-text.ts')
test('复习选题优先未复习和长期未复习，近七天做过的题后排；不改动候选记录', () => {
  const rows = [
    { id: 'recent', error_count: 8, last_reviewed_at: '2026-10-12T00:00:00Z', created_at: '2026-09-01' },
    { id: 'old', error_count: 2, last_reviewed_at: '2026-09-01T00:00:00Z', created_at: '2026-08-01' },
    { id: 'new', error_count: 1, last_reviewed_at: null, created_at: '2026-10-01' }
  ]
  const original = JSON.stringify(rows)
  assert.deepEqual(review.rankReviewQuestions(rows, Date.parse('2026-10-13T00:00:00Z')).map(q => q.id), ['new', 'old', 'recent'])
  assert.equal(JSON.stringify(rows), original)
})
test('同等复习状态下反复错优先，排序稳定不随机重复', () => {
  const rows = [{ id: 'b', error_count: 1, created_at: '2026-09-01' }, { id: 'a', error_count: 1, created_at: '2026-09-01' }, { id: 'c', error_count: 3, created_at: '2026-09-01' }]
  assert.deepEqual(review.rankReviewQuestions(rows, Date.parse('2026-10-13')).map(q => q.id), ['c', 'a', 'b'])
})
test('仅看过解析不会被排到七天后，且说明尚未独立作答', () => {
  const ranked=review.rankReviewQuestions([{id:'a',last_read_at:'2026-10-15',created_at:'2026-10-01'}],Date.parse('2026-10-15'))
  assert.match(ranked[0].selection_reason,/看过解析，尚未记录独立作答/)
  assert.ok(ranked[0].selection_score>=100000)
})
test('按题量或时间选题不拆散同一材料组，也不会重复凑题',()=>{
  const rows=[{id:'a1',group_id:'a'},{id:'b'},{id:'a2',group_id:'a'},{id:'c'}]
  assert.deepEqual(review.selectReviewCandidates(rows,3).picked.map(q=>q.id),['a1','a2','b'])
  const selection=review.selectReviewCandidates(rows,100,5)
  assert.deepEqual(selection.picked.map(q=>q.id),['b','c'])
  assert.ok(selection.estimatedMinutes<=5); assert.equal(selection.skippedGroups,1)
  assert.equal(new Set(selection.picked.map(q=>q.id)).size,selection.picked.length)
})
test('解析页面杂项和思考草稿不能进入导出复盘', () => {
  assert.equal(text.reliableOfficialAnalysis('视频\n粉笔\n行测\n会员\n21272192人已开通'), '')
  assert.ok(text.reliableOfficialAnalysis('根据题干先计算基期数量，因此本题选择 D。'))
  assert.equal(text.cleanPersonalReflection('我们只需要按照要求生成，先分析用户要求。'), '')
  assert.equal(text.cleanPersonalReflection('我们只需要分析\n## 考点与识别信号\n这是正式复盘'), '## 考点与识别信号\n这是正式复盘')
})
test('离线 Markdown 保持标题、加粗及多行公式，同时转义外来 HTML', () => {
  const html = text.renderReviewText('## 复盘\n**年份**先对齐\n$$\n\\frac{a}{b}\n$$\n<script>alert(1)</script>')
  assert.match(html, /<h3>复盘<\/h3>/)
  assert.match(html, /<strong>年份<\/strong>/)
  assert.match(html, /<math[\s>]/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})
test('离线解析公式只嵌入缓存图片，不泄露本地路径或执行外来图片协议', () => {
  const input = '计算![解析图片](</tmp/private-formula.png>)得结果。'
  assert.doesNotMatch(text.renderReviewText(input), /private-formula/)
  assert.match(text.renderReviewText(input, () => 'data:image/png;base64,YQ=='), /<img src="data:image\/png;base64,YQ=="/)
  assert.doesNotMatch(text.renderReviewText(input, () => 'javascript:alert(1)'), /<img|javascript/)
})
