import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // Config
  getConfig: (key: string) => ipcRenderer.invoke('config:get', key),
  getAllConfig: () => ipcRenderer.invoke('config:getAll'),
  setConfig: (key: string, value: string) => ipcRenderer.invoke('config:set', key, value),
  createBackup: () => ipcRenderer.invoke('backup:create'),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  restoreBackup: (name: string) => ipcRenderer.invoke('backup:restore', name),

  // File
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  readImageDataUrl: (filePath: string) => ipcRenderer.invoke('file:readImage', filePath),
  downloadImageAsDataUrl: (url: string) => ipcRenderer.invoke('image:download', url),
  cropAndSaveGraphic: (params: { imageUrl: string; crop: { x: number; y: number; width: number; height: number } | null; rotation: number }) => ipcRenderer.invoke('image:cropAndSave', params),

  // Upload
  uploadImages: (files: (string | { path: string; rotation?: number; crop?: { x: number; y: number; width: number; height: number } })[]) => ipcRenderer.invoke('upload:images', files),
  pasteImage: () => ipcRenderer.invoke('clipboard:pasteImage'),
  testEasyImage: (baseURL: string, token: string) => ipcRenderer.invoke('easyimage:test', baseURL, token),

  // AI Classify
  classifyImage: (imageUrl: string, traceId: string) => ipcRenderer.invoke('ai:classify', imageUrl, traceId),
  createMaterialGroup: (images: Array<{ url: string; localAbsPath?: string }>) => ipcRenderer.invoke('materialGroup:create', images),
  getAiSuggestion: (statsData: any) => ipcRenderer.invoke('ai:suggest', statsData),
  generateReflection: (params: any) => ipcRenderer.invoke('ai:reflect', params),
  fetchModels: (baseURL: string, apiKey: string) => ipcRenderer.invoke('ai:models', baseURL, apiKey),
  getAiUsage: (days?: number) => ipcRenderer.invoke('ai:usage', days),
  getBillingOverview: () => ipcRenderer.invoke('billing:overview'),
  openFenbiImporter: () => ipcRenderer.invoke('fenbi:open'),
  previewFenbiReport: () => ipcRenderer.invoke('fenbi:preview'),
  importFenbiQuestions: (params: any) => ipcRenderer.invoke('fenbi:import', params),
  syncFenbiToday: () => ipcRenderer.invoke('fenbi:syncToday'),
  syncFenbiCurrentReport: () => ipcRenderer.invoke('fenbi:syncCurrent'),
  syncFenbiWrongQuestions: (params: { startDate?: string; endDate?: string; includeCorrectOvertime?: boolean }) => ipcRenderer.invoke('fenbi:syncWrongQuestions', params),
  getFenbiTodaySummary: () => ipcRenderer.invoke('fenbi:todaySummary'),
  getFenbiAnalysisStatus: () => ipcRenderer.invoke('fenbi:analysisStatus'),
  getFenbiGroupEfficiencyRecords: () => ipcRenderer.invoke('fenbi:groupEfficiency'),
  controlFenbiAnalysis: (action: 'pause' | 'resume' | 'retry-failed') => ipcRenderer.invoke('fenbi:analysisControl', action),
  testConnection: (baseURL: string, apiKey: string, model: string) => ipcRenderer.invoke('ai:test', baseURL, apiKey, model),

  // Obsidian
  writeToObsidian: (questionData: any) => ipcRenderer.invoke('obsidian:write', questionData),
  checkObsidianOnline: () => ipcRenderer.invoke('obsidian:check'),
  repairQuestionNotes: () => ipcRenderer.invoke('obsidian:repairNotes'),
  syncVault: () => ipcRenderer.invoke('obsidian:sync'),
  reorganizeVault: () => ipcRenderer.invoke('obsidian:reorganize'),
  getStreak: () => ipcRenderer.invoke('app:streak'),
  getAppOverview: () => ipcRenderer.invoke('app:overview'),
  flushRetryQueue: () => ipcRenderer.invoke('retry:flush'),

  // Questions
  getQuestions: (params: any) => ipcRenderer.invoke('questions:list', params),
  getSpeedTrainingQuestions: (params: any) => ipcRenderer.invoke('speedTraining:questions', params),
  recordSpeedTrainingAttempt: (params: any) => ipcRenderer.invoke('speedTraining:record', params),
  recordSpeedTrainingSession: (params: any) => ipcRenderer.invoke('speedTraining:recordSession', params),
  getQuestion: (id: string) => ipcRenderer.invoke('questions:get', id),
  getQuestionGroupMembers: (groupId: string) => ipcRenderer.invoke('questions:groupMembers', groupId),
  deleteQuestion: (id: string) => ipcRenderer.invoke('questions:delete', id),
  deleteQueuedQuestions: (ids: string[]) => ipcRenderer.invoke('questions:deleteQueued', ids),
  getPendingCount: () => ipcRenderer.invoke('questions:pendingCount'),
  createManualQuestion: (data: any) => ipcRenderer.invoke('questions:createManual', data),
  updatePendingDraft: (id: string, updates: any) => ipcRenderer.invoke('questions:updateDraft', id, updates),
  updateQuestionStatus: (id: string, status: string) => ipcRenderer.invoke('questions:updateStatus', id, status),
  updateQuestion: (id: string, updates: any) => ipcRenderer.invoke('questions:update', id, updates),
  getStats: () => ipcRenderer.invoke('questions:stats'),

  // Tag Tree
  getTagTree: () => ipcRenderer.invoke('tags:getTree'),
  saveTagTree: (data: any) => ipcRenderer.invoke('tags:saveTree', data),
  getCustomTags: () => ipcRenderer.invoke('tags:getCustom'),
  addCustomTag: (tag: any) => ipcRenderer.invoke('tags:addCustom', tag),
  getErrorTypes: () => ipcRenderer.invoke('errorTypes:getAll'),
  saveErrorTypes: (types: string[]) => ipcRenderer.invoke('errorTypes:save', types),

  // Logs
  getLogs: (params: any) => ipcRenderer.invoke('logs:list', params),
  markLogResolved: (id: number) => ipcRenderer.invoke('logs:resolve', id),
  exportLogs: () => ipcRenderer.invoke('logs:export'),
  cleanLogs: (days: number) => ipcRenderer.invoke('logs:clean', days),
  getLogTrace: (traceId: string) => ipcRenderer.invoke('logs:trace', traceId),

  // Knowledge Induction
  getKnowledgeOverview: (date?: string) => ipcRenderer.invoke('knowledge:overview', date),
  inductKnowledge: (date?: string) => ipcRenderer.invoke('knowledge:induct', date),
  writeInductionToVault: (data: any) => ipcRenderer.invoke('knowledge:writeToVault', data),
  getKnowledgeCards: () => ipcRenderer.invoke('knowledge:cards'),
  getKnowledgeCardContent: (filePath: string) => ipcRenderer.invoke('knowledge:cardContent', filePath),
  getDailyNotes: () => ipcRenderer.invoke('knowledge:dailyNotes'),
  getDailyNoteContent: (date: string) => ipcRenderer.invoke('knowledge:dailyNoteContent', date),
  getReviewQueue: (count?: number) => ipcRenderer.invoke('knowledge:reviewQueue', count),
  markReview: (cardPath: string, result: string) => ipcRenderer.invoke('knowledge:reviewDone', cardPath, result),
  getCardQuestions: (cardPath: string) => ipcRenderer.invoke('knowledge:cardQuestions', cardPath),

  // Test Builder (组卷)
  createReviewBatch: (params?: any) => ipcRenderer.invoke('review:createBatch', params || {}),
  getReviewBatch: (id: string) => ipcRenderer.invoke('review:getBatch', id),
  listReviewBatches: () => ipcRenderer.invoke('review:listBatches'),
  completeReviewBatch: (id: string) => ipcRenderer.invoke('review:completeBatch', id),
  exportReviewBatch: (params: any) => ipcRenderer.invoke('review:exportBatch', params),
  selectTestQuestions: (params?: any) => ipcRenderer.invoke('test:selectQuestions', params || {}),
  smartSelectTestQuestions: (params?: any) => ipcRenderer.invoke('test:smartSelect', params || {}),
  generateTestPdf: (questionIds: string[], options?: any) => ipcRenderer.invoke('test:generatePdf', questionIds, options || {}),
  selectFromReviewQueue: (count?: number) => ipcRenderer.invoke('test:selectFromReviewQueue', count),
  markTestAnswers: (wrongIds: string[], questionIds?: string[]) => ipcRenderer.invoke('test:markAnswers', wrongIds, questionIds),
  getTestAttempts: (limit?: number) => ipcRenderer.invoke('test:attempts', limit),

  // Daily Plan (每日备考计划 + AI 动态调整 + 倒排)
  getTodayPlan: () => ipcRenderer.invoke('plan:getToday'),
  updatePlanTask: (date: string, taskId: string, done: boolean) => ipcRenderer.invoke('plan:updateTask', date, taskId, done),
  submitPlanFeedback: (date: string, status: string, note: string) => ipcRenderer.invoke('plan:submitFeedback', date, status, note),
  getPlanHistory: (limit?: number) => ipcRenderer.invoke('plan:history', limit || 7),
  regenerateTodayPlan: (input?: { feedback?: string }) => ipcRenderer.invoke('plan:regenerateToday', input),
  planForward: () => ipcRenderer.invoke('plan:forward'),

  // Events from main
  onLogError: (callback: (data: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('log:error', listener)
    return () => ipcRenderer.removeListener('log:error', listener)
  },
  onUploadProgress: (callback: (data: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('upload:progress', listener)
    return () => ipcRenderer.removeListener('upload:progress', listener)
  },
  onAiProgress: (callback: (data: { traceId: string; stage: string; message: string; ts: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('ai:progress', listener)
    return () => ipcRenderer.removeListener('ai:progress', listener)
  },
  onFenbiAnalysisProgress: (callback: (data: { stage: 'started' | 'progress' | 'complete' | 'paused'; total: number; done: number; failed: number; message: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('fenbi:analysisProgress', listener)
    return () => ipcRenderer.removeListener('fenbi:analysisProgress', listener)
  },
  onAutoInductComplete: (callback: (data: { date: string; success: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('knowledge:autoInductComplete', listener)
    return () => ipcRenderer.removeListener('knowledge:autoInductComplete', listener)
  },
  onPdfProgress: (callback: (data: { stage: string; done?: number; total?: number; ts: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('pdf:progress', listener)
    return () => ipcRenderer.removeListener('pdf:progress', listener)
  },

  // Open external
  openExternal: (path: string) => ipcRenderer.invoke('shell:openPath', path),

  // App info
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // 渲染进程异常上报
  reportRendererError: (errorText: string) => ipcRenderer.invoke('log:rendererError', errorText),

  // 网络状态变化上报
  reportNetworkChange: (status: 'online' | 'offline') => ipcRenderer.invoke('log:network', status),

  // Dialog
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
  selectFiles: () => ipcRenderer.invoke('dialog:selectFiles'),
  saveFile: (defaultName: string, content: string) => ipcRenderer.invoke('dialog:saveFile', defaultName, content)
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronApi = typeof api
