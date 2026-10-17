import { useState, useEffect, useCallback } from 'react'
import { App, Alert, Button, Card, Checkbox, DatePicker, Input, List, Modal, Popconfirm, Progress, Space, Spin, Steps, Switch, Tag, Typography, Tooltip } from 'antd'
import { CheckCircleOutlined, MinusCircleOutlined, RocketOutlined } from '@ant-design/icons'
import { ReloadOutlined, AiSparkOutlined, TimerOutlined, CalendarOutlined, ClockCircleOutlined, ScheduleOutlined, EditOutlined, SyncOutlined, ExportOutlined } from '@/components/study-icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { PageHeader } from '@/components/page-header'

const { Title, Text } = Typography

const MODULE_COLORS: Record<string, string> = {
  资料分析: 'blue',
  判断推理: 'purple',
  言语理解: 'green',
  数量关系: 'gold',
  常识判断: 'cyan',
  政治理论: 'red',
  申论: 'magenta',
  复盘: 'default',
  其他: 'default'
}

interface PlanTask {
  id: string
  title: string
  detail: string
  minutes: number
  module: string
  done: 0 | 1
}

interface TodayPlan {
  date: string
  tasks: PlanTask[]
  status: 'pending' | 'partial' | 'completed'
  note: string
  ai_adjusted: boolean
  adjustment_reason: string
  created_at: string
  updated_at: string
}

interface HistoryItem {
  date: string
  status: 'pending' | 'partial' | 'completed'
  note: string
  ai_adjusted: boolean
  adjustment_reason: string
  tasks_total: number
  tasks_done: number
}

interface PhaseInfo {
  name: '基础阶段' | '强化阶段' | '冲刺阶段' | '已到考前'
  days_left: number
  phase_start: string
  phase_end: string
  phase_days_left: number
  focus: string
  milestones: Array<{ date: string; label: string; type: 'phase' | 'exam' | 'info' }>
}

interface ForwardPlan {
  overview: string
  days: Array<{ date: string; title: string; detail: string }>
  generated_at: string
}

const STATUS_META: Record<string, { text: string; color: string; icon: React.ReactNode }> = {
  completed: { text: '全部完成', color: 'success', icon: <CheckCircleOutlined /> },
  partial: { text: '部分完成', color: 'warning', icon: <MinusCircleOutlined /> },
  pending: { text: '未完成', color: 'error', icon: <ClockCircleOutlined /> }
}

export function PlanPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(true)
  const [plan, setPlan] = useState<TodayPlan | null>(null)
  const [examDate, setExamDate] = useState('2026-11-25')
  const [savedExamDate, setSavedExamDate] = useState('2026-11-25')
  const [daysUntil, setDaysUntil] = useState(0)
  const [phase, setPhase] = useState<PhaseInfo | null>(null)
  const [futureNote, setFutureNote] = useState('')
  const [forwardPlan, setForwardPlan] = useState<ForwardPlan | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [editingExam, setEditingExam] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [planCorrection, setPlanCorrection] = useState('')
  const [forwardLoading, setForwardLoading] = useState(false)
  const [fenbiSummary, setFenbiSummary] = useState<any>(null)
  const [fenbiSyncing, setFenbiSyncing] = useState(false)
  const [fenbiWrongModalOpen, setFenbiWrongModalOpen] = useState(false)
  const [fenbiWrongRange, setFenbiWrongRange] = useState<any>([dayjs(), dayjs()])
  const [includeCorrectOvertime, setIncludeCorrectOvertime] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.getTodayPlan()
      if (res.success && res.plan) {
        setPlan(res.plan)
      } else {
        message.error(res.error || '获取今日计划失败')
      }
      setExamDate(res.exam?.exam_date || '2026-11-25')
      setSavedExamDate(res.exam?.exam_date || '2026-11-25')
      setDaysUntil(res.exam?.days_until ?? 0)
      setPhase(res.phase || null)
      setFutureNote(res.future_note || '')
      setForwardPlan(res.forward_plan || null)
      const h = await window.api.getPlanHistory(7)
      setHistory(h || [])
      setFenbiSummary(await window.api.getFenbiTodaySummary())
    } catch (err: any) {
      message.error(`获取计划失败: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { load() }, [load])

  const toggleTask = async (task: PlanTask, checked: boolean) => {
    if (!plan) return
    // 乐观更新
    const prev = plan
    const next = { ...plan, tasks: plan.tasks.map(t => t.id === task.id ? { ...t, done: (checked ? 1 : 0) as 0 | 1 } : t) }
    setPlan(next)
    try {
      const res = await window.api.updatePlanTask(plan.date, task.id, checked)
      if (!res.success) setPlan(prev)
    } catch {
      setPlan(prev)
    }
  }


  const saveExamDate = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) {
      message.error('日期格式应为 YYYY-MM-DD，例如 2026-11-25')
      return
    }
    try {
      await window.api.setConfig('plan_exam_date', examDate)
      setSavedExamDate(examDate)
      setEditingExam(false)
      message.success(`目标日期已更新为 ${examDate}，倒排计划已重新计算`)
      load()
    } catch (err: any) {
      message.error(`保存失败: ${err.message}`)
    }
  }

  const cancelEditExam = () => {
    setEditingExam(false)
    setExamDate(savedExamDate)
  }

  const regenerate = async () => {
    setRegenerating(true)
    try {
      const res = await window.api.regenerateTodayPlan({ feedback: planCorrection.trim() })
      if (res.plan) {
        setPlan(res.plan)
      }
      if (res.success) {
        setPlanCorrection('')
        setForwardPlan(null)
        const config = await window.api.getAllConfig()
        setFutureNote(config.plan_future_note || '')
        message.success('已调整未完成任务，已完成记录保持不变')
      }
      else message.warning(res.error || 'AI 调整未生效，沿用当前计划')
      const h = await window.api.getPlanHistory(7)
      setHistory(h || [])
    } catch (err: any) {
      message.error(`调整失败: ${err.message}`)
    } finally {
      setRegenerating(false)
    }
  }

  const genForward = async () => {
    setForwardLoading(true)
    try {
      const res = await window.api.planForward()
      if (res.success && res.plan) {
        setForwardPlan(res.plan)
        message.success('未来一周倒排安排已生成')
      } else {
        message.warning(res.error || '生成失败，请检查 AI 配置')
      }
    } catch (err: any) {
      message.error(`生成失败: ${err.message}`)
    } finally {
      setForwardLoading(false)
    }
  }

  const syncFenbi = async (currentOnly = false) => {
    setFenbiSyncing(true)
    try {
      const result = currentOnly ? await window.api.syncFenbiCurrentReport() : await window.api.syncFenbiToday()
      setFenbiSummary({ ...result, accuracy: result.questions ? Math.round(result.correct / result.questions * 100) : 0 })
      message.success(`已同步 ${result.questions} 题${!currentOnly && 'scannedReports' in result ? `（扫描 ${result.scannedReports} 份报告）` : ''}${result.completedTasks.length ? `，自动完成 ${result.completedTasks.length} 项任务` : ''}`)
      await load()
    } catch (error: any) {
      message.warning(error.message || '同步失败，请先在粉笔窗口打开今天完成的练习报告')
    } finally { setFenbiSyncing(false) }
  }

  const syncFenbiWrong = async () => {
    if (!fenbiWrongRange?.[0] || !fenbiWrongRange?.[1]) return message.warning('请选择同步日期')
    setFenbiSyncing(true)
    try {
      const result = await window.api.syncFenbiWrongQuestions({
        startDate: fenbiWrongRange[0].format('YYYY-MM-DD'),
        endDate: fenbiWrongRange[1].format('YYYY-MM-DD'),
        includeCorrectOvertime
      })
      setFenbiWrongModalOpen(false)
      message.success(`扫描 ${result.scannedReports} 份练习，已保存 ${result.imported} 道题并转入后台 AI 分析${result.skipped ? `，跳过 ${result.skipped} 道重复题` : ''}；完成后会通知你确认`)
      await load()
    } catch (error: any) {
      message.warning(error.message || '粉笔错题同步失败')
    } finally { setFenbiSyncing(false) }
  }

  const doneCount = plan?.tasks.filter(t => t.done).length || 0
  const totalTasks = plan?.tasks.length || 0
  const totalMinutes = plan?.tasks.reduce((n, t) => n + t.minutes, 0) || 0
  const completedMinutes = plan?.tasks.filter(t => t.done).reduce((n, t) => n + t.minutes, 0) || 0
  const percent = totalMinutes > 0 ? Math.round(completedMinutes / totalMinutes * 100) : 0

  return (
    <div className="plan-page">
      <PageHeader title="每日计划" subtitle={`${plan?.date || '加载中'}，今天只专注值得完成的事`} extra={<Space>
          <Tag icon={<RocketOutlined />} color={daysUntil <= 60 ? 'red' : 'orange'} style={{ fontSize: 13, padding: '4px 10px' }}>
            距国考约 {daysUntil} 天（{examDate}）
          </Tag>
          <Tooltip title="刷新">
            <Button size="small" aria-label="刷新每日计划" title="刷新每日计划" icon={<ReloadOutlined />} onClick={load} />
          </Tooltip>
        </Space>} />

      {loading ? (
        <Card>
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#999' }}>正在生成今天的计划（首次打开会调用 AI 根据昨天情况调整，约 10-30 秒）...</div>
          </div>
        </Card>
      ) : !plan ? (
        <Card>
          <Alert type="warning" showIcon message="今日计划生成失败" description="请检查 AI 配置或稍后重试。" action={<Button size="small" onClick={load}>重试</Button>} />
        </Card>
      ) : (
        <div className="plan-grid">
          <Card className="plan-sync-card" title={<Space><SyncOutlined style={{ color: '#1677ff' }} />今日粉笔学习记录</Space>} extra={<Space wrap><Button size="small" icon={<ExportOutlined />} onClick={() => window.api.openFenbiImporter()}>打开粉笔</Button><Button size="small" onClick={() => syncFenbi(true)} disabled={fenbiSyncing}>同步当前报告</Button><Button size="small" icon={<SyncOutlined />} onClick={() => setFenbiWrongModalOpen(true)} disabled={fenbiSyncing}>同步错题</Button><Button size="small" type="primary" icon={<SyncOutlined />} loading={fenbiSyncing} onClick={() => syncFenbi(false)}>同步今日记录</Button></Space>}>
            {fenbiSummary ? <>
              <Space wrap size={[8, 8]}>
                <Tag color="blue">{fenbiSummary.sessions} 份练习</Tag><Tag>{fenbiSummary.questions} 题</Tag><Tag color="success">正确率 {fenbiSummary.accuracy}%</Tag><Tag color="error">错题 {fenbiSummary.wrong}</Tag><Tag color="orange">超时 {fenbiSummary.overtime}</Tag><Tag>用时 {Math.floor(fenbiSummary.totalSeconds / 60)} 分钟</Tag>
              </Space>
              <div style={{ marginTop: 10, lineHeight: 1.8 }}>{fenbiSummary.summary || `今天已同步 ${fenbiSummary.questions} 题，正确率 ${fenbiSummary.accuracy}%。`}</div>
              {!!fenbiSummary.modules?.length && <div style={{ marginTop: 8 }}>{fenbiSummary.modules.map((item: any) => <Tag key={item.name}>{item.name} {item.count} 题 · {item.count ? Math.round(item.correct / item.count * 100) : 0}%</Tag>)}</div>}
              <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>上次同步：{fenbiSummary.syncedAt ? new Date(fenbiSummary.syncedAt).toLocaleTimeString() : '-'}</Text>
            </> : <Alert type="info" showIcon message="今天还没有同步粉笔练习" description="点击“自动同步今天”，程序会在粉笔练习历史中筛选今天且已完成的记录，逐份读取并汇总。若粉笔页面结构临时变化，可打开某份报告后使用“同步当前报告”备用。" />}
          </Card>
          <Modal title="从粉笔同步错题" open={fenbiWrongModalOpen} onCancel={() => setFenbiWrongModalOpen(false)} onOk={syncFenbiWrong} okText="开始同步" cancelText="取消" confirmLoading={fenbiSyncing} destroyOnClose={false}>
            <Space direction="vertical" size={18} style={{ width: '100%' }}>
              <div>
                <Text strong>练习日期</Text>
                <DatePicker.RangePicker value={fenbiWrongRange} onChange={value => setFenbiWrongRange(value)} allowClear={false} style={{ width: '100%', marginTop: 8 }} format="YYYY-MM-DD" disabledDate={date => date.isAfter(dayjs(), 'day')} />
                <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>默认今天，单次最多同步 31 天。只读取已经完成的练习。</Text>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', padding: '12px 14px', background: '#fafafa', borderRadius: 8 }}>
                <div><Text strong>同时导入正确但超时题</Text><Text type="secondary" style={{ display: 'block', marginTop: 3 }}>关闭时只同步真正答错的题目</Text></div>
                <Switch checked={includeCorrectOvertime} onChange={setIncludeCorrectOvertime} />
              </div>
              <Alert showIcon type="info" message="同步后进入待确认" description="程序会保留你的答案、正确答案、题目图片、粉笔解析、用时和考点，并自动生成分类与复盘思路；重复题不会再次导入。" />
            </Space>
          </Modal>
          <Card className="plan-speed-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div><Space><TimerOutlined style={{ color: '#bd7418', fontSize: 22 }} /><Text strong style={{ fontSize: 16 }}>今日速度训练</Text><Tag color="orange">正确但超时</Tag></Space><div style={{ marginTop: 6 }}><Text type="secondary">按上次设置快速开始，或进入后调整题量、选题方式和限时标准。</Text></div></div>
              <Space wrap><Button onClick={() => navigate('/speed-training')}>调整后开始</Button><Button type="primary" icon={<TimerOutlined />} onClick={() => navigate('/speed-training?quick=1')}>开始训练</Button></Space>
            </div>
          </Card>
          {phase && (
            <Card className="plan-phase-card" title={<Space><RocketOutlined style={{ color: '#bd7418' }} />当前备考阶段</Space>}>
              <div className="plan-phase-summary"><Tag color="blue">{phase.name}</Tag><Text type="secondary">本阶段还剩 {phase.phase_days_left} 天</Text></div>
              {phase.focus && <div className="plan-phase-focus">{phase.focus}</div>}
              <details className="plan-task-detail plan-phase-detail">
                <summary>目标日期与阶段安排</summary>
              <Space wrap style={{ marginBottom: 10 }}>
                <Text strong>目标日期：</Text>
                {!editingExam ? (
                  <>
                    <Text strong style={{ color: '#1677ff', fontSize: 15 }}>{examDate}</Text>
                    <Button size="small" icon={<EditOutlined />} onClick={() => setEditingExam(true)}>修改</Button>
                  </>
                ) : (
                  <>
                    <Input size="small" value={examDate} onChange={e => setExamDate(e.target.value)} style={{ width: 140 }} placeholder="YYYY-MM-DD" />
                    <Button size="small" type="primary" onClick={saveExamDate}>保存</Button>
                    <Button size="small" onClick={cancelEditExam}>取消</Button>
                  </>
                )}
                <Text type="secondary" style={{ fontSize: 12 }}>填你的考试/目标日期，倒排阶段、每天任务、AI 调整都会以它为终点</Text>
              </Space>
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Space wrap>
                  <Tag color="blue" style={{ fontSize: 13, padding: '4px 10px' }}>{phase.name}</Tag>
                  <Tag color="orange">距国考 {phase.days_left} 天</Tag>
                  <Tag color="geekblue">本阶段还剩 {phase.phase_days_left} 天</Tag>
                  <Tag>{phase.phase_start} ~ {phase.phase_end}</Tag>
                </Space>
                {phase.focus && <Text style={{ color: '#666' }}>{phase.focus}</Text>}
                <Steps
                  size="small"
                  current={phase.name === '基础阶段' ? 0 : phase.name === '强化阶段' ? 1 : phase.name === '冲刺阶段' ? 2 : 3}
                  items={[{ title: '基础阶段' }, { title: '强化阶段' }, { title: '冲刺阶段' }, { title: '考试' }]}
                  style={{ marginTop: 4 }}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  关键节点：{phase.milestones.map(m => `${m.date} ${m.label}`).join(' ｜ ')}
                </Text>
              </Space>
              </details>
            </Card>
          )}
          {plan.ai_adjusted && (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 16 }}
              message={<Text strong>今天的安排已调整</Text>}
              description={plan.adjustment_reason || '昨天有任务未完成，AI 已调整任务量和顺序。'}
            />
          )}
          {plan.status === 'completed' && (
            <Alert type="success" showIcon style={{ marginBottom: 16 }} message="今天的安排已完成，不需要再追加任务。" />
          )}

          <Card
            className="plan-tasks-card"
            title={
              <Space>
                <Text strong>今天要完成的事</Text>
                <Tag color="blue">{doneCount}/{totalTasks} 已完成</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>剩余约 {totalMinutes - completedMinutes} 分钟</Text>
              </Space>
            }
          >
            <div className="plan-correction">
              <Text strong>今天有什么变化？</Text>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={2000} value={planCorrection} onChange={e => setPlanCorrection(e.target.value)} disabled={regenerating}
                style={{ marginTop: 8, marginBottom: 8 }} placeholder="例如：今天很累，只复盘，不做新题。或：今天只做行测，申论另一天。" />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>不用填表；默认套题分天、复盘优先，已完成任务不会被重置。</Text>
                <Button type="primary" icon={<AiSparkOutlined />} loading={regenerating} onClick={regenerate}>调整今天</Button>
              </div>
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>完成进度按计划时长估算，不是实际学习用时</Text>
            <Progress percent={percent} status={percent === 100 ? 'success' : 'active'} style={{ marginBottom: 16 }} />
            {plan.tasks.length === 0 && <Alert type="info" showIcon message="今天不再安排任务，好好休息。" />}
            <List
              itemLayout="horizontal"
              dataSource={plan.tasks}
              renderItem={(task, idx) => (
                <List.Item className={`plan-task${task.done ? ' is-done' : ''}`}>
                  <Space size="middle" align="start" style={{ width: '100%' }}>
                    <Checkbox disabled={regenerating} checked={!!task.done} onChange={e => toggleTask(task, e.target.checked)} style={{ marginTop: 3 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Text strong style={{ textDecoration: task.done ? 'line-through' : 'none', color: task.done ? '#999' : undefined }}>
                          {idx + 1}. {task.title}
                        </Text>
                        <Tag color={MODULE_COLORS[task.module] || 'default'} style={{ margin: 0 }}>{task.module}</Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>约 {task.minutes} 分钟</Text>
                      </div>
                      {task.detail && (
                        <details className="plan-task-detail"><summary>查看任务说明</summary><div>{task.detail}</div></details>
                      )}
                    </div>
                  </Space>
                </List.Item>
              )}
            />
          </Card>

          <Card className="plan-future-card" title={<Space><ScheduleOutlined />接下来一周</Space>}>
            {futureNote && (
              <Alert type="info" showIcon message="AI 对接下来几天的提示" description={futureNote} style={{ marginBottom: 12 }} />
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text strong>未来一周倒排安排（从明天开始）</Text>
              <Button size="small" icon={<AiSparkOutlined />} loading={forwardLoading} onClick={genForward}>
                {forwardPlan ? '重新生成' : '生成'}
              </Button>
            </div>
            {forwardPlan && forwardPlan.days.length > 0 ? (
              <List
                size="small"
                dataSource={forwardPlan.days}
                renderItem={d => (
                  <List.Item style={{ padding: '6px 0' }}>
                    <Space align="start" style={{ width: '100%' }}>
                      <Tag style={{ margin: 0 }}>{d.date}</Tag>
                      <div style={{ flex: 1 }}>
                        <Text strong>{d.title}</Text>
                        {d.detail && <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>{d.detail}</div>}
                      </div>
                    </Space>
                  </List.Item>
                )}
              />
            ) : (
              <Text type="secondary">点击"生成"，AI 会从国考日往前倒排，给出未来 7 天的安排（需要已配置 AI）。</Text>
            )}
            {forwardPlan?.overview && (
              <Alert type="success" showIcon message="安排说明" description={forwardPlan.overview} style={{ marginTop: 12 }} />
            )}
          </Card>


          <Card className="plan-history-card" title="最近 7 天" size="small">
            {history.length === 0 ? (
              <Text type="secondary">还没有历史记录，从今天开始吧。</Text>
            ) : (
              <List
                size="small"
                dataSource={history}
                renderItem={item => (
                  <List.Item style={{ padding: '6px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <Text style={{ minWidth: 74 }}>{item.date}</Text>
                        <Tag color={STATUS_META[item.status]?.color} icon={STATUS_META[item.status]?.icon} style={{ margin: 0, flexShrink: 0 }}>
                          {STATUS_META[item.status]?.text}
                        </Tag>
                        <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{item.tasks_done}/{item.tasks_total} 项</Text>
                        {item.ai_adjusted && <Tag color="geekblue" style={{ margin: 0, flexShrink: 0 }}>AI调整</Tag>}
                      </div>
                      {item.adjustment_reason && (
                        <Tooltip title={item.adjustment_reason}>
                          <Text type="secondary" style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                            {item.adjustment_reason}
                          </Text>
                        </Tooltip>
                      )}
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Card>

        </div>
      )}
    </div>
  )
}
