import OpenAI from 'openai'

export function modelApiError(error: any): string {
  if (error?.status === 401 || error?.status === 403) return '认证失败，请检查 API Key 及账号权限'
  if (error?.status === 429) return '请求过于频繁或账号额度受限，请稍后重试'
  if (error?.status >= 500) return '服务商暂时不可用，请稍后重试'
  if (error?.name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR') return '请求超时，请检查网络后重试；也可直接填写模型名称'
  if (error?.name === 'APIConnectionError' || ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'].includes(error?.code)) return '无法连接服务商，请检查网络和接口地址'
  if (error instanceof SyntaxError) return '服务商返回的模型清单格式异常，请稍后重试'
  if (error?.status === 404 || error?.status === 405) return '接口地址未提供模型清单，可检查地址或直接填写模型名称'
  // 不回传服务商原始错误，避免其中包含请求凭据或代理响应正文。
  return '模型清单获取失败，请检查接口地址；也可直接填写模型名称'
}

export function modelBaseUrls(value: string): string[] {
  const url = new URL(value.trim())
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid-url')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '')
  const base = url.toString().replace(/\/+$/, '')
  return url.pathname.endsWith('/v1') ? [base] : [base, `${base}/v1`]
}

export async function fetchModelCatalog(baseURL: string, apiKey: string): Promise<{ success: boolean; models?: string[]; error?: string }> {
  let urls: string[]
  try { urls = modelBaseUrls(baseURL || '') } catch { return { success: false, error: '请填写有效的接口地址（http 或 https，不含查询参数）' } }
  for (const url of urls) {
    try {
      const client = new OpenAI({ apiKey: apiKey.trim() || 'no-key', baseURL: url, maxRetries: 1, timeout: 15000 })
      const list = await client.models.list()
      if (!Array.isArray(list?.data)) return { success: false, error: '服务商返回的模型清单格式异常，请稍后重试' }
      const models = [...new Set(list.data.map(m => typeof m?.id === 'string' ? m.id.trim() : '').filter(id => {
        const lower = id.toLowerCase()
        return id && !['embedding', 'moderation', 'dall-e', 'tts', 'whisper', 'audio'].some(word => lower.includes(word))
      }))].sort()
      return models.length ? { success: true, models } : { success: false, error: '清单中没有可用的对话模型，可直接填写模型名称' }
    } catch (error: any) {
      // 仅路径确实不存在时尝试 /v1；认证、限流和网络故障不应被误报为“不支持”。
      if (error?.status !== 404 && error?.status !== 405) return { success: false, error: modelApiError(error) }
    }
  }
  return { success: false, error: modelApiError({ status: 404 }) }
}
