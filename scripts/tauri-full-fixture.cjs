const fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
const root=path.resolve(__dirname,'..'),profile=process.argv[2]
if(!profile?.startsWith('/private/tmp/')||fs.existsSync(path.join(profile,'data.db')))throw Error('Use a new /private/tmp profile')
fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(path.join(profile,'vault'))
function compile(file,deps={}){const module={exports:{}},text=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','module','exports',text)(key=>key in deps?deps[key]:require(key),module,module.exports);return module.exports}
const dates=compile('src/main/date-utils.ts'),database=compile('src/main/db.ts',{'./date-utils':dates,electron:{app:{getPath:()=>profile}},'better-sqlite3':require('../tauri-app/runtime/node_modules/better-sqlite3')})
database.initDatabase();const db=database.getDb()
for(const [key,value] of [['obsidian_vault',path.join(profile,'vault')],['local_data_dir',path.join(profile,'local')]])db.prepare('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)').run(key,value)
const chart='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="280"><rect width="720" height="280" fill="white"/><path d="M40 20V240H680" fill="none" stroke="#333"/><g fill="#315cc6"><rect x="100" y="100" width="100" height="140"/><rect x="300" y="70" width="100" height="170"/><rect x="500" y="30" width="100" height="210"/></g><g font-size="25"><text x="100" y="270">2022</text><text x="300" y="270">2023</text><text x="500" y="270">2024</text></g></svg>').toString('base64')
for(let group=1;group<=2;group++)db.prepare('INSERT INTO question_groups(id,title,passage_text,material_images,created_at) VALUES(?,?,?,?,?)').run('group-'+group,'唯一资料组'+group,'唯一公共材料'+group+'：2023年总量为200万，同比增长25%。请结合图表回答以下问题。',JSON.stringify([chart,chart]),new Date().toISOString())
const insert=db.prepare('INSERT INTO questions(id,image_url,level1,level2,confidence,ocr_text,status,error_count,error_type,group_id,question_number,material_image_ids,original_answer,original_analysis,reflection,created_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
for(let i=0;i<20;i++){
 const group=i<5?'group-1':i<10?'group-2':null,number=String(i).padStart(2,'0')
 insert.run('fixture-'+number,'',group?'资料分析':'数量关系','基期计算',1,`唯一题干${number}：2023年数量为200，同比增长25%，2022年约为多少？\nA. 120\nB. 150\nC. 160\nD. 200`,'confirmed',2,'结果错误',group,String(i+1),JSON.stringify(group?[chart]:[]),JSON.stringify({correct:'C',user:'B',targetSeconds:90,answerTime:'95秒',correctRate:'65%'}),`唯一解析${number}：200÷(1+25%)=160，所以选择C。`,'## 考点与识别信号\n基期计算，先核对年份。\n## 标准解题路径\n先将增长率化为小数，再做除法。\n## 易错复盘\n不要用现期量直接减25%。\n## 下次行动规则\n圈出时间范围再计算。','2026-09-01T02:00:00Z','2026-09-01T02:00:00Z')
}
insert.run('pending-fixture','', '数量关系','基础计算',1,'待确认测试：2+2=?\nA.3\nB.4','classified',1,'结果错误',null,'21','[]',JSON.stringify({correct:'B',user:'A'}),'2+2=4。','## 标准解题路径\n2加2等于4。','2026-09-01T02:00:00Z',null)
db.close();console.log(JSON.stringify({profile,questions:20,groups:2,pending:1,synthetic:true}))
