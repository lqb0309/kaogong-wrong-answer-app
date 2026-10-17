import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
let key: Buffer, next = 0
const pending = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>()
export const handlers = new Map<string, Function>()
export function send(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n') }
export function setSecret(value: string) { key = Buffer.from(value, 'base64'); if (key.length !== 32) throw Error('密钥初始化失败') }
export function native(action: string, data: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('系统操作等待超时')) }, 120000)
    pending.set(id, { resolve, reject, timer }); send({ kind: 'native', id, action, data })
  })
}
export function nativeResult(message: any) {
  const call = pending.get(message.id)
  if (!call) return
  pending.delete(message.id); clearTimeout(call.timer)
  message.error ? call.reject(Error(message.error)) : call.resolve(message.result)
}
export function shutdown() { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('应用正在退出')) }; pending.clear() }
export const app = {
  isPackaged: true,
  getPath(name: string) { if (name === 'userData') return process.env.STUDY_TAURI_DATA!; if (name === 'home') return os.homedir(); if (name === 'temp') return os.tmpdir(); throw Error('未知系统目录') },
  getVersion() { return '0.3.0' }, relaunch() { void native('restart') }, exit() { process.exit(0) }
}
export const ipcMain = { handle(channel: string, fn: Function) { if (handlers.has(channel)) throw Error('重复接口'); handlers.set(channel, fn) } }
const windows = new Map<string, BrowserWindow>()
let windowIndex = 0
export function windowEvent(value: any) {
  const win = windows.get(value.label)
  if (!win) return
  if (value.url) win.url = value.url
  if (value.event === 'closed') { win.destroyed = true; windows.delete(win.label) }
  win.emit(value.event)
  win.webContents.emit(value.event)
}
export class BrowserWindow extends EventEmitter {
  label: string; url = ''; destroyed = false; ready: Promise<any>; webContents: any
  constructor(options: any = {}, isMain = false) {
    super(); this.label = isMain ? 'main' : options.webPreferences?.partition ? 'fenbi' : 'paper-' + (++windowIndex)
    windows.set(this.label, this)
    this.ready = isMain ? Promise.resolve() : native('window-create', { label: this.label, title: options.title || 'PDF 排版', visible: options.show !== false, width: options.width || 1000, height: options.height || 800 })
    const contents = new EventEmitter() as any
    Object.assign(contents, {
      getURL: () => this.url, isDestroyed: () => this.destroyed,
      executeJavaScript: async (code: string) => { await this.ready; return native('window-eval', { label: this.label, code }) },
      printToPDF: async (options: any) => { await this.ready; const result = await native('window-pdf', { label: this.label, options }); return Buffer.from(result, 'base64') },
      send: (channel: string, data: unknown) => { if (this.label === 'main') send({ kind: 'event', channel, data }) },
      setWindowOpenHandler: () => {}, debugger: { isAttached: () => true }
    }); this.webContents = contents
    if (this.label === 'fenbi') {
      const timer = setInterval(() => {
        if (this.destroyed) { clearInterval(timer); return }
        void this.ready.then(() => native('window-url', { label: this.label })).then(url => { this.url = url }).catch(() => {})
      }, 400); timer.unref()
    }
  }
  static getAllWindows() { return [...windows.values()] }
  static getFocusedWindow() { return windows.get('main') || null }
  static fromWebContents(sender: unknown) { return [...windows.values()].find(win => win.webContents === sender) || null }
  isDestroyed() { return this.destroyed }
  async loadURL(url: string) {
    await this.ready
    let timeout: ReturnType<typeof setTimeout>, done: () => void
    const finished = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(Error('网页加载超时')), 35000)
      done = () => resolve(); this.once('did-finish-load', done)
    })
    // Attach both rejection handlers immediately: navigation can outlast the load
    // timeout, especially while the site is unavailable or the window is closed.
    try { await Promise.all([native('window-navigate', { label: this.label, url }), finished]) }
    finally { clearTimeout(timeout!); this.removeListener('did-finish-load', done!) }
  }
  async loadFile(filePath: string) { await this.ready; await native('window-html', { label: this.label, html: fs.readFileSync(filePath, 'utf8') }); this.url = 'app://pdf-host' }
  show() { void this.ready.then(() => native('window-show', { label: this.label })).catch(() => {}) }
  focus() { this.show() }
  destroy() { if (this.destroyed) return; this.destroyed = true; windows.delete(this.label); void this.ready.then(() => native('window-close', { label: this.label })).catch(() => {}); this.emit('closed') }
}
export const mainWindow = new BrowserWindow({}, true)
export const dialog = {
  showOpenDialog: (...args: any[]) => native('dialog-open', args.at(-1)),
  showSaveDialog: (...args: any[]) => native('dialog-save', args.at(-1))
}
export const shell = { openExternal: (target: string) => native('open', { target }), openPath: (target: string) => native('open', { target }) }
export const safeStorage = {
  isEncryptionAvailable: () => !!key,
  encryptString(text: string) {
    if (!key) throw Error('系统密钥不可用，拒绝明文保存')
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    return Buffer.concat([Buffer.from('Tauri1'), iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()])
  },
  decryptString(data: Buffer) {
    if (!key || data.subarray(0, 6).toString() !== 'Tauri1') throw Error('不是 Tauri 密文，请重新填写服务密钥')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(6, 18)); decipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([decipher.update(data.subarray(18, -16)), decipher.final()]).toString('utf8')
  }
}
let clipboardPng = Buffer.alloc(0)
export async function refreshClipboard() { clipboardPng = Buffer.from(await native('clipboard-image'), 'base64') }
export const clipboard = { readImage: () => ({ isEmpty: () => !clipboardPng.length, toPNG: () => clipboardPng }) }
export const nativeImage = {}
export class Notification { constructor(private options: any) {} static isSupported() { return true } show() { void native('notification', this.options).catch(() => {}) } }
export const session = { fromPartition: (_partition: string) => ({ fetch: globalThis.fetch }) }
export async function importBrowserImages(items: Array<{name: string; data: string}>) {
  if (!Array.isArray(items) || items.length > 100) throw Error('图片数量无效')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-upload-')), paths: string[] = []
  try {
    for (const item of items) {
      const ext = path.extname(item.name).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || typeof item.data !== 'string' || item.data.length > 28_000_000) throw Error('图片格式或大小无效')
      const file = path.join(dir, crypto.randomUUID() + ext); fs.writeFileSync(file, Buffer.from(item.data, 'base64')); paths.push(file)
    }
    return await handlers.get('upload:images')!({ sender: mainWindow.webContents }, paths)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
