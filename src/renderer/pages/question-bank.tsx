import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Typography, Table, Input, Select, Space, Button, Tag, App, Popconfirm, Image, Modal, Descriptions, Form, InputNumber, Empty, Segmented, Card, Popover, Tabs, Tooltip } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { SearchOutlined, DeleteOutlined, ReloadOutlined, FileTextOutlined, FileImageOutlined, SyncOutlined, FolderOpenOutlined, EditOutlined, ExportOutlined, BookOutlined, BulbOutlined, TimerOutlined } from '@/components/study-icons'
import type { ColumnsType } from 'antd/es/table'
import { useTagTreeStore } from '@/stores/tag-tree'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { PageHeader } from '@/components/page-header'
import { NewQuestionDrawer } from '@/components/new-question-drawer'
import { ReadingSplit } from '@/components/reading-split'

interface Question {
  id: string
  image_url: string
  local_image_path?: string | null
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
  group_id?: string | null
  question_number?: string | null
  group_title?: string | null
  group_passage_text?: string | null
  group_material_images?: string | null
  material_image_ids?: string | null
  question_images?: string | null
  option_images?: string | null
  original_answer?: string | null
  original_analysis?: string | null
  answer_result?: 'wrong' | 'correct' | 'unknown'
  time_status?: 'overtime' | 'within' | 'unknown'
}

function QuestionThumbnail({ question, size = 60 }: { question: Question; size?: number }) {
  const [src, setSrc] = useState(() => /^https?:|^data:/i.test(question.image_url || '') ? question.image_url : '')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    const load = async () => {
      try {
        if (question.local_image_path || question.image_url?.startsWith('file://')) {
          const dataUrl = await window.api.readImageDataUrl(question.local_image_path || question.image_url)
          if (!cancelled) setSrc(dataUrl)
        } else if (question.image_url && !/^https?:|^data:/i.test(question.image_url)) {
          const dataUrl = await window.api.readImageDataUrl(question.image_url)
          if (!cancelled) setSrc(dataUrl)
        } else {
          setSrc(question.image_url || '')
        }
      } catch { if (!cancelled) setFailed(true) }
    }
    load()
    return () => { cancelled = true }
  }, [question.id, question.image_url, question.local_image_path])

  if (!src || failed) {
    const textPreview = String(question.ocr_text || '').replace(/\s+/g, ' ').trim()
    const wide = size >= 60 && !!textPreview
    return <div title={textPreview || undefined} style={{ width: wide ? 126 : size, height: size, borderRadius: 5, background: textPreview ? '#f6f9ff' : question.group_id ? '#e6f4ff' : '#f5f5f5', border: textPreview ? '1px solid #dbeafe' : undefined, display: 'flex', flexDirection: 'column', alignItems: textPreview ? 'flex-start' : 'center', justifyContent: 'center', color: textPreview ? '#475569' : question.group_id ? '#1677ff' : '#aaa', fontSize: textPreview ? 9 : 10, lineHeight: 1.45, padding: textPreview ? '6px 7px' : 0, overflow: 'hidden', textAlign: 'left' }}>
      {textPreview ? <span style={{ display: '-webkit-box', WebkitLineClamp: wide ? 3 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{textPreview}</span> : <><span>{question.group_id ? <FileTextOutlined style={{ fontSize: Math.round(size * .38) }} /> : <FileImageOutlined style={{ fontSize: Math.round(size * .38) }} />}</span><span style={{ marginTop: 2 }}>{question.group_id ? '资料' : '无内容'}</span></>}
    </div>
  }
  return <span onClick={(event) => event.stopPropagation()} style={{ display: 'inline-flex' }}>
    <Image src={src} width={size} height={size} style={{ borderRadius: 4, objectFit: 'cover', cursor: 'zoom-in' }} preview={{ mask: '放大' }}
      onError={async () => {
        if (/^https?:/i.test(question.image_url || '')) {
          try {
            const result = await window.api.downloadImageAsDataUrl(question.image_url)
            if (result.success && result.dataUrl) { setSrc(result.dataUrl); return }
          } catch { /* fall through */ }
        }
        setFailed(true)
      }} />
  </span>
}

function SafeDetailImage({ source, style, alt }: { source: string; style?: CSSProperties; alt?: string }) {
  const [src, setSrc] = useState(() => /^https?:|^data:/i.test(source || '') ? source : '')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    const resolve = async () => {
      try {
        if (source.startsWith('file://') || (!/^https?:|^data:/i.test(source))) {
          const dataUrl = await window.api.readImageDataUrl(source)
          if (!cancelled) setSrc(dataUrl)
        } else if (!cancelled) setSrc(source)
      } catch { if (!cancelled) setFailed(true) }
    }
    resolve()
    return () => { cancelled = true }
  }, [source])

  if (failed || !src) {
    return <div style={{ minHeight: 120, width: '100%', borderRadius: 8, background: '#fafafa', border: '1px dashed #d9d9d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
      <FileImageOutlined style={{ marginRight: 6 }} />图片暂时无法读取
    </div>
  }
  return <Image src={src} alt={alt} style={style} preview={{ mask: '点击放大' }} onError={async () => {
    if (/^https?:/i.test(source)) {
      try {
        const result = await window.api.downloadImageAsDataUrl(source)
        if (result.success && result.dataUrl) { setSrc(result.dataUrl); return }
      } catch { /* show fallback */ }
    }
    setFailed(true)
  }} />
}

export function QuestionBankPage() {
  const pageRef = useRef<HTMLDivElement>(null)
  const [tableHeight, setTableHeight] = useState(300)
  const navigate = useNavigate()
  const [questions, setQuestions] = useState<Question[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(30)
  const [loading, setLoading] = useState(false)
  const [errorTypes, setErrorTypes] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [level1Filter, setLevel1Filter] = useState<string | undefined>()
  const [level2Filter, setLevel2Filter] = useState<string | undefined>()
  const [level3Filter, setLevel3Filter] = useState<string | undefined>()
  const [answerResultFilter, setAnswerResultFilter] = useState<string | undefined>()
  const [timeStatusFilter, setTimeStatusFilter] = useState<string | undefined>()
  const [sortBy, setSortBy] = useState('created_at')
  const [sortOrder, setSortOrder] = useState('desc')
  const [detailItem, setDetailItem] = useState<Question | null>(null)
  const [detailGroup, setDetailGroup] = useState<Question[]>([])
  const [editingItem, setEditingItem] = useState<Question | null>(null)
  const [editForm] = Form.useForm()
  const [viewMode, setViewMode] = useState<'list' | 'group'>('list')
  const [editSaving, setEditSaving] = useState(false)
  const [newQuestionOpen, setNewQuestionOpen] = useState(false)
  const [reflectionLoading, setReflectionLoading] = useState(false)
  const { message } = App.useApp()
  const { tree, load: loadTree } = useTagTreeStore()

  useEffect(() => { if (!tree.length) loadTree() }, [tree.length, loadTree])
  useEffect(() => { window.api.getErrorTypes().then(setErrorTypes) }, [])

  useEffect(() => {
    if (!detailItem?.group_id) { setDetailGroup([]); return }
    window.api.getQuestionGroupMembers(detailItem.group_id).then(setDetailGroup).catch(() => setDetailGroup([]))
  }, [detailItem?.group_id])

  const parseImages = (raw?: string | null): string[] => {
    if (!raw) return []
    try { const value = JSON.parse(raw); return Array.isArray(value) ? value.filter(Boolean) : [] } catch { return [] }
  }
  const parseOptionImages = (raw?: string | null): Record<string, string[]> => {
    if (!raw) return {}
    try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
  }
  const parseOriginalAnswer = (raw?: string | null): { correct?: string; user?: string; answerTime?: string; correctRate?: string; errorProne?: string; questionType?: string; weaknessType?: string; targetSeconds?: number; overtimeSeconds?: number; reportDifficulty?: number | null } => {
    if (!raw) return {}
    try { return JSON.parse(raw) || {} } catch { return {} }
  }
  const parseQuestionContent = (raw?: string) => {
    const text = (raw || '').replace(/\r/g, '').split(/\n?正确答案[：:]?/)[0].trim()
    const optionPattern = /(?:^|\n|\s)([A-H])[.．、）)]\s*/g
    const matches = [...text.matchAll(optionPattern)]
    if (!matches.length) return { stem: text.replace(/(?<!^)\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])/g, '\n'), options: [] as Array<{ key: string; text: string }> }
    const stem = text.slice(0, matches[0].index).trim().replace(/(?<!^)\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])/g, '\n')
    const options = matches.map((match, index) => ({
      key: match[1],
      text: text.slice((match.index || 0) + match[0].length, matches[index + 1]?.index ?? text.length).trim()
    }))
    return { stem, options }
  }
  const cleanReflectionForDisplay = (raw?: string): string => {
    if (!raw) return ''
    const headingIndex = raw.search(/^##\s*考点与识别信号\s*$/m)
    if (headingIndex >= 0) return raw.slice(headingIndex).trim()
    const looksLikeScratchpad = /我们只需要|按照要求生成|先分析|用户要求|需要分析错因|我将|we need|let's think/i.test(raw.slice(0, 400))
    return looksLikeScratchpad ? '' : raw.trim()
  }

  const regenerateReflection = async () => {
    if (!detailItem) return
    setReflectionLoading(true)
    try {
      const answers = parseOriginalAnswer(detailItem.original_answer)
      const result = await window.api.generateReflection({
        questionId: detailItem.id,
        level1: detailItem.level1,
        level2: detailItem.level2,
        level3: detailItem.level3,
        errorType: detailItem.error_type,
        ocrText: detailItem.ocr_text || '',
        officialAnalysis: detailItem.original_analysis || '',
        correctAnswer: answers.correct,
        userAnswer: answers.user,
        answerTime: answers.answerTime,
        correctRate: answers.correctRate,
        difficulty: answers.reportDifficulty
      })
      const cleaned = cleanReflectionForDisplay(result.reflection || '')
      if (!result.success || !cleaned) throw new Error(result.error || '模型未返回可用的正式复盘')
      await window.api.updateQuestion(detailItem.id, { reflection: cleaned })
      setDetailItem({ ...detailItem, reflection: cleaned })
      setDetailGroup(previous => previous.map(item => item.id === detailItem.id ? { ...item, reflection: cleaned } : item))
      message.success('复盘思路已重新生成')
    } catch (error: any) { message.error(error.message || '复盘生成失败') }
    finally { setReflectionLoading(false) }
  }

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

  const fetchQuestions = useCallback(async (p?: number, size?: number) => {
    setLoading(true)
    try {
      const params: any = {
        page: p || page, pageSize: size || pageSize,
        status: 'confirmed', sortBy, sortOrder
      }
      if (level1Filter) params.level1 = level1Filter
      if (level2Filter) params.level2 = level2Filter
      if (level3Filter) params.level3 = level3Filter
      if (answerResultFilter) params.answerResult = answerResultFilter
      if (timeStatusFilter) params.timeStatus = timeStatusFilter
      if (search.trim()) params.search = search.trim()
      const result = await window.api.getQuestions(params)
      setQuestions(result.items)
      setTotal(result.total)
    } catch { /* ignore */ }
    setLoading(false)
  }, [page, pageSize, level1Filter, level2Filter, level3Filter, answerResultFilter, timeStatusFilter, search, sortBy, sortOrder])

  useEffect(() => { fetchQuestions(1) }, [level1Filter, level2Filter, level3Filter, answerResultFilter, timeStatusFilter, sortBy, sortOrder])

  useEffect(() => {
    const root = pageRef.current
    if (!root) return
    const resize = () => {
      const table = root.querySelector('.bank-table')
      if (!table) return
      const header = table.querySelector('.ant-table-header')?.getBoundingClientRect().height || 48
      const pagination = table.querySelector('.ant-pagination')?.getBoundingClientRect().height || 32
      setTableHeight(Math.max(100, Math.floor(root.getBoundingClientRect().bottom - table.getBoundingClientRect().top - header - pagination - 46)))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    const toolbar = root.querySelector('.filter-toolbar')
    if (toolbar) observer.observe(toolbar)
    resize()
    return () => observer.disconnect()
  }, [questions.length, total, viewMode])

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
      const saved = await window.api.updateQuestion(editingItem.id, {
        level1: values.level1,
        level2: values.level2 || '',
        level3: values.level3 || null,
        error_count: values.error_count,
        error_type: values.error_type || null,
        source: values.source || '',
        ocr_text: values.ocr_text || '',
        reflection: values.reflection || ''
      })
      if (!saved.success) throw new Error(saved.error || '修改未保存')
      if (saved.warning) message.warning(saved.warning)
      else message.success('已更新')
      setEditingItem(null)
      fetchQuestions(page)
    } catch (err: any) {
      message.error(`更新失败: ${err.message}`)
    }
    setEditSaving(false)
  }

  const columns: ColumnsType<Question> = [
    {
      title: '题目', dataIndex: 'image_url', width: 150,
      render: (_v: string, question: Question) => (
        <span onClick={(e) => e.stopPropagation()}>
          <QuestionThumbnail question={question} />
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
      title: '答题情况', width: 150,
      render: (_: unknown, question: Question) => {
        const result = question.answer_result || 'unknown'
        const timing = question.time_status || 'unknown'
        return <Space size={[0, 4]} wrap>
          <Tooltip title={question.error_type ? `原错误类型：${question.error_type}` : undefined}>
            <Tag color={result === 'wrong' ? 'error' : result === 'correct' ? 'success' : undefined}>
              {result === 'wrong' ? '答错' : result === 'correct' ? '答对' : '未判定'}
            </Tag>
          </Tooltip>
          <Tag color={timing === 'overtime' ? 'orange' : undefined}>{timing === 'overtime' ? '超时' : timing === 'within' ? '未超时' : '用时未评估'}</Tag>
        </Space>
      }
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
            <Button size="small" type="link" danger aria-label="删除这道题" title="删除这道题" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div className="bank-page" ref={pageRef}>
      <PageHeader
        title="错题库"
        subtitle="先按答题结果找题，再按用时情况细筛"
        extra={
          <Space wrap>
            <Button type="primary" onClick={() => setNewQuestionOpen(true)}>新建错题</Button>
            <Button icon={<SyncOutlined />} onClick={async () => {
              const res = await window.api.syncVault()
              message.info(res.message)
              if (res.repairable) Modal.confirm({
                title: `发现 ${res.repairable} 条旧版或缺失笔记，是否修复？`,
                content: '先备份数据库和旧笔记，再从数据库重建独立笔记。不会删除旧文件；旧笔记中的手工批注请在备份中保留。',
                okText: '备份并修复',
                onOk: async () => {
                  const repaired = await window.api.repairQuestionNotes()
                  message.info(`已修复 ${repaired.repaired} 条，失败 ${repaired.failed} 条；备份：${repaired.backupPath}`)
                  fetchQuestions(1)
                }
              })
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

      <Space className="filter-toolbar" wrap>
        <Button icon={<ExportOutlined />} onClick={() => {
          const params = new URLSearchParams({ answerResult: answerResultFilter || 'all' })
          if (level1Filter) params.set('level1', level1Filter)
          if (level2Filter) params.set('level2', level2Filter)
          if (level3Filter) params.set('level3', level3Filter)
          if (timeStatusFilter) params.set('timeStatus', timeStatusFilter)
          if (search.trim()) params.set('search', search.trim())
          navigate(`/test-builder?${params.toString()}`)
        }}>去复习／导出</Button>
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
        <Select
          aria-label="答题结果"
          value={answerResultFilter}
          onChange={(value) => { setAnswerResultFilter(value); setTimeStatusFilter(undefined); setPage(1) }}
          style={{ width: 140 }}
          allowClear
          placeholder="答题结果：全部"
          options={[
            { value: 'wrong', label: '答错（含超时）' },
            { value: 'correct', label: '答对（含超时）' },
            { value: 'unknown', label: '结果未判定' }
          ]}
        />
        <Select
          aria-label="用时情况"
          value={timeStatusFilter}
          onChange={(value) => { setTimeStatusFilter(value); setPage(1) }}
          style={{ width: 140 }}
          allowClear
          placeholder="用时情况：全部"
          options={[
            { value: 'overtime', label: '仅超时' },
            { value: 'within', label: '仅未超时' },
            { value: 'unknown', label: '用时未评估' }
          ]}
        />
        <Input.Search
          placeholder="搜索题目内容"
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
        {timeStatusFilter === 'overtime' && <Button type="primary" icon={<TimerOutlined />} onClick={() => {
          const params = new URLSearchParams()
          if (level1Filter) params.set('level1', level1Filter)
          if (level2Filter) params.set('level2', level2Filter)
          if (level3Filter) params.set('level3', level3Filter)
          if (answerResultFilter) params.set('answerResult', answerResultFilter)
          navigate(`/speed-training?${params.toString()}`)
        }}>开始速度训练</Button>}
      </Space>

      {viewMode === 'group' ? (
        /* 按知识点分组视图（学习闭环：知识点 ↔ 错题聚合） */
        <Table
          className="bank-table"
          scroll={{ x: 860, y: tableHeight }}
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
                    <QuestionThumbnail question={q} size={36} />
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
          className="bank-table"
          scroll={{ x: 1000, y: tableHeight }}
          dataSource={questions}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
          locale={{
            emptyText: (
              <Empty description={search || level1Filter || level2Filter || level3Filter || answerResultFilter || timeStatusFilter ? '没有符合条件的错题' : '还没有已确认的错题，去错题处理导入题目吧'} image={Empty.PRESENTED_IMAGE_SIMPLE}>
                <Button type="primary" onClick={() => navigate('/')}>去上传</Button>
              </Empty>
            )
          }}
          onRow={(r) => ({ onClick: () => setDetailItem(r), style: { cursor: 'pointer' } })}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 30, 50, 100],
            onChange: (p, size) => {
              setPage(p)
              setPageSize(size)
              fetchQuestions(p, size)
            },
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

      <Modal className="question-detail-modal" title="错题详情" open={!!detailItem} onCancel={() => setDetailItem(null)} width="min(1500px, 94vw)"
        styles={{ body: { height: 'calc(92dvh - 132px)', minHeight: 0, overflow: 'hidden', paddingTop: 12 } }}
        style={{ top: '4dvh' }}
        footer={<Space><Button onClick={() => setDetailItem(null)}>关闭</Button>
          <Button type="primary" ghost onClick={() => {
            if (detailItem) { handleEditOpen(detailItem); setDetailItem(null) }
          }}>编辑</Button>
          <Button type="primary" onClick={() => { if (detailItem) handleOpenObsidian(detailItem.obsidian_path); setDetailItem(null) }}>在 Obsidian 中打开</Button></Space>}>
        {detailItem && (
          <ReadingSplit storageKey="question-detail-reading-layout">
            {/* 左侧：公共资料与题目。题组题在左栏内上下排列。 */}
            <div className={`question-detail-question-column${detailItem.group_id ? ' is-grouped' : ''}`}>
              {detailItem.group_id && (
                <Card size="small" title={detailItem.group_title || '公共资料'} styles={{ body: { height: 'calc(100% - 42px)', overflow: 'auto', padding: 16 } }} style={{ minHeight: 0, overflow: 'hidden' }}>
                  {detailItem.group_passage_text && <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.85 }}>{detailItem.group_passage_text}</div>}
                  {parseImages(detailItem.group_material_images).length > 0 && (
                    <Image.PreviewGroup>
                      <div style={{ display: 'grid', gridTemplateColumns: parseImages(detailItem.group_material_images).length > 1 ? 'repeat(2,minmax(0,1fr))' : '1fr', gap: 10, marginTop: detailItem.group_passage_text ? 14 : 0 }}>
                        {parseImages(detailItem.group_material_images).map((src, index) => <SafeDetailImage key={`${src}-${index}`} source={src} alt={`公共资料图 ${index + 1}`} style={{ width: '100%', maxHeight: 360, objectFit: 'contain', borderRadius: 8 }} />)}
                      </div>
                    </Image.PreviewGroup>
                  )}
                  {!detailItem.group_passage_text && parseImages(detailItem.group_material_images).length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该题组没有额外公共资料" />}
                </Card>
              )}

              <Card size="small" style={{ minHeight: 0, overflow: 'hidden' }} styles={{ body: { height: 'calc(100% - 42px)', overflow: 'auto', padding: 16 } }}
                title={detailItem.group_id ? `当前小题 · 第 ${detailItem.question_number || '?'} 题` : '题目与选项'}
                extra={<Space size={6}>
                  <Popover trigger="click" placement="bottomRight" title="题目信息" content={
                    <Descriptions column={1} size="small" bordered style={{ width: 430 }}>
                      <Descriptions.Item label="分类">{detailItem.level1}{detailItem.level2 ? ` › ${detailItem.level2}` : ''}{detailItem.level3 ? ` › ${detailItem.level3}` : ''}</Descriptions.Item>
                      <Descriptions.Item label="置信度">{Math.round(detailItem.confidence * 100)}%</Descriptions.Item>
                      <Descriptions.Item label="错误次数">{detailItem.error_count} 次</Descriptions.Item>
                      <Descriptions.Item label="错误类型">{detailItem.error_type || '-'}</Descriptions.Item>
                      <Descriptions.Item label="入库时间">{detailItem.created_at?.slice(0, 10)}</Descriptions.Item>
                      <Descriptions.Item label="来源">{detailItem.source || '-'}</Descriptions.Item>
                    </Descriptions>
                  }><Button size="small" icon={<InfoCircleOutlined />}>题目信息</Button></Popover>
                </Space>}>
                {detailItem.group_id && detailGroup.length > 1 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {detailGroup.map((question, index) => <Button key={question.id} size="small" type={question.id === detailItem.id ? 'primary' : 'default'} onClick={() => setDetailItem(question)}>第 {question.question_number || index + 1} 题</Button>)}
                  </div>
                )}
                <Image.PreviewGroup>
                  {[...parseImages(detailItem.question_images), ...(!detailItem.group_id && detailItem.image_url ? [detailItem.image_url] : [])].map((src, index) => <SafeDetailImage key={`${src}-${index}`} source={src} alt={`题干图 ${index + 1}`} style={{ width: '100%', maxHeight: 280, objectFit: 'contain', borderRadius: 8, marginBottom: 10 }} />)}
                </Image.PreviewGroup>
                {(() => {
                  const answers = parseOriginalAnswer(detailItem.original_answer)
                  const parsed = parseQuestionContent(detailItem.ocr_text)
                  const isFenbi = !!detailItem.original_answer || !!detailItem.original_analysis
                  if (!isFenbi) return detailItem.ocr_text ? <div style={{ fontSize: 14, lineHeight: 1.8 }}><MarkdownRenderer content={detailItem.ocr_text} /></div> : <Typography.Text type="secondary">暂无文字题干</Typography.Text>
                  return <div style={{ padding: '2px 4px 8px' }}>
                    <Space size={10} style={{ marginBottom: 14 }}>
                      <Typography.Text strong style={{ fontSize: 18 }}>{detailItem.question_number || ''}{detailItem.question_number ? '.' : ''}</Typography.Text>
                      <Tag color="error" bordered={false}>{answers.questionType || '单选题'}</Tag>
                    </Space>
                    {parsed.stem ? <div style={{ whiteSpace: 'pre-wrap', fontSize: 16, lineHeight: 2, color: '#262626', marginBottom: 16 }}>{parsed.stem}</div> : <Typography.Text type="secondary">暂无文字题干</Typography.Text>}
                    <div style={{ display: 'grid', gap: 9 }}>
                      {parsed.options.map(option => {
                        const correct = answers.correct === option.key
                        const wrong = answers.user === option.key && answers.user !== answers.correct
                        return <div key={option.key} style={{ display: 'grid', gridTemplateColumns: '38px minmax(0,1fr)', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 9, background: correct ? '#f0faf6' : wrong ? '#fff2f0' : 'transparent' }}>
                          <span style={{ width: 32, height: 32, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1.5px solid ${correct ? '#13a879' : wrong ? '#cf3f3f' : '#bfbfbf'}`, background: wrong ? '#cf3f3f' : 'transparent', color: wrong ? '#fff' : correct ? '#13a879' : '#595959', fontWeight: 600 }}>{option.key}</span>
                          <span style={{ fontSize: 15, lineHeight: 1.75 }}>{option.text}</span>
                        </div>
                      })}
                    </div>
                  </div>
                })()}
                {Object.keys(parseOptionImages(detailItem.option_images)).length > 0 && (
                  <Image.PreviewGroup>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8, marginTop: 12 }}>
                      {Object.entries(parseOptionImages(detailItem.option_images)).flatMap(([key, images]) => images.map((src, index) => <div key={`${key}-${index}`} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 8 }}><Tag color="blue">{key}</Tag><SafeDetailImage source={src} alt={`选项 ${key}`} style={{ width: '100%', maxHeight: 180, objectFit: 'contain' }} /></div>))}
                    </div>
                  </Image.PreviewGroup>
                )}
                {(() => {
                  const answers = parseOriginalAnswer(detailItem.original_answer)
                  if (!answers.user && !answers.correct) return null
                  const metrics = [
                    { value: answers.correct || '--', label: '正确答案', color: '#13a879' },
                    { value: answers.user || '--', label: '你的答案', color: answers.user === answers.correct ? '#13a879' : '#cf3f3f' },
                    { value: answers.correctRate || '--', label: '全站正确率', color: '#1677ff' },
                    { value: answers.answerTime || '--', label: '答题用时', color: '#1677ff' },
                    { value: answers.errorProne || '--', label: '易错项', color: '#d46b08' }
                  ]
                  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', marginTop: 16, padding: '12px 4px', borderRadius: 10, background: '#fafafa', border: '1px solid #f0f0f0' }}>
                    {metrics.map((metric, index) => <div key={metric.label} style={{ textAlign: 'center', borderLeft: index ? '1px solid #e8e8e8' : undefined, minWidth: 0 }}>
                      <div style={{ color: metric.color, fontWeight: 700, fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{metric.value}</div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{metric.label}</Typography.Text>
                    </div>)}
                  </div>
                })()}
              </Card>
            </div>

            {/* 右侧：解析与复盘，标签内容区独立滚动。 */}
            <Card className="question-detail-review-card" size="small" style={{ minHeight: 0, overflow: 'hidden' }} styles={{ body: { height: '100%', padding: '0 18px 12px', overflow: 'hidden' } }}>
              <Tabs className="question-detail-tabs" key={detailItem.id} defaultActiveKey="review" items={[
                ...(detailItem.original_analysis ? [{ key: 'fenbi', label: <span><FileTextOutlined /> 粉笔解析</span>, children: <div className="question-detail-scroll" style={{ fontSize: 14, lineHeight: 1.85, whiteSpace: 'pre-wrap' }}><MarkdownRenderer content={detailItem.original_analysis} /></div> }] : []),
                { key: 'review', label: <span><BookOutlined style={{ color: '#fa8c16' }} /> 个人复盘</span>, children: <div className="question-detail-scroll">
                  <div style={{ textAlign: 'right', marginBottom: 4 }}><Button size="small" icon={<BulbOutlined />} loading={reflectionLoading} onClick={regenerateReflection}>AI 重新生成</Button></div>
                  {cleanReflectionForDisplay(detailItem.reflection) ? <div style={{ fontSize: 14, lineHeight: 1.8 }}><MarkdownRenderer content={cleanReflectionForDisplay(detailItem.reflection)} /></div>
                    : <Typography.Text type="secondary">暂无可用复盘，点击“AI 重新生成”获取正式复盘。</Typography.Text>}
                </div> }
              ]} />
            </Card>
          </ReadingSplit>
        )}
      </Modal>

      <NewQuestionDrawer open={newQuestionOpen} onClose={() => setNewQuestionOpen(false)} onCreated={() => fetchQuestions(1)} />

    </div>
  )
}
