import '../src/preload/index'
const tauri = (window as any).__TAURI__
async function start() {
  const testMode = await tauri.core.invoke('service_ready')
  ;(window.api as any).uploadBrowserImages = async (files: File[]) => {
    if (files.length > 100) throw Error('单次最多导入 100 张图片')
    const items = []
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) throw Error('单张图片不能超过 20MB')
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      items.push({ name: file.name, data: btoa(binary) })
    }
    return await tauri.core.invoke('service_call', { channel: 'desktop:uploadBrowserImages', args: [items] })
  }
  await import('../src/renderer/main')
  if (testMode) {
    try {
      let list = await window.api.getQuestions({ status: 'confirmed', pageSize: 30 })
      if (!list.total) { await window.api.createManualQuestion({ ocrText: 'Tauri 测试题：2+2等于多少？\nA. 3\nB. 4', level1: '数量关系', level2: '基础计算', mode: 'direct' }); list = await window.api.getQuestions({status:'confirmed',pageSize:30}) }
      const backup = await window.api.createBackup()
      const batch = await window.api.createReviewBatch({ count: 20, answerResult: 'all' })
      const pdf = await window.api.generateTestPdf(batch.questionIds, { title: 'Tauri 分页验证', answerMode: 'full' })
      const reader = await window.api.exportReviewBatch({batchId:batch.id,format:'html',content:'full'})
      const split = await window.api.exportReviewBatch({batchId:batch.id,format:'pdf',content:'full'})
      const routes=[]
      for(const title of ['每日计划','待确认','错题库','速度训练','统计看板','知识归纳','复习与导出','标签管理','日志','设置']){
        for(let retry=0;retry<30;retry++){
          const item=[...document.querySelectorAll<HTMLElement>('.ant-menu-item')].find(el=>el.textContent?.includes(title))
          if(item){item.click();break}
          await new Promise(r=>setTimeout(r,100))
        }
        await new Promise(r=>setTimeout(r,250));routes.push({title,path:location.pathname,overflow:document.documentElement.scrollWidth>innerWidth+1})
      }
      const errors = await window.api.getLogs({level:'ERROR',pageSize:100})
      await tauri.core.invoke('smoke_finish', { result: { passed: list.total > 0 && backup.success && batch.questionIds.length === Math.min(20,list.total) && pdf.success && reader.success && split.success && routes.every(route=>!route.overflow) && errors.items.length===0, questions: list.total, backup: backup.success, batch: batch.questionIds.length, pdf, reader, split, routes,errors:errors.items.length } })
    } catch (error) { await tauri.core.invoke('smoke_finish', { result: { passed: false, error: String(error) } }) }
  }
}
start().catch(error => { document.getElementById('root')!.textContent = `本地服务未能启动：${String(error)}。正式题库未受影响。` })
