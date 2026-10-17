// Generated build asset only; the maintained parser stays shared with Electron.
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const mod = { exports: {} }
const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/fenbi-page.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
new Function('exports', code)(mod.exports)
const target = path.join(root, 'tauri-lab/src-tauri/generated-parser.js')
fs.writeFileSync(target, `window.__studyCapture = () => { const report = (${mod.exports.readFenbiReportPage.toString()})(); const problem = (${mod.exports.validateFenbiReport.toString()})(report); if(problem) throw new Error(problem); return report; };`)
console.log('Shared Fenbi parser generated for Tauri (no account or learning data).')
