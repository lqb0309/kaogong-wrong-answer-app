import { readConfig } from './config'
import { decryptToken } from './safe-storage'
import { logger } from './logger'
import fs from 'fs-extra'
import path from 'path'

export async function uploadToEasyImage(imagePath: string, traceId: string): Promise<{ url: string }> {
  const baseUrl = readConfig('easyimage_url')
  const encryptedToken = readConfig('easyimage_token')

  if (!baseUrl || !encryptedToken) {
    throw new Error('EasyImage 未配置，请在设置页填写地址和 Token')
  }

  const token = decryptToken(encryptedToken)
  const uploadUrl = `${baseUrl}/api/index.php`

  const fileBuffer = fs.readFileSync(imagePath)
  const ext = path.extname(imagePath).toLowerCase()
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'

  const formData = new FormData()
  formData.append('token', token)
  formData.append('image', new Blob([fileBuffer], { type: mimeType }), path.basename(imagePath))

  const res = await fetch(uploadUrl, {
    method: 'POST',
    body: formData
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`EasyImage 返回 ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as any
  if (data.result !== 'success' || !data.url) {
    throw new Error(`EasyImage 上传失败: ${JSON.stringify(data)}`)
  }

  logger.info('upload', 'upload_success', `EasyImage 上传成功`, { url: data.url, fileName: path.basename(imagePath) }, traceId)

  return { url: data.url }
}
