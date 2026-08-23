import { useState, useEffect, useCallback } from 'react'
import { App, Alert, Button, Card, Checkbox, Input, List, Popconfirm, Progress, Radio, Space, Spin, Steps, Tag, Typography, Tooltip } from 'antd'
import { ReloadOutlined, ThunderboltOutlined, CalendarOutlined, CheckCircleOutlined, ClockCircleOutlined, MinusCircleOutlined, RocketOutlined, ScheduleOutlined, EditOutlined } from '@ant-design/icons'

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
  const [feedbackStatus, setFeedbackStatus] = useState<'pending' | 'partial' | 'completed'>('pending')
  const [feedbackNote, setFeedbackNote] = useState('')
  const [savingFeedback, setSavingFeedback] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [forwardLoading, setForwardLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.getTodayPlan()
      if (res.success && res.plan) {
        setPlan(res.plan)
        setFeedbackStatus(res.plan.status)
        setFeedbackNote(res.plan.note || '')
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

  const saveFeedback = async () => {
    if (!plan) return
    setSavingFeedback(true)
    try {
      const res = await window.api.submitPlanFeedback(plan.date, feedbackStatus, feedbackNote)
      if (res.success && res.plan) {
        setPlan(res.plan)
        message.success('今日反馈已保存，明天的计划会参考它调整')
      }
    } catch (err: any) {
      message.error(`保存失败: ${err.message}`)
    } finally {
      setSavingFeedback(false)
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
      const res = await window.api.regenerateTodayPlan()
      if (res.plan) {
        setPlan(res.plan)
        setFeedbackStatus(res.plan.status)
        setFeedbackNote(res.plan.note || '')
      }
      if (res.success) message.success('AI 已重新调整今天的计划')
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

  const doneCount = plan?.tasks.filter(t => t.done).length || 0
  const totalTasks = plan?.tasks.length || 0
  const percent = totalTasks > 0 ? Math.round(doneCount / totalTasks * 100) : 0

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Title level={4} style={{ margin: 0 }}>
          <CalendarOutlined style={{ marginRight: 8, color: '#1677ff' }} />
          今日计划 · {plan?.date || '加载中'}
        </Title>
        <Space>
          <Tag icon={<RocketOutlined />} color={daysUntil <= 60 ? 'red' : 'orange'} style={{ fontSize: 13, padding: '4px 10px' }}>
            距国考约 {daysUntil} 天（{examDate}）
          </Tag>
          <Tooltip title="刷新">
            <Button size="small" icon={<ReloadOutlined />} onClick={load} />
          </Tooltip>
        </Space>
      </div>

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
        <>
          {phase && (
            <Card style={{ marginBottom: 16 }} title={<Space><RocketOutlined style={{ color: '#fa8c16' }} />倒排计划：从目标日期往前推</Space>}>
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
                {phase.focus && <Text style={{ color: '#666' }}>🎯 {phase.focus}</Text>}
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
            </Card>
          )}
          {plan.ai_adjusted && (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 16 }}
              message={<Text strong>AI 已根据昨天的情况动态调整今天的计划</Text>}
              description={plan.adjustment_reason || '昨天有任务未完成，AI 已调整任务量和顺序。'}
            />
          )}
          {plan.status === 'completed' && (
            <Alert type="success" showIcon style={{ marginBottom: 16 }} message="昨天的计划已全部完成，今天保持节奏继续！" />
          )}

          <Card
            style={{ marginBottom: 16 }}
            title={
              <Space>
                <Text strong>今天要完成的事</Text>
                <Tag color="blue">{doneCount}/{totalTasks} 已完成</Tag>
              </Space>
            }
            extra={<Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} loading={regenerating} onClick={regenerate}>让 AI 重新调整今天</Button>}
          >
            <Progress percent={percent} status={percent === 100 ? 'success' : 'active'} style={{ marginBottom: 16 }} />
            <List
              itemLayout="horizontal"
              dataSource={plan.tasks}
              renderItem={(task, idx) => (
                <List.Item style={{ padding: '10px 4px' }}>
                  <Space size="middle" align="start" style={{ width: '100%' }}>
                    <Checkbox checked={!!task.done} onChange={e => toggleTask(task, e.target.checked)} style={{ marginTop: 3 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Text strong style={{ textDecoration: task.done ? 'line-through' : 'none', color: task.done ? '#999' : undefined }}>
                          {idx + 1}. {task.title}
                        </Text>
                        <Tag color={MODULE_COLORS[task.module] || 'default'} style={{ margin: 0 }}>{task.module}</Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>约 {task.minutes} 分钟</Text>
                      </div>
                      {task.detail && (
                        <div style={{ marginTop: 4, color: '#888', fontSize: 13 }}>{task.detail}</div>
                      )}
                    </div>
                  </Space>
                </List.Item>
              )}
            />
          </Card>

          <Card title={<Space><ScheduleOutlined style={{ color: '#722ed1' }} />未来的安排（AI 每天根据完成情况持续调整）</Space>} style={{ marginBottom: 16 }}>
            {futureNote && (
              <Alert type="info" showIcon message="AI 对接下来几天的提示" description={futureNote} style={{ marginBottom: 12 }} />
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text strong>未来一周倒排安排（从明天开始）</Text>
              <Button size="small" icon={<ThunderboltOutlined />} loading={forwardLoading} onClick={genForward}>
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

          <Card title="今天的完成反馈（明天 AI 会参考它调整计划）" style={{ marginBottom: 16 }}>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Radio.Group value={feedbackStatus} onChange={e => setFeedbackStatus(e.target.value)}>
                <Radio.Button value="completed">全部完成</Radio.Button>
                <Radio.Button value="partial">部分完成</Radio.Button>
                <Radio.Button value="pending">没完成</Radio.Button>
              </Radio.Group>
              <Input.TextArea
                rows={2}
                placeholder="写几句今天的实际情况：哪块卡住了？身体状态如何？明天想优先做什么？（可选）"
                value={feedbackNote}
                onChange={e => setFeedbackNote(e.target.value)}
              />
              <Button type="primary" loading={savingFeedback} onClick={saveFeedback}>保存今日反馈</Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                每天结束时点一下，第二天打开软件，AI 就会根据这个反馈自动调整计划。
              </Text>
            </Space>
          </Card>

          <Card title="最近 7 天记录" size="small">
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

          <div style={{ marginTop: 8 }}>
            <Popconfirm
              title="让 AI 重新调整今天的计划？"
              description="会覆盖当前未勾选的任务内容（已勾选的会保留）。"
              onConfirm={regenerate}
              okText="调整"
              cancelText="取消"
            >
              <Button icon={<ThunderboltOutlined />} style={{ color: '#722ed1', borderColor: '#d3adf7' }}>觉得今天计划不合适？让 AI 再调一次</Button>
            </Popconfirm>
          </div>
        </>
      )}
    </div>
  )
}
