/// <reference types="vite/client" />

interface ElectronApi {  getConfig: (key: string) => Promise<string | undefined>
  createBackup: () => Promise<{ success: boolean; backup: { name: string; path: string; createdAt: string; size: number } }>
  listBackups: () => Promise<Array<{ name: string; path: string; createdAt: string; size: number }>>
  restoreBackup: (name: string) => Promise<{ success: boolean; restarting: boolean }>
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
  createMaterialGroup: (images: Array<{ url: string; localAbsPath?: string }>) => Promise<{ success: boolean; error?: string; groupId?: string; title?: string; totalQuestions?: number; wrongQuestions?: number; uncertainQuestions?: number; createdIds: string[] }>
  getAiSuggestion: (statsData: any) => Promise<{ success: boolean; suggestion?: string; error?: string }>
  generateReflection: (params: { level1: string; level2?: string; level3?: string | null; ocrText: string; errorType?: string; traceId?: string; officialAnalysis?: string; correctAnswer?: string; userAnswer?: string; answerTime?: string; correctRate?: string; difficulty?: number | null; questionId?: string; materialText?: string; imageUrls?: string[] }) => Promise<{ success: boolean; reflection?: string; error?: string }>
  fetchModels: (baseURL: string, apiKey: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
  getAiUsage: (days?: number) => Promise<{ days: number; totals: { calls: number; prompt_tokens: number; completion_tokens: number; total_tokens: number; estimated_cost: number }; byFeature: Array<{ feature: string; calls: number; total_tokens: number; estimated_cost: number }> }>
  getBillingOverview: () => Promise<{
    usage: { today: { calls: number; tokens: number; cost: number; unpriced: number }; month: { calls: number; tokens: number; cost: number; unpriced: number } }
    ccSwitch: { detected: boolean; path: string; modelCount: number; modifiedAt: string | null; error?: string }
    balance: { available: boolean; provider: string; balances: Array<{ currency: string; total: string; granted: string; toppedUp: string }>; error?: string }
  }>
  getFenbiAnalysisStatus: () => Promise<{ queued: number; failed: number; ready: number; running: boolean; paused: boolean }>
  getFenbiGroupEfficiencyRecords: () => Promise<Array<{ id: string; title: string; questionCount: number; correctCount: number; actualSeconds: number | null; targetSeconds: number; graceSeconds: number; difficulty: number | null }>>
  controlFenbiAnalysis: (action: 'pause' | 'resume' | 'retry-failed') => Promise<{ queued: number; failed: number; ready: number; running: boolean; paused: boolean }>
  openFenbiImporter: () => Promise<{ success: boolean; url: string }>
  previewFenbiReport: () => Promise<{
    exerciseId: string; title: string; url: string
    materials: Array<{ index: number; text: string; images: string[] }>
    questions: Array<{
      sourceId: string; index: number; materialIndex: number; stem: string
      options: Array<{ key: string; text: string }>; correctAnswer: string; userAnswer: string
      isWrong: boolean | null; analysis: string; keypoints: string[]; source: string; answerTime: string
      correctRate: string; errorProne: string; questionType: string
      questionImages: string[]; optionImages: Record<string, string[]>
      suggestedSeconds?: number; isOvertime?: boolean; overtimeSeconds?: number
      timingBasis?: 'question' | 'group'; groupActualSeconds?: number
      groupTargetSeconds?: number; groupGraceSeconds?: number
    }>
    duplicateIds: string[]
    difficulty?: number | null
  }>
  importFenbiQuestions: (params: { preview: any; sourceIds: string[]; generateReflections?: boolean }) => Promise<{ imported: number; skipped: number; failed: number; ids: string[]; analysisQueued: number }>
  syncFenbiToday: () => Promise<{ success: boolean; date: string; sessions: number; questions: number; correct: number; wrong: number; overtime: number; totalSeconds: number; modules: Array<{ name: string; count: number; correct: number }>; summary: string; completedTasks: string[]; syncedAt: string; scannedReports: number; failedReports: number }>
  syncFenbiCurrentReport: () => Promise<{ success: boolean; date: string; sessions: number; questions: number; correct: number; wrong: number; overtime: number; totalSeconds: number; modules: Array<{ name: string; count: number; correct: number }>; summary: string; completedTasks: string[]; syncedAt: string }>
  syncFenbiWrongQuestions: (params: { startDate?: string; endDate?: string; includeCorrectOvertime?: boolean }) => Promise<{ scannedReports: number; failedReports: number; selected: number; imported: number; skipped: number; failed: number }>
  getFenbiTodaySummary: () => Promise<{ date: string; sessions: number; questions: number; correct: number; wrong: number; overtime: number; totalSeconds: number; accuracy: number; modules: Array<{ name: string; count: number; correct: number }>; syncedAt: string } | null>
  testConnection: (baseURL: string, apiKey: string, model: string) => Promise<{ success: boolean; latency?: number; modelUsed?: string; preview?: string; error?: string }>
  writeToObsidian: (questionData: any) => Promise<any>
  checkObsidianOnline: () => Promise<boolean>
  repairQuestionNotes: () => Promise<{ repaired: number; failed: number; backupPath: string }>
  syncVault: () => Promise<{ deleted: number; missing?: number; repairable?: number; message: string }>
  reorganizeVault: () => Promise<{ moved: number; skipped: number }>
  getStreak: () => Promise<{ streak: number; total: number }>
  getAppOverview: () => Promise<{ pendingCount: number; classifiedCount: number; confirmedCount: number; todayCount: number; streak: number; retryQueueSize: number }>
  flushRetryQueue: () => Promise<{ flushed: number; failed: number }>
  getQuestions: (params: any) => Promise<{ items: any[]; total: number }>
  getSpeedTrainingQuestions: (params: { count: number; scope?: string; level1?: string; level2?: string; level3?: string; answerResult?: string; pickMode?: string }) => Promise<{ items: any[]; available: number }>
  recordSpeedTrainingAttempt: (params: { questionId: string; selectedAnswer: string; correctAnswer: string; elapsedSeconds: number; targetSeconds: number }) => Promise<{ success: boolean; achieved: boolean; consecutivePasses: number; graduated: boolean }>
  recordSpeedTrainingSession: (params: { answers: Array<{ questionId: string; selectedAnswer: string; correctAnswer: string }>; elapsedSeconds: number; limitSeconds: number; accuracyTarget?: number }) => Promise<{ success: boolean; correctCount: number; accuracy: number; onTime: boolean; savedSeconds: number; graduated: number }>
  getQuestion: (id: string) => Promise<any>
  getQuestionGroupMembers: (groupId: string) => Promise<any[]>
  deleteQuestion: (id: string) => Promise<void>
  deleteQueuedQuestions: (ids: string[]) => Promise<{ deletedIds: string[]; failed: Array<{ id: string; error: string }> }>
  getPendingCount: () => Promise<number>
  createManualQuestion: (data: { imageUrl?: string; level1: string; level2?: string; level3?: string; ocrText?: string; errorCount?: number; source?: string; mode: 'direct' | 'review' }) => Promise<{ success: boolean; id?: string; pendingReview?: boolean; error?: string }>
  updatePendingDraft: (id: string, updates: any) => Promise<{ success: boolean; error?: string }>
  updateQuestionStatus: (id: string, status: string) => Promise<void>
  updateQuestion: (id: string, updates: Record<string, any>) => Promise<{ success: boolean; error?: string; warning?: string; syncPending?: boolean }>
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
  onPdfProgress: (callback: (data: { stage: string; done?: number; total?: number; ts: number }) => void) => () => void
  onUploadProgress: (callback: (data: any) => void) => () => void
  onAiProgress: (callback: (data: { traceId: string; stage: string; message: string; ts: number; progress?: number; tokens?: number }) => void) => () => void
  onFenbiAnalysisProgress: (callback: (data: { stage: 'started' | 'progress' | 'complete' | 'paused'; total: number; done: number; failed: number; message: string }) => void) => () => void
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
  getKnowledgeCards: () => Promise<{ success: boolean; error?: string; cards: Array<{ title: string; file_path: string; knowledge_type: string; level1: string; level2: string; level3: string | null; error_count: number; last_seen: string }> }>
  getKnowledgeCardContent: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
  getDailyNotes: () => Promise<{ success: boolean; error?: string; notes: Array<{ date: string; file_path: string; title: string; total_questions: number; preview: string }> }>
  getDailyNoteContent: (date: string) => Promise<{ success: boolean; content?: string; error?: string }>
  getReviewQueue: (count?: number) => Promise<{ success: boolean; error?: string; cards: Array<{ title: string; file_path: string; knowledge_type: string; level1: string; level2: string; level3: string | null; error_count: number; last_seen: string; score: number }>; reviewedToday: string[] }>
  markReview: (cardPath: string, result: 'done' | 'wrong' | 'hard' | 'easy') => Promise<{ success: boolean; error?: string; cardBumped?: boolean; intervalDays?: number; dueDate?: string; completedPlanTask?: { title: string } | null }>
  getCardQuestions: (cardPath: string) => Promise<{ success: boolean; error?: string; questions: any[] }>
  selectTestQuestions: (params?: { ids?: string[]; level1?: string; level2?: string; level3?: string; search?: string; limit?: number; random?: boolean }) => Promise<{ success: boolean; error?: string; questions: any[] }>
  smartSelectTestQuestions: (params?: { mode?: 'review' | 'weak' | 'recent' | 'balanced' | 'material'; count?: number; level1?: string; avoidRecentDays?: number }) => Promise<{ success: boolean; error?: string; ids: string[]; selections: Array<{ id: string; reason: string; recentlyPracticed: boolean }> }>
  generateTestPdf: (questionIds: string[], options?: { title?: string; showAnswers?: boolean; answerMode?: 'none' | 'answer' | 'analysis' | 'full'; questionsPerPage?: number; pageSize?: string; includeAnswerSheet?: boolean; imageMode?: 'auto' | 'graphics_only' | 'full' }) => Promise<{ success: boolean; filePath?: string; error?: string; imageErrors: string[]; questionIds?: string[] }>
  createReviewBatch: (params?: { count?: number; minutes?: number; ids?: string[]; excludeIds?: string[]; level1?: string; level2?: string; level3?: string; answerResult?: string; timeStatus?: string; since?: string; until?: string; search?: string }) => Promise<any>
  getReviewBatch: (id: string) => Promise<any>
  listReviewBatches: () => Promise<any[]>
  completeReviewBatch: (id: string) => Promise<{ success: boolean; alreadyCompleted?: boolean; completedAt?: string; completedPlanTask?: { title: string } }>
  exportReviewBatch: (params: { batchId: string; format: 'pdf' | 'html'; content: 'none' | 'answer' | 'analysis' | 'full'; splitAnswers?: boolean; title?: string; pageSize?: 'A4' | 'Letter'; includeAnswerSheet?: boolean }) => Promise<{ success: boolean; canceled?: boolean; files: string[]; imageErrors?: string[]; questionIds?: string[]; error?: string }>
  selectFromReviewQueue: (count?: number) => Promise<{ success: boolean; error?: string; ids: string[]; cards: any[] }>
  markTestAnswers: (wrongIds: string[], questionIds?: string[]) => Promise<{ success: boolean; error?: string; updated?: number; cardBumps?: number; totalCount?: number; accuracy?: number; completedPlanTask?: { title: string } | null }>
  getTestAttempts: (limit?: number) => Promise<Array<{ id: string; question_ids: string; wrong_ids: string; total_count: number; wrong_count: number; accuracy: number; created_at: string }>>
  openExternal: (path: string) => Promise<void>
  getAppVersion: () => Promise<string>
  reportRendererError: (errorText: string) => Promise<void>
  reportNetworkChange: (status: 'online' | 'offline') => Promise<void>
  selectDirectory: () => Promise<string | null>
  selectFiles: () => Promise<string[]>
  selectFile: () => Promise<string | null>
  saveFile: (defaultName: string, content: string) => Promise<string | null>

  // Daily Plan (每日备考计划 + AI 动态调整 + 倒排)
  getTodayPlan: () => Promise<{
    success: boolean
    error?: string
    plan: {
      date: string
      tasks: Array<{ id: string; title: string; detail: string; minutes: number; module: string; done: 0 | 1 }>
      status: 'pending' | 'partial' | 'completed'
      note: string
      ai_adjusted: boolean
      adjustment_reason: string
      created_at: string
      updated_at: string
    } | null
    exam: { exam_date: string; days_until: number }
    phase: {
      name: '基础阶段' | '强化阶段' | '冲刺阶段' | '已到考前'
      days_left: number
      phase_start: string
      phase_end: string
      phase_days_left: number
      focus: string
      milestones: Array<{ date: string; label: string; type: 'phase' | 'exam' | 'info' }>
    }
    future_note: string
    forward_plan: {
      overview: string
      days: Array<{ date: string; title: string; detail: string }>
      generated_at: string
    } | null
    recent: Array<{
      date: string
      status: 'pending' | 'partial' | 'completed'
      note: string
      ai_adjusted: boolean
      adjustment_reason: string
      tasks_total: number
      tasks_done: number
    }>
  }>
  updatePlanTask: (date: string, taskId: string, done: boolean) => Promise<{ success: boolean; plan: any }>
  submitPlanFeedback: (date: string, status: string, note: string) => Promise<{ success: boolean; plan: any }>
  getPlanHistory: (limit?: number) => Promise<Array<{
    date: string
    status: 'pending' | 'partial' | 'completed'
    note: string
    ai_adjusted: boolean
    adjustment_reason: string
    tasks_total: number
    tasks_done: number
  }>>
  regenerateTodayPlan: (input?: { feedback?: string }) => Promise<{ success: boolean; plan: any; error?: string; exam?: { exam_date: string; days_until: number }; phase?: any }>
  planForward: () => Promise<{
    success: boolean
    error?: string
    plan?: {
      overview: string
      days: Array<{ date: string; title: string; detail: string }>
      generated_at: string
    }
    exam?: { exam_date: string; days_until: number }
    phase?: any
  }>
}

declare global {
  interface Window {
    api: ElectronApi
  }
}

export {}
