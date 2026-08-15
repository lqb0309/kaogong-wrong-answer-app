import { useEffect, useState, useCallback } from 'react'
import { Typography, Table, Select, Input, Space, Tag, Button, Modal, Tooltip, Switch, App } from 'antd'
import { SearchOutlined, ExportOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { PageHeader } from '@/components/page-header'

interface LogEntry {
  id: number
  timestamp: string
  level: string
  module: string
  event: string
  message: string
  detail: string | null
  trace_id: string | null
  resolved: number
}

const levelColors: Record<string, string> = {
  DEBUG: 'default',
  INFO: 'blue',
  WARN: 'orange',
  ERROR: 'red',
  FATAL: '#8b0000'
}

const moduleLabels: Record<string, string> = {
  upload: '上传',
  ai: 'AI',
  confirm: '确认',
  obsidian: 'Obsidian',
  tag: '标签',
  system: '系统'
}

export function LogViewerPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [level, setLevel] = useState<string | undefined>('WARN')
  const [module, setModule] = useState<string | undefined>(undefined)
  const [onlyUnresolved, setOnlyUnresolved] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null)
  const [traceLogs, setTraceLogs] = useState<LogEntry[]>([])
  const [traceVisible, setTraceVisible] = useState(false)
  const { message } = App.useApp()

  const fetchLogs = useCallback(async (p?: number) => {
    setLoading(true)
    try {
      const params: any = { page: p || page, pageSize: 50, level }
      if (module) params.module = module
      if (onlyUnresolved) params.resolved = 0
      if (search.trim()) params.search = search.trim()
      const result = await window.api.getLogs(params)
      setLogs(result.items)
      setTotal(result.total)
    } catch { /* ignore */ }
    setLoading(false)
  }, [page, level, module, onlyUnresolved, search])

  useEffect(() => { fetchLogs() }, [])

  const handleResolve = async (id: number) => {
    await window.api.markLogResolved(id)
    setLogs((prev) => prev.map((l) => (l.id === id ? { ...l, resolved: 1 } : l)))
  }

  const handleViewTrace = async (traceId: string) => {
    const items = await window.api.getLogTrace(traceId)
    setTraceLogs(items)
    setTraceVisible(true)
  }

  const handleExport = async () => {
    const content = await window.api.exportLogs()
    await window.api.saveFile(`错误日志-${new Date().toISOString().slice(0, 10)}.log`, content)
    message.success('日志已导出')
  }

  const handleClean = async () => {
    Modal.confirm({
      title: '确认清理日志',
      content: '将删除 7 天前的所有日志记录，此操作不可撤销。',
      okText: '确认清理',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.api.cleanLogs(7)
        message.success('日志已清理')
        fetchLogs(1)
      }
    })
  }

  const columns: ColumnsType<LogEntry> = [
    {
      title: '时间', dataIndex: 'timestamp', width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss')
    },
    {
      title: '级别', dataIndex: 'level', width: 80,
      render: (v: string) => <Tag color={levelColors[v] || 'default'}>{v}</Tag>
    },
    {
      title: '模块', dataIndex: 'module', width: 90,
      render: (v: string) => moduleLabels[v] || v
    },
    {
      title: '消息', dataIndex: 'message', ellipsis: true,
      render: (v: string, r: LogEntry) => (
        <Tooltip title={v}>
          <span style={{ cursor: 'pointer' }} onClick={() => setSelectedLog(r)}>{v}</span>
        </Tooltip>
      )
    },
    {
      title: 'Trace ID', dataIndex: 'trace_id', width: 130,
      render: (v: string | null) =>
        v ? <a onClick={() => handleViewTrace(v!)} style={{ cursor: 'pointer' }}>{v}</a> : '-'
    },
    {
      title: '状态', dataIndex: 'resolved', width: 70,
      render: (v: number, r: LogEntry) =>
        v === 0 && (r.level === 'ERROR' || r.level === 'FATAL')
          ? <Tag color="error">未解决</Tag>
          : v === 1 ? <Tag>已解决</Tag> : <span>-</span>
    },
    {
      title: '操作', width: 80,
      render: (_: any, r: LogEntry) =>
        r.resolved === 0 && (r.level === 'ERROR' || r.level === 'FATAL') ? (
          <Button size="small" type="link" onClick={() => handleResolve(r.id)}>标记解决</Button>
        ) : null
    }
  ]

  return (
    <div>
      <PageHeader
        title="错误日志"
        subtitle="trace_id 链路追踪 · 支持筛选与导出"
        extra={
          <Space>
            <Button icon={<ExportOutlined />} onClick={handleExport}>导出日志</Button>
            <Button icon={<DeleteOutlined />} onClick={handleClean}>清理日志</Button>
            <Button icon={<ReloadOutlined />} onClick={() => fetchLogs(1)}>刷新</Button>
          </Space>
        }
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          value={level} onChange={(v) => { setLevel(v); setPage(1) }}
          style={{ width: 130 }} allowClear placeholder="全部级别"
          options={[
            { value: 'DEBUG', label: 'DEBUG' },
            { value: 'INFO', label: 'INFO' },
            { value: 'WARN', label: 'WARN' },
            { value: 'ERROR', label: 'ERROR' },
            { value: 'FATAL', label: 'FATAL' }
          ]}
        />
        <Select
          value={module} onChange={(v) => { setModule(v); setPage(1) }}
          style={{ width: 130 }} allowClear placeholder="全部模块"
          options={Object.entries(moduleLabels).map(([value, label]) => ({ value, label }))}
        />
        <Space>
          <Switch checked={onlyUnresolved} onChange={(v) => { setOnlyUnresolved(v); setPage(1) }} size="small" />
          <span style={{ fontSize: 13 }}>仅未解决</span>
        </Space>
        <Input.Search
          placeholder="搜索日志..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={() => { setPage(1); fetchLogs(1) }}
          style={{ width: 240 }}
          allowClear
        />
      </Space>

      <Table
        dataSource={logs}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{
          current: page,
          pageSize: 50,
          total,
          onChange: (p) => { setPage(p); fetchLogs(p) },
          showTotal: (t) => `共 ${t} 条`
        }}
        onRow={(r) => ({ onClick: () => setSelectedLog(r), style: { cursor: 'pointer' } })}
      />

      {/* Detail Modal */}
      <Modal
        title="日志详情"
        open={!!selectedLog}
        onCancel={() => setSelectedLog(null)}
        footer={selectedLog?.trace_id
          ? <Button onClick={() => { handleViewTrace(selectedLog.trace_id!); setSelectedLog(null) }}>查看完整链路</Button>
          : null}
        width={640}
      >
        {selectedLog && (
          <div style={{ fontSize: 13 }}>
            <p><strong>时间：</strong>{selectedLog.timestamp}</p>
            <p><strong>级别：</strong><Tag color={levelColors[selectedLog.level]}>{selectedLog.level}</Tag></p>
            <p><strong>模块：</strong>{moduleLabels[selectedLog.module] || selectedLog.module}</p>
            <p><strong>事件：</strong>{selectedLog.event}</p>
            <p><strong>消息：</strong>{selectedLog.message}</p>
            {selectedLog.trace_id && <p><strong>Trace ID：</strong>{selectedLog.trace_id}</p>}
            {selectedLog.detail && (
              <div>
                <strong>详细信息：</strong>
                <pre style={{
                  background: '#f5f5f5',
                  padding: 8,
                  borderRadius: 4,
                  maxHeight: 300,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  marginTop: 4
                }}>
                  {(() => { try { return JSON.stringify(JSON.parse(selectedLog.detail!), null, 2) } catch { return selectedLog.detail } })()}
                </pre>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Trace Modal */}
      <Modal
        title="链路追踪"
        open={traceVisible}
        onCancel={() => setTraceVisible(false)}
        footer={null}
        width={720}
      >
        <Table
          dataSource={traceLogs}
          columns={[
            { title: '时间', dataIndex: 'timestamp', width: 160, render: (v: string) => dayjs(v).format('HH:mm:ss') },
            { title: '级别', dataIndex: 'level', width: 70, render: (v: string) => <Tag color={levelColors[v]}>{v}</Tag> },
            { title: '模块', dataIndex: 'module', width: 80, render: (v: string) => moduleLabels[v] || v },
            { title: '事件', dataIndex: 'event' },
            { title: '消息', dataIndex: 'message', ellipsis: true }
          ]}
          rowKey="id"
          size="small"
          pagination={false}
        />
      </Modal>
    </div>
  )
}
