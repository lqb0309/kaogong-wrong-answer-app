const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function reader() {
  const all = [], calls = []
  function node(tag, text = '') {
    const value = { tag, textContent: text, children: [], dataset: {}, events: {}, classList: { add() {}, remove() {} },
      append(...children) { this.children.push(...children) },
      replaceChildren(...children) { this.children = children },
      replaceWith(replacement) { this.replacement = replacement },
      addEventListener(event, handler) { this.events[event] = handler },
      decode() { return Promise.resolve() }, complete: true, naturalWidth: 40 }
    all.push(value); return value
  }
  const ids = new Map()
  const document = { createElement: node, createTextNode: text => node('#text', text),
    getElementById(id) { if (!ids.has(id)) ids.set(id, node('div')); return ids.get(id) },
    querySelector() { return all.find(n => n.dataset.failedImage) || null },
    get images() { return all.filter(n => n.tag === 'img' && !n.replacement) },
    body: node('body'), documentElement: { scrollWidth: 1200, scrollHeight: 2000 } }
  const context = vm.createContext({ document, URL, setTimeout, clearTimeout, requestAnimationFrame: callback => callback(),
    window: { __TAURI__: { core: { invoke: async command => { calls.push(command); return null } }, event: { listen() {} } } } })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../tauri-lab/web/app.js'), 'utf8'), context)
  return { context, all, calls, node }
}

test('Tauri 原始解析在原位置渲染公式图片，保留前后文本而不执行原始HTML', () => {
  const env = reader(), target = env.node('div')
  env.context.target = target
  vm.runInContext("analysisContent('前文![公式](<https://fb.fbstatic.cn/formula.png>)后文<script>危险</script>', target)", env.context)
  assert.deepEqual(target.children.map(n => n.tag), ['#text', 'img', '#text'])
  assert.equal(target.children[1].className, 'formula')
  assert.equal(target.children[2].textContent, '后文<script>危险</script>')
  assert.equal(target.children[1].src, 'https://fb.fbstatic.cn/formula.png')
})

test('Tauri 拒绝非可信图片域名和可执行协议，不静默猜测公式', () => {
  const env = reader(), target = env.node('div')
  env.context.target = target
  vm.runInContext("analysisContent('![公式](<javascript:alert(1)>)![公式](<https://fbstatic.cn.evil.test/x>)', target)", env.context)
  assert.equal(env.all.filter(n => n.tag === 'img').length, 0)
  assert.match(target.children.map(n => n.textContent).join(''), /未取得可信公式图片/)
})

test('Tauri 图表或公式加载失败时不生成缺图PDF，也不打开不完整的打印', async () => {
  const env = reader(), target = env.node('div')
  env.context.target = target
  vm.runInContext("image('https://fb.fbstatic.cn/chart.png', target)", env.context)
  env.all.find(n => n.tag === 'img').events.error()
  await assert.rejects(vm.runInContext('exportPdf()', env.context), /未加载成功/)
  assert.equal(env.calls.includes('export_pdf'), false)
  await vm.runInContext("document.getElementById('print').events.click({target:{disabled:false}})", env.context)
  assert.equal(env.calls.includes('print_reader'), false)
})
