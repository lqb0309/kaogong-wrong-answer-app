const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fse = require('fs-extra')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const ts = require('typescript')
const { fileURLToPath, pathToFileURL } = require('node:url')
const root = path.join(__dirname, '..')
const logger = new Proxy({}, { get: () => () => {} })
function compile(file, dependencies = {}, extra = '') {
  const source = fs.readFileSync(path.join(root, file), 'utf8') + '\n' + extra
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    if (['fs', 'fs-extra', 'path', 'crypto', 'url', 'os', 'dayjs', 'dayjs/plugin/utc'].includes(name)) return require(name)
    throw new Error('Unmocked dependency: ' + name)
  }, module, module.exports)
  return module.exports
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrong-answer-regression-'))
  t.after(() => fse.removeSync(dir))
  return dir
}
const dates = compile('src/main/date-utils.ts')
const data = compile('src/main/question-data.ts', { './date-utils': dates })
const safety = compile('src/main/path-safety.ts')
const order = compile('src/main/paper-order.ts')
const assets = compile('src/main/image-assets.ts')
const reviewText = compile('src/main/review-text.ts', { katex: require('katex') })
const fenbiPage = compile('src/main/fenbi-page.ts')
const record = id => ({ id, image_url: '', level1: '数量关系', level2: '排列组合', error_count: 0, error_type: '正确但超时', ocr_text: '题干与选项原文', reflection: '正式复盘', confirmed_at: '2026-10-05T18:30:00.000Z', created_at: '2026-09-01T00:00:00Z', source: '原始来源', status: 'confirmed' })
test('同秒不同题目使用不同且稳定的笔记名', () => {
  assert.notEqual(data.questionFileName('a'), data.questionFileName('b'))
  assert.equal(data.questionFileName('a'), data.questionFileName('a'))
  assert.throws(() => data.questionFileName(''))
})
test('数据库字段转换保留原文、零错误次数、错误类型及原入库日期', () => {
  const md = data.renderQuestionMarkdown(record('a'))
  assert.match(md, /题干与选项原文/)
  assert.match(md, /正确但超时/)
  assert.match(md, /error_count: 0/)
  assert.match(md, /date: 2026-10-06/)
  assert.doesNotMatch(md, /date: 2026-09-01/)
})
test('北京时间日期边界不依赖运行机器时区', () => {
  assert.equal(dates.localDateKey(new Date('2026-10-05T15:59:59Z')), '2026-10-05')
  assert.equal(dates.localDateKey(new Date('2026-10-05T16:00:00Z')), '2026-10-06')
  assert.match(dates.localDateTime(new Date('2026-10-05T16:00:00Z')), /2026-10-06T00:00:00.000\+08:00/)
})
test('损坏与形状错误的旧图片字段不会让笔记生成崩溃', () => {
  for (const material_image_ids of ['{', '{}', 'null']) assert.doesNotThrow(() => data.renderQuestionMarkdown({ ...record('a'), material_image_ids }))
  assert.deepEqual(data.parseJson('[]', {}), {})
})
test('公共资料、原始解析、答案及选项图片写入笔记', () => {
  const md = data.renderQuestionMarkdown({ ...record('a'), group_passage_text: '公共资料原文', original_analysis: '原解析', original_answer: '{"correct":"B","user":"A"}', option_images: '{"A":["https://example.invalid/a.png"]}' })
  for (const text of ['公共资料原文', '原解析', '正确答案**: B', '我的答案**: A', 'a.png']) assert.ok(md.includes(text))
})
test('题组清单与答题卡按同一顺序，并去重', () => {
  const items = [{ id: 'a1', group_id: 'a' }, { id: 'b' }, { id: 'a2', group_id: 'a' }, { id: 'b' }]
  assert.deepEqual(order.orderPaperQuestions(items).map(q => q.id), ['a1', 'a2', 'b'])
})
test('跨目录及符号链接逃逸均被拒绝', t => {
  const dir = temporary(t), vault = path.join(dir, 'vault'), outside = path.join(dir, 'outside')
  fs.mkdirSync(vault); fs.mkdirSync(outside)
  assert.throws(() => safety.resolveInside(vault, '../outside/x.md'))
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, path.join(vault, 'link'), 'dir')
    assert.throws(() => safety.resolveInside(vault, 'link/x.md'))
  }
  assert.equal(safety.resolveInside(vault, 'new/x.md'), path.join(vault, 'new/x.md'))
})
function vaultHarness(vault) {
  return compile('src/main/obsidian.ts', { './config': { readConfig: () => vault }, './logger': { logger }, './db': { getDb: () => ({}) }, './path-safety': safety, './question-data': data })
}
test('同秒批量入库不覆盖其他题目', t => {
  const dir = temporary(t), writer = vaultHarness(dir)
  for (const id of ['a', 'b']) assert.equal(writer.writeToVault({ ...data.questionData(record(id)), markdown: data.renderQuestionMarkdown(record(id)) }).success, true)
  assert.equal(fs.readdirSync(path.join(dir, '数量关系', '排列组合')).filter(file => file.endsWith('.md')).length, 2)
})
test('外来同名文件及阻塞目录文件不被覆盖或删除', t => {
  const dir = temporary(t), writer = vaultHarness(dir)
  const dest = path.join(dir, '数量关系', '排列组合', data.questionFileName('a'))
  fse.ensureDirSync(path.dirname(dest)); fs.writeFileSync(dest, '人工文件')
  assert.equal(writer.writeToVault({ ...data.questionData(record('a')), markdown: 'new' }).success, false)
  assert.equal(fs.readFileSync(dest, 'utf8'), '人工文件')
  fs.writeFileSync(path.join(dir, '被占用'), '不能删除')
  assert.equal(writer.writeToVault({ id: 'b', level1: '被占用', level2: '子目录', markdown: 'new' }).success, false)
  assert.equal(fs.readFileSync(path.join(dir, '被占用'), 'utf8'), '不能删除')
})
test('自己的笔记可安全更新且不留下临时文件', t => {
  const dir = temporary(t), writer = vaultHarness(dir), q = data.questionData(record('a'))
  const first = writer.writeToVault({ ...q, markdown: data.renderQuestionMarkdown(q) })
  assert.equal(writer.writeToVault({ ...q, markdown: data.renderQuestionMarkdown({ ...q, reflection: '新复盘' }) }).success, true)
  assert.match(fs.readFileSync(first.vaultPath, 'utf8'), /新复盘/)
  assert.ok(fs.readdirSync(path.dirname(first.vaultPath)).every(file => !file.endsWith('.tmp')))
})
test('本地图片、带空格的file地址及data图片共用读取规则', async t => {
  const dir = temporary(t), filename = path.join(dir, '截图 空格.png'), buffer = Buffer.from('test-image')
  fs.writeFileSync(filename, buffer)
  for (const source of [filename, pathToFileURL(filename).href, 'data:image/png;base64,' + buffer.toString('base64')]) {
    assert.deepEqual((await assets.readImageBuffer(source)).buffer, buffer)
  }
  await assert.rejects(assets.readImageBuffer('ftp://example.invalid/x.png'))
})
test('Markdown 编码的本地图片路径可读取，真实百分号文件不被错误解码', async t => {
  const dir = temporary(t), filename = path.join(dir, 'Application Support', '公式 中文.png')
  fse.ensureDirSync(path.dirname(filename)); fs.writeFileSync(filename, 'formula-image')
  assert.equal((await assets.readImageBuffer(encodeURI(filename))).buffer.toString(), 'formula-image')
  const literal = path.join(dir, 'formula%20image.png'), spaced = path.join(dir, 'formula image.png')
  fs.writeFileSync(literal, 'literal-percent'); fs.writeFileSync(spaced, 'space')
  assert.equal((await assets.readImageBuffer(literal)).buffer.toString(), 'literal-percent')
  assert.equal((await assets.readImageBuffer(encodeURI(literal))).buffer.toString(), 'literal-percent')
  await assert.rejects(assets.readImageBuffer(path.join(dir, 'missing%ZZ.png')))
})
function retryHarness(dir, rows, successful = false) {
  const config = new Map([['obsidian_vault', dir]]), writes = []
  const db = { prepare: () => ({ get: id => rows[id]?.status === 'confirmed' ? rows[id] : undefined, run: () => ({ changes: 1 }) }) }
  const api = compile('src/main/retry-queue.ts', { './config': { readConfig: key => config.get(key), writeConfig: (key, value) => config.set(key, value) }, './obsidian': { writeToVault: q => { writes.push(q); return { success: successful, relativePath: 'new.md' } } }, './logger': { logger }, './db': { getDb: () => db }, './question-data': data })
  return { api, config, writes }
}
test('重试读取最新内容，不恢复删除题目', t => {
  const h = retryHarness(temporary(t), { a: { ...record('a'), reflection: '最新复盘' } }, true)
  h.api.enqueueVaultWrite({ id: 'a', reflection: '旧复盘' }, '旧正文')
  h.api.enqueueVaultWrite({ id: 'deleted' }, '被删题目')
  assert.deepEqual(h.api.flushVaultQueue(), { flushed: 1, failed: 0 })
  assert.equal(h.writes.length, 1)
  assert.match(h.writes[0].markdown, /最新复盘/)
  assert.equal(h.api.queueSize(), 0)
})
test('超过200条不静默丢失，失败8次仍保留，同一题仅排队一次', t => {
  const rows = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [String(i), record(String(i))]))
  const h = retryHarness(temporary(t), rows)
  for (const id of Object.keys(rows)) h.api.enqueueVaultWrite({ id }, '')
  h.api.enqueueVaultWrite({ id: '0', reflection: '最新' }, '')
  assert.equal(h.api.queueSize(), 205)
  for (let i = 0; i < 9; i++) h.api.flushVaultQueue()
  assert.equal(h.api.queueSize(), 205)
  h.api.removeVaultRetry('0'); assert.equal(h.api.queueSize(), 204)
})
function knowledgeHarness(dir) {
  const config = new Map([['obsidian_vault', dir]])
  const api = compile('src/main/knowledge-cards.ts', { './config': { readConfig: key => config.get(key), writeConfig: (key, value) => config.set(key, value) }, './logger': { logger }, './db': { getDb: () => ({}) }, './date-utils': dates, './path-safety': safety })
  return { api, config }
}
test('知识卡片拒绝AI输出的目录逃逸与错误日期', t => {
  const h = knowledgeHarness(temporary(t))
  const result = h.api.writeInductionResults('日记', '2026-10-06', [{ file_path: '../outside.md', title: '卡', body: '正文', linked_cards: [], related_questions: [] }], [], [])
  assert.equal(result.newCards[0].success, false)
  assert.equal(result.dailyNote.success, false)
  assert.equal(h.api.writeDailyNote('../../outside', '正文').success, false)
})
test('归纳部分失败后补写，成功卡片不重复累计，缺少章节会补建', t => {
  const dir = temporary(t), h = knowledgeHarness(dir)
  const first = path.join(dir, '第一张.md')
  fs.writeFileSync(first, '---\ntype: knowledge_card\nerror_count: 1\nlast_seen: 2026-10-05\n---\n# 第一张\n')
  const operation = file => ({ existing_file: file, add_to_section: '易错点', new_content: '新归纳', increment_error_count: 1, new_linked_cards: [], new_related_questions: [] })
  const updates = [operation('第一张.md'), operation('暂缺.md')]
  const failed = h.api.writeInductionResults('每日正文', '2026-10-06', [], updates, [])
  assert.equal(failed.dailyNote.success, false)
  assert.match(fs.readFileSync(first, 'utf8'), /## 易错点\n新归纳/)
  assert.match(fs.readFileSync(first, 'utf8'), /error_count: 2/)
  fs.writeFileSync(path.join(dir, '暂缺.md'), '---\nerror_count: 0\n---\n# 补写\n')
  const retried = h.api.writeInductionResults('每日正文', '2026-10-06', [], updates, [])
  assert.equal(retried.dailyNote.success, true)
  assert.match(fs.readFileSync(first, 'utf8'), /error_count: 2/)
  assert.equal(fs.readFileSync(first, 'utf8').split('新归纳').length, 2)
})
test('取消一个进度订阅不会删掉其他组件订阅', () => {
  let api
  const events = new Map()
  const ipcRenderer = { invoke() {}, on(name, listener) { const list = events.get(name) || []; list.push(listener); events.set(name, list) }, removeListener(name, listener) { events.set(name, events.get(name).filter(fn => fn !== listener)) } }
  compile('src/preload/index.ts', { electron: { ipcRenderer, contextBridge: { exposeInMainWorld(_name, value) { api = value } } } })
  let seen = 0
  const unsubscribe = api.onAiProgress(() => { seen++ })
  api.onAiProgress(() => { seen += 10 })
  unsubscribe()
  events.get('ai:progress').forEach(fn => fn({}, {}))
  assert.equal(seen, 10)
})

function aiHarness(replies) {
  const requests = [], usage = []
  class FakeOpenAI {
    chat = { completions: { create: async input => {
      requests.push(input)
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return reply
    } } }
  }
  const api = compile('src/main/ai.ts', {
    './ai-validation': compile('src/main/ai-validation.ts', { zod: require('zod') }),
    './config': { readConfig: key => ({ ai_api_key: 'test-only', vision_api_key: 'test-only' })[key] },
    './safe-storage': { decryptToken: value => value }, './tag-service': { getTagTree: () => [] },
    './logger': { logger }, './utils': { generateTraceId: () => 'test', toImageUrl: value => value },
    openai: FakeOpenAI, './ai-usage': { recordAiUsage: (...args) => usage.push(args) },
    './image-assets': { readImageBuffer: async () => ({ buffer: Buffer.from('mock-image'), mime: 'image/png' }) }
  })
  return { api, requests, usage }
}
const finalReflection = '## 考点与识别信号\n- 考点\n\n## 标准解题路径\n1. 解法\n\n## 考场最短路径\n按标准步骤\n\n## 易错复盘\n比较错误选项\n\n## 下次行动规则\n**先识别，再计算。**'
const reply = (content, reasoning_content, finish_reason = 'stop') => ({ choices: [{ message: { content, reasoning_content }, finish_reason }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
test('AI空正文不回退到推理草稿，两次失败后明确报错', async () => {
  const h = aiHarness([reply('', '我们只需要先分析用户要求'), reply('', '私有草稿')])
  await assert.rejects(h.api.generateReflection({ level1: '数量关系', ocrText: '题干' }), /未返回可用/)
  assert.equal(h.requests.length, 2)
})
test('AI复盘包含完整公共资料，不引用无效粉笔会员页面', async () => {
  const h = aiHarness([reply(finalReflection)])
  await h.api.generateReflection({ level1: '资料分析', ocrText: '求增长率', materialText: '现期200，基期100', officialAnalysis: '视频\n粉笔\n行测\n会员\n21272192人已开通', correctAnswer: 'B', userAnswer: 'A' })
  const prompt = h.requests[0].messages[1].content
  assert.ok(prompt.includes('现期200，基期100'))
  assert.ok(prompt.includes('正确答案：B'))
  assert.ok(!prompt.includes('21272192'))
  assert.ok(prompt.includes('潜在耗时原因必须标为“可能”'))
})
test('缺少可靠解析的图表题先读取图表再生成复盘', async () => {
  const h = aiHarness([reply('图表：基期100，现期200'), reply(finalReflection)])
  assert.equal(await h.api.generateReflection({ level1: '资料分析', ocrText: '题干', imageUrls: ['file:///mock.png'] }), finalReflection)
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[0].messages[0].content[1].type, 'image_url')
  assert.ok(h.requests[1].messages[1].content.includes('基期100'))
})
test('AI截断正文不会当成功保存', async () => {
  const h = aiHarness([reply(finalReflection, '', 'length'), reply(finalReflection, '', 'length')])
  await assert.rejects(h.api.generateReflection({ level1: '数量关系', ocrText: '题干' }), /截断/)
})
test('DeepSeek V4 预留思考及正文预算，仅对官方兼容模型设置 effort', () => {
  const h = aiHarness([])
  assert.deepEqual(h.api.reflectionOutputOptions('https://api.deepseek.com', 'deepseek-v4-pro', 1), { max_tokens: 8192, reasoning_effort: 'low' })
  assert.deepEqual(h.api.reflectionOutputOptions('https://api.deepseek.com/v1', 'deepseek-flash', 2), { max_tokens: 16384, reasoning_effort: 'low' })
  assert.deepEqual(h.api.reflectionOutputOptions('https://api.deepseek.com', 'deepseek-reasoner', 1), { max_tokens: 8192 })
  for (const [url, model] of [['https://api.deepseek.com.evil.invalid', 'deepseek-v4-pro'], ['https://proxy.invalid', 'deepseek-v4-pro'], ['https://api.deepseek.com', 'custom-model']]) {
    assert.deepEqual(h.api.reflectionOutputOptions(url, model, 1), { max_tokens: 3000 })
  }
})
test('复盘带入题组总时间，不能把组内正常单题机械判超时', async () => {
  const h = aiHarness([reply(finalReflection)])
  await h.api.generateReflection({ level1: '资料分析', ocrText: '题干', timingBasis: 'group', answerTime: '1分22秒', groupActualSeconds: 416, groupTargetSeconds: 405, groupGraceSeconds: 41 })
  assert.match(h.requests[0].messages[1].content, /实际 416 秒，参考 405 秒，宽限 41 秒，本组未超时/)
  assert.match(h.requests[0].messages[1].content, /不得写“本题耗时偏长”/)
  assert.match(h.api.reflectionTimingContext({ timingBasis: 'group', groupActualSeconds: 585, groupTargetSeconds: 450, groupGraceSeconds: 45 }), /本组超时/)
  assert.match(h.api.reflectionTimingContext({ timingBasis: 'group' }), /不判断超时/)
  let captured
  const ipc = ipcHarness({}, { dependencies: {
    './ai': { generateReflection: async params => { captured = params; return finalReflection } },
    './storage': { loadQuestionData: () => ({ level1: '资料分析', materialText: '公共材料', originalAnswer: JSON.stringify({ correct: 'B', user: 'B', answerTime: '1分22秒', timingBasis: 'group', groupActualSeconds: 416, groupTargetSeconds: 405, groupGraceSeconds: 41 }) }) }
  } })
  assert.equal((await ipc.handlers.get('ai:reflect')({ sender: {} }, { questionId: 'q', level1: '资料分析', ocrText: '题干' })).success, true)
  assert.equal(captured.groupActualSeconds, 416)
  assert.equal(captured.timingBasis, 'group')
  assert.equal(captured.answerTime, '1分22秒')
})
test('解析公式图片先转写，文本模型不会收到只有图片地址的假公式', async () => {
  const h = aiHarness([reply('解析图片1：现期量除以基期量。'), reply(finalReflection)])
  await h.api.generateReflection({ level1: '资料分析', ocrText: '题干', officialAnalysis: '根据题干可知计算公式为![解析图片](</tmp/formula.png>)，故正确答案为B。' })
  assert.equal(h.requests.length, 2)
  assert.match(h.requests[0].messages[0].content[0].text, /公式和计算过程转写/)
  const context = h.requests[1].messages[1].content
  assert.ok(context.includes('现期量除以基期量'))
  assert.ok(!context.includes('/tmp/formula.png'))
})

function fenbiHarness(raw, imported = false) {
  const captured = []
  const db = { prepare(sql) {
    assert.ok(!/^(?:UPDATE|INSERT|DELETE)/i.test(sql.trim()), '预览不得改写数据库')
    return { get: fingerprint => (typeof imported === 'function' ? imported(fingerprint) : imported) ? { id: 'existing' } : undefined }
  } }
  const api = compile('src/main/fenbi-import.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false } },
    './db': { getDb: () => db }, './logger': { logger }, './ai': { generateReflection: async () => '' },
    './storage': {}, './utils': { generateTraceId: () => 'trace' }, './date-utils': dates,
    './question-data': data, './daily-plan': { completePlanTasksFromFenbi: () => [] }, './fenbi-page': fenbiPage
    , './config': { readConfig: () => undefined, writeConfig() {} }, './fenbi-network': {}
  }, 'exports.__setWindow = win => { fenbiWindow = win }; exports.__efficiency = annotateEfficiency;')
  api.__setWindow({ isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => 'https://spa.fenbi.com/ti/exam/solution/test', executeJavaScript: async script => { captured.push(script); return raw } } })
  return { api, captured }
}
const fenbiQuestion = overrides => ({ sourceId: '', index: 1, materialIndex: 1, stem: '题干', options: [{ key: 'A', text: '选项' }], correctAnswer: 'B', userAnswer: 'A', isWrong: true, analysis: '视频\n粉笔\n行测\n会员\n21272192人已开通', keypoints: ['资料分析', '增长率'], answerTime: '1分30秒', correctRate: '60%', source: 'test', ...overrides })
test('粉笔预览只查询去重，不改写已有分类、解析和答案', async () => {
  const h = fenbiHarness({ title: '资料分析练习', materials: [], questions: [fenbiQuestion()], difficulty: .5 }, true)
  const result = await h.api.previewFenbiReport()
  assert.equal(result.duplicateIds.length, 1)
  assert.equal(result.questions[0].analysis, '')
  const regex = h.captured[0].match(/difficultyMatch[\s\S]*?\.match\((\/[^\n]+?\/)\)/)[1]
  const parsed = new Function('return ' + regex)()
  assert.equal(parsed.exec('难度 0.65')[1], '0.65')
  assert.ok(!h.captured[0].includes('|| correctAnswer'))
})
test('缺失个人答案不计入刷题完成情况', async () => {
  const h = fenbiHarness({})
  await assert.rejects(h.api.syncFenbiCurrentReport('2026-10-06', { questions: [fenbiQuestion({ isWrong: null, userAnswer: '' })] }), /尚未取得/)
})
test('新版保留题干段落时仍能识别旧版扁平题干的已导入记录', async () => {
  const legacy = crypto.createHash('sha256').update('fenbi|test|1|第一段第二段|B').digest('hex')
  const h = fenbiHarness({ title: '资料分析', materials: [], questions: [fenbiQuestion({ stem: '第一段\n第二段' })] }, fingerprint => fingerprint === legacy)
  const result = await h.api.previewFenbiReport()
  assert.equal(result.duplicateIds.length, 1)
})
test('资料组总时限内不惩罚单题慢，缺失用时不判整组超时', () => {
  const h = fenbiHarness({})
  let items = h.api.__efficiency({ title: '资料分析', questions: [fenbiQuestion({ answerTime: '2分' }), fenbiQuestion({ index: 2, answerTime: '10秒' })] })
  assert.ok(items.every(question => !question.isOvertime))
  items = h.api.__efficiency({ title: '资料分析', questions: [fenbiQuestion({ answerTime: '10分' }), fenbiQuestion({ index: 2, answerTime: '' })] })
  assert.ok(items.every(question => !question.isOvertime))
  assert.ok(items.every(question => question.groupActualSeconds === undefined))
})

test('PDF正文与解析及选项图片保持对应', () => {
  const pdf = compile('src/main/pdf-generator.ts', {
    './storage': { getLocalDataDir: () => '/tmp/unused' }, electron: {},
    './paper-order': order, './image-assets': assets, './db': {}, './logger': { logger }, './review-text': reviewText
  }, 'exports.__html = buildFullHtml;')
  const q = (id, group_id) => ({ ...record(id), group_id, ocr_text: id + '题干\nA. ' + id + '选项A\nB. ' + id + '选项B', original_analysis: id + '解析：根据题干可知，因此选择 A。' })
  const selection = order.orderPaperQuestions([q('a1', 'a'), q('b'), q('a2', 'a')])
  selection[2].option_images = '{"A":["option-a"]}'
  const html = pdf.__html(selection, [{ id: 'a', title: '题组', passage_text: '公共资料', material_images: [], questions: selection.slice(0, 2) }], new Map([['option-a', 'data:image/png;base64,AAA']]), { title: '练习', pageSize: 'A4', answerMode: 'analysis', includeAnswerSheet: true })
  assert.ok(html.indexOf('a1题干') < html.indexOf('a2题干'))
  assert.ok(html.indexOf('a2题干') < html.indexOf('b题干'))
  for (const id of ['a1', 'a2', 'b']) assert.ok(html.includes(id + '解析'))
  assert.ok(html.includes('data:image/png;base64,AAA'))
  const introStart = html.indexOf('<div class="group-intro">')
  assert.ok(introStart > 0)
  const intro = html.slice(introStart, html.indexOf('<div class="question"', introStart))
  assert.ok(intro.includes('公共资料'))
  assert.equal((intro.match(/<div\b/g)||[]).length,(intro.match(/<\/div>/g)||[]).length,'materials form a complete non-splitting unit before the first question')
})

function ipcHarness(db, extras = {}) {
  const handlers = new Map(), calls = []
  const deps = {
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, BrowserWindow: { fromWebContents: () => null } },
    './db': { getDb: () => db }, './logger': { logger },
    './config': { readConfig: () => undefined, writeConfig: () => {}, getAllConfig: () => ({}) },
    './safe-storage': {}, './ai': {}, './model-catalog': {}, './obsidian': {},
    './storage': { loadQuestionData: () => record('a'), syncQuestionNotes: id => { calls.push(id); throw new Error('模拟磁盘写入失败') } },
    './utils': {}, './knowledge-cards': {}, './pdf-generator': {},
    './retry-queue': { removeVaultRetry() {} }, './image-assets': assets,
    './queue-deletion': compile('src/main/queue-deletion.ts'),
    './question-filters': compile('src/main/question-filters.ts'),
    './review-center': {},
    './card-scheduler': compile('src/main/card-scheduler.ts', { 'ts-fsrs': require('ts-fsrs'), zod: require('zod'), './date-utils': dates }),
    './question-data': data, './path-safety': safety, './daily-plan': {},
    './date-utils': dates, './backup': {}, './ai-usage': {}, './billing': {},
    './fenbi-import': { repairStoredFenbiCategories() {}, ...extras.fenbi }
  }
  for (const [key, value] of Object.entries(extras.dependencies || {})) deps[key] = value
  const api = compile('src/main/ipc-handlers.ts', deps)
  api.registerIpcHandlers()
  return { handlers, calls }
}
test('处理队列查询不受已入库数量影响，同时保留分析中的记录', () => {
  const queries = []
  const h = ipcHarness({ prepare(sql) {
    queries.push(sql)
    return { get: () => ({ cnt: 0 }), all: () => [] }
  } })
  h.handlers.get('questions:list')(null, { page: 2, pageSize: 500, status: 'queue' })
  assert.equal(queries.length, 2)
  assert.ok(queries.every(sql => sql.includes("status != 'confirmed'")))
  assert.ok(!queries.some(sql => sql.includes('status = ?')))
})
test('批量删除 IPC 二次校验状态，保护已入库及分析中的记录', () => {
  const rows = new Map([['pending', { status: 'pending' }], ['classified', { status: 'classified' }], ['confirmed', { status: 'confirmed' }], ['processing', { status: 'processing' }]])
  const h = ipcHarness({ prepare(sql) { return {
    get: id => rows.get(id),
    run: id => { if (sql.startsWith('DELETE FROM questions')) rows.delete(id) }
  } } })
  const result = h.handlers.get('questions:deleteQueued')(null, [...rows.keys(), 'missing'])
  assert.deepEqual(result.deletedIds, ['pending', 'classified', 'missing'])
  assert.deepEqual(result.failed.map(item => item.id), ['confirmed', 'processing'])
  assert.deepEqual([...rows.keys()], ['confirmed', 'processing'])
})
test('编辑同步失败保留数据库修改，删除的题目不被编辑复活', async () => {
  const writes = []
  const db = { prepare: sql => ({ run: (...args) => { writes.push([sql, args]); return { changes: args.includes('deleted') ? 0 : 1 } } }) }
  const h = ipcHarness(db)
  assert.equal((await h.handlers.get('questions:update')({}, 'a', { reflection: '新复盘' })).syncPending, true)
  assert.equal(writes[0][1][0], '新复盘')
  assert.equal((await h.handlers.get('questions:update')({}, 'deleted', { reflection: '错误内容' })).success, false)
  assert.equal(h.calls.length, 1)
})
test('速度训练核对数据库答案，不信任答题卡传来的正确答案', () => {
  const inserted = []
  const db = { transaction: fn => fn, prepare: sql => ({
    get: () => ({ original_answer: '{"correct":"B"}' }),
    run: (...args) => { inserted.push([sql, args]); return { changes: 1 } },
    all: () => [{ is_correct: 1, is_on_time: 1 }, { is_correct: 1, is_on_time: 0 }]
  }) }
  const h = ipcHarness(db)
  const result = h.handlers.get('speedTraining:record')({}, { questionId: 'a', selectedAnswer: 'A', correctAnswer: 'A', elapsedSeconds: 30, targetSeconds: 90 })
  assert.equal(result.achieved, false)
  assert.equal(result.graduated, false)
  assert.equal(inserted[0][1][2], 'B')
  assert.throws(() => h.handlers.get('speedTraining:recordSession')({}, { answers: [{ questionId: 'a', selectedAnswer: 'A' }, { questionId: 'a', selectedAnswer: 'B' }], elapsedSeconds: 60, limitSeconds: 90 }), /重复/)
})
test('整套超时或正确率不达标均不能毕业，不写虚构单题用时', () => {
  const inserted = []
  const db = { transaction: fn => fn, prepare: sql => ({
    get: () => ({ original_answer: '{"correct":"B"}' }),
    run: (...args) => { inserted.push([sql, args]); return { changes: 1 } },
    all: () => [{ is_correct: 1, is_on_time: 0 }, { is_correct: 1, is_on_time: 1 }]
  }) }
  const h = ipcHarness(db)
  const result = h.handlers.get('speedTraining:recordSession')({}, { answers: [{ questionId: 'a', selectedAnswer: 'B' }], elapsedSeconds: 100, limitSeconds: 90, accuracyTarget: 80 })
  assert.equal(result.onTime, false)
  assert.equal(result.graduated, 0)
  const attempt = inserted.find(([sql]) => sql.includes('INSERT INTO speed_training_attempts'))
  assert.ok(attempt[0].includes('training_mode'))
  assert.equal(attempt[1][4], 0) // not the legacy fabricated one-second target
  assert.equal(attempt[1][6], 0)
})
test('共享粉笔窗口同一时间只允许一个导航读取任务', async () => {
  let finish
  const h = ipcHarness({}, { fenbi: { previewFenbiReport: () => new Promise(resolve => { finish = resolve }), syncFenbiToday: async () => ({ success: true }) } })
  const first = h.handlers.get('fenbi:preview')()
  await assert.rejects(h.handlers.get('fenbi:syncToday')(), /等待当前任务/)
  finish({ success: true }); await first
  assert.deepEqual(await h.handlers.get('fenbi:syncToday')(), { success: true })
})
test('统计查询与新迁移在临时SQLite中语法正确', t => {
  // Use Node 24's SQLite instead of a host CLI whose build may omit FTS5.
  // This keeps the same schema and query assertions mandatory on clean CI.
  const { DatabaseSync } = require('node:sqlite')
  const schema = []
  class FakeDatabase {
    pragma() {}
    exec(sql) {
      const alter = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/)
      if (alter && new RegExp('^\\s*' + alter[2] + '\\s+', 'm').test((schema.join('\n').match(new RegExp('CREATE TABLE IF NOT EXISTS ' + alter[1] + '\\s*\\(([\\s\\S]*?)\\);')) || [])[1] || '')) throw new Error('already exists')
      schema.push(sql)
    }
    prepare() { return { get: () => ({ cnt: 1 }), run() {} } }
  }
  const dbModule = compile('src/main/db.ts', { 'better-sqlite3': FakeDatabase, electron: { app: { getPath: () => temporary(t) } }, './date-utils': dates })
  dbModule.initDatabase()
  const queries = []
  const db = { prepare(sql) {
    queries.push(sql)
    return { get: () => ({ cnt: 0, c: 0, total: 0 }), all: () => [] }
  } }
  const h = ipcHarness(db)
  h.handlers.get('questions:stats')()
  const sql = schema.join(';\n') + ';\n' + queries.map(query => 'EXPLAIN ' + query + ';').join('\n')
  const checked = new DatabaseSync(':memory:')
  t.after(() => checked.close())
  assert.doesNotThrow(() => checked.exec(sql))
  const fixtures = `
    INSERT INTO questions (id, image_url, level1, level2, confidence, status, error_count, error_type, created_at, confirmed_at) VALUES
    ('wrong', '', '数量关系', '计算', 1, 'confirmed', 2, '计算错误', '2026-08-01T00:00:00Z', '2026-10-05T18:30:00Z'),
    ('slow', '', '数量关系', '计算', 1, 'confirmed', 5, '正确但超时', '2026-08-01T00:00:00Z', '2026-10-05T18:30:00Z'),
    ('pending', '', '数量关系', '计算', 1, 'classified', 9, '计算错误', '2026-08-01T00:00:00Z', NULL);
  `
  checked.exec(fixtures)
  const evaluate = query => checked.prepare(query).all().map(row => ({ ...row }))
  const topErrors = queries.find(query => query.includes('ORDER BY error_count DESC'))
  assert.deepEqual(evaluate(topErrors).map(row => row.id), ['wrong'])
  const errorDist = queries.find(query => query.includes('as err_level'))
  assert.deepEqual(evaluate(errorDist), [{ err_level: '2', cnt: 1 }])
  const daily = queries.find(query => query.includes('ORDER BY day DESC LIMIT 180'))
  assert.deepEqual(evaluate(daily), [{ day: '2026-10-06', cnt: 2 }])
  const monthly = queries.find(query => query.includes("strftime('%Y-%m'"))
  assert.deepEqual(evaluate(monthly), [{ month: '2026-10', cnt: 2 }])
})
