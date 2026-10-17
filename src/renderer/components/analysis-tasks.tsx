import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Drawer, Space, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'

export function AnalysisTasks() {
  const { message } = App.useApp(), navigate = useNavigate()
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.api.getFenbiAnalysisStatus>> | null>(null)
  const refresh = useCallback(async () => {
    if (typeof window.api.getFenbiAnalysisStatus !== 'function') return
    try { setStatus(await window.api.getFenbiAnalysisStatus()) } catch { /* background status never blocks reading */ }
  }, [])
  useEffect(() => { void refresh(); const off = window.api.onFenbiAnalysisProgress?.(() => void refresh()); return () => off?.() }, [refresh])
  useEffect(() => { if (!open) return; void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer) }, [open, refresh])
  const control = async (action: 'pause' | 'resume' | 'retry-failed') => {
    setBusy(true)
    try { setStatus(await window.api.controlFenbiAnalysis(action)); message.info(action === 'pause' ? '当前题结束后暂停；已抓取题目保留' : action === 'retry-failed' ? '仅失败题重新排队，不重复抓取' : '已继续后台分析') }
    catch (error: any) { message.error(error.message || '操作失败') } finally { setBusy(false) }
  }
  return <><Button size="small" onClick={() => setOpen(true)}>后台任务{status?.queued ? ` ${status.queued}` : status?.failed ? ` · ${status.failed} 失败` : ''}</Button>
    <Drawer title="粉笔后台分析" open={open} onClose={() => setOpen(false)} width={430}>
      <Typography.Paragraph>先保存题目与图表，再逐题生成复盘。关闭应用后，未完成题目会保留；重新启动后继续。</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}><Tag color="processing">待处理 {status?.queued || 0}</Tag><Tag color="success">可确认 {status?.ready || 0}</Tag><Tag color="error">失败 {status?.failed || 0}</Tag></Space>
      {status?.paused && <Alert type="info" showIcon message={status.running ? '暂停中：当前题结束后停止' : '已暂停，重启后也不会自动继续'} style={{ marginBottom: 16 }} />}
      {!!status?.failed && <Alert type="warning" showIcon message="失败题保留原题，可以重试或手动查看；不会用其他题的解析补齐。" style={{ marginBottom: 16 }} />}
      <Space wrap><Button disabled={busy || !status || (!status.queued && !status.running)} onClick={() => control(status?.paused ? 'resume' : 'pause')}>{status?.paused ? '继续分析' : '暂停分析'}</Button><Button disabled={busy || !status?.failed} onClick={() => control('retry-failed')}>只重试失败题</Button><Button type="primary" onClick={() => { setOpen(false); navigate('/pending') }}>查看待确认</Button></Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 20 }}>重试会调用你配置的模型，可能产生 API 费用。暂停不打断当前正在进行的调用。</Typography.Paragraph>
    </Drawer></>
}
