const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
const root=path.resolve(__dirname,'..')
test('正式安装包名称与版本一致，沿用迁移后的数据及钥匙串标识',()=>{
  const config=JSON.parse(fs.readFileSync(path.join(root,'tauri-app/src-tauri/tauri.conf.json'),'utf8'))
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'tauri-app/package.json'),'utf8'))
  const lock=JSON.parse(fs.readFileSync(path.join(root,'tauri-app/package-lock.json'),'utf8'))
  assert.equal(config.identifier,'com.deca.wrong-answer.tauri')
  assert.equal(config.productName,'小乖的考公错题屋')
  assert.equal(config.app.windows[0].title,config.productName)
  assert.equal(config.version,pkg.version);assert.equal(config.version,lock.packages[''].version)
  assert.match(fs.readFileSync(path.join(root,'tauri-app/src-tauri/Cargo.toml'),'utf8'),new RegExp('version = "'+pkg.version.replaceAll('.','\\.')+'"'))
  assert.ok(fs.readFileSync(path.join(root,'tauri-app/service/desktop-adapter.ts'),'utf8').includes("return '"+pkg.version+"'"))
})
function compile(file,deps={},globals={}){
  const module={exports:{}},source=fs.readFileSync(path.join(root,file),'utf8')
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('require','module','exports',...Object.keys(globals),code)(key=>key in deps?deps[key]:require(key),module,module.exports,...Object.values(globals))
  return module.exports
}
test('Tauri 复用完整版前端全部接口，调用只通过受限服务桥',async()=>{
  const calls=[],listeners=[],window={__TAURI__:{core:{invoke:async(...args)=>{calls.push(args);return 1}},event:{listen:async(_name,fn)=>{listeners.push(fn);return()=>{}}}}}
  const adapter=compile('tauri-app/frontend-electron.ts',{}, {window})
  compile('src/preload/index.ts',{electron:adapter})
  assert.ok(Object.keys(window.api).length>=100)
  await window.api.getQuestionGroupMembers('group-1')
  assert.deepEqual(calls.pop(),['service_call',{channel:'questions:groupMembers',args:['group-1']}])
  let a=0,b=0
  const off=window.api.onAiProgress(()=>a++)
  window.api.onAiProgress(()=>b++)
  await window.api.getAppVersion()
  for(const listener of listeners)listener({payload:{channel:'ai:progress',data:{stage:'done'}}})
  assert.equal(a,1);assert.equal(b,1);off()
})
test('公共图表、选项和缩略图的本地地址经过桌面桥，不依赖 file 协议权限',async()=>{
  const {resolveDisplayImage}=compile('src/renderer/image-source.ts'),calls=[]
  const read=async source=>{calls.push(source);return 'data:image/png;base64,c3ludGhldGlj'}
  for(const source of ['file:///Users/test/Application%20Support/chart.png','/Users/test/截图.png'])
    assert.match(await resolveDisplayImage(source,read),/^data:image/)
  for(const source of ['https://example.invalid/chart.png','data:image/png;base64,eA=='])
    assert.equal(await resolveDisplayImage(source,read),source)
  assert.equal(calls.length,2)
  await assert.rejects(resolveDisplayImage('javascript:alert(1)',read))
})
test('Tauri 密钥使用带认证加密，篡改和 Electron 格式不能被当作明文',()=>{
  const adapter=compile('tauri-app/service/desktop-adapter.ts')
  adapter.setSecret(Buffer.alloc(32,7).toString('base64'))
  const data=adapter.safeStorage.encryptString('synthetic-key')
  assert.equal(adapter.safeStorage.decryptString(data),'synthetic-key')
  assert.notEqual(data.toString('base64'),Buffer.from('synthetic-key').toString('base64'))
  const corrupt=Buffer.from(data);corrupt[20]^=1
  assert.throws(()=>adapter.safeStorage.decryptString(corrupt))
  assert.throws(()=>adapter.safeStorage.decryptString(Buffer.from('legacy-electron-data')))
})
test('Tauri 业务权限仅属于本地主窗口，不向粉笔或排版窗口开放文件/题库命令',()=>{
  const capability=JSON.parse(fs.readFileSync(path.join(root,'tauri-app/src-tauri/capabilities/main.json'),'utf8'))
  assert.deepEqual(capability.windows,['main']);assert.equal(capability.remote,undefined)
  assert.ok(capability.permissions.includes('allow-service-call'))
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'tauri-app/src-tauri/tauri.conf.json'),'utf8'))
  assert.notEqual(manifest.identifier,'com.deca.wrong-answer-app')
  assert.ok(!manifest.app.security.csp.includes("script-src 'self' 'unsafe-inline'"))
  assert.equal(manifest.bundle.macOS.signingIdentity,'-')
})
test('Tauri 网页超时会清理加载监听，不因原生导航尚未返回产生悬空拒绝',async()=>{
  const messages=[],timers=new Set()
  const adapter=compile('tauri-app/service/desktop-adapter.ts',{}, {
    process:{stdout:{write:line=>messages.push(JSON.parse(line))}},
    setTimeout:(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer},
    clearTimeout:timer=>timers.delete(timer)
  })
  const win=new adapter.BrowserWindow()
  adapter.nativeResult({id:messages.at(-1).id,result:null})
  const loading=win.loadURL('https://www.fenbi.com/')
  const rejected=assert.rejects(loading,/网页加载超时/)
  await Promise.resolve();await Promise.resolve()
  const navigate=messages.find(message=>message.action==='window-navigate')
  assert.ok(navigate)
  const timer=[...timers].find(timer=>timer.ms===35000)
  assert.ok(timer);timer.fn();await rejected
  assert.equal(win.listenerCount('did-finish-load'),0)
  adapter.nativeResult({id:navigate.id,result:null})
  assert.equal(timers.size,0)
})
