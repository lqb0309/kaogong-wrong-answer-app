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
}

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
  setQueue: (items) => set({ queue: items, currentIndex: 0 }),
  addItems: (items) =>
    set((s) => ({ queue: [...s.queue, ...items] })),
  removeItem: (id) =>
    set((s) => {
      const queue = s.queue.filter((q) => q.id !== id)
      const currentIndex = Math.min(s.currentIndex, queue.length - 1)
      return { queue, currentIndex: currentIndex >= 0 ? currentIndex : 0 }
    }),
  updateItem: (id, updates) =>
    set((s) => ({
      queue: s.queue.map((q) => (q.id === id ? { ...q, ...updates } : q))
    })),
  setCurrentIndex: (i) => set({ currentIndex: i }),
  clear: () => set({ queue: [], currentIndex: 0 })
}))
