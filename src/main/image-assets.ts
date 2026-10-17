import fs from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'

/** Same asset handling for local previews, cropping, AI and document export. */
export async function readImageBuffer(source: string, timeout = 15000): Promise<{ buffer: Buffer; mime: string }> {
  const maxBytes = 20 * 1024 * 1024
  let buffer: Buffer
  let mime = 'image/png'
  if (/^data:image\//i.test(source)) {
    const match = source.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i)
    if (!match) throw new Error('图片数据格式无效')
    mime = match[1]
    buffer = Buffer.from(match[2], 'base64')
  } else if (source.startsWith('file://') || path.isAbsolute(source)) {
    let filePath = source.startsWith('file://') ? fileURLToPath(source) : source
    // Markdown normalizes bare absolute paths to URL-encoded paths. Preserve
    // literal '%' filenames first; decode only once if that literal is absent.
    if (!source.startsWith('file://') && !fs.existsSync(filePath) && filePath.includes('%')) {
      try {
        const decoded = decodeURIComponent(filePath)
        if (path.isAbsolute(decoded) && fs.existsSync(decoded)) filePath = decoded
      } catch { /* malformed escapes remain a normal missing-file error */ }
    }
    if (fs.statSync(filePath).size > maxBytes) throw new Error('图片超过 20 MB')
    buffer = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    mime = ext === '.webp' ? 'image/webp' : /\.jpe?g/.test(ext) ? 'image/jpeg' : 'image/png'
  } else {
    const parsed = new URL(source)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('不支持的图片地址')
    const response = await fetch(source, { signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`图片加载失败 HTTP ${response.status}`)
    mime = (response.headers.get('content-type') || 'image/png').split(';')[0]
    if (!mime.startsWith('image/')) throw new Error('返回内容不是图片')
    if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('图片超过 20 MB')
    buffer = Buffer.from(await response.arrayBuffer())
  }
  if (!buffer.length || buffer.length > maxBytes) throw new Error('图片为空或超过 20 MB')
  return { buffer, mime }
}
