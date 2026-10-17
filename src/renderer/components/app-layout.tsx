import { useState, useEffect } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Badge, Tooltip, Tag, App, Button } from 'antd'
import { FireOutlined, WifiOutlined } from '@ant-design/icons'
import { HomeOutlined, ReviewInboxOutlined, LogOutlined, DatabaseOutlined, BarChartOutlined, TagsOutlined, SettingOutlined, BookOutlined, FilePdfOutlined, ScheduleOutlined, TimerOutlined } from '@/components/study-icons'
import logoPng from '@/assets/logo.png'
import { AnalysisTasks } from '@/components/analysis-tasks'

const { Sider, Content } = Layout

export function AppLayout() {
  const { notification } = App.useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [streak, setStreak] = useState(0)
  const [pendingCount, setPendingCount] = useState(0)
  const [version, setVersion] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [fenbiProgress, setFenbiProgress] = useState<{ total: number; done: number } | null>(null)

  const selectedKey = '/' + location.pathname.split('/')[1]

  // 打开应用默认进入"每日计划"页：一打开就知道今天要干什么
  useEffect(() => {
    if (location.pathname === '/') {
      navigate('/plan', { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    window.api.getStreak().then(r => setStreak(r.streak)).catch(() => {})
    window.api.getPendingCount().then(setPendingCount).catch(() => {})
    window.api.getAppVersion().then(setVersion).catch(() => {})
  }, [])

  // 路由切换时刷新待确认角标
  useEffect(() => {
    window.api.getPendingCount().then(setPendingCount).catch(() => {})
  }, [location.pathname])

  useEffect(() => {
    if (typeof window.api.onFenbiAnalysisProgress !== 'function') {
      notification.warning({ key: 'preload-update', message: '应用接口已更新，请关闭并重新启动当前应用', description: '前端刷新无法更新后台接口。现有数据不会丢失。', duration: 0 })
      return
    }
    return window.api.onFenbiAnalysisProgress(event => {
    if (event.stage === 'paused') {
      setFenbiProgress(null)
      notification.info({ key: 'fenbi-analysis', message: '后台分析已暂停', description: event.message, duration: 4 })
    } else if (event.stage === 'complete') {
      setFenbiProgress(null)
      window.api.getPendingCount().then(setPendingCount).catch(() => {})
      notification.success({
        key: 'fenbi-analysis',
        message: '粉笔错题分析完成',
        description: event.message,
        duration: 0,
        btn: <Button type="primary" size="small" onClick={() => { notification.destroy('fenbi-analysis'); navigate('/pending') }}>去待确认</Button>
      })
    } else if (event.stage === 'started') {
      setFenbiProgress({ total: event.total, done: event.done })
      notification.info({ key: 'fenbi-analysis', message: '粉笔题已保存', description: event.message, duration: 4 })
    } else {
      setFenbiProgress({ total: event.total, done: event.done })
    }
    })
  }, [navigate, notification])

  // 网络状态监听（PRD 埋点：网络连通性变化）
  useEffect(() => {
    const goOnline = () => { setOnline(true); window.api.reportNetworkChange?.('online').catch(() => {}) }
    const goOffline = () => { setOnline(false); window.api.reportNetworkChange?.('offline').catch(() => {}) }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const pendingItem = {
    key: '/pending', icon: <ReviewInboxOutlined />,
    label: (
      <Badge count={pendingCount} size="small" offset={[8, 0]}>
        <span>待确认</span>
      </Badge>
    )
  }

  const menuItems = [
    {
      type: 'group' as const,
      label: '日常学习',
      children: [
        { key: '/plan', icon: <ScheduleOutlined />, label: '每日计划' },
        { key: '/', icon: <HomeOutlined />, label: '错题处理' },
        pendingItem,
        { key: '/questions', icon: <DatabaseOutlined />, label: '错题库' }
      ]
    },
    {
      type: 'group' as const,
      label: '复习与训练',
      children: [
        { key: '/speed-training', icon: <TimerOutlined />, label: '速度训练' },
        { key: '/stats', icon: <BarChartOutlined />, label: '统计看板' },
        { key: '/knowledge', icon: <BookOutlined />, label: '知识归纳' },
        { key: '/test-builder', icon: <FilePdfOutlined />, label: '复习与导出' }
      ]
    },
    {
      type: 'group' as const,
      label: '工具',
      children: [
        { key: '/tags', icon: <TagsOutlined />, label: '标签管理' },
        { key: '/logs', icon: <LogOutlined />, label: '日志' },
        { key: '/settings', icon: <SettingOutlined />, label: '设置' }
      ]
    }
  ]

  const currentPage = menuItems.flatMap(group => group.children).find(item => item.key === selectedKey)
  const currentTitle = selectedKey === '/pending' ? '待确认' : currentPage?.label || '学习工作台'
  const fixedReading = ['/pending', '/speed-training', '/settings', '/questions'].includes(selectedKey)

  return (
    <Layout className="app-shell">
      <Sider
        className="app-sidebar"
        collapsible collapsed={collapsed} onCollapse={setCollapsed}
        theme="light" width={208} collapsedWidth={68}
        breakpoint="lg" onBreakpoint={setCollapsed}
      >
        <div className={`app-brand${collapsed ? ' is-collapsed' : ''}`}>
          <img src={logoPng} alt="小乖" />
          {!collapsed && <div><strong>小乖的考公错题屋</strong><span>读懂错题，留住方法</span></div>}
        </div>
        <nav className="app-navigation" aria-label="主导航">
          <Menu mode="inline" selectedKeys={[selectedKey]} items={menuItems} onClick={({ key }) => navigate(key)} />
        </nav>
        {!collapsed && <div className="app-sidebar-footer"><span>本地学习记录</span><span>v{version || '0.2.2'}</span></div>}
      </Sider>
      <Layout className="app-main">
        <div className="app-topbar">
          <div className="app-location"><span>学习工作台</span><span aria-hidden="true">/</span><strong>{currentTitle}</strong></div>
          <div className="app-status">
            <AnalysisTasks />
            {!online && <Tag color="red"><WifiOutlined /> 离线</Tag>}
            {fenbiProgress && <Tag color="processing">分析中 {fenbiProgress.done}/{fenbiProgress.total}</Tag>}
            <Tooltip title={`连续打开 ${streak} 天`}>
              <span className="app-streak"><FireOutlined /> 已坚持 {streak} 天</span>
            </Tooltip>
          </div>
        </div>
        <Content className={`app-content${fixedReading ? ' app-content-fixed' : ''}`} data-page={selectedKey.slice(1) || 'import'}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
