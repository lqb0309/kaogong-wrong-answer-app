import { useMemo, useState } from 'react'
import { Alert, App, Button, Checkbox, Drawer, Empty, List, Segmented, Space, Spin, Steps, Switch, Tag, Typography } from 'antd'
import { CheckCircleOutlined, ImportOutlined } from '@ant-design/icons'
import { ExportOutlined, ReloadOutlined } from '@/components/study-icons'
import { useNavigate } from 'react-router-dom'

type Preview = Awaited<ReturnType<typeof window.api.previewFenbiReport>>

export function FenbiImportDrawer(props: { open: boolean; onClose: () => void; onImported?: () => void }) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [generateReflections, setGenerateReflections] = useState(true)
  const [scope, setScope] = useState<'weak' | 'wrong' | 'all'>('weak')

  const duplicateSet = useMemo(() => new Set(preview?.duplicateIds || []), [preview])
  const wrongCount = preview?.questions.filter(question => question.isWrong).length || 0

  const answerSeconds = (value?: string) => {
    if (!value) return null
    const minutes = Number(value.match(/(\d+(?:\.\d+)?)\s*分/)?.[1] || 0)
    const seconds = Number(value.match(/(\d+(?:\.\d+)?)\s*秒/)?.[1] || 0)
    if (minutes || seconds) return Math.round(minutes * 60 + seconds)
    const plain = Number(value.match(/\d+(?:\.\d+)?/)?.[0])
    return Number.isFinite(plain) ? Math.round(plain) : null
  }
  const efficiency = (question: Preview['questions'][number]) => {
    const seconds = answerSeconds(question.answerTime)
    const target = question.suggestedSeconds || (question.keypoints.some(point => /综合分析/.test(point)) ? 120 : 90)
    return { seconds, target, overtime: !!question.isOvertime, timingBasis: question.timingBasis, groupActual: question.groupActualSeconds, groupTarget: question.groupTargetSeconds, groupGrace: question.groupGraceSeconds }
  }
  const selectableIds = (result: Preview, mode: 'weak' | 'wrong' | 'all') => result.questions
    .filter(question => mode === 'all' || question.isWrong || (mode === 'weak' && efficiency(question).overtime))
    .filter(question => !result.duplicateIds.includes(question.sourceId))
    .map(question => question.sourceId)

  const openFenbi = async () => {
    try {
      await window.api.openFenbiImporter()
      message.info('登录后进入“练习历史”，打开一份已完成练习的查看报告')
    } catch (error: any) { message.error(error.message || '无法打开粉笔') }
  }

  const loadPreview = async () => {
    setLoading(true)
    try {
      const result = await window.api.previewFenbiReport()
      setPreview(result)
      setScope('weak')
      setSelected(selectableIds(result, 'weak'))
      const overtimeCount = result.questions.filter(question => !question.isWrong && efficiency(question).overtime).length
      message.success(`读取到 ${result.questions.length} 题：${result.questions.filter(question => question.isWrong).length} 道错题，${overtimeCount} 道正确但超时`)
    } catch (error: any) { message.error(error.message || '读取报告失败') }
    finally { setLoading(false) }
  }

  const doImport = async () => {
    if (!preview || selected.length === 0) return
    setImporting(true)
    try {
      const result = await window.api.importFenbiQuestions({ preview, sourceIds: selected, generateReflections })
      if (result.imported > 0) {
        message.success(result.analysisQueued
          ? `已保存 ${result.imported} 道题，AI 正在后台分析；完成后会通知你去确认`
          : `已导入 ${result.imported} 道薄弱题${result.skipped ? `，跳过 ${result.skipped} 道重复题` : ''}${result.failed ? `，${result.failed} 道失败` : ''}`)
        props.onImported?.()
        props.onClose()
        if (!result.analysisQueued) navigate('/pending')
      } else if (result.failed > 0) message.error(`${result.failed} 道题导入失败，请在日志中查看详情`)
      else message.warning('所选题目均已导入，无需重复添加')
    } catch (error: any) { message.error(error.message || '导入失败') }
    finally { setImporting(false) }
  }

  return (
    <Drawer title="从粉笔导入" width={720} open={props.open} onClose={props.onClose} destroyOnClose={false}
      extra={<Button icon={<ExportOutlined />} onClick={openFenbi}>打开粉笔</Button>}>
      <Steps size="small" current={preview ? 2 : 0} style={{ marginBottom: 20 }} items={[
        { title: '登录并选范围' }, { title: '打开完成报告' }, { title: '预览与去重' }, { title: '导入待确认' }
      ]} />

      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="粉笔登录状态只保存在本机"
        description="点击“打开粉笔”，在练习历史中选择分类和练习范围，再打开已完成练习的查看报告。返回这里点击“读取当前报告”即可。程序不会保存你的粉笔密码。" />

      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<ExportOutlined />} onClick={openFenbi}>1. 打开粉笔并选择报告</Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={loadPreview}>2. 读取当前报告</Button>
      </Space>

      {loading && <div style={{ padding: 48, textAlign: 'center' }}><Spin tip="正在读取题目、答案和解析..." /></div>}
      {!loading && !preview && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未读取报告" />}
      {!loading && preview && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <Typography.Title level={5} style={{ margin: 0 }}>{preview.title}</Typography.Title>
              <Typography.Text type="secondary">
                {preview.materials.length} 组资料 · {preview.questions.length} 题 · {wrongCount} 道错题 · {preview.questions.filter(question => !question.isWrong && efficiency(question).overtime).length} 道正确但超时 · {duplicateSet.size} 道已导入{preview.difficulty ? ` · 粉笔难度 ${preview.difficulty}` : ''}
              </Typography.Text>
            </div>
            <Segmented size="small" value={scope} options={[
              { label: '错题 + 超时题', value: 'weak' },
              { label: '仅错题', value: 'wrong' },
              { label: '全部题目', value: 'all' }
            ]} onChange={value => { const next = value as 'weak' | 'wrong' | 'all'; setScope(next); setSelected(selectableIds(preview, next)) }} />
          </div>

          <List bordered size="small" style={{ maxHeight: '48vh', overflow: 'auto' }} dataSource={preview.questions}
            renderItem={question => {
              const duplicate = duplicateSet.has(question.sourceId)
              const timing = efficiency(question)
              return <List.Item style={{ alignItems: 'flex-start', opacity: duplicate ? 0.55 : 1 }}>
                <Checkbox disabled={duplicate} checked={selected.includes(question.sourceId)}
                  onChange={event => setSelected(previous => event.target.checked ? [...previous, question.sourceId] : previous.filter(id => id !== question.sourceId))}
                  style={{ marginTop: 3, marginRight: 12 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Typography.Text strong>{question.index}. {question.stem}</Typography.Text>
                  <div style={{ marginTop: 6 }}>
                    <Tag color={question.isWrong ? 'error' : 'success'}>{question.isWrong ? `你的答案 ${question.userAnswer} / 正确 ${question.correctAnswer}` : `正确 ${question.correctAnswer}`}</Tag>
                    {question.answerTime && <Tag color={timing.overtime ? 'orange' : 'default'}>用时 {question.answerTime} · 建议 {timing.target} 秒{timing.overtime ? ` · 多用 ${(timing.seconds || 0) - timing.target} 秒` : ''}</Tag>}
                    {timing.timingBasis === 'group' && <Tag color={timing.groupActual && timing.groupTarget && timing.groupActual > timing.groupTarget + (timing.groupGrace || 0) ? 'orange' : 'cyan'}>{timing.groupActual === undefined ? '题组用时未完整取得，不评超时' : `题组 ${timing.groupActual} / 参考 ${timing.groupTarget || 0} 秒`}</Tag>}
                    {!question.isWrong && timing.overtime && <Tag color="warning">正确但超时</Tag>}
                    {question.isWrong && timing.overtime && <Tag color="volcano">错误且超时</Tag>}
                    {question.materialIndex > 0 && <Tag>资料 {question.materialIndex}</Tag>}
                    {question.keypoints.map(point => <Tag color="blue" key={point}>{point}</Tag>)}
                    {duplicate && <Tag icon={<CheckCircleOutlined />}>已导入</Tag>}
                  </div>
                  <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: '6px 0 0' }}>{question.analysis?.replace(/!\[[^\]]*\]\(<[^>]+>\)/g, '【公式图片】') || '暂无可靠的粉笔文字解析，AI 不会引用缺失内容'}</Typography.Paragraph>
                </div>
              </List.Item>
            }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
            <Space><Switch checked={generateReflections} onChange={setGenerateReflections} /><Typography.Text>后台生成中文标签与复盘思路</Typography.Text></Space>
            <Button type="primary" size="large" icon={<ImportOutlined />} disabled={selected.length === 0} loading={importing} onClick={doImport}>
              导入待确认（{selected.length}）
            </Button>
          </div>
        </>
      )}
    </Drawer>
  )
}
