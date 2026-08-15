import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Typography, Button, Space, Tag, Input, Empty, App, Modal, Select, Popconfirm, Tooltip, Radio, Alert, Card, Row, Col, Switch } from 'antd'
import {
  CheckOutlined, StepForwardOutlined, ThunderboltOutlined,
  LeftOutlined, RightOutlined, PlusOutlined, BulbOutlined,
  PictureOutlined, EditOutlined, TagsOutlined, AppstoreOutlined, FileTextOutlined, BookOutlined
} from '@ant-design/icons'
import { usePendingStore } from '@/stores/pending'
import { useSettingsStore } from '@/stores/settings'
import { CategoryTreeSelect } from '@/components/category-tree-select'
import { CanvasCrop } from '@/components/canvas-crop'
import { useTagTreeStore } from '@/stores/tag-tree'
import { PageHeader } from '@/components/page-header'
import dayjs from 'dayjs'

// 图片加载失败占位图
const IMG_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#f5f5f5"/><text x="60" y="62" font-size="12" text-anchor="middle" fill="#bbb">图片加载失败</text></svg>'
)

// 右侧信息区的分区标题
function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
      {icon}
      {children}
    </div>
  )
}

export function PendingPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { queue, currentIndex, removeItem, updateItem, setCurrentIndex, addItems } = usePendingStore()
  const { get: getSetting } = useSettingsStore()
  const { tree, load: loadTree, save: saveTree, addCustomTag, addNode } = useTagTreeStore()
  const [treeSelectOpen, setTreeSelectOpen] = useState(false)
  const [treeSelectTarget, setTreeSelectTarget] = useState<'tag' | 'unknown-adopt' | 'unknown-map'>('tag')
  const [unknownActionItem, setUnknownActionItem] = useState<string | null>(null)
  const [newTagInput, setNewTagInput] = useState('')
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [reflectionLoading, setReflectionLoading] = useState(false)
  const [errorTypes, setErrorTypes] = useState<string[]>([])
  const [cropOpen, setCropOpen] = useState(false)
  const [cropImagePath, setCropImagePath] = useState('')
  const [hasGraphics, setHasGraphics] = useState(false)
  const [graphicImagePath, setGraphicImagePath] = useState('')
  const [autoPlay, setAutoPlay] = useState(false)
  const [sessionStats, setSessionStats] = useState({ confirmed: 0, skipped: 0 })
  const hydratedRef = useRef(false)

  useEffect(() => { if (!tree.length) loadTree() }, [tree.length, loadTree])
  useEffect(() => { window.api.getErrorTypes().then(setErrorTypes) }, [])

  // 重启后从数据库恢复待确认队列（AI 结果已持久化到 questions 表）
  useEffect(() => {
    const hydrate = async () => {
      if (hydratedRef.current || queue.length > 0) return
      hydratedRef.current = true
      try {
        const result = await window.api.getQuestions({ status: 'classified', pageSize: 500 })
        const items = (result.items || []).map((q: any) => ({
          id: q.id,
          imageUrl: q.image_url,
          level1: q.level1 || '未分类',
          level2: q.level2 || '',
          level3: q.level3 || null,
          confidence: q.confidence || 0,
          ocrText: q.ocr_text || '',
          reasoning: q.reasoning || '',
          matchType: q.match_type || 'unknown',
          errorCount: q.error_count || 1,
          source: q.source || '',
          reflection: q.reflection || '',
          errorType: q.error_type || '',
          traceId: q.trace_id || '',
          aiRawLevel1: q.ai_raw_level1 || q.level1,
          aiRawLevel2: q.ai_raw_level2 || q.level2,
          aiRawLevel3: q.ai_raw_level3 || q.level3,
          hasGraphics: !!q.has_graphics,
          graphicImagePath: q.graphic_image_path || ''
        }))
        if (items.length > 0) {
          addItems(items)
          message.info(`已恢复 ${items.length} 道待确认错题`)
        }
      } catch { /* ignore */ }
    }
    hydrate()
  }, [queue.length, addItems, message])
  // Sync graphics state when switching questions
  useEffect(() => {
    const c = queue[currentIndex]
    setHasGraphics(c?.hasGraphics || false)
    setGraphicImagePath(c?.graphicImagePath || '')
  }, [currentIndex, queue])

  const current = queue[currentIndex]
  const threshold = Number(getSetting('confidence_threshold', '0.7'))
  const isLowConfidence = current && current.confidence < threshold
  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex < queue.length - 1

  const handleConfirm = useCallback(async () => {
    if (!current) return
    const isLast = queue.length === 1
    setConfirmLoading(true)
    try {
      const timestamp = dayjs().format('YYYYMMDD-HHmmss')
      const fileName = `${timestamp}.md`

      const questionData = {
        id: current.id,
        imageUrl: current.imageUrl,
        level1: current.level1,
        level2: current.level2,
        level3: current.level3,
        confidence: current.confidence,
        ocrText: current.ocrText,
        reasoning: current.reasoning,
        errorCount: current.errorCount,
        source: current.source,
        reflection: current.reflection,
        errorType: current.errorType,
        traceId: current.traceId,
        hasGraphics: hasGraphics,
        graphicImagePath: graphicImagePath,
        status: 'confirmed',
        fileName
      }

      const result = await window.api.writeToObsidian(questionData)
      if (result.success) {
        message.success(result.vaultWrite ? '已写入 Obsidian' : '已入库（Vault 写入失败，将自动重试）')
      } else {
        message.warning('入库失败，将自动重试')
      }
    } catch (err: any) {
      message.error(`入库失败: ${err.message}`)
    } finally {
      setConfirmLoading(false)
      setSessionStats((s) => ({ ...s, confirmed: s.confirmed + 1 }))
      removeItem(current.id)
      // 最后一题确认完成 → 流程接力：提示生成今日知识点归纳
      if (isLast) {
        Modal.confirm({
          title: '今日错题已全部确认 🎉',
          content: `本次共确认 ${sessionStats.confirmed + 1} 道错题，是否现在生成「今日知识点归纳」？`,
          okText: '去归纳',
          cancelText: '稍后',
          onOk: () => navigate('/knowledge')
        })
      }
    }
  }, [current, queue.length, hasGraphics, graphicImagePath, message, removeItem, sessionStats.confirmed, navigate])

  const handleSkip = useCallback(() => {
    if (!current) return
    // 跳过 → 状态回退为待分类，回到成品库可重新分类或再次送入待确认
    window.api.updateQuestionStatus(current.id, 'pending').catch(() => {})
    setSessionStats((s) => ({ ...s, skipped: s.skipped + 1 }))
    removeItem(current.id)
  }, [current, removeItem])

  // Keyboard shortcuts（自动播放模式下，单独按 Enter 即可确认下一题）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && canGoPrev) setCurrentIndex(currentIndex - 1)
      if (e.key === 'ArrowRight' && canGoNext) setCurrentIndex(currentIndex + 1)
      const isCmdEnter = e.key === 'Enter' && (e.metaKey || e.ctrlKey)
      const isAutoEnter = e.key === 'Enter' && autoPlay && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
      if ((isCmdEnter || isAutoEnter) && current) handleConfirm()
      if (e.key === 's' && (e.metaKey || e.ctrlKey) && current) handleSkip()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentIndex, current, canGoPrev, canGoNext, autoPlay, handleConfirm, handleSkip])

  const handleBatchConfirm = useCallback(async () => {
    Modal.confirm({
      title: '批量快速入库',
      content: `将队列中所有 ${queue.length} 张错题以 AI 建议标签直接入库，确定继续？`,
      okText: '全部入库',
      cancelText: '取消',
      onOk: async () => {
        const fastErrorCount = Number(getSetting('fast_induct_error_count', '1')) || 1
        const succeeded: string[] = []
        const failed: string[] = []
        for (const item of queue) {
          try {
            const timestamp = dayjs().format('YYYYMMDD-HHmmss')
            const fileName = `${timestamp}.md`
            const r = await window.api.writeToObsidian({
              ...item,
              imageUrl: item.imageUrl,
              errorCount: fastErrorCount,
              source: item.source || '',
              hasGraphics: item.hasGraphics || false,
              graphicImagePath: item.graphicImagePath || '',
              fileName
            })
            if (r && r.success) succeeded.push(item.id)
            else failed.push(item.id)
          } catch {
            failed.push(item.id)
          }
        }
        if (succeeded.length > 0) {
          message.success(`已入库 ${succeeded.length} 张错题${failed.length ? `，${failed.length} 张失败留在队列中` : ''}`)
        } else {
          message.error('入库失败，请检查 Obsidian 配置后重试')
        }
        // 只移除成功的，失败的保留在队列中可单独处理
        succeeded.forEach((id) => removeItem(id))
      }
    })
  }, [queue, message, removeItem])

  const handleAddTag = useCallback(() => {
    if (!newTagInput.trim() || !current) return
    addCustomTag({ name: newTagInput.trim(), parentId: null })
    setNewTagInput('')
    message.success(`已添加自定义标签: ${newTagInput}`)
  }, [newTagInput, current, addCustomTag, message])

  const handleGenerateReflection = useCallback(async () => {
    if (!current) return
    setReflectionLoading(true)
    try {
      const result = await window.api.generateReflection({
        level1: current.level1,
        level2: current.level2,
        level3: current.level3,
        ocrText: current.ocrText,
        traceId: current.traceId
      })
      if (result.success && result.reflection) {
        updateItem(current.id, { reflection: result.reflection })
        message.success('复盘思路已生成')
      } else {
        message.error(result.error || '生成失败')
      }
    } catch (err: any) {
      message.error(`生成失败: ${err.message}`)
    }
    setReflectionLoading(false)
  }, [current, updateItem, message])

  const handleTreeSelect = useCallback((node: any) => {
    if (!current || !treeSelectTarget) return
    setTreeSelectOpen(false)
    const path: string[] = node.path || [node.name]

    if (treeSelectTarget === 'unknown-map') {
      // 待归类 → 归入已有分类：映射到树中现有节点
      updateItem(current.id, {
        level1: path[0] || node.name,
        level2: path[1] || '',
        level3: path[2] || null,
        matchType: 'mapped'
      })
      message.success(`已归入: ${path.join(' > ')}`)
    } else if (treeSelectTarget === 'unknown-adopt') {
      // 待归类 → 采纳为新分类：真实写入分类树（PRD 三路分流 · 分类树自生长）
      const parentLevel = node.level || 1
      if (parentLevel >= 3) {
        message.warning('已达最大分类层级（3 级），无法继续添加子分类')
        return
      }
      const newName = (current.aiRawLevel3 || current.aiRawLevel2 || current.aiRawLevel1 || '').trim()
      if (!newName || newName === '未分类') {
        message.warning('AI 未返回可采纳的分类名称，请先检查分类结果')
        return
      }
      const newNode = {
        id: `${node.id || 'root'}-${Date.now()}`,
        name: newName,
        level: parentLevel + 1,
        children: [],
        source: 'ai' as const
      }
      addNode(node.id === 'root' ? '' : node.id, newNode)
      updateItem(current.id, {
        level1: path[0] || current.aiRawLevel1 || current.level1,
        level2: parentLevel === 1 ? newName : (path[1] || ''),
        level3: parentLevel === 2 ? newName : (path[2] || null),
        matchType: 'adopted'
      })
      message.success(`已采纳为新分类「${newName}」，已加入分类树`)
    } else {
      // 从分类库选择：直接用所选节点覆盖 AI 标签
      updateItem(current.id, {
        level1: path[0] || node.name,
        level2: path[1] || '',
        level3: path[2] || null,
        matchType: current.matchType === 'unknown' ? 'mapped' : current.matchType
      })
      message.success(`已设置分类: ${path.join(' > ')}`)
    }
  }, [current, treeSelectTarget, updateItem, message, addNode])

  if (!current) {
    return (
      <div>
        <PageHeader title="待确认" subtitle="逐题核对 AI 分类结果，确认后写入知识库" />
        <Card>
          <Empty description="暂无待确认的错题" image={Empty.PRESENTED_IMAGE_SIMPLE}>
            <Typography.Text type="secondary">上传错题图片并完成 AI 分类后，结果将在此展示</Typography.Text>
            <div style={{ marginTop: 12 }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/')}>去上传</Button>
            </div>
          </Empty>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={<span>待确认 <Typography.Text type="secondary" style={{ fontSize: 15, fontWeight: 400 }}>{currentIndex + 1} / {queue.length}</Typography.Text></span>}
        subtitle={`← → 切换 · ${autoPlay ? 'Enter' : '⌘Enter'} 确认 · ⌘S 跳过 · 已确认 ${sessionStats.confirmed} / 跳过 ${sessionStats.skipped}`}
        extra={
          <Space>
            <Space size={4}>
              <Switch size="small" checked={autoPlay} onChange={setAutoPlay} />
              <Tooltip title="开启后单独按 Enter 即可确认并自动进入下一题，适合连续处理">
                <span style={{ fontSize: 12, color: '#888' }}>自动播放</span>
              </Tooltip>
            </Space>
            <Popconfirm title={`将队列中所有 ${queue.length} 张错题以 AI 建议标签直接入库？`} onConfirm={handleBatchConfirm} okText="全部入库" cancelText="取消">
              <Button icon={<ThunderboltOutlined />} disabled={queue.length === 0}>全部快速入库</Button>
            </Popconfirm>
          </Space>
        }
      />

      <Row gutter={16}>
        {/* Left: Image + queue strip */}
        <Col span={11}>
          <Card
            size="small"
            title={<span><PictureOutlined style={{ color: '#1677ff' }} /> 题目图片</span>}
            extra={isLowConfidence && <Tag color="orange">低置信度 {Math.round(current.confidence * 100)}%</Tag>}
            style={{ border: isLowConfidence ? '1px solid #faad14' : undefined }}
          >
            <div style={{ textAlign: 'center', minHeight: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img
                src={current.imageUrl}
                alt="错题截图"
                onError={(e) => { (e.target as HTMLImageElement).src = IMG_FALLBACK }}
                style={{ maxWidth: '100%', maxHeight: 420, objectFit: 'contain', borderRadius: 6 }}
              />
            </div>

            {isLowConfidence && (
              <Alert type="warning" showIcon style={{ marginTop: 12 }}
                message={`AI 置信度较低 (${Math.round(current.confidence * 100)}%)，请仔细核对后再入库`} />
            )}

            {/* 缩略图队列条 */}
            {queue.length > 1 && (
              <div style={{ marginTop: 12, display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
                {queue.map((q, i) => (
                  <Tooltip key={q.id} title={`第 ${i + 1} 题${i === currentIndex ? '（当前）' : ''}`}>
                    <div onClick={() => setCurrentIndex(i)} style={{
                      width: 54, height: 54, borderRadius: 6, overflow: 'hidden', flexShrink: 0, cursor: 'pointer',
                      border: i === currentIndex ? '2px solid #1677ff' : '2px solid transparent',
                      opacity: i === currentIndex ? 1 : 0.55,
                      background: '#f5f5f5', boxShadow: i === currentIndex ? '0 0 0 2px rgba(22,119,255,0.2)' : undefined
                    }}>
                      <img src={q.imageUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt={`第${i + 1}题`}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    </div>
                  </Tooltip>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
              <Button size="small" icon={<LeftOutlined />} disabled={!canGoPrev} onClick={() => setCurrentIndex(currentIndex - 1)} />
              <Button size="small" icon={<RightOutlined />} disabled={!canGoNext} onClick={() => setCurrentIndex(currentIndex + 1)} />
            </div>
          </Card>
        </Col>

        {/* Right: Info & Actions */}
        <Col span={13}>
          <Card
            size="small"
            title="确认信息"
            style={{ maxHeight: 'calc(100vh - 140px)', overflow: 'auto' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Classification warning */}
              {current.warning && (
                <Alert type="warning" showIcon message="分类异常" description={current.warning} />
              )}

              {/* Tags */}
              <div>
                <SectionLabel icon={<TagsOutlined style={{ color: '#1677ff' }} />}>AI 建议标签</SectionLabel>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <ChipTag current={current} updateItem={updateItem} onUnknownAction={(id, action) => {
                    setUnknownActionItem(id)
                    if (action === 'map' || action === 'adopt') {
                      setTreeSelectTarget(action === 'map' ? 'unknown-map' : 'unknown-adopt')
                      setTreeSelectOpen(true)
                    } else if (action === 'other') {
                      updateItem(id, { matchType: 'other' })
                      message.info('已标记为其他')
                    }
                  }} />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <Input
                    size="small"
                    placeholder="输入自定义标签..."
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onPressEnter={handleAddTag}
                    style={{ width: 180 }}
                  />
                  <Button size="small" icon={<PlusOutlined />} onClick={handleAddTag}>添加</Button>
                  <Button size="small" onClick={() => { setTreeSelectTarget('tag'); setTreeSelectOpen(true) }}>从分类库选择</Button>
                </div>
              </div>

              {/* 分类信息 */}
              <div>
                <SectionLabel icon={<AppstoreOutlined style={{ color: '#722ed1' }} />}>分类信息</SectionLabel>
                <Space size="middle" wrap>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>错误次数</Typography.Text>
                    <div style={{ marginTop: 4 }}>
                      <Radio.Group
                        value={current.errorCount}
                        onChange={(e) => updateItem(current.id, { errorCount: e.target.value })}
                        size="small"
                      >
                        <Radio.Button value={1}>1</Radio.Button>
                        <Radio.Button value={2}>2</Radio.Button>
                        <Radio.Button value={3}>3+</Radio.Button>
                      </Radio.Group>
                    </div>
                  </div>
                  <div style={{ minWidth: 220 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>错误类型</Typography.Text>
                    <div style={{ marginTop: 4 }}>
                      <Select
                        size="small"
                        mode="tags"
                        maxCount={1}
                        value={current.errorType ? [current.errorType] : undefined}
                        onChange={(v: string[]) => updateItem(current.id, { errorType: v[v.length - 1] || '' })}
                        placeholder="选择或直接输入新类型"
                        allowClear
                        style={{ width: '100%' }}
                        options={errorTypes.map(t => ({ value: t, label: t }))}
                      />
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>来源（可选）</Typography.Text>
                    <Input
                      size="small"
                      style={{ marginTop: 4 }}
                      placeholder="如：2025国考行测真题"
                      value={current.source}
                      onChange={(e) => updateItem(current.id, { source: e.target.value })}
                    />
                  </div>
                </Space>
              </div>

              {/* Graphics detection */}
              {current.hasGraphics && (
                <div style={{ background: '#fff7e6', padding: '8px 12px', borderRadius: 6, border: '1px solid #ffd591' }}>
                  <Space>
                    <PictureOutlined style={{ color: '#fa8c16' }} />
                    <Typography.Text strong style={{ color: '#d46b08' }}>检测到图形区域</Typography.Text>
                  </Space>
                  {current.graphicsDescription && (
                    <div style={{ marginTop: 4, fontSize: 12, color: '#666' }}>{current.graphicsDescription}</div>
                  )}
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button size="small" icon={<EditOutlined />}
                      onClick={async () => {
                        try {
                          const result = await window.api.downloadImageAsDataUrl(current.imageUrl)
                          if (result.success && result.dataUrl) {
                            setCropImagePath(result.dataUrl)
                            setCropOpen(true)
                          } else {
                            message.error(`图片加载失败: ${result.error || '未知错误'}`)
                          }
                        } catch (err: any) {
                          message.error(`图片加载失败: ${err.message}`)
                        }
                      }}>
                      裁剪图形区域
                    </Button>
                    <Button size="small"
                      onClick={async () => {
                        const res = await window.api.cropAndSaveGraphic({
                          imageUrl: current.imageUrl,
                          crop: null,
                          rotation: 0
                        })
                        if (res.success) {
                          setGraphicImagePath(`file://${res.filePath}`)
                          setHasGraphics(true)
                          updateItem(current.id, { hasGraphics: true, graphicImagePath: `file://${res.filePath}` })
                          message.success('已将原图标记为图形')
                        } else {
                          message.error(res.error || '保存失败')
                        }
                      }}>
                      整张作为图形
                    </Button>
                    <Button size="small" danger
                      onClick={() => {
                        setHasGraphics(false)
                        setGraphicImagePath('')
                        updateItem(current.id, { hasGraphics: false, graphicImagePath: '' })
                        message.info('已取消图形标记')
                      }}>
                      不是图形题
                    </Button>
                  </div>
                  {graphicImagePath && (
                    <Tag color="green" style={{ marginTop: 6 }}>已标记图形区域</Tag>
                  )}
                </div>
              )}

              {/* Manual graphics toggle for non-detected questions */}
              {!current.hasGraphics && (
                <div>
                  <Button size="small" type="dashed" icon={<PictureOutlined />}
                    onClick={() => {
                      setHasGraphics(true)
                      updateItem(current.id, { hasGraphics: true })
                    }}>
                    标记为图形题
                  </Button>
                </div>
              )}

              {/* AI reasoning */}
              {current.reasoning && (
                <div style={{ background: '#f6ffed', padding: '8px 12px', borderRadius: 6, border: '1px solid #b7eb8f' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>AI 分析：{current.reasoning}</Typography.Text>
                </div>
              )}

              {/* 复盘思路 */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <SectionLabel icon={<BookOutlined style={{ color: '#fa8c16' }} />}>复盘思路</SectionLabel>
                  <Button
                    size="small"
                    icon={<BulbOutlined />}
                    loading={reflectionLoading}
                    onClick={handleGenerateReflection}
                  >
                    AI 生成
                  </Button>
                </div>
                <Input.TextArea style={{ marginTop: 4 }} rows={3}
                  placeholder={reflectionLoading ? '正在生成...' : '点击「AI 生成」或手动输入复盘思路...'}
                  value={current.reflection || ''}
                  onChange={(e) => updateItem(current.id, { reflection: e.target.value })} />
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                <Button onClick={handleSkip} icon={<StepForwardOutlined />} disabled={confirmLoading}>跳过</Button>
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  onClick={handleConfirm}
                  loading={confirmLoading}
                  size="large"
                  style={{ flex: 1 }}
                >
                  确认入库
                </Button>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Crop dialog for graphics */}
      <CanvasCrop
        open={cropOpen}
        imagePath={cropImagePath}
        onOk={async (result) => {
          setCropOpen(false)
          if (!current) return
          try {
            const cropResult = await window.api.cropAndSaveGraphic({
              imageUrl: current.imageUrl,
              crop: result.crop,
              rotation: result.rotation
            })
            if (cropResult.success) {
              setGraphicImagePath(`file://${cropResult.filePath}`)
              setHasGraphics(true)
              updateItem(current.id, { hasGraphics: true, graphicImagePath: `file://${cropResult.filePath}` })
              message.success('图形区域已保存')
            } else {
              message.error(cropResult.error || '图形保存失败')
            }
          } catch (err: any) {
            message.error(`图形保存失败: ${err.message}`)
          }
        }}
        onSkip={() => {
          setCropOpen(false)
          if (current) {
            setGraphicImagePath(current.imageUrl)
            setHasGraphics(true)
            updateItem(current.id, { hasGraphics: true, graphicImagePath: current.imageUrl })
            message.info('已将原图标记为图形')
          }
        }}
        onCancel={() => setCropOpen(false)}
      />

      {/* Tree Select Modal */}
      <CategoryTreeSelect
        open={treeSelectOpen}
        tree={tree}
        onOk={handleTreeSelect}
        onCancel={() => setTreeSelectOpen(false)}
      />
    </div>
  )
}

// Tag chips component
function ChipTag({ current, updateItem, onUnknownAction }: {
  current: any
  updateItem: (id: string, updates: any) => void
  onUnknownAction: (id: string, action: string) => void
}) {
  const [unknownOpen, setUnknownOpen] = useState(false)
  const tags = [
    { name: current.level1, type: current.matchType },
    { name: current.level2, type: current.matchType },
    current.level3 ? { name: current.level3, type: current.matchType } : null
  ].filter(Boolean)

  const rawText = [current.aiRawLevel1, current.aiRawLevel2, current.aiRawLevel3]
    .filter(Boolean)
    .join(' > ')

  const getColors = (matchType: string) => {
    switch (matchType) {
      case 'exact': return { color: 'green', borderStyle: 'solid' as const }
      case 'fuzzy': return { color: 'blue', borderStyle: 'solid' as const }
      case 'unknown': return { color: 'gold', borderStyle: 'dashed' as const }
      case 'mapped': return { color: 'default', borderStyle: 'solid' as const }
      case 'adopted': return { color: 'green', borderStyle: 'solid' as const }
      case 'other': return { color: 'default', borderStyle: 'solid' as const }
      default: return { color: 'default', borderStyle: 'solid' as const }
    }
  }

  return (
    <>
      {tags.map((tag: any) => {
        const { color, borderStyle } = getColors(tag.type)
        const isUnknown = tag.type === 'unknown'

        if (isUnknown) {
          return (
            <Popconfirm
              key={tag.name}
              title="处理未知分类"
              description={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Button size="small" block onClick={(e) => {
                    e?.stopPropagation?.()
                    setUnknownOpen(false)
                    onUnknownAction(current.id, 'map')
                  }}>归入已有分类</Button>
                  <Button size="small" block type="primary" ghost onClick={(e) => {
                    e?.stopPropagation?.()
                    setUnknownOpen(false)
                    onUnknownAction(current.id, 'adopt')
                  }}>采纳为新分类</Button>
                  <Button size="small" block onClick={(e) => {
                    e?.stopPropagation?.()
                    setUnknownOpen(false)
                    onUnknownAction(current.id, 'other')
                  }}>标记为其他</Button>
                </div>
              }
              open={unknownOpen}
              onOpenChange={setUnknownOpen}
              icon={null}
              okText=""
              cancelText=""
            >
              <Tooltip title={`AI 原始输出: "${rawText}" · 点击处理`}>
                <Tag
                  color={color}
                  style={{ borderStyle, cursor: 'pointer' }}
                >
                  {tag.name} ★
                </Tag>
              </Tooltip>
            </Popconfirm>
          )
        }

        return (
          <Tooltip key={tag.name} title={tag.type === 'fuzzy' ? `模糊匹配: AI 原始输出 "${rawText}"` : tag.type === 'adopted' ? '已采纳为新分类' : ''}>
            <Tag color={color} style={{ borderStyle }}>
              {tag.name}
              {tag.type === 'adopted' && ' ★'}
            </Tag>
          </Tooltip>
        )
      })}
    </>
  )
}
