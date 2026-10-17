import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Alert, App, Button, Card, Empty, InputNumber, Progress, Radio, Segmented, Select, Space, Statistic, Tabs, Tag, Typography } from 'antd'
import { CheckCircleOutlined } from '@ant-design/icons'
import { ArrowLeftOutlined, ClockCircleOutlined, TimerOutlined } from '@/components/study-icons'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { SafeImage } from '@/components/safe-image'

type Setup = { count: number; scope: 'pending' | 'all'; pickMode: 'untrained' | 'slowest' | 'random'; timeMode: 'standard' | 'extreme' | 'custom'; customSeconds: number; mode: 'pdf' | 'online'; customTotalMinutes: number; accuracyTarget: number }
type Question = Record<string, any>

function parseJson(raw?: string) { try { return JSON.parse(raw || '{}') || {} } catch { return {} } }
function parseImages(raw?: string): string[] { const value = parseJson(raw); return Array.isArray(value) ? value : [] }
function parseContent(raw?: string) {
  const text = (raw || '').replace(/\r/g, '').trim()
  const matches = [...text.matchAll(/(?:^|\n|\s)([A-H])[.．、）)]\s*/g)]
  if (!matches.length) return { stem: text, options: [] as Array<{ key: string; text: string }> }
  return {
    stem: text.slice(0, matches[0].index).trim(),
    options: matches.map((match, index) => ({ key: match[1], text: text.slice((match.index || 0) + match[0].length, matches[index + 1]?.index ?? text.length).trim() }))
  }
}

function LocalImage({ source }: { source: string }) {
  return <SafeImage src={source} style={{ width: '100%', maxHeight: 360, objectFit: 'contain' }} />
}

export function SpeedTrainingPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { message } = App.useApp()
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem('speed-training-setup') || '') } catch { return null } }, [])
  const [setup, setSetup] = useState<Setup>({ count: 5, scope: 'pending', pickMode: 'untrained', timeMode: 'standard', customSeconds: 90, mode: 'pdf', customTotalMinutes: 8, accuracyTarget: 80, ...(saved || {}) })
  const [questions, setQuestions] = useState<Question[]>([])
  const [available, setAvailable] = useState(0)
  const [started, setStarted] = useState(false)
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<any>(null)
  const [pdfStage, setPdfStage] = useState<'timer' | 'answers' | 'result'>('timer')
  const [pdfPath, setPdfPath] = useState('')
  const [answerSheet, setAnswerSheet] = useState<Record<string, string>>({})
  const quickStarted = useRef(false)
  const clockStart = useRef(0)
  const elapsedRef = useRef(0)

  const current = questions[index]
  const original = parseJson(current?.original_answer)
  const parsed = parseContent(current?.ocr_text)
  const target = !current ? 90 : setup.timeMode === 'custom' ? setup.customSeconds : (/综合分析/.test(`${current.level2} ${current.level3 || ''}`) ? (setup.timeMode === 'extreme' ? 90 : 120) : (setup.timeMode === 'extreme' ? 60 : 90))
  const totalLimit = setup.timeMode === 'custom' ? Math.round(setup.customTotalMinutes * 60) : (questions.length || setup.count) * (setup.timeMode === 'extreme' ? 60 : 90)

  useEffect(() => {
    if (!started || submitted || !current || (setup.mode === 'pdf' && pdfStage !== 'timer')) return
    clockStart.current = Date.now() - elapsedRef.current * 1000
    const tick = () => { elapsedRef.current = Math.floor((Date.now() - clockStart.current) / 1000); setElapsed(elapsedRef.current) }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [started, submitted, current?.id, setup.mode, pdfStage])

  const start = async () => {
    localStorage.setItem('speed-training-setup', JSON.stringify(setup))
    const existingBatch = searchParams.get('batchId') ? await window.api.getReviewBatch(searchParams.get('batchId')!) : null
    const response = existingBatch ? { items: existingBatch.questions, available: existingBatch.questionIds.length } : await window.api.getSpeedTrainingQuestions({ count: setup.count, scope: setup.scope, pickMode: setup.pickMode, level1: searchParams.get('level1') || undefined, level2: searchParams.get('level2') || undefined, level3: searchParams.get('level3') || undefined, answerResult: searchParams.get('answerResult') || undefined })
    if (!response.items.length) { setQuestions([]); setStarted(true); return }
    elapsedRef.current = 0
    setAvailable(response.available); setQuestions(response.items); setIndex(0); setElapsed(0); setSelected(''); setSubmitted(false); setResult(null); setAnswerSheet({}); setPdfStage('timer')
    if (setup.mode === 'pdf') {
      const batch = existingBatch || await window.api.createReviewBatch({ ids: response.items.map((item: Question) => item.id) })
      const pdf = await window.api.exportReviewBatch({ batchId: batch.id, title: '速度专项训练', format: 'pdf', content: 'none', splitAnswers: false })
      if (pdf.canceled) { message.info('已取消导出，计时尚未开始'); return }
      if (!pdf.success || !pdf.files[0]) { message.error(pdf.error || 'PDF 生成失败'); return }
      if (pdf.questionIds) setQuestions(pdf.questionIds.map(id => response.items.find((item: Question) => item.id === id)).filter(Boolean))
      setPdfPath(pdf.files[0])
      await window.api.openExternal(pdf.files[0])
    }
    setStarted(true)
  }
  useEffect(() => {
    if (searchParams.get('quick') === '1' && !quickStarted.current) {
      quickStarted.current = true
      start().catch(() => message.error('速度训练启动失败'))
    }
  }, [])
  const submit = async () => {
    if (!selected) { message.warning('请先选择答案'); return }
    const response = await window.api.recordSpeedTrainingAttempt({ questionId: current.id, selectedAnswer: selected, correctAnswer: original.correct, elapsedSeconds: elapsed, targetSeconds: target })
    setResult(response); setSubmitted(true)
  }
  const next = () => {
    if (index >= questions.length - 1) { setStarted(false); return }
    elapsedRef.current = 0
    setIndex(value => value + 1); setSelected(''); setSubmitted(false); setElapsed(0); setResult(null)
  }
  const submitSheet = async () => {
    const unanswered = questions.filter(question => !answerSheet[question.id]).length
    if (unanswered) { message.warning(`还有 ${unanswered} 题没有填写答案`); return }
    const response = await window.api.recordSpeedTrainingSession({ answers: questions.map(question => ({ questionId: question.id, selectedAnswer: answerSheet[question.id], correctAnswer: parseJson(question.original_answer).correct || '' })), elapsedSeconds: elapsed, limitSeconds: totalLimit, accuracyTarget: setup.accuracyTarget })
    setResult(response); setPdfStage('result')
  }

  if (!started) return <div className="speed-training-page training-setup">
    <Space style={{ marginBottom: 18 }}><Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>返回</Button><Typography.Title level={3} style={{ margin: 0 }}><TimerOutlined style={{ color: '#fa8c16' }} /> 速度训练</Typography.Title></Space>
    <Card title="本次训练设置">
      <Space direction="vertical" size={22} style={{ width: '100%' }}>
        <div><Typography.Text strong>训练方式</Typography.Text><div style={{ marginTop: 8 }}><Radio.Group value={setup.mode} onChange={event => setSetup({ ...setup, mode: event.target.value })}><Radio.Button value="pdf">PDF 模拟训练</Radio.Button><Radio.Button value="online">在线逐题训练</Radio.Button></Radio.Group></div></div>
        <div><Typography.Text strong>训练数量</Typography.Text><div style={{ marginTop: 8 }}><Segmented value={setup.count} options={[2, 5, 10, 15].map(value => ({ label: `${value} 题`, value }))} onChange={value => setSetup({ ...setup, count: Number(value) })} /><InputNumber min={1} max={50} value={setup.count} onChange={value => setSetup({ ...setup, count: value || 5 })} style={{ marginLeft: 10, width: 90 }} /></div></div>
        <div><Typography.Text strong>题目范围</Typography.Text><div style={{ marginTop: 8 }}><Radio.Group value={setup.scope} onChange={event => setSetup({ ...setup, scope: event.target.value })}><Radio.Button value="pending">仍未达标</Radio.Button><Radio.Button value="all">全部超时题</Radio.Button></Radio.Group></div></div>
        <div><Typography.Text strong>选题方式</Typography.Text><div style={{ marginTop: 8 }}><Select value={setup.pickMode} style={{ width: 220 }} onChange={value => setSetup({ ...setup, pickMode: value })} options={[{ value: 'untrained', label: '优先未训练/未达标' }, { value: 'slowest', label: '优先原始超时最多' }, { value: 'random', label: '随机抽取' }]} /></div></div>
        <div><Typography.Text strong>时间标准</Typography.Text><div style={{ marginTop: 8 }}><Radio.Group value={setup.timeMode} onChange={event => setSetup({ ...setup, timeMode: event.target.value })}><Radio.Button value="standard">标准总时限</Radio.Button><Radio.Button value="extreme">极限提速</Radio.Button><Radio.Button value="custom">自定义总时间</Radio.Button></Radio.Group>{setup.timeMode === 'custom' && (setup.mode === 'pdf' ? <InputNumber min={1} max={120} value={setup.customTotalMinutes} onChange={value => setSetup({ ...setup, customTotalMinutes: value || 8 })} addonAfter="分钟/套" style={{ marginLeft: 10, width: 155 }} /> : <InputNumber min={20} max={600} value={setup.customSeconds} onChange={value => setSetup({ ...setup, customSeconds: value || 90 })} addonAfter="秒/题" style={{ marginLeft: 10, width: 150 }} />)}</div></div>
        {setup.mode === 'pdf' && <div><Typography.Text strong>正确率目标</Typography.Text><div style={{ marginTop: 8 }}><InputNumber min={0} max={100} value={setup.accuracyTarget} onChange={value => setSetup({ ...setup, accuracyTarget: value ?? 80 })} addonAfter="%" /></div></div>}
        <Alert type="info" showIcon message="达标规则" description={setup.mode === 'pdf' ? `整套总时限 ${Math.ceil(totalLimit / 60)} 分钟，时间可在题目间自由分配；正确率达到目标且总用时未超时，整套训练达标。单题连续两次随整套达标且答对后毕业。` : '答案正确且在目标时间内才算达标；同一道题连续两次达标后，从“仍未达标”队列毕业。'} />
        <Button type="primary" size="large" icon={<TimerOutlined />} onClick={start}>开始训练</Button>
      </Space>
    </Card>
  </div>

  if (!current) return <Empty description="当前范围没有可训练的超时题"><Button onClick={() => setStarted(false)}>调整条件</Button></Empty>

  if (setup.mode === 'pdf') {
    const remaining = Math.max(0, totalLimit - elapsed)
    const accuracy = result ? Math.round(result.accuracy * 100) : 0
    const passed = !!result && result.onTime && accuracy >= setup.accuracyTarget
    return <div className="speed-training-page training-pdf">
      <Space style={{ marginBottom: 16 }}><Button icon={<ArrowLeftOutlined />} onClick={() => setStarted(false)}>结束训练</Button><Typography.Title level={3} style={{ margin: 0 }}><TimerOutlined style={{ color: '#fa8c16' }} /> PDF 模拟训练</Typography.Title></Space>
      {pdfStage === 'timer' && <Card style={{ textAlign: 'center' }}>
        <Typography.Text type="secondary">整套剩余时间</Typography.Text>
        <div style={{ fontSize: 64, lineHeight: 1.4, fontVariantNumeric: 'tabular-nums', color: remaining === 0 ? '#cf3f3f' : '#1677ff' }}>{String(Math.floor(remaining / 60)).padStart(2, '0')}:{String(remaining % 60).padStart(2, '0')}</div>
        <Progress percent={Math.min(100, Math.round(elapsed / totalLimit * 100))} status={remaining === 0 ? 'exception' : 'active'} showInfo={false} />
        <Typography.Paragraph type="secondary">共 {questions.length} 题 · 总时限 {Math.ceil(totalLimit / 60)} 分钟 · 已用 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</Typography.Paragraph>
        <Space><Button onClick={() => window.api.openExternal(pdfPath)}>重新打开 PDF</Button><Button type="primary" size="large" onClick={() => setPdfStage('answers')}>完成作答，填写答题卡</Button></Space>
      </Card>}
      {pdfStage === 'answers' && <Card title="填写答题卡" extra={<Tag color={elapsed <= totalLimit ? 'success' : 'error'}>用时 {Math.floor(elapsed / 60)}分{elapsed % 60}秒 / 限时 {Math.ceil(totalLimit / 60)}分钟</Tag>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 12 }}>
          {questions.map((question, questionIndex) => <div key={question.id} style={{ padding: 12, border: '1px solid #f0f0f0', borderRadius: 10 }}><Typography.Text strong style={{ marginRight: 12 }}>{questionIndex + 1}</Typography.Text><Radio.Group optionType="button" buttonStyle="solid" size="small" value={answerSheet[question.id]} onChange={event => setAnswerSheet(previous => ({ ...previous, [question.id]: event.target.value }))} options={['A', 'B', 'C', 'D'].map(value => ({ label: value, value }))} /></div>)}
        </div>
        <Alert style={{ marginTop: 18 }} type="info" showIcon message={`已填写 ${Object.keys(answerSheet).length}/${questions.length} 题`} />
        <Space style={{ width: '100%', justifyContent: 'flex-end', marginTop: 16 }}><Button onClick={() => setPdfStage('timer')}>返回继续计时</Button><Button type="primary" size="large" onClick={submitSheet}>交卷</Button></Space>
      </Card>}
      {pdfStage === 'result' && <Card title="训练结果">
        <Alert type={passed ? 'success' : 'warning'} showIcon message={passed ? '本套训练达标' : '本套训练未达标'} description={`答对 ${result.correctCount}/${questions.length} 题，正确率 ${accuracy}%；总用时 ${Math.floor(elapsed / 60)}分${elapsed % 60}秒，${result.onTime ? `比时限提前 ${result.savedSeconds} 秒` : `超过时限 ${Math.abs(result.savedSeconds)} 秒`}。${result.graduated ? `本次有 ${result.graduated} 道题达到连续两次达标并毕业。` : ''}`} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10, marginTop: 16 }}>{questions.map((question, i) => { const correct = parseJson(question.original_answer).correct; const user = answerSheet[question.id]; return <div key={question.id} style={{ padding: 12, borderRadius: 8, background: user === correct ? '#f0faf6' : '#fff2f0' }}><b>第 {i + 1} 题</b><span style={{ marginLeft: 12 }}>你的答案 {user}</span><span style={{ marginLeft: 8, color: '#13a879' }}>正确 {correct}</span></div> })}</div>
        <Space style={{ marginTop: 18 }}><Button onClick={() => window.api.openExternal(pdfPath)}>打开 PDF</Button><Button type="primary" onClick={() => setStarted(false)}>返回训练设置</Button></Space>
      </Card>}
    </div>
  }

  return <div className="speed-training-workspace">
    <Card size="small"><div style={{ display: 'flex', alignItems: 'center', gap: 18 }}><Button icon={<ArrowLeftOutlined />} onClick={() => setStarted(false)}>结束训练</Button><Progress percent={Math.round((index + (submitted ? 1 : 0)) / questions.length * 100)} showInfo={false} style={{ flex: 1 }} /><Typography.Text>{index + 1}/{questions.length}</Typography.Text><Statistic prefix={<ClockCircleOutlined />} value={elapsed} suffix={`/ ${target}秒`} valueStyle={{ fontSize: 20, color: elapsed > target ? '#cf3f3f' : '#1677ff' }} /></div></Card>
    <div style={{ minHeight: 0, display: 'grid', gridTemplateColumns: current.group_id ? 'minmax(0,.9fr) minmax(0,1.1fr)' : '1fr', gap: 12 }}>
      {current.group_id && <Card title="公共资料" styles={{ body: { height: 'calc(100% - 56px)', overflow: 'auto' } }}>{current.group_passage_text && <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.85 }}>{current.group_passage_text}</div>}{parseImages(current.group_material_images).map((src, i) => <LocalImage key={i} source={src} />)}</Card>}
      <Card title={<Space><Tag color="error">限时训练</Tag><span>{current.question_number ? `第 ${current.question_number} 题` : '题目'}</span></Space>} styles={{ body: { height: 'calc(100% - 56px)', overflow: 'auto' } }}>
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 16, lineHeight: 1.9, marginBottom: 16 }}>{parsed.stem}</div>
        {parseImages(current.question_images).map((src, i) => <LocalImage key={i} source={src} />)}
        <Radio.Group value={selected} onChange={event => !submitted && setSelected(event.target.value)} style={{ width: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }}>{parsed.options.map(option => <Radio key={option.key} value={option.key} style={{ display: 'flex', padding: '10px 12px', borderRadius: 8, background: submitted && option.key === original.correct ? '#f0faf6' : submitted && option.key === selected && selected !== original.correct ? '#fff2f0' : '#fafafa', width: '100%' }}><b style={{ marginRight: 10 }}>{option.key}</b>{option.text}</Radio>)}</Space>
        </Radio.Group>
        {!submitted ? <Button type="primary" size="large" block style={{ marginTop: 18 }} onClick={submit}>提交答案</Button> : <>
          <Alert style={{ marginTop: 16 }} type={result?.achieved ? 'success' : 'warning'} showIcon icon={result?.achieved ? <CheckCircleOutlined /> : <ClockCircleOutlined />} message={result?.achieved ? `达标：正确，用时 ${elapsed} 秒` : selected !== original.correct ? `未达标：你的答案 ${selected}，正确答案 ${original.correct}` : `答案正确，但用时 ${elapsed} 秒，超过目标 ${Math.max(0, elapsed - target)} 秒`} description={result?.graduated ? '已连续两次达标，本题已从待训练队列毕业。' : `连续达标 ${result?.consecutivePasses || 0}/2 次`} />
          <Tabs style={{ marginTop: 10 }} items={[{ key: 'fenbi', label: '粉笔解析', children: current.original_analysis ? <MarkdownRenderer content={current.original_analysis} /> : <Typography.Text type="secondary">暂无粉笔解析</Typography.Text> }, { key: 'review', label: '个人复盘', children: current.reflection ? <MarkdownRenderer content={current.reflection} /> : <Typography.Text type="secondary">暂无个人复盘</Typography.Text> }]} />
          <Button type="primary" size="large" block onClick={next}>{index === questions.length - 1 ? '完成训练' : '下一题'}</Button>
        </>}
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>当前范围共有 {available} 道可训练题</Typography.Text>
      </Card>
    </div>
  </div>
}
