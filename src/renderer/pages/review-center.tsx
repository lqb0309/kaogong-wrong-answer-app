import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Alert, App, Button, Card, Collapse, DatePicker, Drawer, Empty, Input, InputNumber, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { PageHeader } from '@/components/page-header'
import { ExportOutlined, ReloadOutlined, CheckOutlined, ReadOutlined } from '@/components/study-icons'
import { useTagTreeStore } from '@/stores/tag-tree'

type Filters = { level1?: string; level2?: string; level3?: string; answerResult?: string; timeStatus?: string; since?: string; until?: string; search?: string }
type Settings = { count: number; mode: 'count' | 'time'; minutes: number; content: 'none' | 'analysis' | 'full'; format: 'pdf' | 'html'; splitAnswers: boolean }
const defaults: Settings = { count: 20, mode: 'count', minutes: 40, content: 'full', format: 'pdf', splitAnswers: true }
function savedSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem('review-center-settings') || '{}')
    return { count: Math.max(1, Math.min(100, Number(saved.count) || 20)), mode: saved.mode === 'time' ? 'time' : 'count', minutes: Math.max(5, Math.min(180, Math.round(Number(saved.minutes) || 40))), content: ['none', 'analysis', 'full'].includes(saved.content) ? saved.content : defaults.content, format: saved.format === 'html' ? 'html' : 'pdf', splitAnswers: saved.splitAnswers !== false }
  } catch { return defaults }
}

export function ReviewCenterPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [settings, setSettings] = useState<Settings>(savedSettings)
  const [filters, setFilters] = useState<Filters>({ answerResult: 'wrong' })
  const [batch, setBatch] = useState<any>(null)
  const [history, setHistory] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [dirty, setDirty] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualRows, setManualRows] = useState<any[]>([])
  const [manualTotal, setManualTotal] = useState(0)
  const [manualPage, setManualPage] = useState(1)
  const [manualIds, setManualIds] = useState<string[]>([])
  const [manualLoading, setManualLoading] = useState(false)
  const [groupEfficiency, setGroupEfficiency] = useState<Awaited<ReturnType<typeof window.api.getFenbiGroupEfficiencyRecords>>>([])
  const { tree, load: loadTree } = useTagTreeStore()

  const refreshHistory = () => window.api.listReviewBatches().then(setHistory).catch(() => undefined)
  useEffect(() => { if (!tree.length) loadTree(); void refreshHistory() }, [])
  useEffect(() => { localStorage.setItem('review-center-settings', JSON.stringify(settings)) }, [settings])
  useEffect(() => {
    const next: Filters = { answerResult: searchParams.get('answerResult') || 'wrong' }
    for (const key of ['level1', 'level2', 'level3', 'timeStatus', 'search'] as const) if (searchParams.get(key)) next[key] = searchParams.get(key)!
    if (searchParams.get('mode') === 'speed') next.timeStatus = 'overtime'
    setFilters(next); setDirty(!!batch)
  }, [searchParams])

  const changeFilters = (patch: Partial<Filters>) => { setFilters(value => ({ ...value, ...patch })); setDirty(!!batch) }
  const generate = async (excludeIds?: string[], ids?: string[]) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.createReviewBatch({ ...filters, count: settings.count, minutes: settings.mode === 'time' && !ids ? settings.minutes : undefined, excludeIds, ids })
      setBatch(result); setDirty(false)
      if (result.questionIds.length < result.requestedCount) message.info(`当前范围可选 ${result.questionIds.length} 题，已按实际数量生成，不重复凑题`)
      if (result.skippedGroups) message.info('部分资料组超过本次预算，已跳过；可以增加预算或手动选题')
      void refreshHistory()
      return true
    } catch (error: any) { message.error(error.message || '生成复习清单失败'); return false }
    finally { setBusy(false) }
  }
  const saveDocument = async () => {
    if (!batch || dirty || busy) return
    setBusy(true); setProgress('准备导出…')
    const unsubscribe = window.api.onPdfProgress(event => setProgress(event.stage === 'download' ? `读取图片 ${event.done || 0}/${event.total || 0}` : '正在生成文档…'))
    try {
      const result = await window.api.exportReviewBatch({ batchId: batch.id, format: settings.format, content: settings.content, splitAnswers: settings.splitAnswers })
      if (!result.success) throw new Error(result.error || '导出失败')
      if (result.canceled) { message.info('已取消保存，未标记复习'); return }
      setBatch((value: any) => ({ ...value, files: [...new Set([...(value.files || []), ...result.files])] }))
      message.success(`已保存 ${result.files.length} 个文件；读完后再标记本批已复习`)
      if (result.imageErrors?.length) message.warning(`${result.imageErrors.length} 项图片读取失败，请检查文档中的提示后重试`)
      void refreshHistory()
      if (settings.format === 'html' && result.files[0]) await window.api.openExternal(result.files[0])
    } catch (error: any) { message.error(error.message || '导出失败') }
    finally { unsubscribe?.(); setBusy(false); setProgress('') }
  }
  const complete = async () => {
    if (!batch || busy) return
    setBusy(true)
    try {
      const result = await window.api.completeReviewBatch(batch.id)
      setBatch((value: any) => ({ ...value, completedAt: result.completedAt }))
      message.success(result.alreadyCompleted ? '这批已记录过复习，不会重复累计' : '已记录本批复习，不会自动标为答对或已掌握')
      if (result.completedPlanTask) message.success(`今日任务已完成：${result.completedPlanTask.title}`)
      void refreshHistory()
    } catch (error: any) { message.error(error.message || '复习记录失败') }
    finally { setBusy(false) }
  }
  const openHistory = async (id: string) => {
    if (busy) return
    setBusy(true)
    try { setBatch(await window.api.getReviewBatch(id)); setDirty(false) }
    catch (error: any) { message.error(error.message || '清单读取失败') }
    finally { setBusy(false) }
  }
  const loadManual = async (page: number) => {
    setManualLoading(true); setManualPage(page)
    try {
      const result = await window.api.getQuestions({ ...filters, page, pageSize: 30, status: 'confirmed' })
      setManualRows(result.items); setManualTotal(result.total)
    } catch (error: any) { message.error(error.message || '候选题加载失败') }
    finally { setManualLoading(false) }
  }
  const openManual = () => { setManualIds(batch?.questionIds || []); setManualOpen(true); void loadManual(1) }
  const removeQuestion = async (id: string) => {
    const groupId = batch.questions.find((q: any) => q.id === id)?.group_id
    const ids = batch.questions.filter((q: any) => groupId ? q.group_id !== groupId : q.id !== id).map((q: any) => q.id)
    if (!ids.length) { setBatch(null); return }
    await generate(undefined, ids)
  }
  const swapQuestion = async (id: string) => {
    if (busy) return
    setBusy(true)
    try {
      const alternative = await window.api.createReviewBatch({ ...filters, count: 1, excludeIds: batch.questionIds })
      const result = await window.api.createReviewBatch({ ids: batch.questionIds.map((value: string) => value === id ? alternative.questionIds[0] : value) })
      setBatch(result); setDirty(false); void refreshHistory()
    } catch (error: any) { message.error(error.message || '没有其他合适的题目') }
    finally { setBusy(false) }
  }
  const level2 = tree.find(node => node.name === filters.level1)?.children || []
  const level3 = level2.find(node => node.name === filters.level2)?.children || []
  const imageWarning = batch?.questions?.some((q: any) => q.image_url && (!q.ocr_text || /正确答案|你的答案/.test(q.ocr_text)))
  const columns: any[] = [
    { title: '题号', width: 58, render: (_: any, __: any, index: number) => index + 1 },
    { title: '题目', dataIndex: 'ocr_text', render: (value: string, row: any) => <div><Typography.Paragraph ellipsis={{ rows: 2, tooltip: value }} style={{ marginBottom: 4 }}>{value || '图形／截图题，导出时带入原图'}</Typography.Paragraph><Space size={[4, 4]} wrap><Tag>{row.level1}</Tag><Tag>{row.level2}</Tag>{row.group_id && <Tag color="blue">公共资料题组</Tag>}</Space></div> },
    { title: '选题原因', width: 170, render: (_: any, row: any) => <Typography.Text type="secondary">{batch?.reasons?.[row.id] || (row.error_count > 1 ? `曾错 ${row.error_count} 次` : '手动选择／固定题单')}</Typography.Text> },
    { title: '调整', width: 120, render: (_: any, row: any) => <Space size={0}>{!row.group_id && <Button size="small" type="link" disabled={busy || dirty} onClick={() => swapQuestion(row.id)}>换题</Button>}<Button size="small" type="link" disabled={busy || dirty} onClick={() => removeQuestion(row.id)}>{row.group_id ? '移除本组' : '移除'}</Button></Space> }
  ]

  return <div className="review-center-page">
    <PageHeader title="复习与导出" subtitle="选一批旧错题，打印或离线阅读；读完再记录复习" extra={<Button disabled={busy} onClick={() => navigate('/test-builder/advanced')}>高级组卷与答题回填</Button>} />
    <Card className="review-setup-card">
      <div className="review-controls-grid">
        <label>今天复习多少<div className="review-count-control"><Select aria-label="复习预算方式" value={settings.mode} style={{ width: 110 }} onChange={mode => { setSettings(value => ({ ...value, mode })); setDirty(!!batch) }} options={[{value:'count',label:'按题量'},{value:'time',label:'按时间'}]} /><InputNumber aria-label={settings.mode === 'time' ? '复习分钟数' : '复习题量'} min={settings.mode === 'time' ? 5 : 1} max={settings.mode === 'time' ? 180 : 100} precision={0} addonAfter={settings.mode === 'time' ? '分钟' : '题'} value={settings.mode === 'time' ? settings.minutes : settings.count} onChange={value => { setSettings(old => ({ ...old, [old.mode === 'time' ? 'minutes' : 'count']: value || (old.mode === 'time' ? 40 : 20) })); setDirty(!!batch) }} /></div></label>
        <label>带哪些内容<Select aria-label="导出内容" value={settings.content} onChange={content => setSettings(value => ({ ...value, content }))} options={[{ value: 'none', label: '纯题目，不带答案解析' }, { value: 'analysis', label: '题目＋答案与粉笔解析' }, { value: 'full', label: '题目＋解析＋个人复盘' }]} /></label>
        <label>在哪里看<Select aria-label="输出方式" value={settings.format} onChange={format => setSettings(value => ({ ...value, format }))} options={[{ value: 'pdf', label: 'PDF · 打印／手机／平板' }, { value: 'html', label: '连续阅读页 · 离线 HTML' }]} /></label>
      </div>
      <div className="review-selection-toolbar"><Typography.Text type="secondary">自动选题保持同一资料组的候选题；时间含核对解析的估算，不是强制单题时限。看过不等于独立做对，不调用 AI。</Typography.Text><Space wrap><Button onClick={openManual} disabled={busy}>自己选题</Button><Button type="primary" onClick={() => generate()} loading={busy && !progress}>生成 {settings.mode === 'time' ? `${settings.minutes} 分钟` : `${settings.count} 题`}清单</Button></Space></div>
      <Collapse ghost items={[{ key: 'filters', label: '更多筛选与导出选项', children: <Space wrap>
        <Select aria-label="复习一级分类" allowClear placeholder="全部模块" value={filters.level1} onChange={value => changeFilters({ level1: value, level2: undefined, level3: undefined })} style={{ width: 135 }} options={tree.map(n => ({ value: n.name, label: n.name }))} />
        <Select allowClear placeholder="二级分类" value={filters.level2} onChange={value => changeFilters({ level2: value, level3: undefined })} style={{ width: 135 }} options={level2.map(n => ({ value: n.name, label: n.name }))} />
        <Select allowClear placeholder="三级分类" value={filters.level3} onChange={value => changeFilters({ level3: value })} style={{ width: 135 }} options={level3.map(n => ({ value: n.name, label: n.name }))} />
        <Select aria-label="复习答题结果" value={filters.answerResult} style={{ width: 145 }} onChange={value => changeFilters({ answerResult: value, timeStatus: undefined })} options={[{ value: 'all', label: '全部入库题' }, { value: 'wrong', label: '答错（含超时）' }, { value: 'correct', label: '答对（含超时）' }, { value: 'unknown', label: '结果未判定' }]} />
        <Select aria-label="复习用时情况" allowClear placeholder="全部用时情况" value={filters.timeStatus} style={{ width: 145 }} onChange={value => changeFilters({ timeStatus: value })} options={[{ value: 'overtime', label: '仅超时' }, { value: 'within', label: '仅未超时' }, { value: 'unknown', label: '未评估' }]} />
        <DatePicker.RangePicker onChange={(_, dates) => changeFilters({ since: dates[0] || undefined, until: dates[1] || undefined })} placeholder={['入库开始日期', '入库结束日期']} />
        <Input allowClear placeholder="题目内容或来源" value={filters.search} onChange={event => changeFilters({ search: event.target.value })} style={{ width: 190 }} />
        {settings.format === 'pdf' && settings.content !== 'none' && <Space><Switch checked={settings.splitAnswers} onChange={splitAnswers => setSettings(value => ({ ...value, splitAnswers }))} /><span>题目卷与答案解析卷分开保存</span></Space>}
      </Space> }]} />
    </Card>
    <Collapse style={{ marginTop: 12 }} onChange={keys => { if (keys.includes('efficiency')) window.api.getFenbiGroupEfficiencyRecords().then(setGroupEfficiency).catch(() => message.error('题组用时记录读取失败')) }} items={[{ key: 'efficiency', label: '资料组效率记录 · 看整组总时间，不按每道题惩罚', children: <>
      <Typography.Paragraph type="secondary">来自本次更新后导入的完整粉笔报告；正确率按原练习整组计算，不是仅按入库错题。参考时间按全站正确率估算，难度系数只展示、不猜测其量纲；缺少用时不评超时。</Typography.Paragraph>
      <Table size="small" rowKey="id" pagination={{ pageSize: 5, showSizeChanger: false }} dataSource={groupEfficiency} columns={[
        { title: '资料组', dataIndex: 'title', ellipsis: true },
        { title: '原组题量／正确率', width: 150, render: (_: any, row: any) => `${row.questionCount}题 · ${Math.round(row.correctCount / Math.max(1, row.questionCount) * 100)}%` },
        { title: '整组用时／参考', width: 175, render: (_: any, row: any) => `${row.actualSeconds === null ? '未完整取得' : `${Math.floor(row.actualSeconds / 60)}分${row.actualSeconds % 60}秒`} / ${Math.ceil(row.targetSeconds / 60)}分` },
        { title: '效率提示', width: 140, render: (_: any, row: any) => <Tag color={row.actualSeconds !== null && row.actualSeconds > row.targetSeconds + row.graceSeconds ? 'orange' : 'default'}>{row.actualSeconds === null ? '暂不评价' : row.actualSeconds > row.targetSeconds + row.graceSeconds ? '先复盘耗时步骤' : '整组在参考范围'}</Tag> }
      ]} />
    </> }]} />
    {dirty && <Alert type="info" showIcon message="题量或筛选已调整，请重新生成清单；未重新生成前不会导出旧题单。" style={{ marginTop: 12 }} />}
    {batch ? <Card className="review-batch-card" title={<Space wrap><span>{batch.title}</span><Tag>{batch.questionIds.length} 道小题 · {batch.groupCount} 组公共资料</Tag>{batch.completedAt && <Tag color="success">已复习</Tag>}</Space>} extra={<Button icon={<ReloadOutlined />} disabled={busy || dirty} onClick={() => generate(batch.questionIds)}>换一批</Button>}>
      {imageWarning && <Alert type="warning" showIcon message="部分原截图可能自带答案。纯题目模式会隐藏系统答案，但不能自动抹去图片中的答案。" style={{ marginBottom: 12 }} />}
      <Table size="small" rowKey="id" dataSource={batch.questions} columns={columns} pagination={false} scroll={{ x: 650, y: 300 }} />
      <div className="review-batch-actions"><Typography.Text type="secondary">固定题单：资料只出现一次，导出不会自动算作已复习。</Typography.Text><Space wrap>
        <Button disabled={busy || dirty} onClick={() => navigate(`/speed-training?batchId=${encodeURIComponent(batch.id)}`)}>计时重做／答题卡</Button>
        <Popconfirm title="确认已经复习完这批题？" description="只记录复习时间，不改变答对、错误次数或掌握状态。" onConfirm={complete} okText="记为已复习" cancelText="还没看完" disabled={busy || dirty || !!batch.completedAt}>
          <Button icon={<CheckOutlined />} disabled={busy || dirty || !!batch.completedAt}>本批已复习</Button>
        </Popconfirm>
        <Button type="primary" icon={settings.format === 'html' ? <ReadOutlined /> : <ExportOutlined />} disabled={dirty || busy} loading={!!progress} onClick={saveDocument}>{progress || (settings.format === 'html' ? '保存并打开连续阅读页' : '保存 PDF')}</Button>
      </Space></div>
      {!!batch.files?.length && <Space direction="vertical" style={{ marginTop: 12 }}>{batch.files.map((file: string) => <Button key={file} type="link" onClick={() => window.api.openExternal(file)}>{file.split('/').pop()}</Button>)}</Space>}
    </Card> : <Card style={{ marginTop: 16 }}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选好题量后生成清单，无需逐题勾选。也可点击“自己选题”。" /></Card>}
    {!!history.length && <Card size="small" title="最近复习清单" style={{ marginTop: 16 }}><Space wrap>{history.slice(0, 8).map(item => <Button key={item.id} disabled={busy} onClick={() => openHistory(item.id)}>{item.title}{item.completedAt ? ' · 已复习' : ''}</Button>)}</Space></Card>}
    <Drawer title={`自己选题 · 已选 ${manualIds.length}/100`} width={850} open={manualOpen} onClose={() => !busy && setManualOpen(false)} extra={<Button type="primary" disabled={!manualIds.length || busy} onClick={async () => { if (await generate(undefined, manualIds)) setManualOpen(false) }}>使用这些题目</Button>}>
      <Typography.Paragraph type="secondary">沿用当前筛选；支持跨页勾选。表头复选框只全选当前页。</Typography.Paragraph>
      <Table rowKey="id" size="small" loading={manualLoading} dataSource={manualRows} columns={[{ title: '题目', dataIndex: 'ocr_text', ellipsis: true, render: (value: string) => value || '图形／截图题' }, { title: '模块', dataIndex: 'level1', width: 110 }, { title: '考点', dataIndex: 'level2', width: 130 }]} rowSelection={{ selectedRowKeys: manualIds, preserveSelectedRowKeys: true, onChange: keys => { if (keys.length > 100) message.warning('最多选 100 题'); else setManualIds(keys as string[]) } }} pagination={{ current: manualPage, pageSize: 30, total: manualTotal, showSizeChanger: false, onChange: loadManual }} />
    </Drawer>
  </div>
}
