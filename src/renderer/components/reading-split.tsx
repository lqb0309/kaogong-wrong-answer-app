import { useEffect, useState, type ReactNode } from 'react'
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels'

/** Same accessible splitter for pending review and the question bank. */
export function ReadingSplit({ storageKey, children }: { storageKey: string; children: [ReactNode, ReactNode] }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 780)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < 780)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const key = `${storageKey}-${narrow ? 'vertical' : 'horizontal'}`
  let layout: Layout = { question: 44, review: 56 }
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    if (saved && Number.isFinite(saved.question) && Number.isFinite(saved.review) && saved.question >= 25 && saved.review >= 25 && Math.abs(saved.question + saved.review - 100) < 1) layout = saved
  } catch { /* unavailable storage or old settings */ }
  return <Group key={`${key}-${revision}`} className={`reading-split${narrow ? ' is-vertical' : ''}`} orientation={narrow ? 'vertical' : 'horizontal'} defaultLayout={layout}
    onLayoutChanged={(value, meta) => { if (meta.isUserInteraction) try { localStorage.setItem(key, JSON.stringify(meta.requestedLayout || value)) } catch { /* layout remains usable */ } }}>
    <Panel id="question" minSize="25%" className="reading-split-panel">{children[0]}</Panel>
    <Separator className="reading-split-handle" style={narrow ? { height: 16, flex: '0 0 16px' } : { width: 16, flex: '0 0 16px' }} aria-label="调整题目与复盘占比" title="拖动或用方向键调整；双击恢复默认比例"
      onDoubleClick={() => { try { localStorage.removeItem(key) } catch { /* optional persistence */ }; setRevision(value => value + 1) }} />
    <Panel id="review" minSize="25%" className="reading-split-panel">{children[1]}</Panel>
  </Group>
}
