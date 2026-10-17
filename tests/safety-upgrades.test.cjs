const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
function compile(file, imports = {}) {
  const mod = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('require','module','exports',code)(key => key in imports ? imports[key] : require(key),mod,mod.exports)
  return mod.exports
}
const validation = compile('src/main/ai-validation.ts')
const dates = compile('src/main/date-utils.ts')
const scheduler = compile('src/main/card-scheduler.ts', { './date-utils': dates })
const config = new Map()
const calendar = compile('src/main/study-calendar.ts', { './config': { readConfig:k=>config.get(k), writeConfig:(k,v)=>config.set(k,v) } })
const valid = { tasks: [{ title:'复盘', detail:'核对错因', minutes:30, module:'复盘', kind:'review' }] }
test('AI字段校验拒绝负时间、字符串分钟、英文模块、错误任务类型', () => {
  for(const patch of [{minutes:-1},{minutes:'30'},{module:'data'},{kind:'made-up'}]) assert.throws(()=>validation.parseValidatedAi(JSON.stringify({tasks:[{...valid.tasks[0],...patch}]}),validation.adjustmentSchema,'stop'))
})
test('即使JSON完整，截断标志和多余思考文本仍不保存', () => {
  assert.throws(()=>validation.parseValidatedAi(JSON.stringify(valid),validation.adjustmentSchema,'length'),/截断/)
  assert.throws(()=>validation.parseValidatedAi('先思考'+JSON.stringify(valid),validation.adjustmentSchema),/格式/)
  assert.deepEqual(validation.parseValidatedAi('```json\n'+JSON.stringify(valid)+'\n```',validation.adjustmentSchema),valid)
})
test('未来计划必须恰好七天并包含可执行的结构化任务',()=>{
  assert.throws(()=>validation.parseValidatedAi('{"overview":"","days":[]}',validation.forwardSchema))
})
test('FSRS四档真实回忆可序列化恢复，旧间隔不伪造成记忆参数',()=>{
  const now=new Date('2026-10-15T08:00:00Z')
  for(const rating of ['wrong','hard','done','easy']) {
    const next=scheduler.scheduleCardReview({ repetitions:9, lapses:2 },rating,now)
    assert.equal(next.repetitions,10); assert.equal(next.lapses,rating==='wrong'?3:2)
    assert.ok(next.intervalDays>=1); assert.ok(next.dueDate>'2026-10-15')
    const second=scheduler.scheduleCardReview({fsrs_json:next.fsrsJson,repetitions:10,lapses:next.lapses},'done',new Date('2026-10-20T08:00:00Z'))
    assert.equal(second.repetitions,11); assert.ok(JSON.parse(second.fsrsJson).reps===2)
  }
})
test('阅读不能当作FSRS回忆，损坏状态不能静默覆盖',()=>{
  assert.throws(()=>scheduler.scheduleCardReview(undefined,'read'),/阅读不等于/)
  assert.throws(()=>scheduler.scheduleCardReview({fsrs_json:'{}'},'done'))
})
test('离线日历识别补班；未公布年份不凭周末增加任务',()=>{
  assert.equal(calendar.studyCalendarDay('2026-10-10').maxMinutes,90)
  assert.equal(calendar.studyCalendarDay('2026-10-03').kind,'holiday')
  assert.equal(calendar.studyCalendarDay('2027-01-02').verified,false)
  assert.equal(calendar.studyCalendarDay('2027-01-02').maxMinutes,90)
})
test('日历缓存拒绝错误年份、重复日期、不存在的日期和非官方来源',()=>{
  const source={year:2027,papers:['https://www.gov.cn/notice'],days:[{date:'2027-01-02',name:'假期',isOffDay:true}]}
  assert.equal(calendar.validateHolidayData(source,2027).year,2027)
  for(const bad of [{...source,year:2028},{...source,days:[...source.days,...source.days]},{...source,days:[{...source.days[0],date:'2027-02-30'}]},{...source,papers:['https://example.com/notice']}]) assert.throws(()=>calendar.validateHolidayData(bad,2027))
})
test('结构化网络报告仅接受当前报告且校验完整性，不猜测未知格式',()=>{
  const page=compile('src/main/fenbi-page.ts')
  const network=compile('src/main/fenbi-network.ts',{'./fenbi-page':page})
  const report={url:'https://spa.fenbi.com/ti/exam/solution/a',materials:[],questions:[{stem:'测试',options:[{key:'A',text:'选项'}],correctAnswer:'A',userAnswer:'A',isWrong:false}]}
  assert.equal(network.verifiedResponseReport({data:report},report.url).questions.length,1)
  assert.equal(network.verifiedResponseReport(report,report.url+'b'),null)
  assert.equal(network.verifiedResponseReport({data:{questions:[{id:1}]}},report.url),null)
})
test('可选Promptfoo评估默认不允许模型调用，也不读取正式凭据',async()=>{
  const Provider=require('../evals/reflection-provider.cjs')
  const previous=process.env.STUDY_EVAL_ALLOW_PAID
  delete process.env.STUDY_EVAL_ALLOW_PAID
  try{assert.match((await new Provider().callApi('{}')).error,/付费评估未启用/)}finally{if(previous!==undefined)process.env.STUDY_EVAL_ALLOW_PAID=previous}
})
