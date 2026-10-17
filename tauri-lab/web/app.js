const invoke = window.__TAURI__.core.invoke
const status = document.getElementById('status')
const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text || ''; return node }
function image(src, parent) {
  if (src !== 'demo-chart.svg' && !/^https:\/\//.test(src)) return
  const img = document.createElement('img'); img.src = src; img.alt = '题目图表'; img.loading = 'lazy'
  img.addEventListener('error', () => {
    const warning=element('p', '图片未能取得：在线图片需要联网；验证版尚未实现离线图片缓存。')
    warning.dataset.failedImage='true';img.replaceWith(warning)
  })
  parent.append(img)
}
function analysisContent(text, parent) {
  // Render formula images in place, never use unsanitized source HTML.
  const pattern=/!\[([^\]]*)\]\(<([^>]+)>\)/g
  let offset=0,match
  while((match=pattern.exec(text))){
    parent.append(document.createTextNode(text.slice(offset,match.index)))
    let allowed=false
    try{const url=new URL(match[2]);allowed=url.protocol==='https:'&&['fbstatic.cn','fenbike.cn','fenbi.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))}catch{}
    if(allowed){
      const img=document.createElement('img');img.src=match[2];img.alt=match[1]||'解析公式';img.className='formula';img.title='点击放大公式';
      img.addEventListener('error',()=>{img.dataset.failed='true';img.alt='公式图片未加载，请联网后重新读取；未用猜测内容补齐'})
      img.addEventListener('click',()=>{
        const dialog=document.createElement('dialog'),large=document.createElement('img'),close=element('button','关闭')
        large.src=img.src;large.alt=img.alt;close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());dialog.append(close,large);document.body.append(dialog);dialog.showModal()
      })
      parent.append(img)
    }else parent.append(document.createTextNode('（未取得可信公式图片）'))
    offset=pattern.lastIndex
  }
  parent.append(document.createTextNode(text.slice(offset)))
}
function render(report) {
  if (!report) return
  for (const id of ['materials','questions','analysis']) document.getElementById(id).replaceChildren()
  const materials = document.getElementById('materials'), questions = document.getElementById('questions'), analysis = document.getElementById('analysis')
  for (const item of report.materials || []) { materials.append(element('h3', `资料 ${item.index}`), element('p',item.text)); for(const src of item.images || []) image(src,materials) }
  for (const item of report.questions || []) {
    const box = element('article'); box.append(element('h3',`第 ${item.index} 题${item.materialIndex ? ` · 资料 ${item.materialIndex}` : ''}`),element('p',item.stem))
    for(const src of item.questionImages || []) image(src,box)
    for(const option of item.options || []) { const row = element('div',`${option.key}. ${option.text}`); row.className='option'; for(const src of item.optionImages?.[option.key] || []) image(src,row); box.append(row) }
    box.append(element('p',`正确答案：${item.correctAnswer}　我的答案：${item.userAnswer}`)); questions.append(box)
    const explanation=element('div');explanation.className='analysis-body'
    analysisContent(item.analysis || '未取得可靠解析；不会使用其他区域的内容补齐。',explanation)
    analysis.append(element('h3',`第 ${item.index} 题`),explanation)
  }
  status.textContent=`${report.title} · ${report.questions.length} 题 · 已保存到验证版独立数据库。打印前请等待图片加载。`
}
for (const [id, command] of [['demo','load_demo'],['fenbi','open_fenbi'],['capture','capture_current'],['print','print_reader']]) document.getElementById(id).addEventListener('click', async event => {
  event.target.disabled=true
  try { if(id==='print')await waitForImages(); const result=await invoke(command); if(id==='demo') render(result); else if(id==='capture') status.textContent='已请求读取，完成后自动显示；加载不完整时粉笔窗口会提示。' }
  catch(error){status.textContent=String(error)} finally{event.target.disabled=false}
})
window.__TAURI__.event.listen('report-ready',event=>render(event.payload))
invoke('read_latest').then(render).catch(error=>status.textContent=String(error))
async function waitForImages() {
  let timeout
  try {
    await Promise.race([Promise.all([...document.images].map(img=>img.decode().catch(()=>null))),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('图片加载超时，请检查联网状态后重试；未导出不完整解析')),15000)})])
    if(document.querySelector('[data-failed-image]')||[...document.images].some(img=>!img.complete||img.naturalWidth===0))throw Error('有图表或公式未加载成功，未导出不完整解析')
  } finally { clearTimeout(timeout) }
}
async function exportPdf() {
  document.body.classList.add('pdf-mode')
  try {
    await waitForImages()
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    return await invoke('export_pdf',{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})
  } finally { document.body.classList.remove('pdf-mode') }
}
document.getElementById('pdf').addEventListener('click',async event=>{
  event.target.disabled=true
  try { status.textContent='已保存连续长页PDF：'+await exportPdf()+'。A4分页请使用打印存PDF。' }
  catch(error){status.textContent=String(error)}finally{event.target.disabled=false}
})
window.runSmoke=async()=>{
  await invoke('smoke_finish',{result:{stage:'javascript-ready'}})
  const latest=await invoke('read_latest')
  render(latest?.url&&latest.url!=='demo'?latest:await invoke('load_demo'))
  await invoke('smoke_finish',{result:{stage:'demo-loaded'}})
  const pdf=await exportPdf(), saved=await invoke('read_latest')
  const formulas=document.querySelectorAll('.formula').length,expected=saved.questions.reduce((sum,q)=>sum+((q.analysis||'').match(/!\[[^\]]*\]\(<[^>]+>\)/g)||[]).length,0)
  const passed=document.querySelectorAll('article').length===saved.questions.length && formulas===expected && [...document.images].every(img=>img.naturalWidth>0)
  await invoke('smoke_finish',{result:{passed,pdf,questions:saved.questions.length,formulas,images:document.images.length,isolatedDatabase:true}})
}
