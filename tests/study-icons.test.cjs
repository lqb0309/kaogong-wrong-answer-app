const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/components/study-icons.tsx'), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
} }).outputText
const moduleForIcons = { exports: {} }
new Function('require', 'module', 'exports', output)(name => {
  assert.ok(['react', 'react/jsx-runtime'].includes(name), 'icons must not add dependencies')
  return require(name)
}, moduleForIcons, moduleForIcons.exports)
const icons = moduleForIcons.exports
const render = (Component, props = {}) => renderToStaticMarkup(React.createElement(Component, props))

test('所有新图标共用矢量网格、圆角线宽，不依赖外部图片或字体', () => {
  for (const [name, Component] of Object.entries(icons)) {
    if (name === 'StudyIcon') continue
    const html = render(Component)
    for (const marker of ['viewBox="0 0 24 24"', 'stroke-width="1.75"', 'stroke-linecap="round"', 'stroke-linejoin="round"', 'stroke="currentColor"']) assert.ok(html.includes(marker), name)
    assert.doesNotMatch(html, /<img|<image|https?:\/\//, name)
  }
})
test('装饰图标不重复朗读，有标签的独立图标可以识别', () => {
  assert.match(render(icons.TimerOutlined), /<span[^>]*aria-hidden="true"/)
  const html = render(icons.TimerOutlined, { 'aria-label': '速度训练' })
  assert.match(html, /<span[^>]*role="img"/)
  assert.match(html, /aria-label="速度训练"/)
  assert.doesNotMatch(html, /<span[^>]*aria-hidden="true"/)
})
test('学习入口与 AI、速度训练使用不同图形，兼容原页面样式', () => {
  const names = ['ScheduleOutlined', 'HomeOutlined', 'ReviewInboxOutlined', 'DatabaseOutlined', 'TimerOutlined', 'BarChartOutlined', 'BookOutlined', 'FilePdfOutlined', 'TagsOutlined', 'LogOutlined', 'SettingOutlined', 'AiSparkOutlined']
  const artworks = names.map(name => render(icons[name]).match(/<svg.*<\/svg>/)[0])
  assert.equal(new Set(artworks).size, names.length)
  const html = render(icons.TimerOutlined, { className: 'custom', style: { fontSize: 22, color: '#315cc6' }, rotate: 15 })
  assert.match(html, /study-icon custom/)
  assert.match(html, /font-size:22px/)
  assert.match(html, /rotate\(15deg\)/)
})
