import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Typography, Table, Input, Select, Space, Button, Tag, App, Popconfirm, Image, Modal, Descriptions, Form, InputNumber, Empty, Segmented } from 'antd'
import { SearchOutlined, DeleteOutlined, ReloadOutlined, FileTextOutlined, SyncOutlined, FolderOpenOutlined, EditOutlined, ExportOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { useTagTreeStore } from '@/stores/tag-tree'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { PageHeader } from '@/components/page-header'

interface Question {
  id: string
  image_url: string
  level1: string
  level2: string
  level3: string | null
  confidence: number
  ocr_text?: string
  reasoning?: string
  error_count: number
  created_at: string
  obsidian_path: string | null
  source: string
  reflection?: string
  error_type?: string
}

export function QuestionBankPage() {
  const navigate = useNavigate()
  const [questions, setQuestions] = useState<Question[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [errorTypes, setErrorTypes] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [level1Filter, setLevel1Filter] = useState<string | undefined>()
  const [level2Filter, setLevel2Filter] = useState<string | undefined>()
  const [level3Filter, setLevel3Filter] = useState<string | undefined>()
  const [sortBy, setSortBy] = useState('created_at')
  const [sortOrder, setSortOrder] = useState('desc')
  const [detailItem, setDetailItem] = useState<Question | null>(null)
  const [editingItem, setEditingItem] = useState<Question | null>(null)
  const [editForm] = Form.useForm()
  const [viewMode, setViewMode] = useState<'list' | 'group'>('list')
  const [editSaving, setEditSaving] = useState(false)
  const { message } = App.useApp()
  const { tree, load: loadTree } = useTagTreeStore()

  useEffect(() => { if (!tree.length) loadTree() }, [tree.length, loadTree])
  useEffect(() => { window.api.getErrorTypes().then(setErrorTypes) }, [])

  const level1Options = tree.map((n) => ({ value: n.name, label: n.name }))
  const level2Options = level1Filter
    ? tree.find((n) => n.name === level1Filter)?.children.map((c) => ({ value: c.name, label: c.name })) || []
    : []
  const level3Options = (level1Filter && level2Filter)
    ? tree.find((n) => n.name === level1Filter)?.children.find((c: any) => c.name === level2Filter)?.children.map((c: any) => ({ value: c.name, label: c.name })) || []
    : []

  // Edit form cascading selects
  const editLevel1 = Form.useWatch('level1', editForm)
  const editLevel2 = Form.useWatch('level2', editForm)
  const editLevel1Options = tree.map((n) => ({ value: n.name, label: n.name }))
  const editLevel2Options = editLevel1
    ? tree.find((n) => n.name === editLevel1)?.children.map((c) => ({ value: c.name, label: c.name })) || []
    : []
  const editLevel3Options = (editLevel1 && editLevel2)
    ? tree.find((n) => n.name === editLevel1)?.children.find((c: any) => c.name === editLevel2)?.children.map((c: any) => ({ value: c.name, label: c.name })) || []
    : []

  const fetchQuestions = useCallback(async (p?: number) => {
    setLoading(true)
    try {
      const params: any = {
        page: p || page, pageSize: 30,
        status: 'all', sortBy, sortOrder
      }
      if (level1Filter) params.level1 = level1Filter
      if (level2Filter) params.level2 = level2Filter
      if (level3Filter) params.level3 = level3Filter
      if (search.trim()) params.search = search.trim()
      const result = await window.api.getQuestions(params)
      setQuestions(result.items)
      setTotal(result.total)
    } catch { /* ignore */ }
    setLoading(false)
  }, [page, level1Filter, level2Filter, level3Filter, search, sortBy, sortOrder])

  useEffect(() => { fetchQuestions() }, [])

  // 按知识点（level1 › level2 › level3）分组（学习闭环：知识点聚合视图）
  const knowledgeGroups = useMemo(() => {
    const map = new Map<string, { name: string; level1: string; level2: string; level3: string; questions: Question[] }>()
    for (const q of questions) {
      const l1 = q.level1 || '未分类'
      const l2 = q.level2 || ''
      const l3 = q.level3 || ''
      const key = [l1, l2, l3].filter(Boolean).join(' › ')
      if (!map.has(key)) map.set(key, { name: key, level1: l1, level2: l2, level3: l3, questions: [] })
      map.get(key)!.questions.push(q)
    }
    return Array.from(map.values())
      .map(g => ({ ...g, count: g.questions.length, totalErr: g.questions.reduce((s, q) => s + (q.error_count || 0), 0) }))
      .sort((a, b) => b.totalErr - a.totalErr || b.count - a.count)
  }, [questions])

  const handleDelete = async (id: string) => {
    await window.api.deleteQuestion(id)
    message.success('已删除')
    fetchQuestions(page)
  }

  const handleOpenObsidian = async (relativePath: string | null) => {
    if (!relativePath) { message.info('未找到 Obsidian 文件路径'); return }
    const vaultRoot = ((await window.api.getConfig('obsidian_vault')) || '').replace(/\/+$/, '')
    if (!vaultRoot) { message.warning('请先配置 Obsidian Vault'); return }
    const vaultName = vaultRoot.split('/').pop() || 'vault'
    const encodedFile = encodeURIComponent(relativePath)
    const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedFile}`
    await window.api.openExternal(uri)
  }

  const handleEditOpen = (item: Question) => {
    setEditingItem(item)
    editForm.setFieldsValue({
      level1: item.level1,
      level2: item.level2,
      level3: item.level3 || undefined,
      error_count: item.error_count,
      error_type: item.error_type || undefined,
      source: item.source || '',
      ocr_text: item.ocr_text || '',
      reflection: item.reflection || ''
    })
  }

  const handleEditSave = async (values: any) => {
    if (!editingItem) return
    setEditSaving(true)
    try {
      await window.api.updateQuestion(editingItem.id, {
        level1: values.level1,
        level2: values.level2 || '',
        level3: values.level3 || null,
        error_count: values.error_count,
        error_type: values.error_type || null,
        source: values.source || '',
        ocr_text: values.ocr_text || '',
        reflection: values.reflection || ''
      })
      message.success('已更新')
      setEditingItem(null)
      fetchQuestions(page)
    } catch (err: any) {
      message.error(`更新失败: ${err.message}`)
    }
    setEditSaving(false)
  }

  const columns: ColumnsType<Question> = [
    {
      title: '图片', dataIndex: 'image_url', width: 80,
      render: (v: string) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Image src={v} width={60} style={{ borderRadius: 4, maxHeight: 60, objectFit: 'cover' }} />
        </span>
      ),
    },
    {
      title: '一级分类', dataIndex: 'level1', width: 100,
      render: (v: string) => <Tag>{v}</Tag>
    },
    {
      title: '二级分类', dataIndex: 'level2', width: 100,
      render: (v: string) => <Tag color="blue">{v}</Tag>
    },
    {
      title: '三级分类', dataIndex: 'level3', width: 100,
      render: (v: string | null) => v ? <Tag color="purple">{v}</Tag> : '-'
    },
    {
      title: '置信度', dataIndex: 'confidence', width: 80,
      render: (v: number) => {
        const color = v < 0.6 ? 'orange' : v < 0.8 ? 'blue' : 'green'
        return <Tag color={color}>{Math.round(v * 100)}%</Tag>
      },
      sorter: true
    },
    {
      title: '错误', dataIndex: 'error_count', width: 60,
      render: (v: number) => v >= 3 ? <Tag color="red">{v}</Tag> : v
    },
    {
      title: '时间', dataIndex: 'created_at', width: 110,
      render: (v: string) => v?.slice(0, 10),
      sorter: true
    },
    {
      title: '操作', width: 180,
      render: (_: any, r: Question) => (
        <Space size="small" onClick={(e) => e.stopPropagation()}>
          <Button size="small" type="link" icon={<EditOutlined />}
            onClick={() => handleEditOpen(r)}>
            编辑
          </Button>
          <Button size="small" type="link" icon={<ExportOutlined />}
            onClick={() => handleOpenObsidian(r.obsidian_path)}>
            Obsidian
          </Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}
            okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
            <Button size="small" type="link" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div>
      <PageHeader
        title="错题库"
        subtitle="已确认错题列表，支持筛选、编辑、同步 Vault"
        extra={
          <Space>
            <Button icon={<SyncOutlined />} onClick={async () => {
              const res = await window.api.syncVault()
              message.info(res.message)
              fetchQuestions(1)
            }}>校验</Button>
            <Button icon={<FolderOpenOutlined />} onClick={async () => {
              const res = await window.api.reorganizeVault()
              message.success(`已移动 ${res.moved} 个文件，跳过 ${res.skipped} 个`)
              fetchQuestions(1)
            }}>重排目录</Button>
            <Button icon={<ReloadOutlined />} onClick={() => fetchQuestions(1)}>刷新</Button>
          </Space>
        }
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          value={level1Filter}
          onChange={(v) => { setLevel1Filter(v); setLevel2Filter(undefined); setPage(1) }}
          style={{ width: 130 }}
          allowClear
          placeholder="一级分类"
          options={level1Options}
        />
        <Select
          value={level2Filter}
          onChange={(v) => { setLevel2Filter(v); setLevel3Filter(undefined); setPage(1) }}
          style={{ width: 130 }}
          allowClear
          placeholder="二级分类"
          options={level2Options}
        />
        <Select
          value={level3Filter}
          onChange={(v) => { setLevel3Filter(v); setPage(1) }}
          style={{ width: 130 }}
          allowClear
          placeholder="三级分类"
          options={level3Options}
          disabled={!level2Filter}
        />
        <Input.Search
          placeholder="搜索 OCR 文本..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={() => { setPage(1); fetchQuestions(1) }}
          style={{ width: 260 }}
          allowClear
        />
        <Segmented
          value={viewMode}
          onChange={(v) => setViewMode(v as 'list' | 'group')}
          options={[{ value: 'list', label: '列表' }, { value: 'group', label: '按知识点' }]}
          size="small"
        />
      </Space>

      {viewMode === 'group' ? (
        /* 按知识点分组视图（学习闭环：知识点 ↔ 错题聚合） */
        <Table
          dataSource={knowledgeGroups}
          rowKey="name"
          size="small"
          loading={loading}
          pagination={false}
          expandable={{
            expandedRowRender: (g: any) => (
              <div>
                {g.questions.map((q: Question) => (
                  <div key={q.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
                    borderBottom: '1px solid #f5f5f5', fontSize: 12, cursor: 'pointer'
                  }} onClick={() => setDetailItem(q)}>
                    <Image src={q.image_url} width={36} height={36} style={{ objectFit: 'cover', borderRadius: 3 }} preview={false} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#666' }}>
                      {(q.ocr_text || '（纯图形题）').slice(0, 50)}
                    </span>
                    <Tag color={q.error_count >= 3 ? 'red' : q.error_count >= 2 ? 'orange' : 'default'}>错 {q.error_count} 次</Tag>
                    <span style={{ color: '#999', flexShrink: 0 }}>{q.created_at?.slice(0, 10)}</span>
                  </div>
                ))}
              </div>
            )
          }}
          columns={[
            { title: '知识点', dataIndex: 'name', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
            { title: '错题数', dataIndex: 'count', width: 90, align: 'center' as const, render: (v: number) => <Tag color="blue">{v} 道</Tag> },
            { title: '累计错误', dataIndex: 'totalErr', width: 100, align: 'center' as const, render: (v: number) => <Tag color={v >= 5 ? 'red' : v >= 3 ? 'orange' : 'default'}>{v} 次</Tag> },
            {
              title: '操作', width: 140,
              render: (_: any, g: any) => (
                <Space size={4} onClick={(e) => e.stopPropagation()}>
                  <Button size="small" type="link" icon={<ExportOutlined />}
                    onClick={() => navigate(`/test-builder?level1=${encodeURIComponent(g.level1)}&level2=${encodeURIComponent(g.level2 || '')}&level3=${encodeURIComponent(g.level3 || '')}`)}>
                    组卷重做
                  </Button>
                </Space>
              )
            }
          ]}
        />
      ) : (
        <Table
          dataSource={questions}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
          locale={{
            emptyText: (
              <Empty description={search || level1Filter || level2Filter ? '没有符合条件的错题' : '还没有已确认的错题，去成品库分类入库吧'} image={Empty.PRESENTED_IMAGE_SIMPLE}>
                <Button type="primary" onClick={() => navigate('/')}>去上传</Button>
              </Empty>
            )
          }}
          onRow={(r) => ({ onClick: () => setDetailItem(r), style: { cursor: 'pointer' } })}
          pagination={{
            current: page,
            pageSize: 30,
            total,
            onChange: (p) => { setPage(p); fetchQuestions(p) },
            showTotal: (t) => `共 ${t} 条`
          }}
          onChange={(_pagination, _filters, sorter: any) => {
            if (sorter?.columnKey) {
              setSortBy(sorter.columnKey)
              setSortOrder(sorter.order === 'ascend' ? 'asc' : 'desc')
            }
          }}
        />
      )}

      <Modal title="编辑错题" open={!!editingItem} onCancel={() => setEditingItem(null)} width={600}
        footer={<Space><Button onClick={() => setEditingItem(null)}>取消</Button>
          <Button type="primary" loading={editSaving} onClick={() => editForm.submit()}>保存</Button></Space>}>
        <Form form={editForm} layout="vertical" onFinish={handleEditSave}>
          <Form.Item label="一级分类" name="level1" rules={[{ required: true, message: '请选择' }]}>
            <Select options={editLevel1Options} placeholder="选择一级分类"
              onChange={() => { editForm.setFieldsValue({ level2: undefined, level3: undefined }) }} />
          </Form.Item>
          <Form.Item label="二级分类" name="level2">
            <Select options={editLevel2Options} placeholder="选择二级分类" disabled={!editLevel1}
              onChange={() => { editForm.setFieldsValue({ level3: undefined }) }} />
          </Form.Item>
          <Form.Item label="三级分类" name="level3">
            <Select options={editLevel3Options} placeholder="选择三级分类" disabled={!editLevel2} allowClear />
          </Form.Item>
          <Form.Item label="错误次数" name="error_count">
            <InputNumber min={1} max={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="错误类型" name="error_type">
            <Select allowClear placeholder="选择错误类型" options={errorTypes.map(t => ({ value: t, label: t }))} />
          </Form.Item>
          <Form.Item label="来源" name="source">
            <Input placeholder="如：2025国考行测真题" />
          </Form.Item>
          <Form.Item label="OCR 原文" name="ocr_text">
            <Input.TextArea rows={3} placeholder="OCR 识别文本" />
          </Form.Item>
          <Form.Item label="复盘反思" name="reflection">
            <Input.TextArea rows={4} placeholder="解题思路和反思" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="错题详情" open={!!detailItem} onCancel={() => setDetailItem(null)} width={640}
        footer={<Space><Button onClick={() => setDetailItem(null)}>关闭</Button>
          <Button type="primary" ghost onClick={() => {
            if (detailItem) { handleEditOpen(detailItem); setDetailItem(null) }
          }}>编辑</Button>
          <Button type="primary" onClick={() => { if (detailItem) handleOpenObsidian(detailItem.obsidian_path); setDetailItem(null) }}>在 Obsidian 中打开</Button></Space>}>
        {detailItem && (
          <div>
            <Image src={detailItem.image_url} style={{ maxWidth: '100%', maxHeight: 300, objectFit: 'contain', marginBottom: 16, borderRadius: 8 }} />
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="一级">{detailItem.level1}</Descriptions.Item>
              <Descriptions.Item label="二级">{detailItem.level2}</Descriptions.Item>
              <Descriptions.Item label="三级">{detailItem.level3 || '-'}</Descriptions.Item>
              <Descriptions.Item label="置信度">{Math.round(detailItem.confidence * 100)}%</Descriptions.Item>
              <Descriptions.Item label="错误次数">{detailItem.error_count}</Descriptions.Item>
              <Descriptions.Item label="错误类型">{detailItem.error_type || '-'}</Descriptions.Item>
              <Descriptions.Item label="入库时间">{detailItem.created_at?.slice(0, 10)}</Descriptions.Item>
              <Descriptions.Item label="来源" span={2}>{detailItem.source || '-'}</Descriptions.Item>
              {detailItem.ocr_text && <Descriptions.Item label="OCR 原文" span={2}><div style={{ fontSize: 12, lineHeight: 1.6, color: '#666' }}><MarkdownRenderer content={detailItem.ocr_text} /></div></Descriptions.Item>}
              {detailItem.reflection && <Descriptions.Item label="复盘反思" span={2}><div style={{ fontSize: 12, lineHeight: 1.6, color: '#fa8c16' }}><MarkdownRenderer content={detailItem.reflection} /></div></Descriptions.Item>}
            </Descriptions>
          </div>
        )}
      </Modal>

    </div>
  )
}
