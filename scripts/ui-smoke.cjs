// Run with the bundled Electron executable after `npm run build`.
// This isolated renderer uses fixtures only: no production preload, IPC, DB, Vault or AI.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = process.argv[2] || path.join(os.tmpdir(), 'wrong-answer-ui-results')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wrong-answer-ui-profile-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('disable-gpu')

const reflection = ['## 考点与识别信号', '本题考查基期比重。先确认年份，再分别还原分子、分母，最后求比重。', '## 标准解题路径', '1. 找到现期量及增长率，不混用增长量。', '2. 基期量 = 现期量 ÷（1 + 增长率）。', '3. 分别还原两个数量，再相除。', '4. 与选项比较，保留足够精度。', '## 考场最短路径', '先判断分子与分母增长率的大小关系，再排除明显不合适的选项。', '## 易错复盘', '你的答案 B 使用了现期分母，导致基期比重偏小。正确答案为 D。', '## 下次行动规则', '**下次看到基期比重，先标年份，再同时还原分子和分母。**'].join('\n\n')
const chart = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="280"><rect width="700" height="280" fill="white"/><text x="30" y="30" font-size="20">2021—2024 年登记数量（万件）</text><path d="M60 65V225H650" fill="none" stroke="#60718b"/><g fill="#92acd8"><rect x="105" y="155" width="60" height="70"/><rect x="245" y="120" width="60" height="105"/><rect x="385" y="95" width="60" height="130"/><rect x="525" y="70" width="60" height="155"/></g><g font-size="16" fill="#25334a"><text x="110" y="250">2021</text><text x="250" y="250">2022</text><text x="390" y="250">2023</text><text x="530" y="250">2024</text></g></svg>').toString('base64')
const questions = Array.from({ length: 35 }, (_, i) => ({
  id: `fixture-${i}`, image_url: i % 3 === 0 ? chart : '', level1: i % 2 ? '数量关系' : '资料分析', level2: i % 2 ? '排列组合' : '基期比重', level3: null, confidence: .96,
  ocr_text: '根据上述资料，2022 年甲地区登记量占全国登记总量的比重约为多少？\nA. 10%\nB. 13%\nC. 18%\nD. 23%',
  reflection, original_analysis: '先还原 2022 年的地区与全国登记量，再计算比重。基期量 = 现期量 /（1 + 增长率）。因此本题选择 D。',
  original_answer: JSON.stringify({ correct: 'D', user: [0, 5].includes(i % 6) ? 'D' : i % 6 === 4 ? '' : 'B', answerTime: '1分35秒', correctRate: '47%', errorProne: 'B' }),
  error_count: [0, 4, 5].includes(i % 6) ? 0 : 1, error_type: ['正确但超时', '结果错误', '错误且超时', '计算错误', '', ''][i % 6],
  answer_result: [0, 5].includes(i % 6) ? 'correct' : i % 6 === 4 ? 'unknown' : 'wrong',
  time_status: [0, 2].includes(i % 6) ? 'overtime' : [1, 5].includes(i % 6) ? 'within' : 'unknown',
  created_at: '2026-10-06T01:00:00Z', confirmed_at: '2026-10-06T01:00:00Z', source: '示例练习（隔离验收数据）',
  status: 'confirmed', obsidian_path: null, group_id: i < 3 ? 'fixture-group' : null, group_title: '登记数据资料组', question_number: String(i + 1),
  group_passage_text: '2023 年，全国登记量为 642.8 万件，同比增长 42.3%。其中甲地区登记量 110.1 万件，比上年增加 5.38 万件。请结合图表回答下列问题。', group_material_images: JSON.stringify([chart]), material_image_ids: JSON.stringify([chart]), question_images: '[]', option_images: '{}', trace_id: `fixture-${i}`
}))
const tree = { tree: ['资料分析', '数量关系', '政治理论'].map((name, i) => ({ id: `root-${i}`, name, level: 1, children: [{ id: `child-${i}`, name: i === 0 ? '基期比重' : '排列组合', level: 2, children: [] }] })) }
const importQueue = Array.from({ length: 16 }, (_, i) => ({
  ...questions[i], id: `queue-${i}`, trace_id: `queue-${i}`,
  status: i < 12 ? 'pending' : i < 15 ? 'classified' : 'processing',
  image_url: i % 4 === 0 ? chart : i % 4 === 1 ? 'file:///fixture/%E6%88%AA%E5%9B%BE.png' : '',
  local_image_path: i % 4 === 1 ? '/fixture/截图.png' : i % 4 === 3 ? '/fixture/missing.png' : '',
  ocr_text: i % 4 === 3 ? '' : questions[i].ocr_text,
  level2: i === 12 ? '很长的分类名称，用来验证不会挤出卡片边界或盖住其他操作' : questions[i].level2
}))
const stats = { total: 35, dailyAvg: 3, todayCount: 5, recent7: 15, prev7: 10, recent30: 35, prev30: 20, byLevel1: [{ level1: '资料分析', cnt: 18, pct: 51 }, { level1: '数量关系', cnt: 17, pct: 49 }], byLevel2: [], byLevel3: [], dailyStats: [{ day: '2026-10-05', cnt: 3 }, { day: '2026-10-06', cnt: 5 }], weeklyStats: [], monthlyStats: [], topErrors: questions.slice(0, 3), errorDist: [{ err_level: '1', cnt: 35 }], errorTypeDist: [], confidenceDist: { low: 0, mid: 1, high: 34 }, reviewedThisWeek: 8, dueReviewCount: 5, reviewWrongRate: 20, latestAttempt: null, reviewDaily: [], weaknessPoints: [], speedTraining: { attempts: 5, achievement_rate: 60, avg_saved_seconds: 8, pending: 8, daily: [] } }
const api = {
  getStreak: { streak: 3 }, getPendingCount: 3, getAppVersion: '0.2.2', getErrorTypes: ['结果错误', '正确但超时', '错误且超时'], getTagTree: tree, getCustomTags: [],
  getAllConfig: { ai_model: 'DeepSeek', vision_model: '通义千问', vision_api_key: 'fixture-only', ai_api_key: 'fixture-only', obsidian_vault: '/fixture/never-opened' }, getConfig: '',
  listBackups: [], getBillingOverview: { usage: { today: { cost: .05, calls: 3 }, month: { cost: 1.2, calls: 40 } }, balance: { available: false, balances: [] }, ccSwitch: { detected: false } },
  getTodayPlan: { success: true, plan: { date: '2026-10-06', status: 'partial', tasks: [
    { id: 'task1', title: '资料分析专项训练', detail: '选两组资料分析，先控制整组时间。训练结束后记录计算错误和年份判断错误，不追加更多新题。', module: '资料分析', minutes: 30, done: 1 },
    { id: 'task2', title: '复盘今天的资料分析', detail: '核对粉笔解析与个人作答，整理基期比重及计算误差。复盘时间至少与做题相同，不要求抄写全部解析。', module: '复盘', minutes: 45, done: 0 },
    { id: 'task3', title: '政治理论易错点复习', detail: '只看昨天标记的两个知识点。今天时间不足时，这项可顺延，不挤占复盘。', module: '政治理论', minutes: 15, done: 0 }
  ] }, exam: { exam_date: '2026-11-25', days_until: 50 }, phase: { name: '强化阶段', days_left: 50, phase_days_left: 20, phase_start: '2026-10-01', phase_end: '2026-10-26', focus: '稳定正确率，优先复盘', milestones: [] } },
  getPlanHistory: [{ date: '2026-10-05', status: 'completed', tasks_done: 3, tasks_total: 3 }], getFenbiTodaySummary: { sessions: 2, questions: 10, accuracy: 80, wrong: 2, overtime: 1, totalSeconds: 1500, summary: '今天完成两组资料分析，复盘重点是基期比重。', modules: [{ name: '资料分析', count: 10, correct: 8 }] },
  getAppOverview: { pendingCount: 3, classifiedCount: 3, confirmedCount: 35, todayCount: 5, streak: 3, retryQueueSize: 0 }, getDailyNotes: { notes: [] }, getReviewQueue: { cards: [], reviewedToday: [] }, getKnowledgeCards: { cards: [] }, getKnowledgeOverview: { today: { questionCount: 5, knowledgePointCount: 3, newPointsCount: 2, highFreqCount: 1, existingCardCount: 0 }, todayQuestions: [], priorityList: [] }, getStats: stats, getLogs: { items: [], total: 0 }, getSpeedTrainingQuestions: { items: questions.slice(0, 3), available: 3 }, getQuestionGroupMembers: questions.slice(0, 3)
}
const fixtureScript = `window.__uiErrors=[];window.__deleteCalls=[];window.__questionCalls=[];window.__reviewExports=[];window.__reviewCompletions=[];window.addEventListener('error',e=>window.__uiErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__uiErrors.push(String(e.reason?.message||e.reason)));const fixtures=${JSON.stringify(api)};const questions=${JSON.stringify(questions)};let batches=new Map(),queue=${JSON.stringify(importQueue)};window.api=new Proxy({}, {get(_,key){if(String(key).startsWith('on'))return()=>()=>{};
if(key==='getQuestions')return async params=>{window.__questionCalls.push(params);let rows=params?.status==='queue'?queue:params?.status==='classified'?queue.filter(q=>q.status==='classified'):questions;if(params?.answerResult&&params.answerResult!=='all')rows=rows.filter(q=>q.answer_result===params.answerResult);if(params?.timeStatus)rows=rows.filter(q=>q.time_status===params.timeStatus);const page=params?.page||1,size=params?.pageSize||20;return {items:rows.slice((page-1)*size,page*size),total:rows.length}};
if(key==='listReviewBatches')return async()=>[...batches.values()];
if(key==='getReviewBatch')return async id=>batches.get(id);
if(key==='createReviewBatch')return async params=>{let rows=params?.ids?questions.filter(q=>params.ids.includes(q.id)):questions.filter(q=>q.answer_result===(params?.answerResult||'wrong')&&!(params?.excludeIds||[]).includes(q.id));rows=rows.slice(0,params?.ids?100:params?.count||20);if(!rows.length)throw Error('没有可选题目');const batch={id:'batch-'+batches.size,title:'2026-10-13 复习清单 · '+rows.length+' 题',questionIds:rows.map(q=>q.id),questions:rows,files:[],completedAt:null,groupCount:1,available:rows.length,requestedCount:params?.ids?rows.length:params?.count||20,reasons:{}};batches.set(batch.id,batch);return batch};
if(key==='exportReviewBatch')return async params=>{window.__reviewExports.push(params);if(window.__cancelNextExport){window.__cancelNextExport=false;return {success:true,canceled:true,files:[]}}return {success:true,files:params.format==='html'?['/fixture/reader.html']:params.splitAnswers?['/fixture/questions.pdf','/fixture/answers.pdf']:['/fixture/questions.pdf'],imageErrors:[]}};
if(key==='completeReviewBatch')return async id=>{window.__reviewCompletions.push(id);batches.get(id).completedAt='2026-10-13T12:00:00Z';return {success:true,completedAt:'2026-10-13T12:00:00Z'}};
if(key==='deleteQueuedQuestions')return async ids=>{window.__deleteCalls.push(ids);const deletedIds=ids.filter(id=>id!=='queue-1');queue=queue.filter(item=>!deletedIds.includes(item.id));return {deletedIds,failed:ids.includes('queue-1')?[{id:'queue-1',error:'模拟单条失败'}]:[]}};
if(key==='readImageDataUrl')return async source=>{if(source.includes('missing'))throw Error('模拟文件缺失');return ${JSON.stringify(chart)}};
if(key==='reportRendererError')return async message=>window.__uiErrors.push(message);if(key in fixtures)return async()=>fixtures[key];return async()=>({success:true});}});`
const html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8').replace('<head>', '<head><script>' + fixtureScript + '</script>')
let server, win
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function capture(route, width, height, action, suffix = '') {
  win.setContentSize(width, height)
  await win.loadURL(`http://127.0.0.1:${server.address().port}${route}`)
  await win.webContents.executeJavaScript('document.fonts.ready')
  await wait(600)
  if (action) { try { await win.webContents.executeJavaScript(action); await wait(400) } catch (error) { throw new Error(route + ' ' + width + 'x' + height + suffix + ': ' + error.message) } }
  const report = await win.webContents.executeJavaScript(`(() => {
    const bounds = selector => {const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight};};
    const iconList = selector => [...document.querySelectorAll(selector)].map(el => {const r=el.querySelector('svg').getBoundingClientRect();return {name:el.dataset.studyIcon,width:r.width,height:r.height};});
    if ([...document.querySelectorAll('.settings-navigation .ant-menu-title-content')].some(el=>el.scrollWidth>el.clientWidth+1)) throw new Error('设置图标旁的名称被截断');
    return {errors:window.__uiErrors, bodyOverflow:document.body.scrollHeight>innerHeight, rootOverflow:document.documentElement.scrollWidth>innerWidth, sidebar:bounds('.app-sidebar'), content:bounds('.app-content'), confirm:bounds('.pending-action-bar'), reader:bounds('.pending-reflection-reader'), save:bounds('.settings-save-bar'), modal:bounds('.question-detail-layout'), pagination:bounds('.ant-pagination'), navigationIcons:iconList('.app-navigation .study-icon'), settingsIcons:iconList('.settings-navigation .study-icon')};
  })()`)
  assert.deepEqual(report.errors, [], `${route}: renderer errors`)
  assert.equal(report.bodyOverflow, false, `${route}: outer vertical overflow`)
  assert.equal(report.rootOverflow, false, `${route}: outer horizontal overflow`)
  assert.equal(report.navigationIcons.length, 11, `${route}: all navigation icons present`)
  assert.equal(new Set(report.navigationIcons.map(icon => icon.name)).size, 11, `${route}: navigation artwork is distinct`)
  for (const icon of [...report.navigationIcons, ...report.settingsIcons]) assert.ok(icon.width >= 16 && icon.height >= 16, `${route}: ${icon.name} not clipped`)
  if (route === '/settings') assert.equal(new Set(report.settingsIcons.map(icon => icon.name)).size, 7, 'settings sections have distinct artwork')
  for (const key of ['confirm', 'save', 'pagination']) if (report[key]) assert.ok(report[key].bottom <= height + 1, `${route}: ${key} below window`)
  if (route === '/pending' && width >= 1024) assert.ok(report.reader?.height >= height * .45, 'review has enough reading space')
  const name = `${route.slice(1).replaceAll('/', '-') || 'import'}-${width}x${height}${action ? '-detail' : ''}${suffix}`
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
  return { name, ...report }
}
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true })
  server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname
    if (name.startsWith('/assets/')) {
      const file = path.join(root, 'out/renderer', name)
      if (!fs.existsSync(file)) { response.writeHead(404).end(); return }
      const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'
      response.setHeader('Content-Type', type); response.end(fs.readFileSync(file)); return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const reports = []
  for (const [width, height] of [[1024, 768], [1440, 900], [1920, 1080]]) {
    for (const route of ['/plan', '/pending', '/questions', '/settings']) reports.push(await capture(route, width, height, route === '/settings' ? "[...document.querySelectorAll('.settings-navigation .ant-menu-item')].find(el=>el.textContent.includes('AI 模型')).click()" : undefined))
    reports.push(await capture('/questions', width, height, "document.querySelector('.ant-table-tbody tr[data-row-key]').click()"))
  }
  for (const route of ['/stats', '/test-builder', '/tags', '/logs', '/speed-training', '/knowledge']) reports.push(await capture(route, 1440, 900))
  for (const [width, height] of [[1024, 768], [1440, 900], [1920, 1080]]) {
    reports.push(await capture('/plan', width, height, `(async()=>{
      [...document.querySelectorAll('.app-navigation .ant-menu-item')].find(el=>el.textContent.includes('错题处理')).click();
      await new Promise(resolve=>setTimeout(resolve,300));document.querySelector('input[aria-label="全选当前结果"]').click();
      document.querySelector('.import-toolbar').scrollIntoView({block:'start'});
    })()`, '-queue'))
    reports.push(await capture('/plan', width, height, `(async()=>{
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const check=(value,label)=>{if(!value)throw Error(label)};
      [...document.querySelectorAll('.app-navigation .ant-menu-item')].find(el=>el.textContent.includes('错题处理')).click();await wait(300);
      const all=()=>document.querySelector('input[aria-label="全选当前结果"]');
      const button=text=>[...document.querySelectorAll('.import-batch-actions button')].find(el=>el.textContent.includes(text));
      const tab=text=>[...document.querySelectorAll('.import-toolbar .ant-tabs-tab')].find(el=>el.textContent.includes(text));
      check(document.querySelectorAll('.import-queue-card').length===16,'应加载完整待处理队列');
      check(button('批量删除').disabled&&button('AI 分类').disabled,'未选择时批量操作应禁用');
      all().click();await wait(60);check(document.querySelector('.import-selected-count').textContent.includes('15'),'全选应跳过分析中的题目');
      check(!button('批量删除').disabled&&button('AI 分类').textContent.includes('12'),'所选分类数量应匹配可分类项');
      document.querySelector('.import-card-checkbox input:not(:disabled)').click();await wait(60);check(all().indeterminate,'部分选择应显示半选');
      tab('已分类').click();await wait(60);check(document.querySelector('.import-selected-count').textContent.includes('0'),'切换筛选清空勾选');
      all().click();await wait(60);check(document.querySelector('.import-selected-count').textContent.includes('3')&&button('AI 分类').disabled,'全选仅包含当前筛选');
      tab('待分类').click();await wait(60);all().click();await wait(60);
      button('批量删除').click();await wait(150);check(window.__deleteCalls.length===0,'确认前不允许删除');
      document.querySelector('.ant-popconfirm-buttons button').click();await wait(200);check(window.__deleteCalls.length===0,'取消删除不得发送请求');
      button('批量删除').click();await wait(150);document.querySelector('.ant-popconfirm-buttons .ant-btn-primary').click();await wait(250);
      check(window.__deleteCalls.length===1&&window.__deleteCalls[0].length===12,'批量删除必须只处理所选项');
      check(document.querySelectorAll('.import-queue-card').length===1&&document.querySelector('.import-selected-count').textContent.includes('1'),'失败项应保留且保持选中');
      tab('全部').click();await wait(100);
      const toolbar=document.querySelector('.import-toolbar');toolbar.scrollIntoView({block:'start'});await wait(100);
      for(const selector of ['.import-toolbar','.import-queue-grid','.import-queue-card']) for(const el of document.querySelectorAll(selector)){check(el.scrollWidth<=el.clientWidth+2,selector+'内容不应横向溢出')}
      const thumbs=[...document.querySelectorAll('.import-thumbnail img')];check(thumbs.some(img=>img.complete&&img.naturalWidth>0),'本地图片应可读取');
    })()`, '-bulk'))
  }
  reports.push(await capture('/pending', 1440, 900, "(async()=>{document.querySelector('.pending-preview-resizer').focus();document.querySelector('.pending-preview-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,100));if(document.querySelector('.pending-preview-resizer').getAttribute('aria-valuenow')!=='80')throw new Error('图片高度键盘调整失败')})()"))
  reports.push(await capture('/settings', 768, 900))
  for (const [width, height] of [[1024, 768], [1440, 900], [1920, 1080]]) {
    reports.push(await capture('/questions', width, height, `(async()=>{
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const check=(value,label)=>{if(!value)throw Error(label)};
      const select=async(label,option)=>{
        const input=document.querySelector('input[aria-label="'+label+'"]');check(input,'筛选必须有可访问名称：'+label);
        input.closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await wait(120);
        const item=[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(el=>el.getAttribute('title')===option);
        check(item,'缺少筛选选项：'+option);item.click();await wait(180);
      };
      const count=()=>document.querySelectorAll('.ant-table-tbody tr[data-row-key]').length;
      await select('答题结果','答错（含超时）');check(count()===18,'答错必须同时包含超时和未超时题');
      check(document.querySelector('[data-row-key="fixture-2"]')&&document.querySelector('[data-row-key="fixture-1"]'),'普通错题与错误且超时都应出现');
      await select('用时情况','仅超时');check(count()===6,'答错再筛超时');
      await select('答题结果','答对（含超时）');check(count()===11,'切换主筛选要清除旧的用时限制');
      check(!window.__questionCalls.at(-1).timeStatus,'换答题结果时旧用时筛选不能残留');
      await select('用时情况','仅未超时');check(count()===5,'答对未超时组合应正确');
      await select('答题结果','答错（含超时）');await select('用时情况','用时未评估');check(count()===6,'无评估记录应单独保留');
      await select('用时情况','仅超时');check(document.querySelector('.filter-toolbar').scrollWidth<=document.querySelector('.filter-toolbar').clientWidth+1,'筛选工具栏不得溢出');
    })()`, '-result-timing'))
  }
  for (const [width, height] of [[1024, 768], [1440, 900], [1920, 1080]]) {
    reports.push(await capture('/test-builder', width, height, `(async()=>{
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const check=(value,label)=>{if(!value)throw Error(label)};
      const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.includes(text));
      const select=async(label,option)=>{const input=document.querySelector('input[aria-label="'+label+'"]');check(input,'缺少控件 '+label);input.closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await wait(100);[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(el=>el.getAttribute('title')===option).click();await wait(100)};
      await select('输出方式','PDF · 打印／手机／平板');await select('快捷题量','20 题');button('生成 20 题清单').click();await wait(180);
      check(document.querySelectorAll('.review-batch-card tr[data-row-key]').length===18,'不足20题应显示真实18题');check(window.__reviewCompletions.length===0,'生成题单不能标记完成');
      await select('快捷题量','5 题');check(button('保存 PDF').disabled,'改题量后不能导出旧题单');button('生成 5 题清单').click();await wait(160);check(document.querySelectorAll('.review-batch-card tr[data-row-key]').length===5,'应生成5题');
      window.__cancelNextExport=true;button('保存 PDF').click();await wait(160);check(window.__reviewCompletions.length===0,'取消保存不能标记复习');
      button('保存 PDF').click();await wait(180);check(window.__reviewExports.at(-1).splitAnswers===true,'默认PDF应分开题目和解析');check(window.__reviewCompletions.length===0,'导出也不能标记复习');
      await select('输出方式','连续阅读页 · 离线 HTML');button('保存并打开连续阅读页').click();await wait(180);check(window.__reviewExports.at(-1).format==='html','应支持连续阅读页');
      button('本批已复习').click();await wait(120);document.querySelector('.ant-popconfirm-buttons .ant-btn-primary').click();await wait(180);check(window.__reviewCompletions.length===1,'明确确认后才记录复习');
      check(button('本批已复习').disabled,'已完成不可重复提交');
      check(document.querySelector('.review-setup-card').scrollWidth<=document.querySelector('.review-setup-card').clientWidth+1,'主设置不应溢出');
    })()`, '-review-center'))
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2))
  process.stdout.write(JSON.stringify({ passed: reports.length, output }) + '\n')
}).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 }).finally(() => {
  if (win && !win.isDestroyed()) win.destroy()
  if (server) server.close()
  app.exit(process.exitCode || 0)
})
