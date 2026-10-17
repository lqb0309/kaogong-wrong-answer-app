const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const moduleUnderTest = { exports: {} }
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main/fenbi-page.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
new Function('module', 'exports', source)(moduleUnderTest, moduleUnderTest.exports)
const { validateFenbiReport } = moduleUnderTest.exports
const question = (isWrong = false) => ({ stem: '题干', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], correctAnswer: 'B', userAnswer: isWrong ? 'A' : 'B', isWrong })
test('新版混合报告：15题9对6错，与粉笔统计一致才允许同步', () => {
  assert.equal(validateFenbiReport({ questions: Array.from({ length: 15 }, (_, i) => question(i < 6)), summary: { total: 15, correct: 9, wrong: 6, unanswered: 0 } }), null)
})
test('缺失答案、未答以及未加载不能当作答对', () => {
  for (const extra of [{ userAnswer: '', isWrong: null }, { correctAnswer: '' }, { userAnswer: '未作答', isWrong: null }]) assert.match(validateFenbiReport({ questions: [{ ...question(), ...extra }] }), /尚未取得/)
})
test('错题数量或题量对不上时拒绝半份报告', () => {
  assert.match(validateFenbiReport({ questions: [question()], summary: { total: 15 } }), /实际读取 1/)
  assert.match(validateFenbiReport({ questions: [question()], summary: { total: 1, correct: 0, wrong: 1 } }), /不一致/)
})
test('空选项不能同步；纯图片选项需要有对应图片', () => {
  const q = { ...question(), options: [{ key: 'A', text: '' }] }
  assert.match(validateFenbiReport({ questions: [q] }), /选项/)
  assert.equal(validateFenbiReport({ questions: [{ ...q, optionImages: { A: ['https://example.invalid/chart.png'] } }] }), null)
})
