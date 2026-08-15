import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Typography, Card, Row, Col, Statistic, Table, Tag, Button, App, Tabs, Empty, Space, Tooltip, Progress, Collapse, Modal, Input, Select, Tree, DatePicker } from 'antd'
import {
  BookOutlined, FileTextOutlined, ReloadOutlined, BulbOutlined,
  FireOutlined, WarningOutlined, PlusCircleOutlined,
  CopyOutlined, FolderOpenOutlined, ExportOutlined, EyeOutlined,
  CalendarOutlined, ThunderboltOutlined
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { PageHeader } from '@/components/page-header'

// ===== Constants =====
const PRIORITY_COLORS: Record<string, string> = { high: '#ff4d4f', medium: '#fa8c16', low: '#52c41a', new: '#1677ff' }
const PRIORITY_LABELS: Record<string, string> = { high: '🔴 高优先', medium: '🟡 中优先', low: '🟢 低优先', new: '⚪ 新知识点' }
const KNOWLEDGE_TYPE_LABELS: Record<string, string> = { pitfall: '易错点', concept: '概念辨析', shortcut: '速解技巧', formula: '公式定理' }

// ===== Types =====
interface OverviewData {
  today: { questionCount: number; knowledgePointCount: number; newPointsCount: number; highFreqCount: number; existingCardCount: number }
  todayQuestions: any[]
  priorityList: any[]
}
interface InductionResult {
  daily_note: { date: string; total_questions: number; categories_studied: string[]; overview: string; error_distribution: string; new_findings: string; cards_new: string[]; cards_updated: string[]; full_markdown: string }
  card_operations: { new_cards: any[]; updated_cards: any[]; moc_updates: any[] }
}

export function KnowledgePage() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [inducting, setInducting] = useState(false)
  const [inductProgress, setInductProgress] = useState(0)
  const [inductMessage, setInductMessage] = useState('')
  const [inductTokens, setInductTokens] = useState(0)
  const [inductionResult, setInductionResult] = useState<InductionResult | null>(null)
  const [writing, setWriting] = useState(false)
  const [writeResult, setWriteResult] = useState<any>(null)
  const [reviewCards, setReviewCards] = useState<any[]>([])
  const [allCards, setAllCards] = useState<any[]>([])
  const [dailyNotes, setDailyNotes] = useState<any[]>([])
  const [cardSearch, setCardSearch] = useState('')
  const [treeSearch, setTreeSearch] = useState('')
  const [expandedTreeKeys, setExpandedTreeKeys] = useState<string[]>([])
  const [cardTypeFilter, setCardTypeFilter] = useState<string | undefined>()
  const [selectedTreeKeys, setSelectedTreeKeys] = useState<string[]>([])
  const [cardModalOpen, setCardModalOpen] = useState(false)
  const [cardModalContent, setCardModalContent] = useState('')
  const [cardModalTitle, setCardModalTitle] = useState('')
  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs>(() => dayjs())
  const [noteModalOpen, setNoteModalOpen] = useState(false)
  const [noteModalContent, setNoteModalContent] = useState('')
  const [noteModalTitle, setNoteModalTitle] = useState('')
  const { message } = App.useApp()
  const unsubRef = useRef<(() => void) | null>(null)

  // ===== Data Fetching =====
  const fetchOverview = useCallback(async (date?: string) => {
    setLoading(true)
    const d = date || selectedDate.format('YYYY-MM-DD')
    try { const r = await window.api.getKnowledgeOverview(d); setData(r) } catch { /* */ }
    setLoading(false)
  }, [selectedDate])

  const loadCards = useCallback(async () => {
    try {
      const [reviewRes, cardsRes, notesRes] = await Promise.all([
        window.api.getReviewCards(3),
        window.api.getKnowledgeCards(),
        window.api.getDailyNotes()
      ])
      if (reviewRes.cards) setReviewCards(reviewRes.cards)
      if (cardsRes.cards) setAllCards(cardsRes.cards)
      if (notesRes.notes) setDailyNotes(notesRes.notes)
    } catch { /* */ }
  }, [])

  useEffect(() => { fetchOverview() }, [fetchOverview])
  useEffect(() => { loadCards() }, [loadCards])

  // Listen for auto-induct completion
  useEffect(() => {
    const unsub = window.api.onAutoInductComplete((evt) => {
      if (evt.success) {
        // Switch to yesterday's date and refresh
        const yest = dayjs().subtract(1, 'day')
        setSelectedDate(yest)
        setInductionResult(null)
        setWriteResult(null)
        fetchOverview(yest.format('YYYY-MM-DD'))
        loadCards()
        message.info(`已自动归纳 ${evt.date} 的知识点，可查看每日笔记`)
      }
    })
    return unsub
  }, [fetchOverview, loadCards, message])

  // ===== Actions =====
  const handleInduct = async () => {
    setInducting(true)
    setInductProgress(0)
    setInductMessage('正在准备...')
    setInductTokens(0)
    setInductionResult(null)
    setWriteResult(null)
    const unsub = window.api.onAiProgress((evt) => {
      if (evt.traceId === 'induct') {
        setInductProgress(evt.progress || 0)
        setInductMessage(evt.message)
        if (evt.tokens) setInductTokens(evt.tokens)
      }
    })
    unsubRef.current = unsub
    try {
      const result = await window.api.inductKnowledge(selectedDate.format('YYYY-MM-DD'))
      if (result.success) { setInductionResult(result as any); setInductProgress(100); setInductMessage('归纳完成'); message.success('知识点归纳完成！') }
      else { message.error(result.error || '归纳失败') }
    } catch (err: any) { message.error(`归纳失败: ${err.message}`) }
    finally { unsub(); unsubRef.current = null; setInducting(false) }
  }

  const handleWriteToVault = async () => {
    if (!inductionResult) return
    setWriting(true); setWriteResult(null)
    try {
      const result = await window.api.writeInductionToVault({
        daily_note_markdown: inductionResult.daily_note.full_markdown,
        date: inductionResult.daily_note.date,
        new_cards: inductionResult.card_operations.new_cards,
        updated_cards: inductionResult.card_operations.updated_cards,
        moc_updates: inductionResult.card_operations.moc_updates
      })
      if (result.success) { setWriteResult(result); message.success('已写入 Obsidian'); fetchOverview(); loadCards() }
      else { message.error(result.error || '写入失败') }
    } catch (err: any) { message.error(`写入失败: ${err.message}`) }
    setWriting(false)
  }

  const handleCopyNote = () => {
    if (!inductionResult) return
    navigator.clipboard.writeText(inductionResult.daily_note.full_markdown)
    message.success('每日笔记已复制')
  }

  const handleOpenVault = async () => {
    const vault = await window.api.getConfig('obsidian_vault') || ''
    if (vault) window.api.openExternal(vault)
    else message.warning('请先配置 Obsidian Vault 路径')
  }

  const handleViewCard = async (card: any) => {
    setCardModalTitle(card.title); setCardModalContent(''); setCardModalOpen(true)
    const r = await window.api.getKnowledgeCardContent(card.file_path)
    if (r.success && r.content) {
      // Strip frontmatter + first h1 heading (title already shown in Modal bar)
      const body = r.content
        .replace(/^---[\s\S]*?---\n*/, '')
        .replace(/^# .+\n*/, '')
      setCardModalContent(body)
    } else setCardModalContent('无法加载卡片内容')
  }

  const handleViewNote = async (note: any) => {
    setNoteModalTitle(note.title); setNoteModalContent(''); setNoteModalOpen(true)
    const r = await window.api.getDailyNoteContent(note.date)
    if (r.success && r.content) setNoteModalContent(r.content)
    else setNoteModalContent('无法加载笔记内容')
  }

  const handleOpenCardInObsidian = async (filePath: string) => {
    const vault = (await window.api.getConfig('obsidian_vault') || '').replace(/\/+$/, '')
    if (!vault) { message.warning('请先配置 Obsidian Vault'); return }
    // Use obsidian:// URI to open the specific file in Obsidian
    const vaultName = vault.split('/').pop() || 'vault'
    const encodedFile = encodeURIComponent(filePath)
    const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedFile}`
    window.api.openExternal(uri)
  }

  // ===== Derived Data =====
  const filteredCards = allCards.filter(c => {
    const searchTerm = cardSearch || treeSearch
    if (searchTerm) { const s = searchTerm.toLowerCase(); if (!c.title.toLowerCase().includes(s) && !c.file_path.toLowerCase().includes(s)) return false }
    if (cardTypeFilter && c.knowledge_type !== cardTypeFilter) return false
    if (selectedTreeKeys.length > 0) {
      const cardKeys = selectedTreeKeys.filter(k => k.startsWith('card:')).map(k => k.replace('card:', ''))
      const topicKeys = selectedTreeKeys.filter(k => k.startsWith('topic:')).map(k => k.replace('topic:', ''))
      const catKeys = selectedTreeKeys.filter(k => !k.startsWith('card:') && !k.startsWith('topic:'))
      // Card-level filter: exact file_path match
      if (cardKeys.length > 0 && !cardKeys.includes(c.file_path)) return false
      // Topic filter: match card title starts with topic
      if (topicKeys.length > 0 && !topicKeys.some(t => c.title.startsWith(t))) return false
      // Category filter: prefix match
      if (catKeys.length > 0) {
        const cp = `${c.level1}|${c.level2}|${c.level3 || ''}`
        if (!catKeys.some(k => cp.startsWith(k))) return false
      }
    }
    return true
  })

  const cardTree = useMemo(() => {
    // Build nested map: { level1: { _cards: [...], level2: { _cards: [...], level3: { _cards: [...] } } } }
    const root: Record<string, any> = {}
    for (const card of allCards) {
      const l1 = card.level1 || '未分类'
      const l2 = card.level2 || ''
      const l3 = card.level3 || ''
      if (!root[l1]) root[l1] = { _cards: [] }
      if (!l2) { root[l1]._cards.push(card); continue }
      if (!root[l1][l2]) root[l1][l2] = { _cards: [] }
      if (!l3) { root[l1][l2]._cards.push(card); continue }
      if (!root[l1][l2][l3]) root[l1][l2][l3] = { _cards: [] }
      root[l1][l2][l3]._cards.push(card)
    }

    function countCards(v: any): number {
      return (v._cards?.length || 0) +
        Object.entries(v)
          .filter(([k]) => k !== '_cards')
          .reduce((s, [, cv]) => s + countCards(cv), 0)
    }

    interface TreeNode {
      title: string; key: string; children?: TreeNode[]; isLeaf?: boolean; selectable?: boolean
    }

    function buildNode(name: string, value: any, nodeKey: string): TreeNode {
      const subEntries = Object.entries(value).filter(([k]) => k !== '_cards')
      const children: TreeNode[] = []

      // Add sub-category nodes
      for (const [k, v] of subEntries) {
        const childKey = nodeKey ? `${nodeKey}|${k}` : k
        children.push(buildNode(k, v, childKey))
      }

      // Build level-4 leaf nodes: group cards by topic, stop here (no individual card leaves)
      if (subEntries.length === 0 && value._cards?.length > 0) {
        const cards: any[] = value._cards
        function extractTopic(title: string): string {
          const m = title.match(/^(.+?)[：:——\-—\s]+/)
          return m ? m[1] : title
        }
        const topicGroups: Record<string, any[]> = {}
        for (const card of cards) {
          const topic = extractTopic(card.title)
          if (!topicGroups[topic]) topicGroups[topic] = []
          topicGroups[topic].push(card)
        }
        for (const [topic, topicCards] of Object.entries(topicGroups)) {
          const isGroup = topicCards.length > 1
          children.push({
            title: isGroup ? `${topic} (${topicCards.length})` : topic,
            key: isGroup ? `${nodeKey}|topic:${topic}` : `card:${topicCards[0].file_path}`,
            isLeaf: true,
            selectable: true
          })
        }
      }

      const total = countCards(value)
      return {
        title: `${name} (${total})`,
        key: nodeKey,
        children: children.length > 0 ? children : undefined,
        isLeaf: children.length === 0 && !value._cards?.length,
        selectable: true
      }
    }

    return Object.entries(root).map(([name, value]) => buildNode(name, value, name))
  }, [allCards])

  // Filter tree nodes by search and get expanded keys
  const filteredTree = useMemo(() => {
    if (!treeSearch) return cardTree
    const s = treeSearch.toLowerCase()
    function filterNodes(nodes: any[]): any[] {
      if (!nodes) return []
      const result: any[] = []
      for (const node of nodes) {
        const titleMatch = node.title?.toLowerCase().includes(s)
        const filteredChildren = node.children ? filterNodes(node.children) : []
        if (titleMatch || filteredChildren.length > 0) {
          result.push({ ...node, children: filteredChildren.length > 0 ? filteredChildren : node.children })
        }
      }
      return result
    }
    return filterNodes(cardTree)
  }, [cardTree, treeSearch])

  // Auto-expand matching tree nodes
  const treeExpandedKeys = useMemo(() => {
    if (!treeSearch) return expandedTreeKeys
    const s = treeSearch.toLowerCase()
    const keys: string[] = []
    function collectKeys(nodes: any[]) {
      for (const node of nodes) {
        if (node.children) {
          const hasMatch = node.children.some((c: any) => {
            if (c.title?.toLowerCase().includes(s)) return true
            if (c.children) { collectKeys(c.children); return c.children.some((cc: any) => cc.title?.toLowerCase().includes(s)) }
            return false
          })
          if (hasMatch || node.title?.toLowerCase().includes(s)) keys.push(node.key)
          collectKeys(node.children)
        }
      }
    }
    collectKeys(cardTree)
    return [...new Set(keys)]
  }, [cardTree, treeSearch, expandedTreeKeys])

  // ===== Table Columns =====
  const priorityCols = [
    { title: '#', width: 40, render: (_: any, __: any, i: number) => <span style={{ color: i < 3 ? '#ff4d4f' : '#999', fontWeight: i < 3 ? 700 : 400 }}>{i + 1}</span> },
    { title: '知识点', render: (_: any, r: any) => <span style={{ fontWeight: 500 }}>{[r.level1, r.level2, r.level3].filter(Boolean).join(' > ')}</span> },
    { title: '错题数', dataIndex: 'question_count', width: 70, align: 'center' as const, render: (v: number) => `${v} 道` },
    { title: '累计犯错', dataIndex: 'total_errors', width: 80, align: 'center' as const, render: (v: number) => <Tag color={v >= 5 ? 'red' : v >= 3 ? 'orange' : v >= 2 ? 'green' : 'blue'}>{v} 次</Tag> },
    { title: '最近犯错', dataIndex: 'last_seen', width: 100, render: (v: string) => { const t = new Date().toISOString().slice(0, 10); const isT = v === t; return <span style={{ color: isT ? '#ff4d4f' : '#888', fontWeight: isT ? 600 : 400 }}>{isT ? '今天' : v}</span> } },
    { title: '优先级', dataIndex: 'priority', width: 100, align: 'center' as const, render: (v: string) => <Tag color={PRIORITY_COLORS[v]}>{PRIORITY_LABELS[v]}</Tag> }
  ]

  const questionCols = [
    { title: '#', width: 40, render: (_: any, __: any, i: number) => <span style={{ color: '#999' }}>{i + 1}</span> },
    { title: '题目预览', dataIndex: 'ocr_text', ellipsis: true, render: (v: string | null) => <Tooltip title={v || ''}><span style={{ fontSize: 12 }}>{v?.slice(0, 60) || '（无OCR）'}</span></Tooltip> },
    { title: '分类', width: 160, render: (_: any, r: any) => <span style={{ fontSize: 12 }}>{[r.level1, r.level2, r.level3].filter(Boolean).join(' > ')}</span> },
    { title: '错误类型', dataIndex: 'error_type', width: 120, render: (v: string | null) => v ? <Tag style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis' }} title={v}>{v}</Tag> : <span style={{ color: '#bbb' }}>-</span> },
    { title: '该点累计', width: 90, align: 'center' as const, render: (_: any, r: any) => <Tag color={r.knowledge_total_errors >= 5 ? 'red' : r.knowledge_total_errors >= 3 ? 'orange' : 'green'}>第{r.knowledge_total_errors}次</Tag> },
    { title: '状态', width: 90, align: 'center' as const, render: (_: any, r: any) => r.is_first_time ? <Tag color="blue">🆕 新</Tag> : <Tag color="orange">再次踩坑</Tag> },
    { title: '', width: 50, render: (_: any, r: any) => r.obsidian_path ? <Button size="small" type="link" onClick={async () => { const vault = (await window.api.getConfig('obsidian_vault') || '').replace(/\/+$/, ''); if (!vault) return; const vn = vault.split('/').pop() || 'vault'; window.api.openExternal(`obsidian://open?vault=${encodeURIComponent(vn)}&file=${encodeURIComponent(r.obsidian_path)}`); }}>打开</Button> : null }
  ]

  // ===== Early Return =====
  if (!data) {
    return <div><PageHeader title="📘 知识归纳" /><Card><Empty description="暂无数据，请先上传并确认错题" /></Card></div>
  }

  const { today, priorityList, todayQuestions } = data

  // ===== Render =====
  return (
    <div>
      <PageHeader
        title="📘 知识归纳"
        subtitle="从每日错题中提炼知识点，生成每日笔记与知识卡片"
        extra={
          <Space wrap>
            <DatePicker
              value={selectedDate}
              onChange={(d) => { if (d) { setSelectedDate(d); setInductionResult(null); setWriteResult(null); fetchOverview(d.format('YYYY-MM-DD')) } }}
              disabledDate={(d) => d && d.isAfter(dayjs(), 'day')}
              allowClear={false}
              size="small"
              style={{ width: 130 }}
            />
            {inducting ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 320 }}>
                <Progress type="circle" percent={inductProgress} size={32} strokeColor="#1677ff" />
                <div style={{ fontSize: 12, color: '#666', maxWidth: 200 }}>
                  <div style={{ fontWeight: 500, color: '#1677ff' }}>{inductMessage}</div>
                  {inductTokens > 0 && <span style={{ fontSize: 11, color: '#999' }}>已接收 {inductTokens} tokens</span>}
                </div>
              </div>
            ) : (
              <Button icon={<BulbOutlined />} type="primary" onClick={handleInduct} disabled={today.questionCount === 0}>
                {selectedDate.format('YYYY-MM-DD') === dayjs().format('YYYY-MM-DD')
                  ? '归纳今日知识点'
                  : `归纳 ${selectedDate.format('MM-DD')} 知识点`}
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={() => fetchOverview()} loading={loading} disabled={inducting}>刷新</Button>
          </Space>
        }
      />

      {/* Overview Cards */}
      <Row gutter={12} style={{ marginBottom: 16 }}>
        {[
          { title: '今日错题', value: today.questionCount, suffix: '道', icon: <FileTextOutlined />, color: '#1677ff' },
          { title: '涉及知识点', value: today.knowledgePointCount, suffix: '个', icon: <BookOutlined />, color: '#722ed1' },
          { title: '高频重复', value: today.highFreqCount, suffix: '个', icon: <FireOutlined />, color: today.highFreqCount > 0 ? '#ff4d4f' : '#52c41a', tip: '累计错误 ≥ 3 次' },
          { title: '首次出现', value: today.newPointsCount, suffix: '个', icon: <PlusCircleOutlined />, color: today.newPointsCount > 0 ? '#1677ff' : '#bbb', tip: '历史首次出现的知识点' },
          { title: '知识卡片', value: today.existingCardCount, suffix: '张', icon: <FolderOpenOutlined />, color: '#52c41a', tip: 'Vault 中已有卡片总数' },
          { title: '预警', value: priorityList.filter((p: any) => p.priority === 'high').length, suffix: '项', icon: <WarningOutlined />, color: '#ff4d4f', tip: '高优先级需突破' }
        ].map((s, i) => (
          <Col span={4} key={i}>
            <Card size="small">
              <Statistic title={s.title} value={s.value} suffix={s.suffix} prefix={s.icon}
                valueStyle={{ color: s.color }}
                valueRender={(v: any) => s.tip ? <Tooltip title={s.tip}><span>{v}</span></Tooltip> : <span>{v}</span>}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* Daily Review Cards */}
      {reviewCards.length > 0 && (
        <Card size="small" style={{ marginBottom: 16, border: '1px solid #ffd591', background: '#fffbe6' }}
          title={<span><ThunderboltOutlined style={{ color: '#fa8c16' }} /> 今日复习推荐（每天随机 3 张，巩固记忆）</span>}
          extra={<Button size="small" type="link" onClick={loadCards} icon={<ReloadOutlined />}>换一批</Button>}>
          <Row gutter={12}>
            {reviewCards.map((card: any, idx: number) => (
              <Col span={8} key={idx}>
                <Card size="small" hoverable style={{ cursor: 'pointer' }} onClick={() => handleViewCard(card)}>
                  <Typography.Text strong ellipsis style={{ fontSize: 14 }}>{card.title}</Typography.Text>
                  <div style={{ marginTop: 4 }}><Tag color="purple" style={{ fontSize: 11 }}>{KNOWLEDGE_TYPE_LABELS[card.knowledge_type] || card.knowledge_type}</Tag></div>
                  <div style={{ marginTop: 6, fontSize: 11, color: '#888' }}>{[card.level1, card.level2, card.level3].filter(Boolean).join(' > ')}</div>
                  <Tag icon={<EyeOutlined />} color="blue" style={{ fontSize: 11, marginTop: 6 }}>点击查看详情</Tag>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      )}

      {/* AI Induction Result */}
      {inductionResult && (
        <Card style={{ marginBottom: 16, border: '1px solid #91caff', background: '#f6ffed' }}
          extra={<Space>
            <Button size="small" icon={<CopyOutlined />} onClick={handleCopyNote}>复制笔记</Button>
            <Button size="small" type="primary" icon={<ExportOutlined />} onClick={handleWriteToVault} loading={writing}>写入 Obsidian</Button>
            <Button size="small" type="link" onClick={() => setInductionResult(null)}>收起</Button>
          </Space>}>
          {writeResult && (
            <Card size="small" style={{ marginBottom: 12, background: '#e6f4ff', border: '1px solid #91caff' }}>
              <Typography.Text strong>写入完成：</Typography.Text>
              <span style={{ marginLeft: 8 }}>
                每日笔记 {writeResult.dailyNote?.success ? '✅' : '❌'} |
                新卡片 {writeResult.newCards?.filter((c: any) => c.success).length}/{writeResult.newCards?.length} |
                更新 {writeResult.updatedCards?.filter((c: any) => c.success).length}/{writeResult.updatedCards?.length} |
                MOC {writeResult.mocUpdates?.filter((m: any) => m.success).length}/{writeResult.mocUpdates?.length}
              </span>
              {writeResult.dailyNote?.path && <div style={{ marginTop: 4 }}><Button size="small" type="link" onClick={handleOpenVault}><FolderOpenOutlined /> 打开 Vault</Button></div>}
            </Card>
          )}
          <Tabs items={[
            {
              key: 'note', label: '📓 今日笔记',
              children: <div style={{ maxHeight: 400, overflow: 'auto', background: '#fff', borderRadius: 8, padding: 16, border: '1px solid #f0f0f0' }}>
                <MarkdownRenderer content={inductionResult.daily_note.full_markdown} />
              </div>
            },
            {
              key: 'cards',
              label: <span>📔 知识卡片
                {inductionResult.card_operations.new_cards.length > 0 && <Tag color="blue" style={{ marginLeft: 4 }}>+{inductionResult.card_operations.new_cards.length}</Tag>}
                {inductionResult.card_operations.updated_cards.length > 0 && <Tag color="orange" style={{ marginLeft: 2 }}>~{inductionResult.card_operations.updated_cards.length}</Tag>}
              </span>,
              children: <div style={{ maxHeight: 400, overflow: 'auto' }}>
                {inductionResult.card_operations.new_cards.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <Typography.Title level={5} style={{ color: '#1677ff' }}>✨ 新建 ({inductionResult.card_operations.new_cards.length})</Typography.Title>
                    {inductionResult.card_operations.new_cards.map((card: any, idx: number) => (
                      <Card key={idx} size="small" style={{ marginBottom: 8 }}>
                        <Typography.Text strong>{card.title}</Typography.Text>
                        <div style={{ fontSize: 12, color: '#888' }}><Tag color="purple">{KNOWLEDGE_TYPE_LABELS[card.knowledge_type] || card.knowledge_type}</Tag>{card.file_path}</div>
                        <div style={{ marginTop: 6, padding: 8, background: '#fafafa', borderRadius: 6, fontSize: 12, maxHeight: 120, overflow: 'auto' }}><MarkdownRenderer content={card.body?.slice(0, 500) || ''} /></div>
                      </Card>
                    ))}
                  </div>
                )}
                {inductionResult.card_operations.updated_cards.length > 0 && (
                  <div>
                    <Typography.Title level={5} style={{ color: '#fa8c16' }}>🔄 更新 ({inductionResult.card_operations.updated_cards.length})</Typography.Title>
                    {inductionResult.card_operations.updated_cards.map((card: any, idx: number) => (
                      <Card key={idx} size="small" style={{ marginBottom: 8 }}>
                        <Typography.Text strong>{card.existing_file}</Typography.Text>
                        <div style={{ fontSize: 12, color: '#888' }}><Tag>追加「{card.add_to_section}」</Tag>+{card.increment_error_count} 次</div>
                        {card.new_content && <div style={{ marginTop: 6, padding: 8, background: '#fff7e6', borderRadius: 6, fontSize: 12 }}>{card.new_content}</div>}
                      </Card>
                    ))}
                  </div>
                )}
                {inductionResult.card_operations.moc_updates.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>📑 将更新 {inductionResult.card_operations.moc_updates.length} 个 MOC 索引</Typography.Text>}
              </div>
            }
          ]} />
        </Card>
      )}

      {/* Priority Table */}
      <Card title="🔥 知识点优先级排行榜" size="small" style={{ marginBottom: 16 }}
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>按累计错误次数排序</Typography.Text>}>
        {priorityList.length === 0
          ? <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          : <Table dataSource={priorityList} columns={priorityCols} rowKey={(r: any) => `${r.level1}|${r.level2}|${r.level3}`} size="small" pagination={{ pageSize: 15, size: 'small', showSizeChanger: false }} />}
      </Card>

      {/* Today's Questions */}
      <Card title="📋 今日错题清单" size="small" style={{ marginBottom: 16 }}
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{todayQuestions.length} 道题</Typography.Text>}>
        {todayQuestions.length === 0
          ? <Empty description="今天还没有已确认的错题" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          : <Table dataSource={todayQuestions} columns={questionCols} rowKey="id" size="small" pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }} />}
      </Card>

      {/* Knowledge Card Library */}
      <Card size="small"
        title={<span>📔 知识卡片库（{filteredCards.length}{cardSearch || cardTypeFilter || selectedTreeKeys.length > 0 ? ` / 共 ${allCards.length}` : ''}）</span>}
        extra={<Space onClick={e => e.stopPropagation()}>
          <Select size="small" placeholder="全部类型" allowClear style={{ width: 110 }} value={cardTypeFilter} onChange={(v) => { setCardTypeFilter(v); setSelectedTreeKeys([]) }}
            options={[{ value: 'pitfall', label: '易错点' }, { value: 'concept', label: '概念辨析' }, { value: 'shortcut', label: '速解技巧' }, { value: 'formula', label: '公式定理' }]}
          />
          <Input size="small" placeholder="搜索..." style={{ width: 140 }} value={cardSearch} onChange={e => { setCardSearch(e.target.value); setSelectedTreeKeys([]) }} allowClear />
        </Space>}>
        <Row gutter={16}>
          <Col span={6}>
            <Input size="small" placeholder="🔍 搜索卡片..." value={treeSearch}
              onChange={e => setTreeSearch(e.target.value)} allowClear
              style={{ marginBottom: 8 }} />
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 8, maxHeight: 370, overflow: 'auto', background: '#fafafa' }}>
              {filteredTree.length === 0
                ? <Empty description={treeSearch ? '无匹配结果' : '暂无卡片'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                : <Tree treeData={filteredTree} selectedKeys={selectedTreeKeys}
                    expandedKeys={treeSearch ? treeExpandedKeys : expandedTreeKeys}
                    onExpand={(keys) => setExpandedTreeKeys(keys as string[])}
                    onSelect={(keys) => setSelectedTreeKeys(keys as string[])}
                    showLine={{ showLeafIcon: false }} style={{ fontSize: 13 }} />}
            </div>
          </Col>
          <Col span={18}>
            {filteredCards.length === 0
              ? <Empty description="暂无知识卡片" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              : <Table dataSource={filteredCards} rowKey="file_path" size="small" pagination={{ pageSize: 12, size: 'small', showSizeChanger: false }}
                  columns={[
                    { title: '标题', dataIndex: 'title', ellipsis: true, render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
                    { title: '类型', dataIndex: 'knowledge_type', width: 80, render: (v: string) => <Tag>{KNOWLEDGE_TYPE_LABELS[v] || v}</Tag> },
                    { title: '操作', width: 130, render: (_: any, r: any) => <Space size={0}>
                      <Button size="small" type="link" style={{ padding: '0 4px' }} onClick={() => handleViewCard(r)}><EyeOutlined /></Button>
                      <Button size="small" type="link" style={{ padding: '0 4px' }} onClick={() => handleOpenCardInObsidian(r.file_path)}><ExportOutlined /></Button>
                    </Space> }
                  ]} />}
          </Col>
        </Row>
      </Card>

      {/* Daily Notes */}
      <Collapse style={{ marginTop: 12 }}
        items={[{
          key: 'notes', label: <span>📓 每日笔记（{dailyNotes.length} 篇）</span>,
          children: dailyNotes.length === 0
            ? <Empty description="暂无每日笔记" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            : <Table dataSource={dailyNotes} rowKey="date" size="small" pagination={{ pageSize: 15, size: 'small', showSizeChanger: false }}
                columns={[
                  { title: '日期', dataIndex: 'date', width: 110, render: (v: string) => <Space><CalendarOutlined style={{ color: '#1677ff' }} />{v}</Space> },
                  { title: '标题', dataIndex: 'title', ellipsis: true, render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
                  { title: '错题', dataIndex: 'total_questions', width: 60, align: 'center' as const, render: (v: number) => <Tag color="blue">{v}</Tag> },
                  { title: '摘要', dataIndex: 'preview', ellipsis: true, render: (v: string) => <span style={{ fontSize: 12, color: '#888' }}>{v}</span> },
                  { title: '', width: 100, render: (_: any, r: any) => <Space size={0}>
                    <Button size="small" type="link" style={{ padding: '0 4px' }} onClick={() => handleViewNote(r)}><EyeOutlined /></Button>
                    <Button size="small" type="link" style={{ padding: '0 4px' }} onClick={() => handleOpenCardInObsidian(r.file_path)}><ExportOutlined /></Button>
                  </Space> }
                ]} />
        }]} />

      {/* Modals */}
      <Modal title={cardModalTitle} open={cardModalOpen} onCancel={() => setCardModalOpen(false)} footer={null} width={700}>
        <div className="markdown-body" style={{ maxHeight: '60vh', overflow: 'auto', padding: 8, fontSize: 14, lineHeight: 1.8 }}>
          {cardModalContent ? <MarkdownRenderer content={cardModalContent} /> : '加载中...'}
        </div>
      </Modal>
      <Modal title={noteModalTitle} open={noteModalOpen} onCancel={() => setNoteModalOpen(false)} footer={null} width={750}>
        <div className="markdown-body" style={{ maxHeight: '60vh', overflow: 'auto', padding: 8, fontSize: 14, lineHeight: 1.8 }}>
          {noteModalContent ? <MarkdownRenderer content={noteModalContent} /> : '加载中...'}
        </div>
      </Modal>
    </div>
  )
}
