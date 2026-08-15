import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Typography, Card, Table, Button, Tag, Space, App, Input, Select, Row, Col, Image, Empty, InputNumber, Switch, Radio, Divider, Tooltip, Modal, Checkbox, Alert } from 'antd'
import {
  ReloadOutlined, ClearOutlined, UpOutlined, DownOutlined,
  ExportOutlined, FileImageOutlined, ScissorOutlined, PictureOutlined,
  AimOutlined, CheckCircleOutlined, SortAscendingOutlined
} from '@ant-design/icons'
import { CanvasCrop } from '@/components/canvas-crop'
import { PageHeader } from '@/components/page-header'
import { useTagTreeStore } from '@/stores/tag-tree'

interface Question {
  id: string; level1: string; level2: string; level3: string | null
  image_url: string; local_image_path: string | null
  ocr_text: string | null; error_count: number; source: string | null
  reflection: string | null; error_type: string | null
  group_id: string | null; obsidian_path: string | null
  has_graphics?: number; graphic_image_path?: string | null
}

export function TestBuilderPage() {
  const { message } = App.useApp()
  const [searchParams] = useSearchParams()
  const [allQuestions, setAllQuestions] = useState<Question[]>([])
  // 有序选题：数组顺序即试卷顺序（可上移/下移调整）
  const [selectedOrder, setSelectedOrder] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')

  // 对答案回填状态
  const [answerOpen, setAnswerOpen] = useState(false)
  const [wrongSet, setWrongSet] = useState<Set<string>>(new Set())

  // 导出前预览
  const [previewOpen, setPreviewOpen] = useState(false)
  const autoSelectRef = useRef<{ l1: string; l2?: string; l3?: string } | null>(null)

  // Crop state
  const [cropOpen, setCropOpen] = useState(false)
  const [cropTarget, setCropTarget] = useState<Question | null>(null)
  const [cropDataUrl, setCropDataUrl] = useState('')

  // Filters
  const [filterLevel1, setFilterLevel1] = useState<string | undefined>()
  const [filterLevel2, setFilterLevel2] = useState<string | undefined>()
  const [filterLevel3, setFilterLevel3] = useState<string | undefined>()
  const [search, setSearch] = useState('')

  // 分类树（一级/二级/三级筛选用）
  const { tree, loaded: treeLoaded, load: loadTree } = useTagTreeStore()
  useEffect(() => { if (!treeLoaded) loadTree() }, [treeLoaded, loadTree])
  const level1Options = tree.map((n: any) => ({ value: n.name, label: n.name }))
  const level2Options = filterLevel1
    ? tree.find((n: any) => n.name === filterLevel1)?.children.map((c: any) => ({ value: c.name, label: c.name })) || []
    : []
  const level3Options = (filterLevel1 && filterLevel2)
    ? tree.find((n: any) => n.name === filterLevel1)?.children.find((c: any) => c.name === filterLevel2)?.children.map((c: any) => ({ value: c.name, label: c.name })) || []
    : []

  // PDF options
  const [pdfTitle, setPdfTitle] = useState('错题练习卷')
  const [showAnswers, setShowAnswers] = useState(false)
  const [pageSize, setPageSize] = useState<'A4' | 'Letter'>('A4')
  const [includeAnswerSheet, setIncludeAnswerSheet] = useState(false)
  const [onlyGraphicsImages, setOnlyGraphicsImages] = useState(true)
  const [randomCount, setRandomCount] = useState(10)

  // Graphics image preview cache: questionId → dataUrl
  const [graphicPreviews, setGraphicPreviews] = useState<Record<string, string>>({})

  // Load a file:// graphic as data URL for display
  const loadGraphicPreview = async (q: Question) => {
    if (!q.graphic_image_path) return
    const key = q.id
    if (graphicPreviews[key]) return // already loaded
    try {
      const dataUrl = await window.api.readImageDataUrl(q.graphic_image_path)
      setGraphicPreviews(prev => ({ ...prev, [key]: dataUrl }))
    } catch {
      if (q.has_graphics === 1 && q.image_url) {
        try {
          const res = await window.api.downloadImageAsDataUrl(q.image_url)
          if (res.success) {
            setGraphicPreviews(prev => ({ ...prev, [key]: res.dataUrl! }))
          }
        } catch { /* */ }
      }
    }
  }

  // Load questions
  const loadQuestions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.getQuestions({ status: 'confirmed', pageSize: 500, level1: filterLevel1, level2: filterLevel2, level3: filterLevel3, search })
      const items = res.items || []
      setAllQuestions(items)
      for (const q of items) {
        if (q.graphic_image_path) loadGraphicPreview(q)
      }
    } catch { /* */ }
    setLoading(false)
  }, [filterLevel1, filterLevel2, filterLevel3, search])

  useEffect(() => { loadQuestions() }, [loadQuestions])

  // 统计看板跳转：?level1=&level2=&level3= → 自动筛选并全选
  useEffect(() => {
    const l1 = searchParams.get('level1')
    if (!l1) return
    const l2 = searchParams.get('level2') || undefined
    const l3 = searchParams.get('level3') || undefined
    setFilterLevel1(l1)
    setFilterLevel2(l2)
    setFilterLevel3(l3)
    autoSelectRef.current = { l1, l2, l3 }
  }, [searchParams])

  useEffect(() => {
    if (autoSelectRef.current && !loading && allQuestions.length > 0) {
      const { l1, l2, l3 } = autoSelectRef.current
      const matched = allQuestions.filter(q => q.level1 === l1 && (!l2 || q.level2 === l2) && (!l3 || (q.level3 || '') === l3))
      if (matched.length > 0) {
        setSelectedOrder(matched.map(q => q.id))
        message.success(`已自动选中 ${matched.length} 道「${[l1, l2, l3].filter(Boolean).join('/')}」错题`)
      }
      autoSelectRef.current = null
    }
  }, [allQuestions, loading, message])

  // 从复习队列选题（学习闭环：复习队列 → 组卷重做）
  const handleSelectFromReviewQueue = useCallback(async () => {
    try {
      const res = await window.api.selectFromReviewQueue()
      if (res.success && res.ids.length > 0) {
        setSelectedOrder(res.ids)
        message.success(`已从复习队列选中 ${res.ids.length} 道薄弱错题，可再手动调整`)
      } else {
        message.info(res.cards?.length === 0 ? '暂无可复习的知识卡片' : '复习队列的卡片暂无匹配错题，请先在知识归纳中生成卡片')
      }
    } catch (err: any) {
      message.error(`加载失败: ${err.message}`)
    }
  }, [message])

  // 对答案回填（学习闭环：重做结果回到系统）
  const handleOpenAnswer = useCallback(() => {
    if (selectedOrder.length === 0) { message.warning('请先选择题'); return }
    setWrongSet(new Set())
    setAnswerOpen(true)
  }, [selectedOrder.length, message])

  const handleSubmitAnswers = useCallback(async () => {
    const wrongIds = Array.from(wrongSet)
    if (wrongIds.length === 0) {
      message.success('全部做对了，太棒了！')
      setAnswerOpen(false)
      return
    }
    try {
      const res = await window.api.markTestAnswers(wrongIds)
      if (res.success) {
        message.success(`已回填 ${res.updated} 道错题（错误计数 +1），同步 ${res.cardBumps} 张知识卡片`)
      } else {
        message.error(res.error || '回填失败')
      }
    } catch (err: any) {
      message.error(`回填失败: ${err.message}`)
    }
    setAnswerOpen(false)
  }, [wrongSet, message])

  // ── 有序选中操作 ──
  const isSelected = (id: string) => selectedOrder.includes(id)

  const toggleSelect = (id: string) => {
    setSelectedOrder(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // 全选当前筛选结果（替换现有选择）
  const selectAllFiltered = () => {
    if (allQuestions.length === 0) { message.info('当前筛选条件下没有题目'); return }
    setSelectedOrder(allQuestions.map(q => q.id))
    message.success(`已选择当前结果 ${allQuestions.length} 道题`)
  }

  // 只选图形题
  const selectOnlyGraphics = () => {
    const ids = allQuestions.filter(q => q.has_graphics === 1 || q.graphic_image_path).map(q => q.id)
    setSelectedOrder(ids)
    message.success(ids.length > 0 ? `已选择 ${ids.length} 道图形题` : '当前结果中没有图形题')
  }

  const handleRandomSelect = () => {
    const available = allQuestions.filter(q => !isSelected(q.id))
    const shuffled = [...available].sort(() => Math.random() - 0.5)
    const toAdd = shuffled.slice(0, Math.min(randomCount, shuffled.length))
    setSelectedOrder(prev => [...prev, ...toAdd.map(q => q.id)])
    message.success(`随机追加 ${toAdd.length} 道题`)
  }

  const clearSelection = () => setSelectedOrder([])

  const removeSelected = (id: string) => {
    setSelectedOrder(prev => prev.filter(x => x !== id))
  }

  // 调整试卷顺序
  const moveSelected = (index: number, dir: -1 | 1) => {
    setSelectedOrder(prev => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  // 按错误次数降序排列
  const sortSelectedByErrors = () => {
    setSelectedOrder(prev => {
      const qmap = new Map(allQuestions.map(q => [q.id, q]))
      return [...prev].sort((a, b) => (qmap.get(b)?.error_count || 0) - (qmap.get(a)?.error_count || 0))
    })
    message.success('已按错误次数从高到低排列')
  }

  // Open crop for a question
  const handleCrop = async (q: Question, e: React.MouseEvent) => {
    e.stopPropagation()
    setCropTarget(q)
    const res = await window.api.downloadImageAsDataUrl(q.image_url)
    if (res.success) {
      setCropDataUrl(res.dataUrl!)
      setCropOpen(true)
    } else {
      message.error('图片加载失败')
    }
  }

  const handleCropSaved = () => { loadQuestions() }

  // ── 导出：先预览确认，再执行（带阶段进度） ──
  const handleExport = () => {
    if (selectedOrder.length === 0) { message.warning('请先选择题'); return }
    setPreviewOpen(true)
  }

  const doExport = useCallback(async () => {
    setPreviewOpen(false)
    setExporting(true)
    setExportProgress('正在准备...')
    const unsub = window.api.onPdfProgress((data) => {
      if (data.stage === 'download') setExportProgress(`正在下载题目图片 ${data.done ?? 0}/${data.total ?? 0}...`)
      else if (data.stage === 'render') setExportProgress('正在渲染 PDF...')
      else setExportProgress('正在生成...')
    })
    try {
      const result = await window.api.generateTestPdf(selectedOrder, {
        title: pdfTitle,
        showAnswers,
        pageSize,
        includeAnswerSheet,
        imageMode: onlyGraphicsImages ? 'graphics_only' : 'full'
      })

      if (!result.success) {
        message.error(result.error || 'PDF 生成失败')
        return
      }
      if (result.imageErrors.length > 0) {
        message.warning(`${result.imageErrors.length} 张图片下载失败，PDF 中可能缺少部分题目图片`)
      }
      if (result.filePath) {
        message.success(`PDF 已保存到: ${result.filePath}`)
      } else {
        message.info('已取消保存')
      }
    } catch (err: any) {
      message.error(`导出失败: ${err.message}`)
    } finally {
      unsub?.()
      setExporting(false)
      setExportProgress('')
    }
  }, [selectedOrder, pdfTitle, showAnswers, pageSize, includeAnswerSheet, onlyGraphicsImages, message])

  // 按选题顺序解析已选题目
  const qmap = new Map(allQuestions.map(q => [q.id, q]))
  const selectedQuestions: Question[] = selectedOrder
    .map(id => qmap.get(id))
    .filter((q): q is Question => !!q)

  const graphicsCount = selectedQuestions.filter(q => q.has_graphics === 1 || q.graphic_image_path).length
  const totalErrors = selectedQuestions.reduce((s, q) => s + (q.error_count || 0), 0)

  const categoryLabel = (q: Question) => [q.level1, q.level2, q.level3].filter(Boolean).join(' › ')

  const hasGraphic = (q: Question) => q.has_graphics === 1 && !!q.graphic_image_path
  const getGraphicSrc = (q: Question) => graphicPreviews[q.id] || q.graphic_image_path || q.image_url

  const questionCols = [
    { title: '#', width: 30, render: (_: any, __: any, i: number) => <span style={{ color: '#999' }}>{i + 1}</span> },
    {
      title: '图形', width: 55,
      render: (_: any, r: Question) => hasGraphic(r)
        ? <Tooltip title="已裁剪图形区域，将嵌入PDF"><Image src={getGraphicSrc(r)} width={40} height={40} style={{ objectFit: 'cover', borderRadius: 3, border: '1px solid #52c41a' }} preview={{ mask: null }} /></Tooltip>
        : r.has_graphics === 1
          ? <Tooltip title="已标记图形题，显示原图"><PictureOutlined style={{ fontSize: 20, color: '#fa8c16' }} /></Tooltip>
          : <span style={{ color: '#ddd', fontSize: 18 }}>-</span>
    },
    {
      title: '预览', width: 55,
      render: (_: any, r: Question) => r.image_url
        ? <Image src={r.image_url} width={40} height={40} style={{ objectFit: 'cover', borderRadius: 3 }} preview={{ mask: null }} />
        : <FileImageOutlined style={{ fontSize: 28, color: '#ccc' }} />
    },
    { title: '分类', width: 120, ellipsis: true, render: (_: any, r: Question) => <span style={{ fontSize: 12 }}>{categoryLabel(r)}</span> },
    {
      title: '内容', ellipsis: true,
      render: (_: any, r: Question) => <span style={{ fontSize: 12, color: '#666' }}>{(r.ocr_text || '（纯图形题）').slice(0, 50)}</span>
    },
    { title: '错', width: 40, align: 'center' as const, render: (_: any, r: Question) => <Tag color={r.error_count >= 3 ? 'red' : 'orange'}>{r.error_count}</Tag> },
    {
      title: '', width: 60,
      render: (_: any, r: Question) => (
        <Space size={0}>
          <Tooltip title="裁剪图形区域">
            <Button size="small" type="link" style={{ padding: '0 2px' }}
              icon={<ScissorOutlined style={{ fontSize: 12 }} />}
              onClick={(e: any) => handleCrop(r, e)} />
          </Tooltip>
          {isSelected(r.id)
            ? <Button size="small" type="link" danger style={{ padding: '0 2px' }}
                onClick={(e: any) => { e.stopPropagation(); removeSelected(r.id) }}>移</Button>
            : <Button size="small" type="link" style={{ padding: '0 2px' }}
                onClick={(e: any) => { e.stopPropagation(); toggleSelect(r.id) }}>选</Button>
          }
        </Space>
      )
    }
  ]

  return (
    <div>
      <PageHeader
        title="📝 组卷导出"
        subtitle="选题顺序即试卷顺序（可调整）· 导出 PDF 后「对答案回填」形成闭环"
        extra={
          <Space>
            <Button icon={<AimOutlined />} onClick={handleSelectFromReviewQueue}>从复习队列选题</Button>
            <Button icon={<CheckCircleOutlined />} onClick={handleOpenAnswer} disabled={selectedOrder.length === 0}>对答案回填</Button>
            <Button icon={<ReloadOutlined />} onClick={loadQuestions} loading={loading}>刷新</Button>
          </Space>
        }
      />

      <Row gutter={16}>
        {/* Left: Question Browser */}
        <Col span={14}>
          <Card size="small" title={<span>📋 错题库（共 {allQuestions.length} 题）</span>}
            extra={<Space size="small">
              <Select size="small" placeholder="一级分类" allowClear style={{ width: 96 }} value={filterLevel1}
                onChange={(v) => { setFilterLevel1(v); setFilterLevel2(undefined); setFilterLevel3(undefined) }}
                options={level1Options} />
              <Select size="small" placeholder="二级" allowClear style={{ width: 92 }} value={filterLevel2}
                onChange={(v) => { setFilterLevel2(v); setFilterLevel3(undefined) }} options={level2Options} disabled={!filterLevel1} />
              <Select size="small" placeholder="三级" allowClear style={{ width: 92 }} value={filterLevel3}
                onChange={setFilterLevel3} options={level3Options} disabled={!filterLevel2} />
              <Input size="small" placeholder="搜索..." style={{ width: 110 }} value={search}
                onChange={e => setSearch(e.target.value)} allowClear />
              <Button size="small" onClick={selectAllFiltered}>全选结果</Button>
              <Button size="small" icon={<PictureOutlined />} onClick={selectOnlyGraphics}>只选图形</Button>
            </Space>}>
            <Table dataSource={allQuestions} columns={questionCols} rowKey="id" size="small"
              pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }}
              scroll={{ y: 420 }}
              onRow={(r) => ({
                onClick: () => toggleSelect(r.id),
                style: { cursor: 'pointer', background: isSelected(r.id) ? '#e6f4ff' : undefined }
              })} />
            <div style={{ marginTop: 4, fontSize: 11, color: '#999' }}>
              <PictureOutlined style={{ color: '#fa8c16' }} /> = 已标记图形题 &nbsp;
              <Image src="" width={14} height={14} style={{ border: '1px solid #52c41a', borderRadius: 2, verticalAlign: 'middle' }} preview={false} /> = 已裁剪图形区域
              &nbsp; ✂️ = 裁剪/编辑图形 · 点击行 = 选中/取消
            </div>
          </Card>
        </Col>

        {/* Right: Selection Panel */}
        <Col span={10}>
          <Card size="small" title={<span>✅ 已选题目（{selectedOrder.length} 题）</span>}
            extra={<Space size="small">
              <InputNumber size="small" min={1} max={500} value={randomCount} onChange={v => setRandomCount(v || 10)} style={{ width: 48 }} />
              <Button size="small" onClick={handleRandomSelect}>🎲 随机</Button>
              <Button size="small" icon={<ClearOutlined />} danger onClick={clearSelection} disabled={selectedOrder.length === 0}>清空</Button>
            </Space>}>

            {/* 汇总统计 */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <Tag color="blue">{selectedOrder.length} 题</Tag>
              <Tag color="orange">{graphicsCount} 张图形题</Tag>
              <Tag color={totalErrors >= 5 ? 'red' : 'default'}>累计错误 {totalErrors} 次</Tag>
            </div>

            {/* 排序工具 */}
            {selectedQuestions.length > 1 && (
              <Space size={4} style={{ marginBottom: 8 }}>
                <Button size="small" icon={<SortAscendingOutlined />} onClick={sortSelectedByErrors}>按错误降序</Button>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>↑↓ 可调整题目顺序</Typography.Text>
              </Space>
            )}

            {/* Selected list（顺序即试卷顺序） */}
            <div style={{ maxHeight: 300, overflow: 'auto', marginBottom: 12 }}>
              {selectedQuestions.length === 0
                ? <Empty description="点击左侧题目的行或「随机抽题」来选择" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                : selectedQuestions.map((q, i) => (
                  <div key={q.id} style={{
                    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px',
                    borderBottom: '1px solid #f0f0f0', fontSize: 12
                  }}>
                    <span style={{ color: '#1677ff', fontWeight: 600, minWidth: 38, fontSize: 12 }}>第{i + 1}题</span>
                    {hasGraphic(q) ? (
                      <Image src={getGraphicSrc(q)} width={34} height={34}
                        style={{ objectFit: 'cover', borderRadius: 3, border: '1px solid #52c41a', flexShrink: 0 }}
                        preview={{ mask: <span style={{ fontSize: 10 }}>查看</span> }} />
                    ) : q.has_graphics === 1 ? (
                      <Image src={q.image_url} width={34} height={34}
                        style={{ objectFit: 'cover', borderRadius: 3, border: '1px solid #fa8c16', flexShrink: 0 }}
                        preview={{ mask: <span style={{ fontSize: 10 }}>查看</span> }} />
                    ) : null}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#666', fontSize: 11 }}>
                      {categoryLabel(q)} · {(q.ocr_text || '纯图形题').slice(0, 22)}
                    </span>
                    <Tooltip title="上移">
                      <Button size="small" type="text" style={{ padding: 0, fontSize: 11 }} icon={<UpOutlined />}
                        disabled={i === 0} onClick={() => moveSelected(i, -1)} />
                    </Tooltip>
                    <Tooltip title="下移">
                      <Button size="small" type="text" style={{ padding: 0, fontSize: 11 }} icon={<DownOutlined />}
                        disabled={i === selectedQuestions.length - 1} onClick={() => moveSelected(i, 1)} />
                    </Tooltip>
                    <Button size="small" type="link" danger style={{ padding: '0 2px', fontSize: 11 }}
                      onClick={() => removeSelected(q.id)}>移</Button>
                  </div>
                ))}
            </div>

            <Divider style={{ margin: '8px 0' }} />

            {/* PDF Options */}
            <Typography.Text strong style={{ fontSize: 13 }}>导出设置</Typography.Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, minWidth: 56 }}>标题</span>
                <Input size="small" value={pdfTitle} onChange={e => setPdfTitle(e.target.value)} style={{ flex: 1 }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, minWidth: 56 }}>纸张</span>
                <Radio.Group size="small" value={pageSize} onChange={e => setPageSize(e.target.value)}>
                  <Radio.Button value="A4">A4</Radio.Button>
                  <Radio.Button value="Letter">Letter</Radio.Button>
                </Radio.Group>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, minWidth: 56 }}>显示解析</span>
                <Switch size="small" checked={showAnswers} onChange={setShowAnswers} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, minWidth: 56 }}>答题卡</span>
                <Switch size="small" checked={includeAnswerSheet} onChange={setIncludeAnswerSheet} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, minWidth: 56 }}>题目图片</span>
                <Switch size="small" checked={onlyGraphicsImages} onChange={setOnlyGraphicsImages} />
                <span style={{ fontSize: 11, color: '#888' }}>
                  {onlyGraphicsImages ? '仅图形题' : '全部显示'}
                </span>
              </div>
            </div>

            {/* Export button */}
            <Button
              type="primary" size="large" block
              icon={<ExportOutlined />}
              onClick={handleExport}
              loading={exporting}
              disabled={selectedOrder.length === 0}
              style={{ marginTop: 16 }}
            >
              {exporting ? exportProgress || '生成中...' : `导出 PDF（${selectedOrder.length} 题）`}
            </Button>
          </Card>
        </Col>
      </Row>

      {/* 导出前预览 Modal */}
      <Modal
        title="确认导出试卷"
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        onOk={doExport}
        okText="确认导出"
        cancelText="再调整"
        width={520}
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="导出顺序 = 右侧「已选题目」列表顺序，可返回再调整" />
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <div style={{ fontSize: 13 }}><b>标题：</b>{pdfTitle || '错题练习卷'}</div>
          <div style={{ fontSize: 13 }}><b>题量：</b>{selectedOrder.length} 题（图形题 {graphicsCount} 张）</div>
          <div style={{ fontSize: 13 }}><b>累计错误：</b>{totalErrors} 次</div>
          <div style={{ fontSize: 13 }}><b>选项：</b>纸张 {pageSize} · {showAnswers ? '含解析' : '纯题目'} · {includeAnswerSheet ? '附答题卡' : '无答题卡'} · 图片{onlyGraphicsImages ? '仅图形' : '全部'}</div>
        </Space>
        <div style={{ marginTop: 12, maxHeight: 200, overflow: 'auto', borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
          {selectedQuestions.map((q, i) => (
            <div key={q.id} style={{ fontSize: 12, padding: '2px 0', color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              第{i + 1}题 · {categoryLabel(q)} · {(q.ocr_text || '纯图形题').slice(0, 40)}
            </div>
          ))}
        </div>
      </Modal>

      {/* Crop dialog */}
      <CanvasCrop
        open={cropOpen}
        imagePath={cropDataUrl}
        onOk={async (result) => {
          setCropOpen(false)
          if (!cropTarget) return
          try {
            const cropResult = await window.api.cropAndSaveGraphic({
              imageUrl: cropTarget.image_url,
              crop: result.crop,
              rotation: result.rotation
            })
            if (cropResult.success) {
              await window.api.updateQuestion(cropTarget.id, {
                has_graphics: 1,
                graphic_image_path: `file://${cropResult.filePath}`
              })
              message.success('图形区域已保存，刷新后可预览')
              handleCropSaved()
            } else {
              message.error(cropResult.error || '保存失败')
            }
          } catch (err: any) {
            message.error(`保存失败: ${err.message}`)
          }
        }}
        onSkip={() => {
          setCropOpen(false)
          if (cropTarget) {
            window.api.cropAndSaveGraphic({
              imageUrl: cropTarget.image_url,
              crop: null,
              rotation: 0
            }).then(res => {
              if (res.success) {
                window.api.updateQuestion(cropTarget.id, {
                  has_graphics: 1,
                  graphic_image_path: `file://${res.filePath}`
                })
                message.success('已将原图标记为图形')
                handleCropSaved()
              }
            })
          }
        }}
        onCancel={() => setCropOpen(false)}
      />

      {/* 对答案回填 Modal */}
      <Modal
        title={`对答案回填（${selectedQuestions.length} 题）`}
        open={answerOpen}
        onCancel={() => setAnswerOpen(false)}
        onOk={handleSubmitAnswers}
        okText="提交回填"
        cancelText="取消"
        width={560}
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="勾选本次做错的题目，提交后错误次数 +1 并同步对应知识卡片（薄弱点权重提升）" />
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {selectedQuestions.map((q, i) => (
            <div key={q.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px',
              borderBottom: '1px solid #f5f5f5'
            }}>
              <Checkbox
                checked={wrongSet.has(q.id)}
                onChange={(e) => {
                  setWrongSet(prev => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(q.id)
                    else next.delete(q.id)
                    return next
                  })
                }}
              >
                <Tag color={q.error_count >= 3 ? 'red' : q.error_count >= 2 ? 'orange' : 'default'} style={{ margin: 0 }}>
                  错 {q.error_count} 次
                </Tag>
              </Checkbox>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                {i + 1}. {categoryLabel(q)} · {(q.ocr_text || '纯图形题').slice(0, 30)}
              </span>
              <span style={{ fontSize: 11, color: wrongSet.has(q.id) ? '#ff4d4f' : '#bbb', flexShrink: 0 }}>
                {wrongSet.has(q.id) ? '✗ 做错了' : '✓ 做对了'}
              </span>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
