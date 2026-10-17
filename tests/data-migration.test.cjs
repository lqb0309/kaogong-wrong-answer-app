const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto')
let Database
for(const module of ['../tauri-app/runtime/node_modules/better-sqlite3','better-sqlite3']){
  try{const candidate=require(module),probe=new candidate(':memory:');probe.close();Database=candidate;break}catch{/* CI may only have the Electron ABI until Tauri runtime is prepared. */}
}
const sqliteTest=Database?test:(name,fn)=>test(name,{skip:'需要为当前 Node 准备 Tauri SQLite 运行时'},fn)
const {rewriteLocations,copyVerifiedTree,migrate}=require('../scripts/migrate-electron-data.cjs')
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wrong-answer-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
function fixture(root,name){
  const profile=path.join(root,name),local=path.join(profile,'local'),vault=path.join(profile,'vault');fs.mkdirSync(local,{recursive:true});fs.mkdirSync(vault)
  const file=path.join(profile,'data.db'),db=new Database(file)
  db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE questions(id TEXT PRIMARY KEY,import_fingerprint TEXT UNIQUE,status TEXT,reflection TEXT,image_url TEXT,legacy_note TEXT);
    CREATE TABLE question_groups(id TEXT PRIMARY KEY,title TEXT);
    CREATE TABLE daily_plans(date TEXT PRIMARY KEY,tasks_json TEXT);
    CREATE TABLE review_batches(id TEXT PRIMARY KEY,files_json TEXT);
    CREATE TABLE ai_usage(id INTEGER PRIMARY KEY AUTOINCREMENT,model TEXT);
    CREATE TABLE review_state(card_path TEXT PRIMARY KEY,due_date TEXT);`)
  const config=db.prepare('INSERT INTO config VALUES(?,?)');config.run('local_data_dir',local);config.run('obsidian_vault',vault)
  config.run('ai_api_key',name+'-encrypted');config.run('ai_model',name+'-model');config.run('vision_api_key',name+'-vision-encrypted')
  db.prepare('INSERT INTO questions VALUES(?,?,?,?,?,?)').run(name,name+'-fingerprint',name==='old'?'confirmed':'classified',name+'-reflection',path.join(local,'图片.png'),name+'-user-note')
  db.prepare('INSERT INTO ai_usage(model) VALUES(?)').run(name)
  db.prepare('INSERT INTO daily_plans VALUES(?,?)').run('2026-10-17',name)
  fs.writeFileSync(path.join(local,'图片.png'),Buffer.from('synthetic-asset'))
  fs.writeFileSync(path.join(vault,'卡片.md'),'---\ntype: knowledge_card\n---\n![图片](<'+path.join(local,'图片.png')+'>)')
  return {profile,local,vault,file,db,config}
}
test('路径改写覆盖 file URL、中文空格与 JSON；不误改前缀相近的其他目录',()=>{
  const mappings=[['/old 目录','/new 目录']]
  assert.equal(rewriteLocations('/old 目录/图.png',mappings),'/new 目录/图.png')
  assert.equal(rewriteLocations('file:///old%20%E7%9B%AE%E5%BD%95/a.png',mappings),'file:///new%20%E7%9B%AE%E5%BD%95/a.png')
  assert.equal(rewriteLocations('/old 目录-backup/a.png',mappings),'/old 目录-backup/a.png')
  assert.equal(rewriteLocations(JSON.stringify({image:'/old 目录/a.png'}),mappings),JSON.stringify({image:'/new 目录/a.png'}))
})
test('文件副本逐个校验，链接和已有目的目录不静默覆盖',t=>{
  const root=temp(t),src=path.join(root,'source');fs.mkdirSync(src);fs.writeFileSync(path.join(src,'a'),'kept')
  const dst=path.join(root,'dest');assert.equal(copyVerifiedTree(src,dst).files,1);assert.equal(hash(path.join(src,'a')),hash(path.join(dst,'a')))
  assert.throws(()=>copyVerifiedTree(src,path.join(src,'nested')),/源目录内部/)
  assert.throws(()=>copyVerifiedTree(src,dst),/已存在/)
  fs.symlinkSync(path.join(src,'a'),path.join(src,'link'));assert.throws(()=>copyVerifiedTree(src,path.join(root,'blocked')),/符号链接/)
})
sqliteTest('完整迁移保留原记录和新版待确认，保留新版密钥，复制笔记、图片及导出文件',async t=>{
  const root=temp(t),old=fixture(root,'old'),next=fixture(root,'next')
  old.config.run('easyimage_token','old-incompatible-encrypted')
  const exportFile=path.join(root,'复习 20题.pdf');fs.writeFileSync(exportFile,'synthetic-pdf')
  old.db.prepare('INSERT INTO review_batches VALUES(?,?)').run('batch',JSON.stringify([exportFile]))
  old.db.prepare('INSERT INTO review_state VALUES(?,?)').run(path.join(old.vault,'卡片.md'),'2026-10-18')
  next.db.exec('ALTER TABLE questions ADD COLUMN source_snapshot TEXT')
  old.db.close();next.db.close();const before=hash(old.file)
  const report=await migrate({sourceFile:old.file,targetFile:next.file})
  assert.equal(hash(old.file),before);assert.equal(fs.readFileSync(path.join(old.vault,'卡片.md'),'utf8').includes(old.local),true)
  assert.equal(report.counts.questions,2);assert.equal(report.counts.ai_usage,2)
  assert.equal(report.assetCounts[1].knowledgeCards,1);assert.equal(report.exportFilesCopied,1)
  const db=new Database(next.file,{readonly:true}),get=k=>db.prepare('SELECT value FROM config WHERE key=?').get(k)?.value
  assert.equal(get('ai_api_key'),'next-encrypted');assert.equal(get('ai_model'),'next-model');assert.equal(get('easyimage_token'),undefined)
  assert.equal(db.prepare("SELECT legacy_note FROM questions WHERE id='old'").get().legacy_note,'old-user-note')
  assert.equal(db.prepare("SELECT status FROM questions WHERE id='next'").get().status,'classified')
  assert.equal(db.prepare('SELECT tasks_json FROM daily_plans').get().tasks_json,'old')
  const local=get('local_data_dir'),vault=get('obsidian_vault');assert.notEqual(local,old.local);assert.notEqual(vault,old.vault)
  assert.equal(fs.existsSync(path.join(local,'图片.png')),true)
  assert.equal(fs.readFileSync(path.join(vault,'卡片.md'),'utf8').includes(local),true)
  assert.equal(db.prepare('SELECT card_path FROM review_state').get().card_path,path.join(vault,'卡片.md'))
  const exported=JSON.parse(db.prepare('SELECT files_json FROM review_batches').get().files_json)[0];assert.equal(hash(exported),hash(exportFile))
  assert.equal(fs.existsSync(path.join(report.backup,'tauri-before.db')),true)
  db.close()
  await assert.rejects(migrate({sourceFile:old.file,targetFile:next.file}),/已经迁移过/)
})
sqliteTest('异号同题不能直接丢弃关联；失败时新版数据库保持原样',async t=>{
  const root=temp(t),old=fixture(root,'old'),next=fixture(root,'next')
  next.db.prepare('UPDATE questions SET import_fingerprint=?').run('old-fingerprint')
  old.db.close();next.db.close();const before=hash(next.file)
  await assert.rejects(migrate({sourceFile:old.file,targetFile:next.file}),/不同编号的重复题/)
  assert.equal(hash(next.file),before)
})
