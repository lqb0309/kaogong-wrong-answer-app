import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Typography, Button, App, Card, Tag, Space, Checkbox, Badge, Progress, Popconfirm, Empty, Row, Col, Tooltip, Statistic, Tabs, Modal } from 'antd'
import { LoadingOutlined, FireOutlined, ApartmentOutlined, CloudDownloadOutlined } from '@ant-design/icons'
import { PlusOutlined, AiSparkOutlined, ClockCircleOutlined, DeleteOutlined, CheckOutlined, CloseOutlined, EditOutlined, InboxOutlined, FileImageOutlined, SyncOutlined, ArrowRightOutlined } from '@/components/study-icons'
import { usePendingStore, flushPendingDraft } from '@/stores/pending'
import { ImportThumbnail } from '@/components/import-thumbnail'
import { loadImportQueue, queueItemTitle, selectableQueueItems } from '@/import-queue'
import { useClassifyJobsStore } from '@/stores/classify-jobs'
import { useSettingsStore } from '@/stores/settings'
import { CanvasCrop } from '@/components/canvas-crop'
import { PageHeader } from '@/components/page-header'
import { SetupBanner } from '@/components/setup-banner'
import { NewQuestionDrawer } from '@/components/new-question-drawer'
import { FenbiImportDrawer } from '@/components/fenbi-import-drawer'

interface LibItem {
  id: string
  imageUrl: string
  localPath: string
  level1: string | null
  level2: string | null
  level3: string | null
  confidence: number | null
  status: 'pending' | 'classifying' | 'processing' | 'classified' | 'confirmed'
  traceId: string
  fileName: string
  createdAt: string
  text: string
}

export function HomePage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { addItems } = usePendingStore()
  const { jobs: classifyJobs, setJob: setClassifyJob, active: classifying, setActive: setClassifying, clear: clearClassifyJobs } = useClassifyJobsStore()

  const [library, setLibrary] = useState<LibItem[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const mutationLock = useRef(false)
  const [newQuestionOpen, setNewQuestionOpen] = useState(false)
  const [fenbiImportOpen, setFenbiImportOpen] = useState(false)
  const classifyingIdsRef = useRef(new Set<string>())
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; fileName: string } | null>(null)
  const [cropTarget, setCropTarget] = useState<LibItem | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [overview, setOverview] = useState<{ pendingCount: number; classifiedCount: number; confirmedCount: number; todayCount: number; streak: number; retryQueueSize: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'classified'>('all')
  const [dailyNoteReady, setDailyNoteReady] = useState(false)
  const [reviewedToday, setReviewedToday] = useState(0)
  const { get: getSetting } = useSettingsStore()

  const refreshOverview = useCallback(async () => {
    try {
      const data = await window.api.getAppOverview()
      setOverview(data)
      setPendingCount(data.classifiedCount)
    } catch { /* ignore */ }
    // 今日归纳状态 + 今日复习进度
    try {
      const notes = await window.api.getDailyNotes()
      const today = new Date().toISOString().slice(0, 10)
      setDailyNoteReady(!!notes.notes?.some((n: any) => n.date === today))
    } catch { /* ignore */ }
    try {
      const qr = await window.api.getReviewQueue()
      setReviewedToday(qr.reviewedToday?.length || 0)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    refreshOverview()
    loadLibrary()
  }, [refreshOverview])

  useEffect(() => window.api.onFenbiAnalysisProgress?.(event => {
    if (event.stage === 'complete') { void loadLibrary(); void refreshOverview() }
  }), [refreshOverview])

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
        if (result.success && result.url) {
          const qId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          await window.api.writeToObsidian({
            id: qId, imageUrl: result.url, level1: '未分类', level2: '', level3: null,
            confidence: 0, ocrText: '', reasoning: '', errorCount: 1, source: '',
            traceId: result.traceId, fileName: `粘贴-${new Date().toLocaleTimeString()}.png`, status: 'pending',
            localAbsPath: result.localAbsPath
          })
          message.success('图片已加入处理队列')
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

  const loadLibrary = async (): Promise<LibItem[]> => {
    try {
      const filtered = await loadImportQueue(params => window.api.getQuestions(params))
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
        fileName: queueItemTitle(q),
        createdAt: q.created_at || '',
        text: q.ocr_text || ''
      }))
      setLibrary(items)
      setSelected(ids => ids.filter(id => items.some(item => item.id === id && (item.status === 'pending' || item.status === 'classified'))))
      // 待确认只统计已完成 AI 分类的题目；未分类题目单独展示
      window.api.getPendingCount().then(setPendingCount).catch(() => undefined)
      return items
    } catch (err: any) {
      console.error('loadLibrary error:', err)
      message.error(`加载错题处理队列失败: ${err.message}`)
      return []
    }
  }

  // ── 导入：选择文件 / 拖拽 / 粘贴 ──
  const importPaths = async (paths: string[], browserFiles?: File[]) => {
    if ((!paths || paths.length === 0) && !browserFiles?.length) return
    // 同一批内去重
    const unique = Array.from(new Set(paths))
    setImporting(true)
    let results: any[]
    try {
      results = browserFiles?.length
        ? await (window.api as any).uploadBrowserImages(browserFiles)
        : await window.api.uploadImages(unique.map(fp => ({ path: fp, rotation: 0 })))
    } catch (error: any) { setImporting(false); message.error(error.message || '图片导入失败'); return }
    let ok = 0
    let dupCount = 0
    const importedIds: string[] = []
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
        importedIds.push(qId)
        ok++
      }
    }
    setImporting(false)
    const freshItems = await loadLibrary()
    refreshOverview()
    const failCount = results.length - ok - dupCount
    const parts: string[] = [`已导入 ${ok} 张图片`]
    if (dupCount > 0) parts.push(`跳过 ${dupCount} 张重复图片`)
    if (failCount > 0) parts.push(`${failCount} 张失败`)
    message[ok > 0 ? 'success' : failCount > 0 ? 'error' : 'warning'](parts.join('，'))

    // 流程接力：开启「导入后自动分类」时，新导入的图直接进 AI 分类
    if (ok > 0 && getSetting('auto_classify_after_import', 'false') === 'true') {
      const fresh = freshItems.filter((q) => importedIds.includes(q.id) && q.status === 'pending')
      if (fresh.length > 0) {
        message.info(`开始自动分类 ${fresh.length} 张图片...`)
        await classifyItems(fresh)
      }
    }
  }

  const handleImport = async () => {
    const paths = await window.api.selectFiles()
    await importPaths(paths)
  }

  const mergeSelectedAsMaterialGroup = async () => {
    const snapshots = library.filter(item => selected.includes(item.id))
    if (!snapshots.length || snapshots.some(item => item.status !== 'pending' || (!item.imageUrl && !item.localPath)) || mutationLock.current || classifying || importing) return
    setImporting(true)
    try {
      message.info(`正在把勾选的 ${selected.length} 张截图合并识别...`)
      const selectedImages = snapshots
        .map(item => ({ url: item.imageUrl, localAbsPath: item.localPath || undefined }))
      if (selectedImages.length === 0) throw new Error('未找到勾选截图，请刷新后重试')
      const result = await window.api.createMaterialGroup(selectedImages)
      if (!result.success) throw new Error(result.error || '资料题组识别失败')
      await Promise.all(selected.map(id => window.api.deleteQuestion(id)))
      setSelected([])
      await loadLibrary()
      refreshOverview()
      if ((result.createdIds?.length || 0) > 0) {
        message.success(`已识别 ${result.totalQuestions} 题，筛出 ${result.wrongQuestions} 道错题进入待确认`)
        navigate('/pending')
      } else {
        message.success(`识别 ${result.totalQuestions} 题，没有发现错题`)
      }
    } catch (err: any) {
      message.error(err.message || '合并题组失败')
    } finally {
      setImporting(false)
    }
  }

  // 拖拽上传（Electron 的 File 对象带 .path）
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f: any) => f.path)
      .filter((p: string) => /\.(jpg|jpeg|png|webp)$/i.test(p))
    if (paths.length > 0) importPaths(paths)
    else if ((window.api as any).uploadBrowserImages && e.dataTransfer.files.length) {
      const images = Array.from(e.dataTransfer.files).filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file.name))
      if (images.length) void importPaths([], images)
      else message.warning('仅支持 jpg / png / webp 图片')
    }
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
    const uniqueItems = Array.from(new Map(items.map(item => [item.id, item])).values())
      .filter(item => !classifyingIdsRef.current.has(item.id) && item.status === 'pending')
    if (uniqueItems.length === 0) {
      message.info('所选题目正在分类或已完成分类')
      return
    }
    uniqueItems.forEach(item => classifyingIdsRef.current.add(item.id))
    setClassifying(true)
    clearClassifyJobs()
    const concurrency = 3
    const queue = [...uniqueItems]
    let doneCount = 0

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift()!
        setClassifyJob({ traceId: item.traceId, fileName: item.fileName, stage: 'start', message: '开始分类...', ts: Date.now() })

        try {
          const aiResult = await window.api.classifyImage(item.imageUrl, item.traceId)
          if (aiResult.success) {
            doneCount++
            setLibrary((prev) => prev.filter((q) => q.id !== item.id))
            // 持久化 AI 结果 + 状态，重启后待确认队列可恢复
            await window.api.updateQuestion(item.id, {
              level1: aiResult.level1 || '未分类',
              level2: aiResult.level2 || '',
              level3: aiResult.level3 || null,
              confidence: aiResult.confidence || 0,
              ocr_text: aiResult.ocr_text || '',
              reasoning: aiResult.reasoning || '',
              reflection: aiResult.reflection || '',
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

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
    } finally {
      uniqueItems.forEach(item => classifyingIdsRef.current.delete(item.id))
      setClassifying(false)
      setSelected([])
      await loadLibrary()
      refreshOverview()
    }
    if (doneCount > 0) {
      message.success(`AI 分类完成：${doneCount} 道`)
      // 流程接力：提示去确认（学习闭环第②步）
      Modal.confirm({
        title: `${doneCount} 道错题已分类完成`,
        content: '已进入「待确认」队列，是否现在去逐题确认？',
        okText: '去确认',
        cancelText: '稍后',
        onOk: () => navigate('/pending')
      })
    } else {
      message.error('分类失败，可点击任务条上的「重试」')
    }
  }, [addItems, message, setClassifyJob, clearClassifyJobs, setClassifying, setSelected, refreshOverview, navigate])

  const handleBatchClassify = useCallback(async () => {
    if (mutationLock.current || importing || classifying) return
    const toClassify = library.filter((q) => selected.includes(q.id) && q.status === 'pending')
    if (toClassify.length === 0) { message.warning('请选择待分类的图片'); return }
    await classifyItems(toClassify)
  }, [library, selected, classifyItems, message, importing, classifying])

  // 单题失败重试
  const retryClassify = useCallback(async (traceId: string, fileName: string) => {
    const item = library.find((q) => q.traceId === traceId && q.status === 'pending')
    if (!item) { message.warning('该图片已不在处理队列中'); return }
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

  const handleDelete = async (ids: string[]) => {
    if (mutationLock.current || importing || classifying || !ids.length) return
    if (typeof window.api.deleteQueuedQuestions !== 'function') {
      message.error('请重启应用以启用新的批量删除功能')
      return
    }
    mutationLock.current = true
    setDeleting(true)
    const deleted = new Set<string>()
    const errors: string[] = []
    try {
      // Complete any saved review edits before removing records from both queues.
      await Promise.all(ids.map(flushPendingDraft))
      for (let offset = 0; offset < ids.length; offset += 500) {
        const result = await window.api.deleteQueuedQuestions(ids.slice(offset, offset + 500))
        for (const id of result.deletedIds) {
          deleted.add(id)
          usePendingStore.getState().removeItem(id)
        }
        errors.push(...result.failed.map(item => item.error))
      }
    } catch (error: any) {
      errors.push(error.message || '删除请求失败')
    } finally {
      setLibrary(items => items.filter(item => !deleted.has(item.id)))
      setSelected(items => items.filter(id => !deleted.has(id)))
      mutationLock.current = false
      setDeleting(false)
      void refreshOverview()
    }
    if (deleted.size) message.success(`已删除 ${deleted.size} 条记录`)
    if (errors.length) message.error(`部分记录未删除，已保留：${errors[0]}`)
  }

  const pendingItems = library.filter((q) => q.status === 'pending')
  const classifiedItems = library.filter((q) => q.status === 'classified')
  const visibleLibrary = statusFilter === 'all' ? library : library.filter((q) => q.status === statusFilter)
  const selectableItems = selectableQueueItems(visibleLibrary)
  const selectedItems = library.filter(item => selected.includes(item.id))
  const selectedPending = selectedItems.filter(item => item.status === 'pending')
  const allSelected = selectableItems.length > 0 && selectableItems.every(item => selected.includes(item.id))
  const busy = importing || classifying || deleting
  const canMerge = selectedItems.length > 0 && selectedItems.every(item => item.status === 'pending' && !!(item.imageUrl || item.localPath))
  const changeFilter = (filter: typeof statusFilter) => { setStatusFilter(filter); setSelected([]) }

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
    if (busy || mutationLock.current) return
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const reviewTarget = Number(getSetting('review_daily_count', '5')) || 5

  return (
    <div className="import-page">
      <PageHeader
        title="错题处理"
        subtitle="导入题目 → AI 分类 → 人工确认入库"
        extra={
          <Space wrap>
            <Button icon={<PlusOutlined />} type="primary" onClick={handleImport} loading={importing}>
              {importing ? '导入中...' : '导入图片'}
            </Button>
            <Button icon={<CloudDownloadOutlined />} onClick={() => setFenbiImportOpen(true)}>从粉笔导入</Button>
            <Button onClick={() => setNewQuestionOpen(true)}>新建错题</Button>
            <Button onClick={() => navigate('/pending')}>
              <Badge count={pendingCount} size="small" offset={[6, -2]}>
                <ClockCircleOutlined /> 待确认
              </Badge>
            </Button>
          </Space>
        }
      />

      <SetupBanner />

      <FenbiImportDrawer open={fenbiImportOpen} onClose={() => setFenbiImportOpen(false)} onImported={() => { loadLibrary(); refreshOverview() }} />

      {/* 学习闭环流程状态条：收集 → 确认 → 归纳 → 复习 */}
      <Card size="small" style={{ marginBottom: 12, background: '#fafafa', border: '1px solid #f0f0f0' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
          <FlowStep n={1} label="收集" value={`待分类 ${pendingItems.length}`} active={pendingItems.length > 0} color="#1677ff" onClick={() => changeFilter('pending')} />
          <ArrowRightOutlined style={{ color: '#ccc', fontSize: 12 }} />
          <FlowStep n={2} label="确认" value={`待确认 ${pendingCount}`} active={pendingCount > 0} color="#722ed1" onClick={() => navigate('/pending')} />
          <ArrowRightOutlined style={{ color: '#ccc', fontSize: 12 }} />
          <FlowStep n={3} label="归纳" value={dailyNoteReady ? '今日笔记 ✅' : '待生成'} active={!dailyNoteReady} color="#52c41a" onClick={() => navigate('/knowledge')} />
          <ArrowRightOutlined style={{ color: '#ccc', fontSize: 12 }} />
          <FlowStep n={4} label="复习" value={`${reviewedToday}/${reviewTarget}`} active={reviewedToday < reviewTarget} color="#fa8c16" onClick={() => navigate('/knowledge')} />
        </div>
      </Card>

      {/* 概览统计（点击卡片可跳转） */}
      <Row gutter={[12, 12]} className="import-metrics" style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card size="small" hoverable style={{ cursor: 'pointer' }} onClick={() => changeFilter('pending')}>
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
        className="import-dropzone"
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
      <section className="import-toolbar" aria-label="筛选与批量操作">
        <div className="import-filter-row">
          <Tabs size="small" activeKey={statusFilter} onChange={(k) => changeFilter(k as typeof statusFilter)}
            items={[
              { key: 'all', label: `全部 (${library.length})` },
              { key: 'pending', label: `待分类 (${pendingItems.length})` },
              { key: 'classified', label: `已分类 (${classifiedItems.length})` }
            ]}
          />
          <Typography.Text type="secondary">共 {visibleLibrary.length} 条 · 点击图片可放大</Typography.Text>
        </div>
        <div className="import-batch-row">
          <div className="import-selection">
            <Checkbox aria-label="全选当前结果" checked={allSelected} indeterminate={selected.length > 0 && !allSelected}
              disabled={busy || !selectableItems.length}
              onChange={event => setSelected(event.target.checked ? selectableItems.map(item => item.id) : [])}>
              全选当前结果
            </Checkbox>
            <span className="import-selected-count" aria-live="polite">已选 {selected.length} 条</span>
            {selected.length > 0 && <Button type="link" size="small" disabled={busy} onClick={() => setSelected([])}>清空选择</Button>}
            {selectableItems.length < visibleLibrary.length && <Typography.Text type="secondary">分析中的题目暂不可选</Typography.Text>}
          </div>
          <div className="import-batch-actions">
          <Popconfirm title={`删除选中的 ${selected.length} 条记录？`}
            description="会同时删除对应的独立 Obsidian 笔记；保留原图片。此操作不可撤销。"
            disabled={busy || !selected.length} onConfirm={() => handleDelete([...selected])}
            okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }}>
            <Button danger icon={<DeleteOutlined />} loading={deleting} disabled={busy || !selected.length}>批量删除（{selected.length}）</Button>
          </Popconfirm>
          <Tooltip title={canMerge ? '将所选截图识别为一组公共资料与子题' : '仅支持选择尚未分类、带图片的记录'}>
          <Popconfirm
            title={`将勾选的 ${selected.length} 张截图按当前顺序合并为一个资料题组？`}
            description="识别成功后，原始截图条目会由拆分出的错题替换。"
            disabled={busy || !canMerge}
            onConfirm={mergeSelectedAsMaterialGroup}
            okText="合并识别"
            cancelText="取消"
          >
            <Button icon={<ApartmentOutlined />} disabled={busy || !canMerge}>
              合并为资料题组
            </Button>
          </Popconfirm>
          </Tooltip>
          <Button type="primary" icon={<AiSparkOutlined />} onClick={handleBatchClassify} loading={classifying}
            disabled={busy || !selectedPending.length}>
            AI 分类（{selectedPending.length}）
          </Button>
          </div>
        </div>
      </section>

      {/* 图片网格 */}
      {visibleLibrary.length === 0 ? (
        <Card>
          <Empty description={statusFilter === 'all' ? '点击上方「导入图片」，或直接拖拽截图到此处' : statusFilter === 'pending' ? '没有待分类的图片' : '没有已分类待确认的图片'}
            image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      ) : (
        <div className="import-queue-grid">
          {visibleLibrary.map((item) => {
            const isSelected = selected.includes(item.id)
            return (
                <Card
                  key={item.id}
                  className={`import-queue-card${isSelected ? ' is-selected' : ''}`}
                  size="small"
                  hoverable
                  cover={
                    <div className="import-card-cover">
                      <ImportThumbnail imageUrl={item.imageUrl} localPath={item.localPath} text={item.text} title={item.fileName} />
                      <Checkbox
                        aria-label={`选择 ${item.fileName}`}
                        checked={isSelected}
                        disabled={busy || !['pending', 'classified'].includes(item.status)}
                        onChange={() => toggleSelect(item.id)}
                        className="import-card-checkbox"
                      />
                      {item.status === 'classified' && item.confidence != null && item.confidence > 0 && (
                        <Tag color={item.confidence < 0.6 ? 'orange' : 'blue'} style={{ position: 'absolute', top: 6, right: 6, margin: 0 }}>
                          {Math.round(item.confidence * 100)}%
                        </Tag>
                      )}
                    </div>
                  }
                >
                  <div className="import-card-title">
                    <Tooltip title={item.fileName}>
                      <Typography.Text ellipsis>{item.fileName}</Typography.Text>
                    </Tooltip>
                  </div>
                  <div className="import-card-status">
                    {item.status === 'pending' && <Tag color="default" style={{ margin: 0 }}>待分类</Tag>}
                    {item.status === 'classified' && <Tooltip title={[item.level1, item.level2, item.level3].filter(Boolean).join(' / ')}>
                      <Tag color="blue">{item.level1}{item.level2 ? ` / ${item.level2}` : ''}</Tag>
                    </Tooltip>}
                    {['processing', 'classifying'].includes(item.status) && <Tag color="processing">AI 分析中</Tag>}
                  </div>
                  <div className="import-card-footer">
                    <span>{item.createdAt?.slice(0, 10)}</span>
                    <Space size={0}>
                      <Button size="small" type="text" aria-label="编辑截图" title="编辑截图" disabled={busy || !item.localPath || item.status !== 'pending'} icon={<EditOutlined />}
                        onClick={() => handleEditItem(item)} />
                      {item.status === 'classified' && (
                        <Button size="small" type="text" aria-label="前往待确认" title="前往待确认" disabled={busy} icon={<ClockCircleOutlined />}
                          onClick={() => navigate('/pending')} />
                      )}
                      <Popconfirm title="删除这条记录？" description="同时删除对应的独立笔记，保留原图片。不可撤销。" disabled={busy || !['pending', 'classified'].includes(item.status)} onConfirm={() => handleDelete([item.id])} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" type="text" danger aria-label="删除这条记录" title="删除这条记录" disabled={busy || !['pending', 'classified'].includes(item.status)} icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                </Card>
            )
          })}
        </div>
      )}

      {/* Crop dialog */}
      <CanvasCrop
        open={!!cropTarget}
        imagePath={cropTarget?.localPath || ''}
        onOk={handleCropDone}
        onSkip={handleCropSkip}
        onCancel={() => { setCropTarget(null) }}
      />
      <NewQuestionDrawer open={newQuestionOpen} onClose={() => setNewQuestionOpen(false)} onCreated={() => loadLibrary()} />
    </div>
  )
}

// 学习闭环流程步骤（首页状态条）
function FlowStep({ n, label, value, active, color, onClick }: {
  n: number
  label: string
  value: string
  active: boolean
  color: string
  onClick: () => void
}) {
  return (
    <Tooltip title="点击前往">
      <Button type="text" size="small" onClick={onClick} style={{ padding: '2px 8px', height: 'auto' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 18, height: 18, borderRadius: '50%',
            background: active ? color : '#d9d9d9',
            color: '#fff', fontSize: 11, lineHeight: '18px', textAlign: 'center',
            display: 'inline-block', flexShrink: 0
          }}>{n}</span>
          <span style={{ fontWeight: 500, fontSize: 13 }}>{label}</span>
          <span style={{ color: active ? color : '#999', fontSize: 12 }}>{value}</span>
        </span>
      </Button>
    </Tooltip>
  )
}
