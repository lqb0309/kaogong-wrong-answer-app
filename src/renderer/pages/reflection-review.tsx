import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Button, Card, Empty, Input, Modal, Segmented, Space, Spin, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, BulbOutlined, CheckOutlined, EditOutlined, LeftOutlined, ReadOutlined, RightOutlined } from '@/components/study-icons'
import { PageHeader } from '@/components/page-header'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { QuestionTextFallback } from '@/components/question-text-fallback'
import { SafeImage } from '@/components/safe-image'
import { usePendingStore, flushPendingDraft } from '@/stores/pending'
import dayjs from 'dayjs'

export function ReflectionReviewPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { queue, currentIndex, addItems, removeItem, setCurrentIndex, updateItem } = usePendingStore()
  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const [loading, setLoading] = useState(false)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const hydratedRef = useRef(false)

  useEffect(() => {
    if (queue.length || hydratedRef.current) return
    hydratedRef.current = true
    window.api.getQuestions({ status: 'classified', pageSize: 500 }).then((result) => {
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
        hasGraphics: !!q.has_graphics,
        graphicImagePath: q.graphic_image_path || ''
      }))
      if (items.length) addItems(items)
    }).catch(() => message.error('待确认题目加载失败'))
  }, [queue.length, addItems, message])

  const current = queue[currentIndex]
  const generateReflection = useCallback(async () => {
    if (!current) return
    setLoading(true)
    try {
      const result = await window.api.generateReflection({
        questionId: current.id,
        level1: current.level1,
        level2: current.level2,
        level3: current.level3,
        ocrText: current.ocrText,
        errorType: current.errorType,
        traceId: current.traceId
      })
      if (result.success && result.reflection) {
        updateItem(current.id, { reflection: result.reflection })
        message.success('复盘思路已重新生成')
      } else message.error(result.error || '生成失败')
    } catch (error: any) {
      message.error(`生成失败：${error.message}`)
    } finally {
      setLoading(false)
    }
  }, [current, message, updateItem])

  const confirmToLibrary = useCallback(async () => {
    if (!current) return
    const isLast = queue.length === 1
    setConfirmLoading(true)
    try {
      await flushPendingDraft(current.id)
      const result = await window.api.writeToObsidian({
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
        hasGraphics: current.hasGraphics || false,
        graphicImagePath: current.graphicImagePath || '',
        status: 'confirmed',
        fileName: `${dayjs().format('YYYYMMDD-HHmmss')}.md`
      })
      if (result.success) {
        message.success(result.vaultWrite ? '复盘完成，已写入 Obsidian' : '复盘完成，已入库')
        removeItem(current.id)
        setMode('read')
        if (isLast) {
          Modal.confirm({
            title: '待确认错题已全部复盘完成',
            content: '是否返回待确认页面？',
            okText: '返回',
            cancelText: '留在这里',
            onOk: () => navigate('/pending')
          })
        }
      } else message.error('入库失败，请稍后重试')
    } catch (error: any) {
      message.error(`入库失败：${error.message}`)
    } finally {
      setConfirmLoading(false)
    }
  }, [current, message, navigate, queue.length, removeItem])

  if (!current) {
    return (
      <div className="reflection-review-page">
        <PageHeader title="专注复盘" extra={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/pending')}>返回待确认</Button>} />
        <Card><Empty description="暂无可复盘的待确认题目" /></Card>
      </div>
    )
  }

  const canPrev = currentIndex > 0
  const canNext = currentIndex < queue.length - 1
  const tags = [current.level1, current.level2, current.level3].filter(Boolean)

  return (
    <div className="reflection-review-page">
      <PageHeader
        title={<span>专注复盘 <Typography.Text type="secondary" className="reflection-review-count">{currentIndex + 1} / {queue.length}</Typography.Text></span>}
        subtitle="左侧核对题目，右侧完整阅读或编辑复盘思路"
        extra={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/pending')}>返回待确认</Button>}
      />
      <div className="reflection-review-workspace">
        <Card size="small" title="题目" className="reflection-question-card">
          <div className="reflection-question-stage">
            {current.imageUrl ? <SafeImage
                src={current.imageUrl}
                alt="错题截图"
                preview={{ mask: '点击放大' }}
              /> : <QuestionTextFallback content={current.ocrText || ''} label="粉笔文字题目" />}
          </div>
          <div className="reflection-question-meta">
            <Space size={[4, 6]} wrap>{tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space>
            <div className="reflection-question-nav">
              <Button icon={<LeftOutlined />} disabled={!canPrev} onClick={() => setCurrentIndex(currentIndex - 1)}>上一题</Button>
              <Button icon={<RightOutlined />} disabled={!canNext} onClick={() => setCurrentIndex(currentIndex + 1)}>下一题</Button>
            </div>
          </div>
        </Card>

        <Card
          size="small"
          title="复盘思路"
          className="reflection-document-card"
          extra={
            <Space>
              <Segmented
                value={mode}
                onChange={(value) => setMode(value as 'read' | 'edit')}
                options={[
                  { value: 'read', label: '阅读', icon: <ReadOutlined /> },
                  { value: 'edit', label: '编辑', icon: <EditOutlined /> }
                ]}
              />
            </Space>
          }
        >
          <div className="reflection-document-layout">
            <div className="reflection-document-content">
              <Spin spinning={loading}>
                {mode === 'edit' ? (
                  <Input.TextArea
                    className="reflection-document-editor"
                    value={current.reflection || ''}
                    placeholder="复盘思路会在识别时自动生成，也可以在这里手动修改"
                    onChange={(event) => updateItem(current.id, { reflection: event.target.value })}
                  />
                ) : current.reflection ? (
                  <article className="reflection-document-reader"><MarkdownRenderer content={current.reflection} /></article>
                ) : (
                  <Empty description="暂无复盘思路">
                    <Button type="primary" icon={<BulbOutlined />} loading={loading} onClick={generateReflection}>AI 生成复盘思路</Button>
                  </Empty>
                )}
              </Spin>
            </div>
            <div className="reflection-confirm-bar">
              <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/pending')}>返回修改分类</Button>
              <Button
                type="primary"
                size="large"
                icon={<CheckOutlined />}
                loading={confirmLoading}
                onClick={confirmToLibrary}
              >
                复盘无误，确认入库
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
