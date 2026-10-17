import katex from 'katex'

export const escapeReviewHtml = (text: string) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function reliableOfficialAnalysis(raw?: string | null): string {
  const text = String(raw || '').split('\n').map(line => line.trim()).filter(line => line && !/^(视频|粉笔|行测|会员|\d+人已开通|收藏|笔记)$/.test(line)).join('\n').trim()
  if (/(开通会员|人已开通|购买课程|扫码|下载.*APP)/.test(text) && !/(因此|所以|故|选项|题干|解析|公式|计算|根据|正确答案)/.test(text)) return ''
  return text.length >= 8 ? text : ''
}

export function cleanPersonalReflection(raw?: string | null): string {
  const text = String(raw || '').trim()
  const start = text.search(/^#{1,3}\s*考点与识别信号/m)
  if (start >= 0) return text.slice(start)
  return /我们只需要|按照要求生成|先分析|用户要求|需要分析错因|we need|let's think/i.test(text.slice(0, 400)) ? '' : text
}

/** Safe offline Markdown subset plus MathML: no remote fonts, scripts or HTML from a question. */
export function renderReviewText(raw: string, resolveImage?: (source: string) => string | undefined): string {
  const inline = (value: string) => value.split(/(!\[[^\]]*\]\(<[^>]+>\)|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g).map(part => {
    const image = part.match(/^!\[[^\]]*\]\(<([^>]+)>\)$/)
    if (image) {
      const source = resolveImage?.(image[1])
      return source && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(source) ? `<img src="${escapeReviewHtml(source)}" alt="解析图片" style="max-width:100%;height:auto;vertical-align:middle" />` : '（解析图片未载入）'
    }
    if (part.startsWith('$') && part.endsWith('$')) {
      const displayMode = part.startsWith('$$')
      try { return katex.renderToString(part.slice(displayMode ? 2 : 1, displayMode ? -2 : -1), { throwOnError: false, trust: false, strict: 'ignore', output: 'mathml', displayMode }) } catch { /* show plain text */ }
    }
    return escapeReviewHtml(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
  }).join('')
  return String(raw || '').replace(/\r/g, '').split(/(\$\$[\s\S]*?\$\$)/g).map(block => block.startsWith('$$') && block.endsWith('$$') ? inline(block) : block.split('\n').map(line => {
    const heading = line.match(/^(#{1,6})\s+(.+)/)
    if (heading) return `<h3>${inline(heading[2])}</h3>`
    if (/^\s*[-*]\s+/.test(line)) return `<div class="review-bullet">• ${inline(line.replace(/^\s*[-*]\s+/, ''))}</div>`
    return line.trim() ? `<p>${inline(line)}</p>` : ''
  }).join('\n')).join('\n')
}
