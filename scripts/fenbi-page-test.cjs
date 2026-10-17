/* Real Chromium DOM tests, without login, AI, production DB or remote requests. */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const assert = require('assert/strict')
const ts = require('typescript')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'fenbi-dom-test-')))
const mod = { exports: {} }
new Function('exports', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main/fenbi-page.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(mod.exports)
const { readFenbiReportPage, validateFenbiReport } = mod.exports
const figure = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='
let body = '', server, win, passed = 0
const section = (title, content) => `<section class="result-common-section"><app-solution-title>${title}</app-solution-title>${content}</section>`
function item(index, { wrong = false, legacy = false, missing = false, unanswered = false, formula = false, imageOnly = false } = {}) {
  return `<app-solution-choice><div>单选题</div><app-question-choice><div class="question-choice-container"><p>第${index}道题第一段</p><p>第二段</p><app-choice-radio><ul class="choice-radios">${['A', 'B', 'C', 'D'].map(key => `<li class="choice-radio"><label><input type="radio" ${!missing && !unanswered && key === (wrong ? 'A' : 'B') ? 'checked' : ''}><div class="input-radio ${!missing && !unanswered && !wrong && key === 'B' ? 'correct' : ''}">${key}</div>${legacy ? `<p class="input-text">选项${key}</p>` : `<app-format-html><p>${imageOnly ? `<img src="/option-${key}.png">` : `富文本选项${key}`}</p></app-format-html>`}</label></li>`).join('')}</ul></app-choice-radio></div></app-question-choice><app-solution-overall><span class="correct-answer">B</span>${wrong || legacy || unanswered ? `<span class="your-answer">${unanswered ? '未作答' : wrong ? 'A' : 'B'}</span>` : ''}<span class="answer-time">1分20秒</span></app-solution-overall><app-result-common>${section('解析视频', '粉笔 行测 会员 999人已开通')}${section('解析', `<p>根据题干计算，公式为${formula ? '<img src="/formulas?latex=encrypted"><span>，结果为</span><img src="/result.png">' : '1+1=2'}，故正确答案为B。</p>`)}${section('考点', '<p>文字资料</p><p>现期比重</p>')}${section('来源', '<p>2026年测试试卷第1题</p>')}</app-result-common></app-solution-choice>`
}
async function read(html) {
  body = `<html><head><title>资料分析练习</title></head><body>${html}</body></html>`
  await win.loadURL(`http://127.0.0.1:${server.address().port}/report`)
  return win.webContents.executeJavaScript('(' + readFenbiReportPage.toString() + ')()')
}
app.whenReady().then(async () => {
  server = http.createServer((req, res) => { if (req.url !== '/report') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from(figure.split(',')[1], 'base64')); return } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body) }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.on('listening', resolve))
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
  const header = '<div>难度4.3</div><span>9</span><span>/15</span><div>共计15题 答对9题 答错6题 未答0题</div>'
  let raw = await read(header + Array.from({ length: 15 }, (_, i) => `${i % 5 === 0 ? `<app-materials><p>公共资料${i / 5 + 1}</p>${i === 5 ? '<img src="/chart1.png"><img src="/chart2.png">' : ''}</app-materials>` : ''}${item(i + 1, { wrong: i < 6, formula: i === 0 })}`).join(''))
  assert.equal(validateFenbiReport(raw), null); assert.equal(raw.questions.filter(q => q.isWrong).length, 6); assert.equal(raw.questions[14].userAnswer, 'B'); assert.equal(raw.questions[0].options[3].text, '富文本选项D'); assert.equal(raw.questions[0].stem, '第1道题第一段\n第二段'); assert.equal(raw.materials.length, 3); assert.equal(raw.materials[1].images.length, 2); assert.equal(raw.questions[5].materialIndex, 2); assert.deepEqual(raw.questions[0].keypoints, ['文字资料', '现期比重']); assert.match(raw.questions[0].source, /2026年测试/); assert.equal(raw.difficulty, 4.3); assert.match(raw.questions[0].analysis, /公式为!\[解析图片\].*formulas.*结果为!\[解析图片\]/); assert.doesNotMatch(raw.questions[0].analysis, /会员|999/); assert.equal(raw.questions[0].analysisImages.length, 2); passed++
  raw = await read(item(1, { legacy: true })); assert.equal(validateFenbiReport(raw), null); assert.equal(raw.questions[0].options[0].text, '选项A'); passed++
  raw = await read(item(1, { missing: true })); assert.equal(raw.questions[0].isWrong, null); assert.match(validateFenbiReport(raw), /尚未取得/); passed++
  raw = await read(item(1, { unanswered: true })); assert.equal(raw.questions[0].isWrong, null); assert.equal(raw.questions[0].answerEvidence, 'unanswered'); passed++
  raw = await read(item(1, { imageOnly: true })); assert.equal(validateFenbiReport(raw), null); assert.equal(raw.questions[0].optionImages.A.length, 1); passed++
  raw = await read(header + item(1)); assert.match(validateFenbiReport(raw), /实际读取 1/); passed++
  console.log(`PASS: ${passed} Chromium DOM scenarios, including 15-question mixed report, legacy UI, missing/unanswered, image options, partial report`)
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { win?.destroy(); server?.close(); app.quit() })
