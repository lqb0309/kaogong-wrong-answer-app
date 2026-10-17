const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
function catalog(responses = []) {
  const calls = [], module = { exports: {} }
  class OpenAI {
    constructor(options) {
      calls.push(options)
      this.models = { list: async () => {
        const next = responses.shift()
        if (next instanceof Error) throw next
        return next
      } }
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/main/model-catalog.ts'), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(() => OpenAI, module, module.exports)
  return { ...module.exports, calls }
}
function failure(status, extra = {}) { return Object.assign(new Error('secret-key / private-provider-body'), { status, ...extra }) }
test('模型接口地址去空白、尾斜杠与误填的完成路径，不泄露 URL 中的凭据', () => {
  const c = catalog()
  assert.deepEqual(c.modelBaseUrls(' https://api.deepseek.com/ '), ['https://api.deepseek.com', 'https://api.deepseek.com/v1'])
  assert.deepEqual(c.modelBaseUrls('https://example.invalid/v1/chat/completions'), ['https://example.invalid/v1'])
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.invalid', 'https://example.invalid?api_key=secret']) assert.throws(() => c.modelBaseUrls(url))
})
test('DeepSeek 标准 data 清单去重，保留代码对话模型，不带入空 ID 与非对话模型', async () => {
  const c = catalog([{ data: [{ id: 'deepseek-v4-pro' }, { id: ' deepseek-flash ' }, { id: 'deepseek-v4-pro' }, { id: 'code-chat' }, { id: 'embedding-3' }, {}, { id: 123 }] }])
  assert.deepEqual(await c.fetchModelCatalog('https://api.deepseek.com', ' key '), { success: true, models: ['code-chat', 'deepseek-flash', 'deepseek-v4-pro'] })
  assert.equal(c.calls[0].apiKey, 'key')
  assert.equal(c.calls[0].timeout, 15000)
})
test('仅 404/405 回退 /v1', async () => {
  for (const status of [404, 405]) {
    const c = catalog([failure(status), { data: [{ id: 'working-model' }] }])
    assert.equal((await c.fetchModelCatalog('https://example.invalid', '')).success, true)
    assert.equal(c.calls[1].baseURL, 'https://example.invalid/v1')
  }
})
test('认证、限流和服务故障不盲目重试路径，不泄露原始错误', async () => {
  for (const [status, text] of [[401, '认证失败'], [403, '认证失败'], [429, '请求过于频繁'], [503, '服务商暂时不可用']]) {
    const c = catalog([failure(status)])
    const result = await c.fetchModelCatalog('https://api.deepseek.com', 'secret-key')
    assert.match(result.error, new RegExp(text)); assert.equal(c.calls.length, 1)
    assert.doesNotMatch(JSON.stringify(result), /secret-key|private-provider-body|不支持/)
  }
})
test('网络和超时有独立可操作提示', async () => {
  for (const [name, text] of [['APIConnectionTimeoutError', '请求超时'], ['APIConnectionError', '无法连接']]) {
    const c = catalog([failure(undefined, { name })])
    assert.match((await c.fetchModelCatalog('https://api.deepseek.com', '')).error, new RegExp(text))
    assert.equal(c.calls.length, 1)
  }
})
test('损坏、空清单和所有路径不存在时均允许手动配置', async () => {
  for (const response of [{}, { data: {} }, { data: [] }, new SyntaxError('secret')]) {
    const result = await catalog([response]).fetchModelCatalog('https://example.invalid', '')
    assert.equal(result.success, false); assert.doesNotMatch(result.error, /secret|不支持/)
  }
  assert.match((await catalog([failure(404), failure(404)]).fetchModelCatalog('https://example.invalid', '')).error, /直接填写/)
})
test('无效地址不发请求', async () => {
  const c = catalog()
  assert.equal((await c.fetchModelCatalog('', 'secret')).success, false)
  assert.equal(c.calls.length, 0)
})
test('模型输入支持手动名称及加载反馈，不强制切换当前模型', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/settings.tsx'), 'utf8')
  assert.match(source, /<AutoComplete options=/)
  assert.match(source, /loading=\{modelLoading\[kind\]\}/)
  const fetch = source.slice(source.indexOf('const fetchModels ='), source.indexOf('const testModel ='))
  assert.doesNotMatch(fetch, /setFieldValue/)
  assert.match(fetch, /finally/)
})
