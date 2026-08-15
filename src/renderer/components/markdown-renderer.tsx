import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

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
        remarkPlugins={[remarkGfm, remarkMath, remarkWikiLink]}
        rehypePlugins={[rehypeKatex]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
