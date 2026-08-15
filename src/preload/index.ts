import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // Config
  getConfig: (key: string) => ipcRenderer.invoke('config:get', key),
  getAllConfig: () => ipcRenderer.invoke('config:getAll'),
  setConfig: (key: string, value: string) => ipcRenderer.invoke('config:set', key, value),

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
  getAiSuggestion: (statsData: any) => ipcRenderer.invoke('ai:suggest', statsData),
  generateReflection: (params: any) => ipcRenderer.invoke('ai:reflect', params),
  fetchModels: (baseURL: string, apiKey: string) => ipcRenderer.invoke('ai:models', baseURL, apiKey),
  testConnection: (baseURL: string, apiKey: string, model: string) => ipcRenderer.invoke('ai:test', baseURL, apiKey, model),

  // Obsidian
  writeToObsidian: (questionData: any) => ipcRenderer.invoke('obsidian:write', questionData),
  checkObsidianOnline: () => ipcRenderer.invoke('obsidian:check'),
  syncVault: () => ipcRenderer.invoke('obsidian:sync'),
  reorganizeVault: () => ipcRenderer.invoke('obsidian:reorganize'),
  getStreak: () => ipcRenderer.invoke('app:streak'),
  getAppOverview: () => ipcRenderer.invoke('app:overview'),
  flushRetryQueue: () => ipcRenderer.invoke('retry:flush'),

  // Questions
  getQuestions: (params: any) => ipcRenderer.invoke('questions:list', params),
  getQuestion: (id: string) => ipcRenderer.invoke('questions:get', id),
  deleteQuestion: (id: string) => ipcRenderer.invoke('questions:delete', id),
  getPendingCount: () => ipcRenderer.invoke('questions:pendingCount'),
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
  getReviewCards: (count?: number) => ipcRenderer.invoke('knowledge:reviewCards', count || 3),

  // Test Builder (组卷)
  selectTestQuestions: (params?: any) => ipcRenderer.invoke('test:selectQuestions', params || {}),
  generateTestPdf: (questionIds: string[], options?: any) => ipcRenderer.invoke('test:generatePdf', questionIds, options || {}),

  // Events from main
  onLogError: (callback: (data: any) => void) => {
    ipcRenderer.on('log:error', (_event, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('log:error')
  },
  onUploadProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('upload:progress', (_event, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('upload:progress')
  },
  onAiProgress: (callback: (data: { traceId: string; stage: string; message: string; ts: number }) => void) => {
    ipcRenderer.on('ai:progress', (_event, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('ai:progress')
  },
  onAutoInductComplete: (callback: (data: { date: string; success: boolean }) => void) => {
    ipcRenderer.on('knowledge:autoInductComplete', (_event, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('knowledge:autoInductComplete')
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
