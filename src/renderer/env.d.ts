/// <reference types="vite/client" />

interface ElectronApi {  getConfig: (key: string) => Promise<string | undefined>
  getAllConfig: () => Promise<Record<string, string>>
  setConfig: (key: string, value: string) => Promise<void>
  readFile: (filePath: string) => Promise<string>
  readImageDataUrl: (filePath: string) => Promise<string>
  downloadImageAsDataUrl: (url: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
  cropAndSaveGraphic: (params: { imageUrl: string; crop: { x: number; y: number; width: number; height: number } | null; rotation: number }) => Promise<{ success: boolean; filePath?: string; error?: string }>
  uploadImages: (files: (string | { path: string; rotation?: number; crop?: { x: number; y: number; width: number; height: number } })[]) => Promise<any[]>
  pasteImage: () => Promise<{ success: boolean; url?: string; localAbsPath?: string; localRelPath?: string; traceId?: string; error?: string }>
  testEasyImage: (baseURL: string, token: string) => Promise<{ success: boolean; message?: string; detail?: string; error?: string }>
  classifyImage: (imageUrl: string, traceId: string) => Promise<any>
  getAiSuggestion: (statsData: any) => Promise<{ success: boolean; suggestion?: string; error?: string }>
  generateReflection: (params: { level1: string; level2?: string; level3?: string | null; ocrText: string; traceId?: string }) => Promise<{ success: boolean; reflection?: string; error?: string }>
  fetchModels: (baseURL: string, apiKey: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
  testConnection: (baseURL: string, apiKey: string, model: string) => Promise<{ success: boolean; latency?: number; modelUsed?: string; preview?: string; error?: string }>
  writeToObsidian: (questionData: any) => Promise<any>
  checkObsidianOnline: () => Promise<boolean>
  syncVault: () => Promise<{ deleted: number; message: string }>
  reorganizeVault: () => Promise<{ moved: number; skipped: number }>
  getStreak: () => Promise<{ streak: number; total: number }>
  getQuestions: (params: any) => Promise<{ items: any[]; total: number }>
  getQuestion: (id: string) => Promise<any>
  deleteQuestion: (id: string) => Promise<void>
  getPendingCount: () => Promise<number>
  updateQuestionStatus: (id: string, status: string) => Promise<void>
  updateQuestion: (id: string, updates: Record<string, any>) => Promise<{ success: boolean }>
  getStats: () => Promise<any>
  getTagTree: () => Promise<any>
  saveTagTree: (data: any) => Promise<void>
  getCustomTags: () => Promise<any[]>
  addCustomTag: (tag: any) => Promise<void>
  getErrorTypes: () => Promise<string[]>
  saveErrorTypes: (types: string[]) => Promise<void>
  getLogs: (params: any) => Promise<{ items: any[]; total: number }>
  markLogResolved: (id: number) => Promise<void>
  exportLogs: () => Promise<string>
  cleanLogs: (days: number) => Promise<void>
  getLogTrace: (traceId: string) => Promise<any[]>
  onLogError: (callback: (data: any) => void) => () => void
  onAutoInductComplete: (callback: (data: { date: string; success: boolean }) => void) => () => void
  onUploadProgress: (callback: (data: any) => void) => () => void
  onAiProgress: (callback: (data: { traceId: string; stage: string; message: string; ts: number; progress?: number; tokens?: number }) => void) => () => void
  getKnowledgeOverview: (date?: string) => Promise<{
    today: {
      questionCount: number
      knowledgePointCount: number
      newPointsCount: number
      highFreqCount: number
      existingCardCount: number
    }
    todayQuestions: Array<{
      id: string
      level1: string; level2: string; level3: string | null
      error_count: number; error_type: string | null
      ocr_text: string | null; obsidian_path: string | null
      confirmed_at: string; created_at: string
      reflection: string | null
      knowledge_total_errors: number
      knowledge_first_seen: string
      knowledge_question_count: number
      is_first_time: boolean
    }>
    priorityList: Array<{
      level1: string; level2: string; level3: string | null
      question_count: number; total_errors: number
      first_seen: string; last_seen: string
      priority: 'high' | 'medium' | 'low' | 'new'
    }>
  }>
  inductKnowledge: (date?: string) => Promise<{
    success: boolean
    error?: string
    daily_note?: {
      date: string; total_questions: number; categories_studied: string[]
      overview: string; error_distribution: string
      new_findings: string; cards_new: string[]; cards_updated: string[]
      full_markdown: string
    }
    card_operations?: {
      new_cards: Array<{
        file_path: string; title: string; knowledge_type: string
        body: string; linked_cards: string[]; related_questions: string[]
      }>
      updated_cards: Array<{
        existing_file: string; add_to_section: string; new_content: string
        increment_error_count: number
        new_linked_cards: string[]; new_related_questions: string[]
      }>
      moc_updates: Array<{
        moc_file: string; action: string; card_path?: string; group?: string
      }>
    }
  }>
  writeInductionToVault: (data: {
    daily_note_markdown: string; date: string
    new_cards: any[]; updated_cards: any[]; moc_updates: any[]
  }) => Promise<{
    success: boolean; error?: string
    dailyNote: { success: boolean; path: string; error?: string }
    newCards: Array<{ title: string; success: boolean; path: string; error?: string }>
    updatedCards: Array<{ file: string; success: boolean; error?: string }>
    mocUpdates: Array<{ file: string; success: boolean; error?: string }>
  }>
  getKnowledgeCards: () => Promise<{ success: boolean; error?: string; cards: Array<{ title: string; file_path: string; knowledge_type: string; level1: string; level2: string; level3: string | null }> }>
  getKnowledgeCardContent: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
  getDailyNotes: () => Promise<{ success: boolean; error?: string; notes: Array<{ date: string; file_path: string; title: string; total_questions: number; preview: string }> }>
  getDailyNoteContent: (date: string) => Promise<{ success: boolean; content?: string; error?: string }>
  getReviewCards: (count?: number) => Promise<{ success: boolean; error?: string; cards: Array<{ title: string; file_path: string; knowledge_type: string; level1: string; level2: string; level3: string | null }> }>
  selectTestQuestions: (params?: { ids?: string[]; level1?: string; level2?: string; level3?: string; search?: string; limit?: number; random?: boolean }) => Promise<{ success: boolean; error?: string; questions: any[] }>
  generateTestPdf: (questionIds: string[], options?: { title?: string; showAnswers?: boolean; questionsPerPage?: number; pageSize?: string; includeAnswerSheet?: boolean; imageMode?: 'graphics_only' | 'full' }) => Promise<{ success: boolean; filePath?: string; error?: string; imageErrors: string[] }>
  openExternal: (path: string) => Promise<void>
  getAppVersion: () => Promise<string>
  selectDirectory: () => Promise<string | null>
  selectFiles: () => Promise<string[]>
  selectFile: () => Promise<string | null>
  saveFile: (defaultName: string, content: string) => Promise<string | null>
}

declare global {
  interface Window {
    api: ElectronApi
  }
}

export {}
