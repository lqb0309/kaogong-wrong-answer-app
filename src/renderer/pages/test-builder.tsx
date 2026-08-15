import { useState, useEffect, useCallback } from 'react'
import { Typography, Card, Table, Button, Tag, Space, App, Input, Select, Row, Col, Image, Empty, InputNumber, Switch, Radio, Divider, Tooltip } from 'antd'
import {
  ReloadOutlined, ClearOutlined,
  ExportOutlined, FileImageOutlined, ScissorOutlined, PictureOutlined
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
  const [allQuestions, setAllQuestions] = useState<Question[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')

  // Crop state
  const [cropOpen, setCropOpen] = useState(false)
  const [cropTarget, setCropTarget] = useState<Question | null>(null)
  const [cropDataUrl, setCropDataUrl] = useState('')

  // Filters
  const [filterLevel1, setFilterLevel1] = useState<string | undefined>()
  const [filterLevel2, setFilterLevel2] = useState<string | undefined>()
  const [search, setSearch] = useState('')

  // 分类树（一级/二级筛选用）
  const { tree, loaded: treeLoaded, load: loadTree } = useTagTreeStore()
  useEffect(() => { if (!treeLoaded) loadTree() }, [treeLoaded, loadTree])
  const level1Options = tree.map((n: any) => ({ value: n.name, label: n.name }))
  const level2Options = filterLevel1
    ? tree.find((n: any) => n.name === filterLevel1)?.children.map((c: any) => ({ value: c.name, label: c.name })) || []
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
      // If readImageDataUrl fails for file://, try downloadImageAsDataUrl with the image_url as fallback
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
      const res = await window.api.getQuestions({ status: 'confirmed', pageSize: 500, level1: filterLevel1, level2: filterLevel2, search })
      const items = res.items || []
      setAllQuestions(items)
      // Load graphic previews for questions with graphics
      for (const q of items) {
        if (q.graphic_image_path) loadGraphicPreview(q)
      }
    } catch { /* */ }
    setLoading(false)
  }, [filterLevel1, filterLevel2, search])

  useEffect(() => { loadQuestions() }, [loadQuestions])

  // Selection handlers
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  const selectAllFiltered = () => {
    const ids = allQuestions.map(q => q.id)
    setSelectedIds(new Set([...selectedIds, ...ids]))
  }

  const handleRandomSelect = () => {
    const available = allQuestions.filter(q => !selectedIds.has(q.id))
    const shuffled = [...available].sort(() => Math.random() - 0.5)
    const toAdd = shuffled.slice(0, Math.min(randomCount, shuffled.length))
    setSelectedIds(new Set([...selectedIds, ...toAdd.map(q => q.id)]))
    message.success(`随机选中 ${toAdd.length} 道题`)
  }

  const clearSelection = () => setSelectedIds(new Set())

  const removeSelected = (id: string) => {
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
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

  // After crop saved, refresh question data
  const handleCropSaved = () => {
    loadQuestions()
  }

  // Export PDF
  const handleExport = async () => {
    if (selectedIds.size === 0) { message.warning('请先选择题'); return }
    setExporting(true)
    setExportProgress('正在下载题目图片...')
    try {
      const result = await window.api.generateTestPdf(Array.from(selectedIds), {
        title: pdfTitle,
        showAnswers,
        pageSize,
        includeAnswerSheet,
        imageMode: onlyGraphicsImages ? 'graphics_only' : 'full'
      })

      if (!result.success) {
        message.error(result.error || 'PDF 生成失败')
        setExporting(false)
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
    }
    setExporting(false)
    setExportProgress('')
  }

  // Selected items sorted
  const selectedQuestions = allQuestions.filter(q => selectedIds.has(q.id))

  const categoryLabel = (q: Question) => [q.level1, q.level2, q.level3].filter(Boolean).join(' › ')

  // Check if a question has a cropped graphic image (with preview loaded)
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
          {selectedIds.has(r.id)
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
        subtitle="选题 / 随机抽题 → 导出 PDF 试卷"
        extra={
          <Button icon={<ReloadOutlined />} onClick={loadQuestions} loading={loading}>刷新</Button>
        }
      />

      <Row gutter={16}>
        {/* Left: Question Browser */}
        <Col span={14}>
          <Card size="small" title={<span>📋 错题库（共 {allQuestions.length} 题）</span>}
            extra={<Space size="small">
              <Select size="small" placeholder="一级分类" allowClear style={{ width: 100 }} value={filterLevel1}
                onChange={(v) => { setFilterLevel1(v); setFilterLevel2(undefined) }}
                options={level1Options} />
              <Select size="small" placeholder="二级" allowClear style={{ width: 100 }} value={filterLevel2}
                onChange={setFilterLevel2} options={level2Options} disabled={!filterLevel1} />
              <Input size="small" placeholder="搜索..." style={{ width: 120 }} value={search}
                onChange={e => setSearch(e.target.value)} allowClear />
              <Button size="small" onClick={selectAllFiltered}>全选</Button>
            </Space>}>
            <Table dataSource={allQuestions} columns={questionCols} rowKey="id" size="small"
              pagination={{ pageSize: 15, size: 'small', showSizeChanger: false }}
              scroll={{ y: 400 }}
              onRow={(r) => ({
                onClick: () => toggleSelect(r.id),
                style: { cursor: 'pointer', background: selectedIds.has(r.id) ? '#e6f4ff' : undefined }
              })} />
            <div style={{ marginTop: 4, fontSize: 11, color: '#999' }}>
              <PictureOutlined style={{ color: '#fa8c16' }} /> = 已标记图形题 &nbsp;
              <Image src="" width={14} height={14} style={{ border: '1px solid #52c41a', borderRadius: 2, verticalAlign: 'middle' }} preview={false} /> = 已裁剪图形区域
              &nbsp; ✂️ = 裁剪/编辑图形
            </div>
          </Card>
        </Col>

        {/* Right: Selection Panel */}
        <Col span={10}>
          <Card size="small" title={<span>✅ 已选题目（{selectedIds.size} 题）</span>}
            extra={<Space size="small">
              <InputNumber size="small" min={1} max={500} value={randomCount} onChange={v => setRandomCount(v || 10)} style={{ width: 52 }} />
              <Button size="small" onClick={handleRandomSelect}>🎲 随机抽题</Button>
              <Button size="small" icon={<ClearOutlined />} danger onClick={clearSelection} disabled={selectedIds.size === 0}>清空</Button>
            </Space>}>

            {/* Selected list with graphic previews */}
            <div style={{ maxHeight: 240, overflow: 'auto', marginBottom: 12 }}>
              {selectedQuestions.length === 0
                ? <Empty description="点击左侧题目的行或「随机抽题」来选择" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                : selectedQuestions.map((q, i) => (
                  <div key={q.id} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                    borderBottom: '1px solid #f0f0f0', fontSize: 12
                  }}>
                    <span style={{ color: '#1677ff', fontWeight: 600, minWidth: 26, fontSize: 12 }}>第{i + 1}题</span>
                    {/* Show the actual image that will go into PDF */}
                    {hasGraphic(q) ? (
                      <Image src={getGraphicSrc(q)} width={36} height={36}
                        style={{ objectFit: 'cover', borderRadius: 3, border: '1px solid #52c41a', flexShrink: 0 }}
                        preview={{ mask: <span style={{ fontSize: 10 }}>查看</span> }} />
                    ) : q.has_graphics === 1 ? (
                      <Image src={q.image_url} width={36} height={36}
                        style={{ objectFit: 'cover', borderRadius: 3, border: '1px solid #fa8c16', flexShrink: 0 }}
                        preview={{ mask: <span style={{ fontSize: 10 }}>查看</span> }} />
                    ) : null}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#666', fontSize: 11 }}>
                      {categoryLabel(q)} · {(q.ocr_text || '纯图形题').slice(0, 25)}
                    </span>
                    <Button size="small" type="link" danger style={{ padding: '0 2px', fontSize: 11 }}
                      onClick={() => removeSelected(q.id)}>移除</Button>
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
              disabled={selectedIds.size === 0}
              style={{ marginTop: 16 }}
            >
              {exporting ? exportProgress || '生成中...' : `导出 PDF（${selectedIds.size} 题）`}
            </Button>
          </Card>
        </Col>
      </Row>

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
    </div>
  )
}
