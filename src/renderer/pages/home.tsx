import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Typography, Button, App, Card, Tag, Space, Checkbox, Image, Badge, Progress, Popconfirm, Empty, Row, Col, Tooltip, Statistic, Tabs } from 'antd'
import {
  PlusOutlined, ThunderboltOutlined, ClockCircleOutlined, DeleteOutlined,
  CheckOutlined, CloseOutlined, LoadingOutlined, EditOutlined,
  InboxOutlined, FireOutlined, FileImageOutlined, CheckSquareOutlined, SyncOutlined
} from '@ant-design/icons'
import { usePendingStore } from '@/stores/pending'
import { useClassifyJobsStore } from '@/stores/classify-jobs'
import { CanvasCrop } from '@/components/canvas-crop'
import { PageHeader } from '@/components/page-header'
import { SetupBanner } from '@/components/setup-banner'

interface LibItem {
  id: string
  imageUrl: string
  localPath: string
  level1: string | null
  level2: string | null
  level3: string | null
  confidence: number | null
  status: 'pending' | 'classifying' | 'classified' | 'confirmed'
  traceId: string
  fileName: string
  createdAt: string
}

// 图片加载失败占位图
const IMG_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#f5f5f5"/><text x="60" y="62" font-size="12" text-anchor="middle" fill="#bbb">图片加载失败</text></svg>'
)

export function HomePage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { addItems } = usePendingStore()
  const { jobs: classifyJobs, setJob: setClassifyJob, active: classifying, setActive: setClassifying, clear: clearClassifyJobs } = useClassifyJobsStore()

  const [library, setLibrary] = useState<LibItem[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; fileName: string } | null>(null)
  const [cropTarget, setCropTarget] = useState<LibItem | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [overview, setOverview] = useState<{ pendingCount: number; classifiedCount: number; confirmedCount: number; todayCount: number; streak: number; retryQueueSize: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'classified'>('all')

  const refreshOverview = useCallback(async () => {
    try {
      const data = await window.api.getAppOverview()
      setOverview(data)
      setPendingCount(data.pendingCount + data.classifiedCount)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    refreshOverview()
    loadLibrary()
  }, [refreshOverview])

  // Upload progress events from main process
  useEffect(() => {
    const unsub = window.api.onUploadProgress((data) => {
      setUploadProgress({ done: data.done || 0, total: data.total || 0, fileName: data.fileName || '' })
      if (data.done >= data.total) {
        setTimeout(() => setUploadProgress(null), 2000)
      }
    })
    return () => unsub?.()
  }, [])

  // Clipboard paste support
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      let hasImage = false
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) { hasImage = true; break }
      }
      if (!hasImage) return

      e.preventDefault()
      setImporting(true)
      try {
        const result = await window.api.pasteImage()
        if (result.success) {
          const qId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          await window.api.writeToObsidian({
            id: qId, imageUrl: result.url, level1: '未分类', level2: '', level3: null,
            confidence: 0, ocrText: '', reasoning: '', errorCount: 1, source: '',
            traceId: result.traceId, fileName: `粘贴-${new Date().toLocaleTimeString()}.png`, status: 'pending',
            localAbsPath: result.localAbsPath
          })
          message.success('图片已粘贴到成品库')
          loadLibrary()
        } else {
          message.error(result.error || '剪贴板中无图片')
        }
      } catch (err: any) {
        message.error(`粘贴失败: ${err.message}`)
      }
      setImporting(false)
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [message])

  // Listen for AI progress (preserve fileName from initial setClassifyJob)
  const classifyJobsRef = useRef(classifyJobs)
  classifyJobsRef.current = classifyJobs
  useEffect(() => {
    const unsub = window.api.onAiProgress((data) => {
      const existing = classifyJobsRef.current[data.traceId]
      setClassifyJob({ traceId: data.traceId, fileName: existing?.fileName || '', stage: data.stage, message: data.message, ts: data.ts })
    })
    return () => unsub?.()
  }, [setClassifyJob])

  const loadLibrary = async () => {
    try {
      const result = await window.api.getQuestions({ page: 1, pageSize: 500, status: 'all' })
      const filtered = (result.items || []).filter((q: any) => q.status !== 'confirmed')
      const items: LibItem[] = filtered.map((q: any) => ({
        id: q.id,
        imageUrl: q.image_url,
        localPath: q.local_image_path || '',
        level1: q.level1,
        level2: q.level2,
        level3: q.level3,
        confidence: q.confidence,
        status: q.status as LibItem['status'],
        traceId: q.trace_id || '',
        fileName: q.image_url?.split('/').pop() || '',
        createdAt: q.created_at || ''
      }))
      setLibrary(items)
      // 同步待确认角标（pending + classified）
      window.api.getPendingCount().then(setPendingCount)
    } catch (err: any) {
      console.error('loadLibrary error:', err)
      message.error(`加载成品库失败: ${err.message}`)
    }
  }

  // ── 导入：选择文件 / 拖拽 / 粘贴 ──
  const importPaths = async (paths: string[]) => {
    if (!paths || paths.length === 0) return
    // 同一批内去重
    const unique = Array.from(new Set(paths))
    setImporting(true)
    const results = await window.api.uploadImages(unique.map(fp => ({ path: fp, rotation: 0 })))
    let ok = 0
    let dupCount = 0
    for (const res of results) {
      if (res?.duplicate) { dupCount++; continue }
      if (res?.success) {
        const qId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        await window.api.writeToObsidian({
          id: qId, imageUrl: res.url, level1: '未分类', level2: '', level3: null,
          confidence: 0, ocrText: '', reasoning: '', errorCount: 1, source: '',
          traceId: res.traceId, fileName: (res.filePath || 'unknown').split('/').pop() || 'unknown', status: 'pending',
          localAbsPath: res.localAbsPath, fileHash: res.fileHash
        })
        ok++
      }
    }
    setImporting(false)
    loadLibrary()
    const failCount = results.length - ok - dupCount
    const parts: string[] = [`已导入 ${ok} 张图片`]
    if (dupCount > 0) parts.push(`跳过 ${dupCount} 张重复图片`)
    if (failCount > 0) parts.push(`${failCount} 张失败`)
    message[ok > 0 ? 'success' : failCount > 0 ? 'error' : 'warning'](parts.join('，'))
  }

  const handleImport = async () => {
    const paths = await window.api.selectFiles()
    await importPaths(paths)
  }

  // 拖拽上传（Electron 的 File 对象带 .path）
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f: any) => f.path)
      .filter((p: string) => /\.(jpg|jpeg|png|webp)$/i.test(p))
    if (paths.length > 0) importPaths(paths)
    else message.warning('仅支持 jpg / png / webp 图片')
  }

  // ── 编辑（旋转/裁剪）──
  const handleEditItem = (item: LibItem) => {
    setEditingId(item.id)
    setCropTarget(item)
  }

  const handleCropDone = async (result: { rotation: number; crop: { x: number; y: number; width: number; height: number } | null }) => {
    const item = cropTarget
    if (!item) return
    setCropTarget(null); setEditingId(null)
    try {
      const localPath = item.localPath
      if (localPath) {
        const res = await window.api.uploadImages([{ path: localPath, rotation: result.rotation, crop: result.crop || undefined }])
        if (res[0]?.success) {
          const up = res[0]
          const qId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          await window.api.writeToObsidian({
            id: qId, imageUrl: up.url, level1: '未分类', level2: '', level3: null,
            confidence: 0, ocrText: '', reasoning: '', errorCount: 1, source: '',
            traceId: up.traceId, fileName: localPath.split('/').pop() || 'unknown', status: 'pending',
            localAbsPath: up.localAbsPath
          })
          await window.api.deleteQuestion(item.id)
          message.success('编辑完成')
        }
      } else {
        message.warning('无法获取本地图片路径')
      }
    } catch (err: any) { message.error(`编辑失败: ${err.message}`) }
    loadLibrary()
  }

  const handleCropSkip = () => { setCropTarget(null); setEditingId(null) }

  // ── 批量 AI 分类（核心：按传入列表分类） ──
  const classifyItems = useCallback(async (items: LibItem[]) => {
    if (items.length === 0) return
    setClassifying(true)
    clearClassifyJobs()
    const concurrency = 3
    const queue = [...items]

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift()!
        setClassifyJob({ traceId: item.traceId, fileName: item.fileName, stage: 'start', message: '开始分类...', ts: Date.now() })

        try {
          const aiResult = await window.api.classifyImage(item.imageUrl, item.traceId)
          if (aiResult.success) {
            setLibrary((prev) => prev.filter((q) => q.id !== item.id))
            // 持久化 AI 结果 + 状态，重启后待确认队列可恢复
            await window.api.updateQuestion(item.id, {
              level1: aiResult.level1 || '未分类',
              level2: aiResult.level2 || '',
              level3: aiResult.level3 || null,
              confidence: aiResult.confidence || 0,
              ocr_text: aiResult.ocr_text || '',
              reasoning: aiResult.reasoning || '',
              match_type: aiResult.fuzzy_match_type || 'unknown',
              ai_raw_level1: aiResult.raw_level1 || aiResult.level1,
              ai_raw_level2: aiResult.raw_level2 || aiResult.level2,
              ai_raw_level3: aiResult.raw_level3 || aiResult.level3 || null,
              has_graphics: aiResult.has_graphics ? 1 : 0
            })
            await window.api.updateQuestionStatus(item.id, 'classified')
            setClassifyJob({ traceId: item.traceId, fileName: item.fileName, stage: 'done', message: `${aiResult.level1}/${aiResult.level2}`, ts: Date.now() })
            addItems([{
              id: item.id, imageUrl: item.imageUrl,
              level1: aiResult.level1 || '未分类', level2: aiResult.level2 || '', level3: aiResult.level3 || null,
              confidence: aiResult.confidence || 0, ocrText: aiResult.ocr_text || '', reasoning: aiResult.reasoning || '',
              matchType: aiResult.fuzzy_match_type || 'unknown', matchScore: aiResult.fuzzy_match_score,
              errorCount: 1, source: '', reflection: aiResult.reflection || '', errorType: '', warning: aiResult.warning, traceId: item.traceId,
              aiRawLevel1: aiResult.raw_level1 || aiResult.level1, aiRawLevel2: aiResult.raw_level2 || aiResult.level2, aiRawLevel3: aiResult.raw_level3 || aiResult.level3,
              hasGraphics: aiResult.has_graphics || false,
              graphicsDescription: aiResult.graphics_description || ''
            }])
          } else {
            setClassifyJob({ traceId: item.traceId, fileName: item.fileName, stage: 'error', message: aiResult.error || '失败', ts: Date.now() })
          }
        } catch (err: any) {
          setClassifyJob({ traceId: item.traceId, fileName: item.fileName, stage: 'error', message: err.message, ts: Date.now() })
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    setClassifying(false)
    setSelected([])
    message.success('AI 分类完成')
  }, [addItems, message, setClassifyJob, clearClassifyJobs, setClassifying, setSelected])

  const handleBatchClassify = useCallback(async () => {
    const toClassify = library.filter((q) => selected.includes(q.id) && q.status === 'pending')
    if (toClassify.length === 0) { message.warning('请选择待分类的图片'); return }
    await classifyItems(toClassify)
  }, [library, selected, classifyItems, message])

  // 单题失败重试
  const retryClassify = useCallback(async (traceId: string, fileName: string) => {
    const item = library.find((q) => q.traceId === traceId && q.status === 'pending')
    if (!item) { message.warning('该图片已不在成品库中'); return }
    setClassifyJob({ traceId, fileName, stage: 'start', message: '重试中...', ts: Date.now() })
    await classifyItems([item])
  }, [library, classifyItems, message, setClassifyJob])

  // 手动刷新重试队列
  const handleFlushRetry = useCallback(async () => {
    try {
      const res = await window.api.flushRetryQueue()
      if (res.flushed > 0) message.success(`已补写 ${res.flushed} 条到 Obsidian`)
      else if (res.failed > 0) message.warning(`仍有 ${res.failed} 条待写入（请检查 Vault 路径）`)
      else message.info('没有待重试的写入')
      refreshOverview()
    } catch (err: any) {
      message.error(`刷新失败: ${err.message}`)
    }
  }, [message, refreshOverview])

  const handleDelete = async (id: string) => {
    await window.api.deleteQuestion(id)
    setLibrary((prev) => prev.filter((q) => q.id !== id))
    setSelected((prev) => prev.filter((x) => x !== id))
  }

  const pendingItems = library.filter((q) => q.status === 'pending')
  const classifiedItems = library.filter((q) => q.status === 'classified')
  const visibleLibrary = statusFilter === 'all' ? library : library.filter((q) => q.status === statusFilter)

  // Progress helpers
  const jobProgress = (job: { stage: string }) => {
    switch (job.stage) {
      case 'start': return 10
      case 'vision': return 30
      case 'reason': return 65
      case 'reflection': return 90
      case 'done': return 100
      case 'error': return 100
      default: return 50
    }
  }
  const stageProgress = (jobs: { stage: string }[]) => {
    if (jobs.length === 0) return 0
    return Math.round(jobs.reduce((sum, j) => sum + jobProgress(j), 0) / jobs.length)
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  return (
    <div>
      <PageHeader
        title="成品库"
        subtitle="导入错题截图 → 批量 AI 分类 → 人工确认入库"
        extra={
          <Space>
            <Button icon={<PlusOutlined />} type="primary" onClick={handleImport} loading={importing}>
              {importing ? '导入中...' : '导入图片'}
            </Button>
            <Button onClick={() => navigate('/pending')}>
              <Badge count={pendingCount} size="small" offset={[6, -2]}>
                <ClockCircleOutlined /> 待确认
              </Badge>
            </Button>
          </Space>
        }
      />

      <SetupBanner />

      {/* 概览统计（点击卡片可跳转） */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={4}>
          <Card size="small" hoverable style={{ cursor: 'pointer' }} onClick={() => { if (pendingItems.length > 0) setSelected(pendingItems.map(q => q.id)) }}>
            <Statistic title="待分类" value={overview?.pendingCount ?? pendingItems.length} prefix={<FileImageOutlined />} valueStyle={{ fontSize: 20 }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" hoverable style={{ cursor: 'pointer' }} onClick={() => navigate('/pending')}>
            <Statistic title="待确认" value={pendingCount} prefix={<ClockCircleOutlined />} valueStyle={{ fontSize: 20, color: '#1677ff' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" hoverable style={{ cursor: 'pointer' }} onClick={() => navigate('/knowledge')}>
            <Statistic title="今日新增" value={overview?.todayCount ?? 0} suffix="题" prefix={<PlusOutlined />} valueStyle={{ fontSize: 20, color: '#722ed1' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" hoverable style={{ cursor: 'pointer' }} onClick={() => navigate('/questions')}>
            <Statistic title="已入库" value={overview?.confirmedCount ?? 0} prefix={<CheckOutlined />} valueStyle={{ fontSize: 20, color: '#52c41a' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" hoverable style={{ cursor: 'pointer' }} onClick={() => navigate('/stats')}>
            <Statistic title="连续使用" value={overview?.streak ?? 0} suffix="天" prefix={<FireOutlined />} valueStyle={{ fontSize: 20, color: '#fa8c16' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" hoverable style={{ cursor: 'pointer', borderColor: (overview?.retryQueueSize ?? 0) > 0 ? '#ffd591' : undefined }}
            onClick={handleFlushRetry}>
            <Statistic title="待补写" value={overview?.retryQueueSize ?? 0} suffix="条" prefix={<SyncOutlined />}
              valueStyle={{ fontSize: 20, color: (overview?.retryQueueSize ?? 0) > 0 ? '#fa8c16' : '#999' }} />
          </Card>
        </Col>
      </Row>

      {/* 拖拽上传区 */}
      <Card
        size="small"
        style={{ marginBottom: 12, border: dragOver ? '2px dashed #1677ff' : '2px dashed #d9d9d9', background: dragOver ? '#e6f4ff' : '#fafafa' }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div onClick={handleImport} style={{ cursor: 'pointer', textAlign: 'center', padding: '10px 0', userSelect: 'none' }}>
          <InboxOutlined style={{ fontSize: 30, color: dragOver ? '#1677ff' : '#bfbfbf' }} />
          <div style={{ marginTop: 6, color: dragOver ? '#1677ff' : '#666', fontWeight: 500 }}>
            {dragOver ? '松开鼠标导入图片' : '拖拽图片到这里，或点击选择文件'}
          </div>
          <div style={{ marginTop: 2, fontSize: 12, color: '#999' }}>
            支持 jpg / png / webp（≤20MB）· 可多选 · 也可 Cmd+V / Ctrl+V 粘贴截图
          </div>
        </div>
      </Card>

      {/* Upload progress */}
      {uploadProgress && uploadProgress.total > 0 && (
        <Card size="small" style={{ marginBottom: 12, border: '1px solid #1677ff40' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Typography.Text strong style={{ flexShrink: 0 }}>图片导入</Typography.Text>
            <Progress percent={Math.round((uploadProgress.done / uploadProgress.total) * 100)} size="small" style={{ flex: 1, margin: 0 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{uploadProgress.done}/{uploadProgress.total} · {uploadProgress.fileName}</Typography.Text>
          </div>
        </Card>
      )}

      {/* Classify progress */}
      {(classifying || Object.keys(classifyJobs).length > 0) && (
        <Card size="small" style={{ marginBottom: 12, border: '1px solid #1677ff40' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Typography.Text strong>AI 分类进度</Typography.Text>
            <Progress percent={stageProgress(Object.values(classifyJobs))} size="small" style={{ width: 120 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 200, overflow: 'auto' }}>
            {Object.values(classifyJobs).map((job) => (
              <div key={job.traceId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '2px 0' }}>
                {job.stage === 'done' ? <CheckOutlined style={{ color: '#52c41a', flexShrink: 0 }} />
                  : job.stage === 'error' ? <CloseOutlined style={{ color: '#ff4d4f', flexShrink: 0 }} />
                  : <LoadingOutlined style={{ color: '#1677ff', flexShrink: 0 }} />}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.fileName || job.traceId}</span>
                <Progress percent={jobProgress(job)} size="small" style={{ width: 60, margin: 0 }} strokeWidth={6} showInfo={false} />
                <span style={{ color: job.stage === 'error' ? '#ff4d4f' : '#888', flexShrink: 0, fontSize: 11 }}>{job.message}</span>
                {job.stage === 'error' && (
                  <Button size="small" type="link" style={{ padding: '0 4px', fontSize: 11, flexShrink: 0 }}
                    onClick={() => retryClassify(job.traceId, job.fileName)}>重试</Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 工具条 + 状态筛选 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <Space wrap>
          <Tabs size="small" activeKey={statusFilter} onChange={(k) => setStatusFilter(k as any)}
            items={[
              { key: 'all', label: `全部 (${library.length})` },
              { key: 'pending', label: `待分类 (${pendingItems.length})` },
              { key: 'classified', label: `已分类 (${classifiedItems.length})` }
            ]}
            style={{ marginBottom: 0 }}
          />
          {selected.length > 0 && <Button size="small" onClick={() => setSelected([])}>取消全选（{selected.length}）</Button>}
        </Space>
        <Space>
          <Button size="small" icon={<CheckSquareOutlined />} onClick={() => setSelected(pendingItems.map(q => q.id))}
            disabled={pendingItems.length === 0}>全选待分类</Button>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleBatchClassify} loading={classifying}
            disabled={pendingItems.length === 0}>
            批量 AI 分类（{pendingItems.length}）
          </Button>
        </Space>
      </div>

      {/* 图片网格 */}
      {visibleLibrary.length === 0 ? (
        <Card>
          <Empty description={statusFilter === 'all' ? '点击上方「导入图片」，或直接拖拽截图到此处' : statusFilter === 'pending' ? '没有待分类的图片' : '没有已分类待确认的图片'}
            image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      ) : (
        <Row gutter={[12, 12]}>
          {visibleLibrary.map((item) => {
            const isSelected = selected.includes(item.id)
            return (
              <Col xs={12} sm={8} md={6} lg={4} xl={4} key={item.id}>
                <Card
                  size="small"
                  hoverable
                  style={{ borderColor: isSelected ? '#1677ff' : undefined }}
                  cover={
                    <div style={{ position: 'relative' }}>
                      <Image
                        src={item.imageUrl}
                        height={130}
                        style={{ objectFit: 'cover', borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
                        preview={{ mask: '点击查看' }}
                        fallback={IMG_FALLBACK}
                      />
                      <Checkbox
                        checked={isSelected}
                        onChange={() => toggleSelect(item.id)}
                        style={{ position: 'absolute', top: 6, left: 6, background: 'rgba(255,255,255,0.9)', borderRadius: 4, padding: 2 }}
                      />
                      {item.status === 'classified' && item.confidence != null && item.confidence > 0 && (
                        <Tag color={item.confidence < 0.6 ? 'orange' : 'blue'} style={{ position: 'absolute', top: 6, right: 6, margin: 0 }}>
                          {Math.round(item.confidence * 100)}%
                        </Tag>
                      )}
                    </div>
                  }
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Tooltip title={item.fileName}>
                      <Typography.Text ellipsis style={{ fontSize: 12, maxWidth: 110 }}>{item.fileName}</Typography.Text>
                    </Tooltip>
                    {item.status === 'pending' && <Tag color="default" style={{ margin: 0 }}>待分类</Tag>}
                    {item.status === 'classified' && <Tag color="blue" style={{ margin: 0 }}>{item.level1}{item.level2 ? `/${item.level2}` : ''}</Tag>}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#999' }}>{item.createdAt?.slice(0, 10)}</span>
                    <Space size={0}>
                      <Button size="small" type="link" style={{ padding: '0 4px' }} icon={<EditOutlined />}
                        onClick={() => handleEditItem(item)} />
                      {item.status === 'classified' && (
                        <Button size="small" type="link" style={{ padding: '0 4px' }} icon={<ClockCircleOutlined />}
                          onClick={() => navigate('/pending')} />
                      )}
                      <Popconfirm title="确认删除？" onConfirm={() => handleDelete(item.id)} okText="删除" cancelText="取消">
                        <Button size="small" type="link" danger style={{ padding: '0 4px' }} icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                </Card>
              </Col>
            )
          })}
        </Row>
      )}

      {/* Crop dialog */}
      <CanvasCrop
        open={!!cropTarget}
        imagePath={cropTarget?.localPath || ''}
        onOk={handleCropDone}
        onSkip={handleCropSkip}
        onCancel={() => { setCropTarget(null) }}
      />
    </div>
  )
}
