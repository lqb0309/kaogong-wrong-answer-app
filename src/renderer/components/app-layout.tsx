import { useState, useEffect } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Badge, Tooltip, Tag } from 'antd'
import {
  HomeOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  BarChartOutlined,
  TagsOutlined,
  FileTextOutlined,
  SettingOutlined,
  EditOutlined,
  FireOutlined,
  BookOutlined,
  FilePdfOutlined,
  WifiOutlined
} from '@ant-design/icons'
import logoPng from '@/assets/logo.png'

const { Sider, Content } = Layout

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [streak, setStreak] = useState(0)
  const [pendingCount, setPendingCount] = useState(0)
  const [version, setVersion] = useState('')
  const [online, setOnline] = useState(navigator.onLine)

  const selectedKey = '/' + location.pathname.split('/')[1]

  useEffect(() => {
    window.api.getStreak().then(r => setStreak(r.streak))
    window.api.getPendingCount().then(setPendingCount)
    window.api.getAppVersion().then(setVersion).catch(() => {})
  }, [])

  // 路由切换时刷新待确认角标
  useEffect(() => {
    window.api.getPendingCount().then(setPendingCount).catch(() => {})
  }, [location.pathname])

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
    key: '/pending', icon: <ClockCircleOutlined />,
    label: (
      <Badge count={pendingCount} size="small" offset={[8, 0]}>
        <span>待确认</span>
      </Badge>
    )
  }

  const menuItems = [
    {
      type: 'group' as const,
      label: '核心流程',
      children: [
        { key: '/', icon: <HomeOutlined />, label: '成品库' },
        pendingItem,
        { key: '/questions', icon: <DatabaseOutlined />, label: '错题库' },
        { key: '/manual', icon: <EditOutlined />, label: '手动入库' }
      ]
    },
    {
      type: 'group' as const,
      label: '学习分析',
      children: [
        { key: '/stats', icon: <BarChartOutlined />, label: '统计看板' },
        { key: '/knowledge', icon: <BookOutlined />, label: '知识归纳' },
        { key: '/test-builder', icon: <FilePdfOutlined />, label: '组卷导出' }
      ]
    },
    {
      type: 'group' as const,
      label: '系统管理',
      children: [
        { key: '/tags', icon: <TagsOutlined />, label: '标签管理' },
        { key: '/logs', icon: <FileTextOutlined />, label: '日志' },
        { key: '/settings', icon: <SettingOutlined />, label: '设置' }
      ]
    }
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        width={208}
        style={{ borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{
          minHeight: 56,
          margin: '14px 16px 10px',
          display: 'flex',
          flexDirection: collapsed ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8
        }}>
          <img src={logoPng} style={{
            width: collapsed ? 30 : 38,
            height: collapsed ? 30 : 38,
            borderRadius: 10,
            objectFit: 'cover',
            boxShadow: '0 2px 6px rgba(22,119,255,0.25)'
          }} alt="logo" />
          <span style={{
            fontWeight: 700,
            fontSize: collapsed ? 11 : 15,
            color: '#1677ff',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            letterSpacing: 0.5
          }}>
            {collapsed ? '小乖' : '小乖的考公错题屋'}
          </span>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ borderRight: 0 }}
          />
        </div>
        {!collapsed && (
          <div style={{
            padding: '10px 16px',
            borderTop: '1px solid #f0f0f0',
            fontSize: 11,
            color: '#bbb',
            textAlign: 'center',
            userSelect: 'none'
          }}>
            v{version || '0.1.0'} · 考公错题管理
          </div>
        )}
      </Sider>
      <Layout>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 24px', background: '#fff', borderBottom: '1px solid #f0f0f0',
          height: 44
        }}>
          <div style={{ fontSize: 12, color: '#999', display: 'flex', alignItems: 'center', gap: 8 }}>
            {location.pathname === '/' ? '上传 → AI 分类 → 人工确认 → 知识库' : ''}
            {!online && (
              <Tag color="red" style={{ margin: 0 }}>
                <WifiOutlined /> 离线模式
              </Tag>
            )}
          </div>
          <Tooltip title={`连续打开 ${streak} 天`}>
            <span style={{ fontSize: 12, color: '#fa8c16' }}>
              <FireOutlined /> 已坚持 <b>{streak}</b> 天
            </span>
          </Tooltip>
        </div>
        <Content style={{ padding: 24, background: '#f5f7fa', overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
