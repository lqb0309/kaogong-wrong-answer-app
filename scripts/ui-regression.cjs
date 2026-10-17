// Real app, renderer, preload and SQLite; synthetic data only, no credentials.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict'), ts = require('typescript')
const root = path.resolve(__dirname,'..'), profile = fs.mkdtempSync('/private/tmp/wrong-answer-ui-')
const output = path.join(profile,'screenshots'); fs.mkdirSync(output)
process.env.WRONG_ANSWER_TEST_PROFILE = profile
app.setPath('userData',profile)
app.on('window-all-closed',()=>{})
app.on('browser-window-created',(_event,win)=>{ win.show=()=>{}; win.webContents.setBackgroundThrottling(false) })
function compile(file,deps={}) {
  const mod={exports:{}}
  const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('require','module','exports',code)(key=>key in deps?deps[key]:require(key),mod,mod.exports)
  return mod.exports
}
const dates=compile('src/main/date-utils.ts'), database=compile('src/main/db.ts',{'./date-utils':dates})
database.initDatabase()
const db=database.getDb(), vault=path.join(profile,'vault'); fs.mkdirSync(vault)
db.prepare('INSERT OR REPLACE INTO config(key,value) VALUES (?,?)').run('obsidian_vault',vault)
db.prepare('INSERT OR REPLACE INTO config(key,value) VALUES (?,?)').run('local_data_dir',path.join(profile,'local'))
const image='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="180"><rect width="500" height="180" fill="#f8fafc"/><rect x="100" y="60" width="80" height="100" fill="#315cc6"/><rect x="300" y="20" width="80" height="140" fill="#16a085"/></svg>').toString('base64')
db.prepare('INSERT INTO question_groups(id,title,passage_text,material_images,created_at) VALUES (?,?,?,?,?)').run('group','测试公共资料','公共资料：2024年数量120，2023年数量100。\n'.repeat(8),JSON.stringify([image]),new Date().toISOString())
const reflection='## 考点与识别信号\n核心考点：增长率，先核对年份。\n\n## 标准解题路径\n1. 找现期与基期。\n2. 计算：(120−100)÷100=20%。\n\n## 易错复盘\n不要将增长量当作增长率。\n\n## 下次行动规则\n先找分母。\n'
const insert=db.prepare('INSERT INTO questions(id,image_url,level1,level2,confidence,ocr_text,status,error_count,group_id,question_number,original_answer,original_analysis,reflection,created_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
for(let i=0;i<12;i++) insert.run('q'+i,image,'资料分析','增长率',1,'2024年同比增长多少？\nA. 10%\nB. 20%\nC. 30%\nD. 40%',i===0?'classified':'confirmed',i%4+1,i<3?'group':null,String(i+1),JSON.stringify({correct:'B',user:'A',targetSeconds:90,timingBasis:'group',groupTargetSeconds:300,groupActualSeconds:290}), '根据增长率计算，(120−100)÷100=20%，因此选择B。',reflection.repeat(4),'2026-10-01T02:00:00Z','2026-10-01T02:00:00Z')
db.close()
require('../out/main/index.js')
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(win,expression) {
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(expression))return;await wait(100)}
  throw new Error('UI not ready: '+expression)
}
const results=[]
app.whenReady().then(async()=>{
  const win=BrowserWindow.getAllWindows()[0]
  await until(win,'!!document.querySelector(".app-shell")')
  await win.webContents.insertCSS('* { animation-duration: 0s !important; transition-duration: 0s !important; }')
  for(const [width,height] of [[1024,768],[1440,900],[1920,1080]]) {
    win.setSize(width,height)
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.ant-menu-item')].find(el=>el.textContent.includes('待确认')).click()")
    await until(win,'!!document.querySelector(".reading-split")')
    await wait(250)
    const state=await win.webContents.executeJavaScript(`(()=>{const panel=document.querySelector('.pending-reflection-reader'),bar=document.querySelector('.pending-confirm-bar')||document.querySelector('.pending-form-actions'),split=document.querySelector('.reading-split');return {outerOverflow:document.documentElement.scrollHeight>innerHeight+1,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,panelHeight:panel?.clientHeight||0,splitHeight:split.clientHeight,images:[...document.images].filter(i=>i.src&&!i.complete).length}})()`)
    assert.equal(state.outerOverflow,false);assert.equal(state.horizontalOverflow,false);assert.ok(state.panelHeight>250,JSON.stringify(state));assert.ok(state.splitHeight>400)
    await win.webContents.executeJavaScript("document.querySelector('[role=separator]').focus()")
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(150)
    assert.ok(await win.webContents.executeJavaScript("!!localStorage.getItem('pending-reading-layout-horizontal')"),'keyboard splitter persists layout')
    fs.writeFileSync(path.join(output,`pending-${width}.png`),(await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.ant-menu-item')].find(el=>el.textContent.includes('错题库')).click()")
    await until(win,'document.querySelectorAll(".ant-table-row").length>0')
    await win.webContents.executeJavaScript("document.querySelector('.ant-table-row').click()")
    await until(win,'!!document.querySelector(".question-detail-modal .reading-split")')
    await wait(450)
    const detail=await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.question-detail-scroll');return {height:p?.clientHeight||0,overflow:document.documentElement.scrollHeight>innerHeight+1,text:document.querySelector('.question-detail-modal').innerText}})()`)
    assert.ok(detail.height>250);assert.ok(detail.height<height,JSON.stringify(detail));assert.equal(detail.overflow,false);assert.ok(detail.text.includes('正确答案'))
    assert.ok(await win.webContents.executeJavaScript("(()=>{const p=document.querySelector('.question-detail-scroll');p.scrollTop=100000;return p.scrollTop>0})()"),'long reflection can scroll to the end')
    fs.writeFileSync(path.join(output,`detail-${width}.png`),(await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript("document.querySelector('.question-detail-modal .ant-modal-close').click()")
    results.push({width,height,...state,detailHeight:detail.height})
  }
  const status=await win.webContents.executeJavaScript("window.api.controlFenbiAnalysis('pause')")
  assert.equal(status.paused,true)
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.ant-menu-item')].find(el=>el.textContent.includes('复习与导出')).click()")
  await until(win,'!!document.querySelector(".review-setup-card")')
  const batch=await win.webContents.executeJavaScript("window.api.createReviewBatch({minutes:15})")
  assert.ok(batch.questionIds.length>0);assert.ok(batch.estimatedMinutes<=15)
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.ant-menu-item')].find(el=>el.textContent.includes('设置')).click()")
  await until(win,'!!document.querySelector(".settings-page")')
  assert.ok(await win.webContents.executeJavaScript("document.querySelector('.settings-main').clientHeight>200"))
  const errors=new (require('better-sqlite3'))(path.join(profile,'data.db'),{readonly:true})
  const logs=errors.prepare("SELECT message FROM error_logs WHERE level='error'").all();errors.close()
  assert.deepEqual(logs,[])
  console.log(JSON.stringify({passed:true,profile,output,viewports:results,minutesBatch:batch.questionIds.length,noRendererErrors:true}))
}).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{for(const win of BrowserWindow.getAllWindows())win.destroy();app.exit(process.exitCode||0)})
