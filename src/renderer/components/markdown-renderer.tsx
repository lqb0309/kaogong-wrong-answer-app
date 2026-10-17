import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useEffect, useState } from 'react'

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setUrl(''); setFailed(false)
    if (!src) return
    const load = /^https?:|^data:image\//i.test(src) ? Promise.resolve(src) : window.api.readImageDataUrl(src)
    load.then(value => { if (active) setUrl(value) }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [src])
  if (failed) return <span>（解析图片无法读取）</span>
  return url ? <img src={url} alt={alt || '解析图片'} onError={() => setFailed(true)} style={{ maxWidth: '100%', height: 'auto', verticalAlign: 'middle' }} /> : <span>（图片加载中）</span>
}

/**
 * Obsidian wikilink 支持：把 [[名称]] 渲染为带 wikilink 样式的链接。
 * 在 mdast 文本节点中拆分 [[...]] 片段为 link 节点。
 */
function remarkWikiLink() {
  return (tree: any) => {
    const visitChildren = (parent: any, index: number) => {
      const node = parent?.children?.[index]
      if (!node) return
      if (node.type === 'text' && typeof node.value === 'string' && node.value.includes('[[')) {
        const parts = node.value.split(/(\[\[[^\]]+\]\])/g).filter(Boolean)
        if (parts.length > 1) {
          const newNodes = parts.map((p: string) => {
            const m = p.match(/^\[\[([^\]]+)\]\]$/)
            if (m) {
              return {
                type: 'link',
                url: `#${encodeURIComponent(m[1])}`,
                title: 'Obsidian 双链',
                children: [{ type: 'text', value: m[1] }],
                data: { hProperties: { className: 'wikilink' } }
              }
            }
            return { type: 'text', value: p }
          })
          parent.children.splice(index, 1, ...newNodes)
          return
        }
      }
      if (Array.isArray(node.children)) {
        for (let i = node.children.length - 1; i >= 0; i--) visitChildren(node, i)
      }
    }
    for (let i = (tree.children?.length || 0) - 1; i >= 0; i--) visitChildren(tree, i)
  }
}

/**
 * 统一 Markdown 渲染组件：
 * 支持 GFM（表格/任务列表/删除线）、LaTeX 数学公式（$...$ / $$...$$）、Obsidian [[双链]]。
 * 不启用 rehype-raw，原始 HTML 会被转义，避免 XSS。
 */
export function MarkdownRenderer({ content }: { content: string }) {
  if (!content) return null

  return (
    <div className="markdown-body">
      <ReactMarkdown
        urlTransform={url => /^(?:https?:|data:image\/|file:|\/)/i.test(url) ? url : url.startsWith('#') ? url : ''}
        components={{ img: MarkdownImage }}
        remarkPlugins={[remarkGfm, remarkMath, remarkWikiLink]}
        rehypePlugins={[rehypeKatex]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
