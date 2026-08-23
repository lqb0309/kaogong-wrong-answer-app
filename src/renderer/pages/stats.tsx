import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Typography, Card, Row, Col, Statistic, Table, Tag, Select, Space, Button, App, Spin, Progress, Empty, Segmented, DatePicker } from 'antd'
import {
  FileTextOutlined, CalendarOutlined, ReloadOutlined,
  BulbOutlined, WarningOutlined, PlusCircleOutlined
} from '@ant-design/icons'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, AreaChart, Area,
  PieChart, Pie, Cell, Treemap, Legend
} from 'recharts'
import dayjs from 'dayjs'
import { useSettingsStore } from '@/stores/settings'
import { PageHeader } from '@/components/page-header'

const COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2', '#f5222d', '#faad14']
const CHART_COLORS = ['#1677ff', '#fa8c16', '#52c41a', '#722ed1']
const { Text } = Typography

interface StatsData {
  total: number; dailyAvg: number; todayCount: number
  recent7: number; prev7: number; recent30: number; prev30: number
  byLevel1: any[]; byLevel2: any[]; byLevel3: any[]
  dailyStats: any[]; weeklyStats: any[]; monthlyStats: any[]
  topErrors: any[]; errorDist: any[]; errorTypeDist: any[]; confidenceDist: any
  reviewedThisWeek: number; dueReviewCount: number; reviewWrongRate: number
  latestAttempt: { accuracy: number; created_at: string } | null
  reviewDaily: Array<{ date: string; cnt: number }>
  weaknessPoints: Array<{ level1: string; level2: string; question_count: number; total_errors: number; repeated_count: number; last_error_at: string }>
}

export function StatsPage() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [timeRange, setTimeRange] = useState<number | 'custom'>(30)
  const [customRange, setCustomRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null)
  const [level1Filter, setLevel1Filter] = useState<string | undefined>()
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [suggestionLoading, setSuggestionLoading] = useState(false)
  const [chartMode, setChartMode] = useState<string>('line')
  const [drillLevel1, setDrillLevel1] = useState<string | undefined>()
  const { get: getSetting } = useSettingsStore()
  const { message } = App.useApp()

  const fetchStats = useCallback(async () => {
    setLoading(true)
    try {
      const data = await window.api.getStats()
      setStats(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])

  const handleAskAi = async () => {
    if (!stats) return
    setSuggestionLoading(true)
    setSuggestion(null)
    try {
      const result = await window.api.getAiSuggestion(stats)
      if (result.success && result.suggestion) {
        setSuggestion(result.suggestion)
      } else {
        message.error(result.error || 'AI 分析失败')
      }
    } catch (err: any) {
      message.error(`AI 分析失败: ${err.message}`)
    }
    setSuggestionLoading(false)
  }

  if (!stats) {
    return (
      <div>
        <PageHeader title="统计看板" subtitle="错题分布、趋势与薄弱点分析" />
        <Card><Empty description="暂无数据，请先上传并确认错题" /></Card>
      </div>
    )
  }

  const threshold = Number(getSetting('weakness_threshold', '5'))

  // --- Derived chart data ---
  const reviewByDay = new Map((stats.reviewDaily || []).map((item: any) => [item.date, item.cnt]))
  const dailyData = (stats.dailyStats || [])
    .filter((d: any) => {
      const days = (Date.now() - new Date(d.day).getTime()) / (1000 * 86400)
      if (timeRange === 'custom') {
        if (!customRange) return true
        const t = new Date(d.day).getTime()
        return t >= customRange[0].startOf('day').valueOf() && t <= customRange[1].endOf('day').valueOf()
      }
      return days <= timeRange
    })
    .map((d: any) => ({ day: d.day?.slice(5), count: d.cnt, review: reviewByDay.get(d.day) || 0 }))

  // Moving average (3-day)
  const dailyWithMA = dailyData.map((d: any, i: number, arr: any[]) => {
    const window = arr.slice(Math.max(0, i - 2), i + 1)
    const ma = Math.round(window.reduce((s: number, x: any) => s + x.count, 0) / window.length * 10) / 10
    return { ...d, ma }
  })

  const weekData = (stats.weeklyStats || [])
    .slice()
    .reverse()
    .map((w: any) => ({ week: w.week?.replace('W', 'W'), count: w.cnt }))

  const pieData = (stats.byLevel1 || []).map((l: any) => ({ name: l.level1, value: l.cnt }))

  const barData = (stats.byLevel1 || []).map((l: any) => ({
    name: l.level1,
    count: l.cnt,
    pct: l.pct
  }))

  const errDistData = (stats.errorDist || []).map((e: any) => ({
    name: `${e.err_level}次`,
    count: e.cnt
  }))

  const confidenceData = stats.confidenceDist
    ? [
        { name: '低 (<60%)', value: stats.confidenceDist.low, color: '#ff4d4f' },
        { name: '中 (60-80%)', value: stats.confidenceDist.mid, color: '#faad14' },
        { name: '高 (>80%)', value: stats.confidenceDist.high, color: '#52c41a' }
      ]
    : []

  const treemapData = [{
    name: '二级分类',
    children: (stats.byLevel2 || []).slice(0, 30).map((item: any) => ({
      name: `${item.level1}/${item.level2}`,
      size: item.cnt,
      avgErr: Math.round(item.avg_err * 10) / 10
    }))
  }]

  // --- Drill-down data ---
  const activeDrillL1 = drillLevel1 || stats.byLevel1?.[0]?.level1 || ''
  const drillL2 = (stats.byLevel2 || []).filter((d: any) => d.level1 === activeDrillL1)
  const drillL3 = (stats.byLevel3 || []).filter((d: any) => d.level1 === activeDrillL1)
  const drillL3Grouped: Record<string, any[]> = {}
  for (const d of drillL3) {
    if (!drillL3Grouped[d.level2]) drillL3Grouped[d.level2] = []
    drillL3Grouped[d.level2].push(d)
  }

  const weaknessColumns = [
    { title: '知识点', key: 'point', render: (_: any, r: any) => <span>{r.level1} / {r.level2 || '未细分'}</span> },
    { title: '错题', dataIndex: 'question_count', width: 64 },
    { title: '累计错误', dataIndex: 'total_errors', width: 82, render: (v: number) => <Text strong style={{ color: v >= threshold ? '#ff4d4f' : '#fa8c16' }}>{v}</Text> },
    { title: '重复出错', dataIndex: 'repeated_count', width: 82 },
    { title: '状态', width: 80, render: (_: any, r: any) => <Tag color={r.total_errors >= threshold * 2 ? 'red' : r.total_errors >= threshold ? 'orange' : 'blue'}>{r.total_errors >= threshold * 2 ? '薄弱' : r.total_errors >= threshold ? '待巩固' : '新发现'}</Tag> },
    { title: '操作', width: 82, render: (_: any, r: any) => <Button size="small" type="link" onClick={() => navigate(`/test-builder?level1=${encodeURIComponent(r.level1)}&level2=${encodeURIComponent(r.level2 || '')}`)}>专项组卷</Button> }
  ]

  return (
    <div className="stats-dashboard">
      <PageHeader
        title="统计看板"
        subtitle="错题分布、趋势与薄弱点分析"
        extra={
          <Space wrap>
            <Button icon={<BulbOutlined />} type="primary"
              onClick={handleAskAi} loading={suggestionLoading}>
              AI 分析建议
            </Button>
            <Button icon={<ReloadOutlined />} onClick={fetchStats} loading={loading}>刷新</Button>
          </Space>
        }
      />

      {/* AI Suggestion Panel */}
      {suggestion && (
        <Card
          style={{ marginBottom: 16, border: '1px solid #91caff', background: '#e6f4ff' }}
          extra={
            <Button size="small" type="link" onClick={() => setSuggestion(null)}>收起</Button>
          }
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <BulbOutlined style={{ color: '#1677ff', fontSize: 18, marginTop: 2 }} />
            <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
              {suggestion}
            </Typography.Paragraph>
          </div>
        </Card>
      )}

      {/* Core learning indicators */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} lg={6}>
          <Card size="small" className="stats-metric-card">
            <Statistic title="总错题数" value={stats.total} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card size="small" className="stats-metric-card">
            <Statistic title="本周新增" value={stats.recent7} prefix={<PlusCircleOutlined />} suffix="题" />
            <Text type="secondary">衡量学习投入，不判定好坏</Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card size="small" className="stats-metric-card">
            <Statistic title="本周已复习" value={stats.reviewedThisWeek || 0} prefix={<CalendarOutlined />} suffix="个" valueStyle={{ color: '#52c41a' }} />
            <Text type="secondary">按知识卡片去重</Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card size="small" className="stats-metric-card">
            <Statistic title="待巩固知识点" value={(stats.weaknessPoints || []).filter(p => p.total_errors >= threshold).length} prefix={<WarningOutlined />} suffix="个" valueStyle={{ color: '#ff4d4f' }} />
            <Text type="secondary">累计错误达到 {threshold} 次</Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} md={8}><Card size="small"><Statistic title="到期未复习" value={stats.dueReviewCount || 0} suffix="个" valueStyle={{ color: stats.dueReviewCount ? '#fa8c16' : '#52c41a' }} /></Card></Col>
        <Col xs={24} md={8}><Card size="small"><Statistic title="近 30 天复习再错率" value={stats.reviewWrongRate || 0} suffix="%" valueStyle={{ color: stats.reviewWrongRate > 30 ? '#ff4d4f' : '#52c41a' }} /></Card></Col>
        <Col xs={24} md={8}><Card size="small"><Statistic title="最近组卷正确率" value={stats.latestAttempt ? Math.round(stats.latestAttempt.accuracy * 100) : 0} suffix="%" /><Text type="secondary">{stats.latestAttempt ? stats.latestAttempt.created_at?.slice(0, 10) : '暂无组卷记录'}</Text></Card></Col>
      </Row>

      {/* Chart Row 1: Trend + Distribution */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} xl={14}>
          <Card
            title="错题趋势"
            size="small" className="stats-chart-card"
            extra={
              <Space size={4} wrap>
                <Segmented size="small" value={chartMode} onChange={setChartMode}
                  options={[{ value: 'line', label: '日' }, { value: 'week', label: '周' }]} />
                {chartMode === 'line' && (
                  <>
                    <Select size="small" value={timeRange} onChange={(v) => { setTimeRange(v); if (v !== 'custom') setCustomRange(null) }} style={{ width: 84 }}
                      options={[{ value: 7, label: '7天' }, { value: 30, label: '30天' }, { value: 90, label: '90天' }, { value: 'custom', label: '自定义' }]} />
                    {timeRange === 'custom' && (
                      <DatePicker.RangePicker
                        size="small"
                        allowClear={false}
                        value={customRange}
                        onChange={(v) => setCustomRange(v as [dayjs.Dayjs, dayjs.Dayjs] | null)}
                        style={{ width: 220 }}
                      />
                    )}
                  </>
                )}
              </Space>
            }
          >
            <ResponsiveContainer width="100%" height={260}>
              {chartMode === 'line' ? (
                <AreaChart data={dailyWithMA}>
                  <defs>
                    <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1677ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#1677ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" fontSize={10} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} fontSize={10} />
                  <Tooltip />
                  <Area type="monotone" dataKey="count" stroke="#1677ff" fill="url(#colorCount)" strokeWidth={2} name="新增错题" />
                  <Line type="monotone" dataKey="review" stroke="#52c41a" strokeWidth={2} dot={false} name="完成复习" />
                </AreaChart>
              ) : (
                <BarChart data={weekData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="week" fontSize={10} />
                  <YAxis allowDecimals={false} fontSize={10} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#1677ff" radius={[4, 4, 0, 0]} name="入库数" />
                </BarChart>
              )}
            </ResponsiveContainer>
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card title="一级分类占比" size="small" className="stats-chart-card">
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%" cy="50%"
                  innerRadius={48} outerRadius={78}
                  paddingAngle={3} dataKey="value"
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: any, name: any) => [`${value} 题`, name]} />
                <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>

      {/* Row 2: Bar chart + Error distribution + Confidence + Error type */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} md={12} xl={6}>
          <Card title="各分类错题数" size="small" className="stats-chart-card">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData} layout="vertical" margin={{ left: 4, right: 8 }}>
                <XAxis type="number" fontSize={10} />
                <YAxis type="category" dataKey="name" width={70} fontSize={10} />
                <Tooltip formatter={(v: any) => [`${v} 题`, '数量']} />
                <Bar dataKey="count" fill="#1677ff" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card title="错误次数分布" size="small" className="stats-chart-card">
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={errDistData}
                  cx="50%" cy="50%"
                  innerRadius={30} outerRadius={70}
                  paddingAngle={4} dataKey="count"
                >
                  {errDistData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card title="置信度分布" size="small" className="stats-chart-card">
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={confidenceData}
                  cx="50%" cy="50%"
                  innerRadius={30} outerRadius={70}
                  paddingAngle={4} dataKey="value"
                >
                  {confidenceData.map((d, i) => (
                    <Cell key={i} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card title="错误类型分布" size="small" className="stats-chart-card">
            {(stats.errorTypeDist || []).length === 0 ? (
              <Empty description="暂无错误类型数据" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={stats.errorTypeDist} layout="vertical" margin={{ left: 0 }}>
                  <XAxis type="number" fontSize={10} />
                  <YAxis type="category" dataKey="error_type" width={80} fontSize={10} />
                  <Tooltip formatter={(v: any) => [`${v} 题`, '数量']} />
                  <Bar dataKey="cnt" fill="#fa8c16" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>
      </Row>

      {/* Row 3: Drill-down by classification */}
      <Card
        title="分类下钻"
        size="small"
        style={{ marginBottom: 12 }}
        extra={
          <Select size="small" value={activeDrillL1} onChange={setDrillLevel1} style={{ width: 130 }}
            options={(stats.byLevel1 || []).map((l: any) => ({ value: l.level1, label: `${l.level1} (${l.cnt})` }))} />
        }
      >
        <Row gutter={[20, 16]}>
          <Col xs={24} xl={10}>
            <Typography.Text strong style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>二级分类分布</Typography.Text>
            {drillL2.length === 0 ? (
              <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={drillL2} layout="vertical" margin={{ left: 0 }}>
                  <XAxis type="number" fontSize={10} />
                  <YAxis type="category" dataKey="level2" width={80} fontSize={10} />
                  <Tooltip formatter={(v: any, _n: any, props: any) => [`${v} 题`, props.payload.level2]} />
                  <Bar dataKey="cnt" radius={[0, 4, 4, 0]}>
                    {drillL2.map((d: any) => (
                      <Cell key={d.level2} fill={d.cnt >= 8 ? '#ff4d4f' : d.cnt >= 4 ? '#fa8c16' : '#1677ff'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Col>
          <Col xs={24} xl={14}>
            <Typography.Text strong style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>三级考点明细</Typography.Text>
            {drillL3.length === 0 ? (
              <Empty description="暂无三级分类数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <div style={{ maxHeight: 280, overflow: 'auto' }}>
                {Object.entries(drillL3Grouped).map(([level2, items]) => (
                  <div key={level2} style={{ marginBottom: 12 }}>
                    <Typography.Text strong style={{ fontSize: 12, color: '#555' }}>{level2} ({items.reduce((s, i) => s + i.cnt, 0)}题)</Typography.Text>
                    <Table
                      dataSource={items.sort((a, b) => b.cnt - a.cnt)}
                      rowKey="level3"
                      size="small"
                      pagination={false}
                      showHeader={false}
                      columns={[
                        { dataIndex: 'level3', width: 120, render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span> },
                        {
                          width: 130,
                          render: (_: any, r: any) => {
                            const maxCnt = Math.max(...items.map(i => i.cnt), 1)
                            const pct = Math.round((r.cnt / maxCnt) * 100)
                            return (
                              <Space size={4}>
                                <Progress percent={pct} size="small" style={{ width: 70, margin: 0 }} strokeWidth={6}
                                  strokeColor={r.cnt >= 4 ? '#ff4d4f' : r.cnt >= 2 ? '#fa8c16' : '#1677ff'}
                                  showInfo={false} />
                                <span style={{ fontSize: 11, fontWeight: 500, color: r.cnt >= 4 ? '#ff4d4f' : '#888' }}>{r.cnt}题</span>
                              </Space>
                            )
                          }
                        }
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </Col>
        </Row>
      </Card>

      {/* Row 4: Treemap + Weakness Table */}
      <Row gutter={[12, 12]}>
        <Col xs={24} xl={10}>
          <Card title="二级题型分布" size="small" className="stats-chart-card">
            <ResponsiveContainer width="100%" height={300}>
              <Treemap data={treemapData} dataKey="size" aspectRatio={4 / 3} stroke="#fff" fill="#1677ff">
                <Tooltip formatter={(v: any, _name: any, props: any) => [`${v} 题`, props.payload.name]} />
              </Treemap>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            title="薄弱知识点"
            size="small"
            extra={
              <Space size={4}>
                <Select
                  size="small" allowClear placeholder="一级分类" style={{ width: 100 }}
                  value={level1Filter} onChange={setLevel1Filter}
                  options={(stats.byLevel1 || []).map((l: any) => ({ value: l.level1, label: l.level1 }))}
                />
              </Space>
            }
          >
            <Table
              dataSource={(stats.weaknessPoints || []).filter((e: any) => !level1Filter || e.level1 === level1Filter)}
              columns={weaknessColumns}
              rowKey={(r: any) => `${r.level1}/${r.level2}`}
              size="small"
              pagination={false}
              scroll={{ x: 520, y: 260 }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
