import crypto from 'crypto'
import { localDateKey } from './date-utils'

/** One conversion boundary for database rows and renderer payloads. */
export function questionData(row: any): any {
  return {
    ...row,
    imageUrl: row.imageUrl ?? row.image_url ?? '',
    localAbsPath: row.localAbsPath ?? row.local_image_path,
    ocrText: row.ocrText ?? row.ocr_text ?? '',
    errorType: row.errorType ?? row.error_type ?? '',
    errorCount: row.errorCount ?? row.error_count ?? 1,
    hasGraphics: row.hasGraphics ?? !!row.has_graphics,
    graphicImagePath: row.graphicImagePath ?? row.graphic_image_path ?? '',
    traceId: row.traceId ?? row.trace_id,
    createdAt: row.createdAt ?? row.created_at,
    confirmedAt: row.confirmedAt ?? row.confirmed_at,
    materialText: row.materialText ?? row.group_passage_text ?? '',
    originalAnalysis: row.originalAnalysis ?? row.original_analysis ?? '',
    originalAnswer: row.originalAnswer ?? row.original_answer
  }
}

export function questionFileName(id: string): string {
  if (!id) throw new Error('题目缺少唯一编号，不能保存笔记')
  return `错题-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 32)}.md`
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return (raw ?? fallback) as T
  try {
    const value = JSON.parse(raw)
    if (Array.isArray(fallback) && !Array.isArray(value)) return fallback
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback) && (!value || typeof value !== 'object' || Array.isArray(value))) return fallback
    return value ?? fallback
  } catch { return fallback }
}

export function renderQuestionMarkdown(input: any): string {
  const data = questionData(input)
  const tags = [data.level1 || '未分类', data.level2, data.level3].filter(Boolean)
  const date = localDateKey(data.confirmedAt ? new Date(data.confirmedAt) : data.createdAt ? new Date(data.createdAt) : new Date())
  const answer = parseJson<any>(data.originalAnswer, {})
  const quote = (text: string) => text.split('\n').map(line => `> ${line}`).join('\n')
  const assets = [...parseJson<string[]>(data.materialImages ?? data.material_image_ids, []), ...parseJson<string[]>(data.questionImages ?? data.question_images, [])]
  const optionAssets = parseJson<Record<string, string[]>>(data.optionImages ?? data.option_images, {})
  const imageUrls = [...new Set([data.imageUrl, ...assets, ...Object.values(optionAssets).filter(Array.isArray).flat()].filter(Boolean))]
  return `---
question_id: ${JSON.stringify(String(data.id || ''))}
tags:
${['行测/错题', ...tags].map(tag => `  - ${JSON.stringify(tag)}`).join('\n')}
status: ${JSON.stringify(data.errorType === '正确但超时' ? 'speed_review' : 'wrong')}
error_count: ${data.errorCount}
confidence: ${data.confidence || 0}
date: ${date}
source: ${JSON.stringify(data.source || '')}
---

# ${data.id ? questionFileName(data.id).replace('.md', '') : '错题'}

**分类**: ${tags.map(tag => `[[${tag}]]`).join(' » ')}
**日期**: ${date} | **错误次数**: ${data.errorCount} | **置信度**: ${Math.round((data.confidence || 0) * 100)}%
${data.errorType ? `**错误类型**: ${data.errorType}\n` : ''}
${data.materialText ? `\n## 公共资料\n${data.materialText}\n` : ''}
${imageUrls.map(url => `![题目或资料图片](${url})`).join('\n')}
${data.ocrText ? `\n> [!quote] 题目与选项\n${quote(data.ocrText)}\n` : ''}
${answer.correct || answer.user ? `\n**正确答案**: ${answer.correct || '未取得'} | **我的答案**: ${answer.user || '未取得'}\n` : ''}
${data.originalAnalysis ? `\n## 粉笔解析\n${data.originalAnalysis}\n` : ''}
${data.reflection ? `\n> [!danger] 复盘反思\n${quote(data.reflection)}\n` : ''}
`
}
