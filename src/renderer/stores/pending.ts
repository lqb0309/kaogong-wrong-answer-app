import { create } from 'zustand'

interface PendingItem {
  id: string
  imageUrl: string
  level1: string
  level2: string
  level3: string | null
  confidence: number
  ocrText: string
  reasoning: string
  matchType: 'exact' | 'fuzzy' | 'unknown' | 'mapped' | 'adopted' | 'other'
  matchScore?: number
  aiRawLevel1?: string
  aiRawLevel2?: string
  aiRawLevel3?: string
  errorCount: number
  source: string
  reflection: string
  errorType: string
  warning?: string
  traceId: string
  hasGraphics?: boolean
  graphicsDescription?: string
  graphicImagePath?: string
  groupId?: string
  questionNumber?: string
  materialImages?: string[]
  groupTitle?: string
  materialText?: string
  questionImages?: string[]
  optionImages?: Record<string, string[]>
  originalAnswer?: Record<string, any>
  officialAnalysis?: string
}

const draftWrites = new Map<string, Promise<void>>()
export async function flushPendingDraft(id: string): Promise<void> { await draftWrites.get(id) }

interface PendingState {
  queue: PendingItem[]
  currentIndex: number
  setQueue: (items: PendingItem[]) => void
  addItems: (items: PendingItem[]) => void
  removeItem: (id: string) => void
  updateItem: (id: string, updates: Partial<PendingItem>) => void
  setCurrentIndex: (i: number) => void
  clear: () => void
}

export const usePendingStore = create<PendingState>((set) => ({
  queue: [],
  currentIndex: 0,
  setQueue: (items) => set({ queue: [...new Map(items.map((item) => [item.id, item])).values()], currentIndex: 0 }),
  addItems: (items) =>
    set((s) => {
      const merged = new Map(s.queue.map((item) => [item.id, item]))
      for (const item of items) merged.set(item.id, { ...merged.get(item.id), ...item })
      return { queue: [...merged.values()] }
    }),
  removeItem: (id) =>
    set((s) => {
      const queue = s.queue.filter((q) => q.id !== id)
      const currentIndex = Math.min(s.currentIndex, queue.length - 1)
      return { queue, currentIndex: currentIndex >= 0 ? currentIndex : 0 }
    }),
  updateItem: (id, updates) => {
    set((s) => ({ queue: s.queue.map((q) => (q.id === id ? { ...q, ...updates } : q)) }))
    const mapping: Record<string, string> = { level1: 'level1', level2: 'level2', level3: 'level3', ocrText: 'ocr_text', errorType: 'error_type', errorCount: 'error_count', source: 'source', reflection: 'reflection', hasGraphics: 'has_graphics', graphicImagePath: 'graphic_image_path' }
    const payload = Object.fromEntries(Object.entries(updates).filter(([key]) => mapping[key]).map(([key, value]) => [mapping[key], key === 'hasGraphics' ? Number(value) : value]))
    if (!Object.keys(payload).length) return
    const work = (draftWrites.get(id) || Promise.resolve()).then(async () => {
      const result = await window.api.updatePendingDraft(id, payload)
      if (!result.success) throw new Error(result.error || '待确认修改未保存')
    }).catch(error => {
      set(s => ({ queue: s.queue.map(q => q.id === id ? { ...q, warning: `本次修改尚未保存：${error.message}。请重试确认，不要关闭应用。` } : q) }))
    })
    draftWrites.set(id, work)
    void work.finally(() => { if (draftWrites.get(id) === work) draftWrites.delete(id) })
  },
  setCurrentIndex: (i) => set({ currentIndex: i }),
  clear: () => set({ queue: [], currentIndex: 0 })
}))
