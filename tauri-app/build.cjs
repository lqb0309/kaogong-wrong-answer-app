const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), runtime = path.join(__dirname, 'runtime')
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, npm_config_cache: '/private/tmp/wrong-answer-npm-cache', npm_config_devdir: '/private/tmp/wrong-answer-node-gyp' } })
  if (result.status !== 0) throw Error(command + ' failed')
}
async function build() {
  fs.mkdirSync(runtime, { recursive: true })
  if (process.argv.includes('--runtime')) {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Build the service with Node.js 24 LTS')
    for (const file of ['package.json','package-lock.json']) fs.copyFileSync(path.join(__dirname,'service',file),path.join(runtime,file))
    // Separate Node ABI: never rebuild or mutate Electron's native modules.
    run('npm', ['ci', '--omit=dev'], runtime)
    fs.copyFileSync(process.execPath, path.join(runtime, 'node'))
    fs.chmodSync(path.join(runtime, 'node'), 0o755)
  }
  if (!fs.existsSync(path.join(runtime, 'node'))) throw Error('Run npm run prepare:runtime first')
  if (process.platform === 'darwin') {
    const binary=path.join(runtime,'node'),architecture=process.arch==='arm64'?'arm64':'x86_64'
    const info=spawnSync('/usr/bin/lipo',['-archs',binary],{encoding:'utf8'})
    if(info.status!==0)throw Error('Cannot verify bundled Node architecture')
    if(info.stdout.trim().split(/\s+/).length>1){const thin=path.join(runtime,'node-thin');run('/usr/bin/lipo',['-thin',architecture,binary,'-output',thin],runtime);fs.renameSync(thin,binary)}
  }
  const ts = require('typescript'), source = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  const ast = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, true), channels = new Set()
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcRenderer.invoke' && ts.isStringLiteral(node.arguments[0])) channels.add(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(ast); channels.add('desktop:uploadBrowserImages')
  fs.writeFileSync(path.join(__dirname, 'src-tauri/channels.json'), JSON.stringify([...channels].sort()))
  await require('esbuild').build({ entryPoints: [path.join(__dirname, 'service/main.ts')], outfile: path.join(runtime, 'service.cjs'), platform: 'node', target: 'node24', format: 'cjs', bundle: true, packages: 'external', alias: { electron: path.join(__dirname, 'service/desktop-adapter.ts') }, plugins: [{name:'tauri-credentials',setup(build){build.onResolve({filter:/^\.\/safe-storage$/},()=>({path:path.join(__dirname,'service/safe-storage.ts')}))}}] })
  run(path.join(root, 'node_modules/.bin/vite'), ['build', '--config', path.join(__dirname, 'vite.config.ts')], root)
  fs.writeFileSync(path.join(__dirname, 'dist/pdf-host.html'), '<!doctype html><html><body></body></html>')
  fs.copyFileSync(path.join(root, 'resources/icon.png'), path.join(__dirname, 'src-tauri/icon.png'))
  console.log('Full React UI and shared business service built; no Electron binary bundled.')
}
build().catch(error => { console.error(error); process.exitCode = 1 })
