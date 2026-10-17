// Executes the real shared handlers in the isolated Node service. No model calls.
const { spawn } = require('node:child_process'), readline = require('node:readline'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const runtime = path.resolve(__dirname, '../tauri-app/runtime'), profile = fs.mkdtempSync('/private/tmp/wrong-answer-tauri-service-')
const child = spawn(path.join(runtime,'node'), [path.join(runtime,'service.cjs')], { cwd:runtime, env:{...process.env,STUDY_TAURI_DATA:profile,STUDY_TAURI_TEST:'1'}, stdio:['pipe','pipe','pipe'] })
const calls = new Map(); let next=0, stderr='', readyResolve, readyReject
child.stderr.on('data', chunk => stderr+=chunk)
const ready = new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject})
const lines = readline.createInterface({input:child.stdout})
const write = message => child.stdin.write(JSON.stringify(message)+'\n')
lines.on('line',line=>{
  const message=JSON.parse(line)
  if(message.kind==='ready')readyResolve(message.channels)
  if(message.kind==='fatal')readyReject(Error(message.error))
  if(message.kind==='result') { const call=calls.get(message.id);if(call){calls.delete(message.id);clearTimeout(call.timer);message.error?call.reject(Error(message.error)):call.resolve(message.result)} }
  if(message.kind==='native')write({kind:'native-result',id:message.id,result:message.action==='dialog-save'?{canceled:true}:message.action==='clipboard-image'?'':null})
})
child.on('exit',code=>{if(code)readyReject(Error(stderr||'service failed '+code))})
function invoke(channel,...args){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{calls.delete(id);reject(Error('timeout '+channel))},10000);calls.set(id,{resolve,reject,timer});write({kind:'call',id,channel,args})})}
write({kind:'init',secret:Buffer.alloc(32,29).toString('base64')})
;(async()=>{
  const channels=await ready
  const expected=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../tauri-app/src-tauri/channels.json'),'utf8'))
  assert.deepEqual(expected.filter(channel=>!channels.includes(channel)),[],'all frontend methods have real shared handlers')
  await invoke('config:set','vision_api_key','synthetic-test-key')
  assert.equal((await invoke('config:getAll')).vision_api_key,'synthetic-test-key')
  const Database=require(path.join(runtime,'node_modules/better-sqlite3')), db=new Database(path.join(profile,'data.db'),{readonly:true})
  assert.notEqual(db.prepare("SELECT value FROM config WHERE key='vision_api_key'").get().value,'synthetic-test-key');db.close()
  await invoke('config:set','vision_api_key','')
  const question=await invoke('questions:createManual',{level1:'数量关系',level2:'基础计算',ocrText:'2+2=?\nA. 3\nB. 4',mode:'direct'})
  assert.equal(question.success,true)
  const list=await invoke('questions:list',{status:'confirmed'});assert.equal(list.total,1)
  const id=list.items[0].id
  assert.equal((await invoke('questions:get',id)).ocr_text.includes('2+2'),true)
  const batch=await invoke('review:createBatch',{count:1});assert.deepEqual(batch.questionIds,[id])
  assert.equal((await invoke('backup:create')).success,true)
  assert.equal((await invoke('fenbi:analysisControl','pause')).paused,true)
  assert.ok(await invoke('questions:stats'))
  assert.ok(await invoke('plan:getToday'))
  assert.deepEqual((await invoke('knowledge:cards')).cards,[])
  const paste=await invoke('clipboard:pasteImage');assert.equal(paste.success,false)
  console.log(JSON.stringify({passed:true,channels:expected.length,profile,encrypted:true,manualQuestion:true,reviewBatch:true,backup:true,plan:true,stats:true,emptyClipboard:true}))
})().catch(error=>{console.error(error,stderr);process.exitCode=1}).finally(()=>{child.stdin.end();setTimeout(()=>child.kill(),1000).unref()})
