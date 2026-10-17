const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
function load(relative) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const mod = { exports: {} }
  new Function('module', 'exports', output)(mod, mod.exports)
  return mod.exports
}
const { loadImportQueue, selectableQueueItems, queueItemTitle } = load('src/renderer/import-queue.ts')
const { deleteQueueItems } = load('src/main/queue-deletion.ts')

test('全选的数据加载不被已入库记录或 500 条限制截断', async () => {
  const rows = Array.from({ length: 1031 }, (_, i) => ({ id: String(i), status: 'pending' }))
  const calls = []
  const result = await loadImportQueue(async params => {
    calls.push(params)
    return { items: rows.slice((params.page - 1) * params.pageSize, params.page * params.pageSize), total: rows.length }
  })
  assert.equal(result.length, 1031)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(params => params.status === 'queue'))
})
test('加载去重、排除已入库项，选择排除进行中的分析', async () => {
  const rows = [{ id: 'a', status: 'pending' }, { id: 'a', status: 'pending' }, { id: 'b', status: 'confirmed' }, { id: 'c', status: 'processing' }, { id: 'd', status: 'classified' }]
  const items = await loadImportQueue(async () => ({ items: rows, total: rows.length }))
  assert.deepEqual(items.map(item => item.id), ['a', 'c', 'd'])
  assert.deepEqual(selectableQueueItems(items).map(item => item.id), ['a', 'd'])
})
test('题目标题有文字优先、文件路径解码，空图片不会显示空白或 data URL', () => {
  assert.equal(queueItemTitle({ id: 'a', ocr_text: '这是一道\n文字题' }), '这是一道 文字题')
  assert.equal(queueItemTitle({ id: 'b', image_url: 'file:///tmp/%E6%88%AA%E5%9B%BE.png' }), '截图.png')
  assert.equal(queueItemTitle({ id: 'c', image_url: 'data:image/png;base64,AAAA' }), '截图 c')
  assert.equal(queueItemTitle({ id: 'd', image_url: 'https://example.com/photo.png?token=secret' }), 'photo.png')
})
test('批量删除去重；已入库、分析中、单条失败不影响其他项；缺失项可以清理前端', () => {
  const statuses = { a: 'pending', b: 'confirmed', c: 'processing', d: 'classified', e: 'pending' }
  const removed = []
  const result = deleteQueueItems(['a', 'a', 'b', 'c', 'd', 'e', 'missing'], {
    getStatus: id => statuses[id],
    remove: id => { if (id === 'e') throw new Error('模拟写入失败'); removed.push(id) }
  })
  assert.deepEqual(removed, ['a', 'd'])
  assert.deepEqual(result.deletedIds, ['a', 'd', 'missing'])
  assert.deepEqual(result.failed.map(item => item.id), ['b', 'c', 'e'])
})
test('批量删除拒绝无效和过大的请求，不能部分执行恶意输入', () => {
  let calls = 0
  const operations = { getStatus: () => { calls++; return 'pending' }, remove() {} }
  for (const input of [null, 'a', ['a', 1], [''], Array(1001).fill('a')]) assert.throws(() => deleteQueueItems(input, operations))
  assert.equal(calls, 0)
})
