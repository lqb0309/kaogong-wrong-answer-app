import type { WebContents } from 'electron'
import { validateFenbiReport } from './fenbi-page'

/** Only accept an already-normalized, complete report tied to this exact URL.
 * Unknown response schemas are deliberately not guessed; DOM remains fallback.
 */
export function verifiedResponseReport(value: any, pageUrl: string): any | null {
  for (const candidate of [value, value?.data, value?.data?.report, value?.report]) {
    if (candidate?.url === pageUrl && Array.isArray(candidate.materials) && !validateFenbiReport(candidate)) return candidate
  }
  return null
}

export function attachFenbiResponseReader(contents: WebContents): { read: (pageUrl: string) => any | null; dispose: () => void } {
  let report: any = null, active = false, epoch = 0
  const requests = new Map<string, { page: string; epoch: number }>()
  const clear = () => { epoch++; report = null; requests.clear() }
  const message = async (_event: unknown, method: string, params: any) => {
    try {
      if (method === 'Network.responseReceived') {
        const response = params.response
        const url = new URL(response.url)
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.fenbi.com') || !/exam|solution|report/.test(url.pathname) || /login|token|auth|account|profile/.test(url.pathname) || response.status !== 200 || !/json/i.test(response.mimeType)) return
        if (requests.size >= 20) requests.delete(requests.keys().next().value!)
        requests.set(params.requestId, { page: contents.getURL(), epoch })
      } else if (method === 'Network.loadingFinished') {
        const request = requests.get(params.requestId)
        requests.delete(params.requestId)
        if (!request || params.encodedDataLength > 2_000_000) return
        const body = await contents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
        if (contents.isDestroyed() || request.epoch !== epoch || request.page !== contents.getURL()) return
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
        if (typeof text !== 'string' || text.length > 2_000_000) return
        const candidate = verifiedResponseReport(JSON.parse(text), request.page)
        if (candidate) report = structuredClone(candidate)
      } else if (method === 'Network.loadingFailed') requests.delete(params.requestId)
    } catch { /* inspector contention, unknown schema or disappearing request: DOM fallback */ }
  }
  const dispose = () => {
    clear()
    contents.removeListener('did-start-navigation', clear)
    if (active && !contents.isDestroyed()) {
      contents.debugger.removeListener('message', message)
      try { contents.debugger.detach() } catch { /* already detached */ }
    }
    active = false
  }
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3'); active = true
      contents.debugger.on('message', message)
      contents.on('did-start-navigation', clear)
      void contents.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 4_000_000, maxResourceBufferSize: 2_000_000 }).catch(dispose)
    }
  } catch { /* optional adapter; never block login */ }
  return { read: url => report?.url === url ? structuredClone(report) : null, dispose }
}
