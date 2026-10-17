// Isolated real SQLite + Electron PDF/HTML integration. No production preload, AI or Vault.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const output = process.argv[2] || path.join(os.tmpdir(), 'review-export-results-' + Date.now())
assert.ok(output && path.isAbsolute(output))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-integration-'))
app.setPath('userData', scratch)
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})
const logger = new Proxy({}, { get: () => () => {} })
function compile(relative, deps = {}, extra = '') {
  const content = fs.readFileSync(path.join(root, relative), 'utf8') + '\n' + extra
  const text = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', text)(name => Object.hasOwn(deps, name) ? deps[name] : name.startsWith('./') ? (() => { throw Error('Unmapped ' + name) })() : require(name), mod, mod.exports)
  return mod.exports
}
const dates = compile('src/main/date-utils.ts')
const dbModule = compile('src/main/db.ts', { './date-utils': dates })
const reviewText = compile('src/main/review-text.ts')
const order = compile('src/main/paper-order.ts')
const assets = compile('src/main/image-assets.ts')
const filters = compile('src/main/question-filters.ts')
const pdf = compile('src/main/pdf-generator.ts', { './storage': { getLocalDataDir: () => scratch }, './paper-order': order, './image-assets': assets, './db': dbModule, './logger': { logger }, './review-text': reviewText }, 'exports.buildFullHtml = buildFullHtml;')
let cancelNext = false, renders = 0, failRender = 0, destinationName = '连续阅读.html'
const review = compile('src/main/review-center.ts', {
  './db': dbModule, './question-filters': filters, './pdf-generator': { ...pdf, generatePdf: (...args) => { renders++; return renders === failRender ? Promise.resolve({ success: false, error: '模拟第二个文件失败', imageErrors: [] }) : pdf.generatePdf(...args) } },
  './date-utils': dates, './daily-plan': { completePlanTaskForActivity: () => null },
  electron: { BrowserWindow, dialog: {
    showOpenDialog: async () => { const canceled = cancelNext; cancelNext = false; return { canceled, filePaths: [output] } },
    showSaveDialog: async () => { const canceled = cancelNext; cancelNext = false; return { canceled, filePath: path.join(output, destinationName) } }
  } }
})
const chart = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="800" height="300" fill="white"/><g fill="#708cb4"><rect x="100" y="140" width="80" height="100"/><rect x="300" y="90" width="80" height="150"/><rect x="500" y="40" width="80" height="200"/></g><path d="M60 30V240H720" fill="none" stroke="#333"/><g font-size="24"><text x="100" y="275">2022</text><text x="300" y="275">2023</text><text x="500" y="275">2024</text></g></svg>').toString('base64')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true }); dbModule.initDatabase(); const db = dbModule.getDb()
  const formulaPath = path.join(scratch, 'formula.png')
  await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="60"><rect width="480" height="60" fill="white"/><text x="10" y="42" font-size="30">200 / (1 + 25%) = 160</text></svg>')).png().toFile(formulaPath)
  const groupInsert = db.prepare('INSERT INTO question_groups (id, title, passage_text, material_images, created_at) VALUES (?, ?, ?, ?, ?)')
  groupInsert.run('group-a', '资料组甲', '唯一公共材料甲：2023年总量为200万，同比增长25%，请结合图表回答。', JSON.stringify([chart]), new Date().toISOString())
  groupInsert.run('group-b', '资料组乙', '唯一公共材料乙：某地区登记量增长，请先辨别现期与基期。', JSON.stringify([chart]), new Date().toISOString())
  const insert = db.prepare(`INSERT INTO questions (id,image_url,level1,level2,confidence,ocr_text,status,error_count,error_type,group_id,question_number,material_image_ids,original_answer,original_analysis,reflection,created_at,confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (let i = 0; i < 32; i++) {
    const group = i >= 1 && i <= 3 ? 'group-a' : i >= 5 && i <= 7 ? 'group-b' : null
    insert.run('question-' + i, '', group ? '资料分析' : '数量关系', group ? '基期比重' : '排列组合', .95,
      `案例 ${String(i).padStart(2, '0')}：根据材料，2022年甲地区登记量占全国登记总量的比重约为多少？\nA. 10%\nB. 13%\nC. 18%\nD. 23%`, 'confirmed', i % 4 === 0 ? 0 : i % 3 + 1, i % 4 === 0 ? '正确但超时' : i % 2 ? '结果错误' : '错误且超时', group, String(i), group ? JSON.stringify([chart]) : '[]',
      JSON.stringify({ correct: 'D', user: i % 4 === 0 ? 'D' : 'B', targetSeconds: 90, overtimeSeconds: i % 2 ? 0 : 30, answerTime: '60秒' }),
      i === 4 ? '视频\n粉笔\n行测\n会员\n21272192人已开通' : `解析 ${String(i).padStart(2, '0')}：根据题干先还原基期量${i === 0 ? `![解析图片](<${formulaPath}>)` : ''}，再计算比重。因此选择 D。`,
      '## 考点与识别信号\n**核心考点**：基期比重，先找年份。\n## 标准解题路径\n1. 还原分子和分母。\n2. 基期量：$\\frac{现期量}{1+增长率}$。\n## 易错复盘\n不要混用两个年份的数量。', '2026-09-01T02:00:00Z', '2026-09-01T02:00:00Z')
  }
  const standard = review.createReviewBatch({ count: 20 })
  assert.equal(standard.questionIds.length, 20)
  assert.ok(standard.questions.every(q => q.error_type !== '正确但超时'))
  assert.equal(standard.completedAt, null)
  assert.throws(() => review.createReviewBatch({ ids: [] }))
  assert.throws(() => review.createReviewBatch({ ids: ['deleted'] }))
  const short = review.createReviewBatch({ count: 100, excludeIds: standard.questionIds })
  assert.equal(short.questionIds.length, 4)
  const manual = review.createReviewBatch({ ids: Array.from({ length: 20 }, (_, i) => 'question-' + i) })
  const snapshotIds = manual.questionIds
  db.prepare("UPDATE questions SET ocr_text='不应进入旧清单的新题干', original_analysis='不应进入旧清单的新解析' WHERE id='question-1'").run()
  cancelNext = true; const beforeRenders = renders
  assert.equal((await review.exportReviewBatch({ batchId: manual.id, format: 'pdf', content: 'full' })).canceled, true)
  assert.equal(renders, beforeRenders)
  const split = await review.exportReviewBatch({ batchId: manual.id, format: 'pdf', content: 'full' })
  assert.equal(split.files.length, 2); assert.deepEqual(split.questionIds, snapshotIds)
  assert.equal(review.getReviewBatch(manual.id).completedAt, null)
  assert.equal(split.imageErrors.length, 0)
  const reader = await review.exportReviewBatch({ batchId: manual.id, format: 'html', content: 'full' })
  const html = fs.readFileSync(reader.files[0], 'utf8')
  assert.ok(!html.includes('不应进入旧清单的新题干'))
  assert.ok(!html.includes('21272192人已开通'))
  assert.equal((html.match(/唯一公共材料甲/g) || []).length, 1)
  assert.equal((html.match(/data-question-id=/g) || []).length, 20)
  assert.equal((html.match(/class="reader-solution"/g) || []).length, 20)
  assert.ok(!/<img[^>]+src="(?:https?:|file:)/.test(html))
  assert.ok(html.includes('data:image/png;base64,'), '解析公式图片嵌入离线页')
  assert.ok(!html.includes(formulaPath), '离线页不泄露本地图片路径')
  assert.ok(!html.includes('![解析图片]'), '不把图片标记当成普通文字')
  const before = db.prepare('SELECT id,status,error_count FROM questions ORDER BY id').all()
  const completed = review.completeReviewBatch(manual.id)
  assert.ok(completed.completedAt)
  assert.equal(review.completeReviewBatch(manual.id).alreadyCompleted, true)
  assert.deepEqual(db.prepare('SELECT id,status,error_count FROM questions ORDER BY id').all(), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_batch_items WHERE batch_id=? AND completed_at IS NOT NULL').get(manual.id).n, 20)
  const beforeFailure = new Set(fs.readdirSync(output)); failRender = renders + 2
  await assert.rejects(review.exportReviewBatch({ batchId: standard.id, format: 'pdf', content: 'full' }))
  assert.deepEqual(new Set(fs.readdirSync(output)), beforeFailure)
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { offscreen: true, sandbox: true } })
  await win.loadFile(reader.files[0]); await wait(250)
  const readerState = await win.webContents.executeJavaScript(`(()=>{document.getElementById('reader-expand').click();document.getElementById('reader-larger').click();return {count:document.querySelectorAll('.reader-solution[open]').length,font:document.body.style.fontSize,badImages:[...document.images].filter(i=>i.src&&!i.complete).length,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
  assert.equal(readerState.count, 20); assert.equal(readerState.font, '20px'); assert.equal(readerState.overflow, false)
  await wait(200)
  fs.writeFileSync(path.join(output, '连续阅读-顶部.png'), (await win.webContents.capturePage()).toPNG())
  await win.webContents.executeJavaScript("document.getElementById('question-20').scrollIntoView();"); await wait(350)
  const scroll = await win.webContents.executeJavaScript('scrollY'); assert.ok(scroll > 0)
  fs.writeFileSync(path.join(output, '连续阅读-末尾.png'), (await win.webContents.capturePage()).toPNG())
  await win.reload(); await wait(400)
  assert.ok(await win.webContents.executeJavaScript('scrollY') > 0, 'reading position should restore')
  assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.reader-solution[open]').length"), 20, 'expanded answers should restore')
  win.destroy()
  fs.writeFileSync(path.join(output, 'integration-report.json'), JSON.stringify({ passed: true, questions: 20, splitFiles: split.files, reader: reader.files[0], fixedOrder: snapshotIds, readerState, noAutomaticCompletion: true, completionIdempotent: true }, null, 2))
  db.close()
  process.stdout.write(JSON.stringify({ passed: true, output, pdfs: split.files, reader: reader.files[0] }) + '\n')
}).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 }).finally(() => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(process.exitCode || 0) })
