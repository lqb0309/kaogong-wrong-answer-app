import { FileTextOutlined } from '@/components/study-icons'
import { MarkdownRenderer } from './markdown-renderer'

export function formatQuestionMarkdown(source: string): string {
  const lines = String(source || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) return ''
  return lines.map((line, index) => {
    const option = line.match(/^([A-H])[.、．]\s*(.+)$/i)
    if (option) return `- **${option[1].toUpperCase()}.** ${option[2]}`
    return index === 0 ? `### ${line}` : line
  }).join('\n\n')
}

export function QuestionTextFallback({ content, label = '文字题目' }: { content: string; label?: string }) {
  const options = String(content || '').split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-H][.、．]\s*.+$/i.test(line))
  const compactOptions = options.length >= 2 && options.every(line => line.length <= 24)
  const markdown = formatQuestionMarkdown(content)
  if (!markdown) return null
  return (
    <div className={`question-text-fallback${compactOptions ? ' has-short-options' : ''}`}>
      <div className="question-text-fallback-label"><FileTextOutlined /> {label}</div>
      <MarkdownRenderer content={markdown} />
    </div>
  )
}
