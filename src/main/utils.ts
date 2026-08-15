import fs from 'fs-extra'
import path from 'path'

export function generateTraceId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const seq = Math.floor(Math.random() * 999).toString().padStart(3, '0')
  return `q-${date}-${seq}`
}

// Convert a local file:// URL or path to a base64 data URL for AI APIs
export function toImageUrl(imageUrl: string): string {
  if (!imageUrl.startsWith('file://')) return imageUrl
  const filePath = imageUrl.replace('file://', '')
  const ext = path.extname(filePath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  const buf = fs.readFileSync(filePath)
  return `data:${mime};base64,${buf.toString('base64')}`
}
