const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), ts=require('typescript')
function harness(worker, rows) {
  const config=new Map(), events=[]
  const db={prepare(sql){return {
    get(){if(sql.includes('SUM(CASE'))return {queued:rows.filter(r=>r.status==='processing').length,failed:rows.filter(r=>r.status==='classified'&&r.analysis_status==='failed').length,ready:rows.filter(r=>r.status==='classified'&&r.analysis_status==='complete').length};if(sql.includes('COUNT(*)'))return{count:rows.filter(r=>r.status==='processing').length};return rows.find(r=>r.status==='processing')},
    run(...args){if(sql.includes("status = 'processing', analysis_status = 'queued'")){for(const row of rows)if(row.status==='classified'&&row.analysis_status==='failed'){row.status='processing';row.analysis_status='queued'};return}const id=args.at(-1),row=rows.find(r=>r.id===id);if(row?.status!=='processing')return;row.status='classified';row.analysis_status=sql.includes("analysis_status = 'complete'")?'complete':'failed';row.reflection=args[0]}
  }}}
  const deps={electron:{BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:(_c,e)=>events.push(e)}}]},Notification:{isSupported:()=>false}},'./db':{getDb:()=>db},'./logger':{logger:{info(){},warn(){},error(){}}},'./ai':{generateReflection:worker},'./storage':{},'./utils':{},'./question-data':{parseJson:(_v,f)=>f},'./date-utils':{},'./daily-plan':{},'./fenbi-page':{},'./fenbi-network':{},'./config':{readConfig:k=>config.get(k),writeConfig:(k,v)=>config.set(k,v)}}
  const mod={exports:{}}
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/main/fenbi-import.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('require','module','exports',code)(name=>name in deps?deps[name]:require(name),mod,mod.exports)
  return {api:mod.exports,events,rows}
}
const row=id=>({id,import_source:'fenbi',status:'processing',original_answer:'{}'})
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('后台队列只启动一个消费者；失败不阻塞后续题，仅失败项重试',async()=>{
  let calls=0
  const h=harness(async()=>{calls++;if(calls===1)throw Error('模拟超时');return '正式复盘'},[row('a'),row('b')])
  h.api.startFenbiAnalysisQueue();h.api.startFenbiAnalysisQueue();await tick()
  assert.equal(calls,2);assert.equal(h.api.fenbiAnalysisStatus().failed,1);assert.equal(h.api.fenbiAnalysisStatus().ready,1)
  h.api.controlFenbiAnalysis('retry-failed');await tick()
  assert.equal(calls,3);assert.equal(h.api.fenbiAnalysisStatus().failed,0);assert.equal(h.api.fenbiAnalysisStatus().ready,2)
})
test('暂停等待当前题完成，持久保留下一题；恢复不重复已经完成的题',async()=>{
  let finish, calls=0
  const h=harness(async()=>{calls++;if(calls===1)await new Promise(resolve=>finish=resolve);return '复盘'},[row('a'),row('b')])
  h.api.startFenbiAnalysisQueue();h.api.controlFenbiAnalysis('pause');finish();await tick()
  assert.equal(calls,1);assert.equal(h.api.fenbiAnalysisStatus().queued,1);assert.equal(h.api.fenbiAnalysisStatus().paused,true)
  assert.ok(h.events.some(e=>e.stage==='paused'))
  h.api.startFenbiAnalysisQueue();await tick();assert.equal(calls,1)
  h.api.controlFenbiAnalysis('resume');await tick();assert.equal(calls,2);assert.equal(h.api.fenbiAnalysisStatus().queued,0)
})
