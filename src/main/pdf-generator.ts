import { BrowserWindow } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import { getDb } from './db'
import { logger } from './logger'

// ============ Types ============

export interface PdfOptions {
  title: string
  showAnswers?: boolean
  questionsPerPage?: number
  pageSize?: 'A4' | 'Letter'
  includeAnswerSheet?: boolean
  imageMode?: 'graphics_only' | 'full'
}

interface QuestionData {
  id: string
  level1: string
  level2: string
  level3: string | null
  image_url: string
  local_image_path: string | null
  ocr_text: string | null
  error_count: number
  source: string | null
  reflection: string | null
  error_type: string | null
  group_id: string | null
  obsidian_path: string | null
  has_graphics?: number
  graphic_image_path?: string | null
}

interface QuestionGroup {
  id: string
  title: string | null
  passage_image_url: string | null
  passage_text: string | null
  group_type: string
  questions: QuestionData[]
}

const DEFAULT_OPTIONS: PdfOptions = {
  title: '错题练习卷',
  showAnswers: false,
  questionsPerPage: 3,
  pageSize: 'A4',
  includeAnswerSheet: false
}

// ============ Fetch Questions ============

export function fetchQuestionsForTest(
  ids: string[],
  filters?: { level1?: string; level2?: string; level3?: string; search?: string; limit?: number; random?: boolean }
): QuestionData[] {
  const db = getDb()

  if (ids.length > 0) {
    // Fetch specific question IDs
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT id, level1, level2, level3, image_url, local_image_path,
             ocr_text, error_count, source, reflection, error_type, group_id, obsidian_path, has_graphics, graphic_image_path
      FROM questions
      WHERE status = 'confirmed' AND id IN (${placeholders})
    `).all(...ids) as QuestionData[]
    return rows
  }

  // Fetch with filters
  const conditions: string[] = ["status = 'confirmed'"]
  const values: any[] = []

  if (filters?.level1) { conditions.push('level1 = ?'); values.push(filters.level1) }
  if (filters?.level2) { conditions.push('level2 = ?'); values.push(filters.level2) }
  if (filters?.level3) { conditions.push('level3 = ?'); values.push(filters.level3) }
  if (filters?.search) {
    conditions.push('(ocr_text LIKE ? OR source LIKE ?)')
    const s = `%${filters.search}%`
    values.push(s, s)
  }

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const limitClause = filters?.limit ? ` LIMIT ${filters.limit}` : ''
  const orderClause = filters?.random ? ' ORDER BY RANDOM()' : ' ORDER BY created_at DESC'

  const rows = db.prepare(`
    SELECT id, level1, level2, level3, image_url, local_image_path,
           ocr_text, error_count, source, reflection, error_type, group_id, obsidian_path, has_graphics, graphic_image_path
    FROM questions${whereClause}${orderClause}${limitClause}
  `).all(...values) as QuestionData[]

  return rows
}

export function fetchQuestionGroups(groupIds: string[]): QuestionGroup[] {
  const db = getDb()

  const groups = db.prepare(`
    SELECT * FROM question_groups
    WHERE id IN (${groupIds.map(() => '?').join(',')})
  `).all(...groupIds) as any[]

  const result: QuestionGroup[] = []
  for (const g of groups) {
    const questions = db.prepare(`
      SELECT id, level1, level2, level3, image_url, local_image_path,
             ocr_text, error_count, source, reflection, error_type, group_id, obsidian_path, has_graphics, graphic_image_path
      FROM questions
      WHERE status = 'confirmed' AND group_id = ?
      ORDER BY created_at ASC
    `).all(g.id) as QuestionData[]

    result.push({
      id: g.id,
      title: g.title,
      passage_image_url: g.passage_image_url,
      passage_text: g.passage_text,
      group_type: g.group_type,
      questions
    })
  }

  return result
}

// ============ Image Download ============

async function downloadImageAsBase64(url: string, timeout = 10000): Promise<string | null> {
  if (!url) return null
  try {
    // Handle local file paths
    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '')
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath)
        const ext = path.extname(filePath).toLowerCase()
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
        return `data:${mime};base64,${buf.toString('base64')}`
      }
      return null
    }

    // Remote URLs (EasyImage etc.)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const resp = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)

    if (!resp.ok) return null

    const buf = Buffer.from(await resp.arrayBuffer())
    const contentType = resp.headers.get('content-type') || 'image/png'
    const mime = contentType.includes('webp') ? 'image/webp'
                : contentType.includes('png') ? 'image/png'
                : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch (err: any) {
    logger.warn('pdf_gen', 'image_download_failed', `图片下载失败: ${url}`, { error: err.message })
    return null
  }
}

async function downloadImagesForQuestions(questions: QuestionData[]): Promise<Map<string, string>> {
  const cache = new Map<string, string>()

  // Collect unique image URLs
  const urls = new Set<string>()
  for (const q of questions) {
    if (q.image_url) urls.add(q.image_url)
	    if (q.graphic_image_path) urls.add(q.graphic_image_path)
  }

  // Download in parallel with concurrency limit
  const urlList = Array.from(urls)
  const BATCH = 5
  for (let i = 0; i < urlList.length; i += BATCH) {
    const batch = urlList.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async (url) => {
        let base64 = await downloadImageAsBase64(url)
        // Fallback: try loading from local cache using image_url pattern matching
        if (!base64) {
          const localDir = path.join(require('os').homedir(), '考公错题', 'images')
          if (fs.existsSync(localDir)) {
            // Try to find local image by matching question data
            for (const q of questions) {
              if (q.image_url === url && q.local_image_path && fs.existsSync(q.local_image_path)) {
                base64 = await downloadImageAsBase64(`file://${q.local_image_path}`)
                break
              }
            }
          }
        }
        return { url, base64 }
      })
    )
    for (const { url, base64 } of results) {
      if (base64) cache.set(url, base64)
    }
  }

  return cache
}

// ============ HTML Builder ============

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Parse OCR text into question body and options list.
 * Detects patterns like:
 *   "A.xxx B.xxx C.xxx D.xxx"
 *   "A、xxx B、xxx"
 *   "A) xxx B) xxx"
 */
interface ParsedOcr {
  body: string
  options: string[]
}

function parseOcrText(raw: string): ParsedOcr {
  if (!raw || !raw.trim()) return { body: '', options: [] }

  // Try to find options starting with A./A、/A)/A．followed by content
  // Match patterns like: A.xxx B.xxx C.xxx D.xxx or A、xxx B、xxx
  const optionRegex = /\b([A-D])[.、．)）]\s*(.+?)(?=\s*\b[A-D][.、．)）]\s*|$)/g
  const matches: { letter: string; text: string }[] = []
  let m: RegExpExecArray | null
  while ((m = optionRegex.exec(raw)) !== null) {
    matches.push({ letter: m[1], text: m[2].trim() })
  }

  // Only treat as options if we found at least 3 (standard 4-option format) and exactly A,B,C,D
  if (matches.length >= 3 && matches.length <= 6) {
    // Verify they're consecutive: A,B,C,D...
    const letters = matches.map(x => x.letter)
    const expected = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, matches.length)
    const isSequential = letters.every((l, i) => l === expected[i])

    if (isSequential) {
      // Extract body: everything before the first option
      const firstOptionIdx = raw.search(/\bA[.、．)）]/)
      const body = firstOptionIdx > 0
        ? raw.slice(0, firstOptionIdx).trim()
        : raw.trim()

      return {
        body,
        options: matches.map(m => `${m.letter}. ${m.text}`)
      }
    }
  }

  // No clear option structure found — return as body only
  return { body: raw.trim(), options: [] }
}

function buildCategoryLabel(q: QuestionData): string {
  return [q.level1, q.level2, q.level3].filter(Boolean).join(' › ')
}

function buildQuestionHtml(
  index: number,
  q: QuestionData,
  imageBase64: string | undefined,
  options: PdfOptions
): string {
  const category = buildCategoryLabel(q)
  const isGraphics = q.has_graphics === 1 || !!q.graphic_image_path
  const hasImage = imageBase64 && q.image_url
  const parsed = parseOcrText(q.ocr_text || '')
  const hasBody = parsed.body.length > 0
  const hasOptions = parsed.options.length > 0

  // Image display: 'graphics_only' = only questions marked has_graphics; 'full' = show all
  const mode = options.imageMode || 'graphics_only'
  const showImage = mode === 'graphics_only' ? (hasImage && isGraphics) : hasImage
  const imageClass = isGraphics ? 'question-image' : 'question-image question-image-thumb'

  return `
    <div class="question">
      <div class="question-header">
        <span class="question-number">第 ${index} 题</span>
        <span class="question-category">${escapeHtml(category)}</span>
        ${q.error_count > 1 ? `<span class="error-count">错 ${q.error_count} 次</span>` : ''}
      </div>

      ${showImage ? `
        <div class="${imageClass}">
          <img src="${imageBase64}" alt="题目图片" />
        </div>
      ` : ''}

      ${hasBody ? `
        <div class="question-body">${escapeHtml(parsed.body)}</div>
      ` : ''}

      ${hasOptions ? `
        <div class="question-options">
          ${parsed.options.map((opt, i) => `
            <div class="option-item">
              <span class="option-letter">${escapeHtml(opt.split('.')[0])}</span>
              <span class="option-text">${escapeHtml(opt.slice(opt.indexOf('.') + 2))}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${!showImage && !hasBody && !hasOptions ? `
        <div class="question-text-empty">
          （此题目为纯图形题，请查看原始图片。OCR 未能提取文本内容。）
        </div>
      ` : ''}

      <div class="answer-area">
        <div class="answer-label">作答：</div>
        <div class="answer-line"></div>
        <div class="answer-line"></div>
        ${hasBody && parsed.body.length > 40 ? '<div class="answer-line"></div>' : ''}
      </div>

      ${options.showAnswers && q.reflection ? `
        <div class="reflection">
          <strong>💡 解析 / 复盘：</strong>
          <div>${escapeHtml(q.reflection.slice(0, 300))}</div>
        </div>
      ` : ''}

      ${q.source ? `<div class="source">来源：${escapeHtml(q.source)}</div>` : ''}
    </div>
  `
}

function buildGroupHtml(
  index: number,
  group: QuestionGroup,
  imageCache: Map<string, string>,
  options: PdfOptions
): string {
  const passageImage = group.passage_image_url
    ? imageCache.get(group.passage_image_url) || undefined
    : undefined

  // Find the material image from the first question if group has no dedicated passage image
  const fallbackImage = !passageImage && group.questions[0]?.image_url
    ? imageCache.get(group.questions[0].image_url)
    : undefined

  let html = `
    <div class="question-group">
      <div class="group-header">
        <span class="group-title">${escapeHtml(group.title || '资料分析')}</span>
        <span class="group-badge">共 ${group.questions.length} 题</span>
      </div>
  `

  // Render passage material
  if (passageImage || fallbackImage) {
    html += `
      <div class="passage-image">
        <img src="${passageImage || fallbackImage}" alt="材料图表" />
      </div>
    `
  }

  if (group.passage_text) {
    html += `
      <div class="passage-text">${escapeHtml(group.passage_text)}</div>
    `
  }

  // Render sub-questions
  for (const q of group.questions) {
    const imgKey = (q.graphic_image_path && q.has_graphics) ? q.graphic_image_path : q.image_url
    const qImage = imgKey ? imageCache.get(imgKey) : undefined
    html += buildQuestionHtml(index, q, qImage, options)
  }

  html += `</div>`
  return html
}

function buildFullHtml(
  questions: QuestionData[],
  groups: QuestionGroup[],
  imageCache: Map<string, string>,
  options: PdfOptions
): string {
  const pageWidth = options.pageSize === 'A4' ? '210mm' : '215.9mm'
  const pageHeight = options.pageSize === 'A4' ? '297mm' : '279.4mm'

  let bodyHtml = ''
  let qIndex = 1

  // Render grouped questions first
  const groupedIds = new Set<string>()
  for (const group of groups) {
    for (const q of group.questions) {
      groupedIds.add(q.id)
    }
    bodyHtml += buildGroupHtml(qIndex, group, imageCache, options)
    qIndex += group.questions.length
  }

  // Render standalone questions (not in any group)
  const standalone = questions.filter(q => !groupedIds.has(q.id))
  for (const q of standalone) {
    // For graphics questions, use the cropped graphic image instead of full image
    const imgKey = (q.graphic_image_path && q.has_graphics) ? q.graphic_image_path : q.image_url
    const imageBase64 = imgKey ? imageCache.get(imgKey) : undefined
    bodyHtml += buildQuestionHtml(qIndex, q, imageBase64, options)
    qIndex++
  }

  // Answer sheet
  let answerSheetHtml = ''
  if (options.includeAnswerSheet) {
    const totalQuestions = qIndex - 1
    const answerRows = []
    for (let i = 1; i <= totalQuestions; i++) {
      answerRows.push(`
        <tr>
          <td class="ans-num">${i}</td>
          <td class="ans-blank"></td>
          <td class="ans-num">${i + Math.ceil(totalQuestions / 2)}</td>
          <td class="ans-blank"></td>
        </tr>
      `)
    }
    answerSheetHtml = `
      <div class="page-break"></div>
      <div class="answer-sheet">
        <h2>📝 答题卡</h2>
        <table class="answer-table">
          <thead><tr><th>题号</th><th>答案</th><th>题号</th><th>答案</th></tr></thead>
          <tbody>${answerRows.join('')}</tbody>
        </table>
      </div>
    `
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  @page {
    size: ${pageWidth} ${pageHeight};
    margin: 18mm 16mm;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 12pt;
    line-height: 1.8;
    color: #1a1a1a;
  }

  .test-title {
    text-align: center;
    font-size: 18pt;
    font-weight: 700;
    margin-bottom: 4mm;
    padding-bottom: 3mm;
    border-bottom: 2px solid #333;
  }
  .test-subtitle {
    text-align: center;
    font-size: 10pt;
    color: #666;
    margin-bottom: 10mm;
  }

  .question {
    margin-bottom: 8mm;
    padding: 4mm 0;
    border-bottom: 1px dashed #ddd;
  }
  .question-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3mm;
    flex-wrap: wrap;
  }
  .question-number {
    font-weight: 700;
    font-size: 13pt;
    color: #1677ff;
    min-width: 48px;
  }
  .question-category {
    font-size: 9pt;
    color: #888;
    background: #f5f5f5;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .error-count {
    font-size: 9pt;
    color: #ff4d4f;
    background: #fff1f0;
    padding: 1px 6px;
    border-radius: 3px;
  }

  .question-image {
    text-align: center;
    margin: 3mm 0;
  }
  .question-image img {
    max-width: 100%;
    max-height: 90mm;
    object-fit: contain;
    border: 1px solid #eee;
    border-radius: 2px;
  }
  .question-image-thumb img {
    max-width: 45%;
    max-height: 35mm;
    float: right;
    margin-left: 3mm;
    margin-bottom: 2mm;
  }

  .question-body {
    margin: 4mm 0 3mm;
    text-indent: 2em;
    line-height: 2;
    font-size: 11.5pt;
  }
  .question-text-empty {
    margin: 4mm 0;
    color: #999;
    font-style: italic;
    text-align: center;
  }

  .question-options {
    margin: 3mm 0 3mm 4mm;
  }
  .option-item {
    display: flex;
    align-items: baseline;
    margin-bottom: 1.5mm;
    line-height: 1.9;
  }
  .option-letter {
    font-weight: 600;
    color: #1677ff;
    min-width: 8mm;
    font-size: 11pt;
  }
  .option-text {
    flex: 1;
    font-size: 11pt;
  }

  .answer-area {
    margin: 6mm 0 3mm;
  }
  .answer-label {
    font-size: 9pt;
    color: #999;
    margin-bottom: 2mm;
  }
  .answer-line {
    border-bottom: 1px solid #ccc;
    height: 8mm;
    margin-bottom: 2mm;
  }

  .reflection {
    margin-top: 3mm;
    padding: 3mm;
    background: #f6ffed;
    border-left: 3px solid #52c41a;
    font-size: 10pt;
    color: #555;
  }

  .source {
    font-size: 9pt;
    color: #aaa;
    margin-top: 2mm;
  }

  .question-group {
    margin-bottom: 10mm;
    padding: 4mm;
    border: 1px solid #91caff;
    background: #f0f9ff;
    border-radius: 4px;
  }
  .group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4mm;
    padding-bottom: 2mm;
    border-bottom: 1px solid #91caff;
  }
  .group-title {
    font-weight: 700;
    font-size: 13pt;
    color: #0958d9;
  }
  .group-badge {
    font-size: 9pt;
    color: #1677ff;
    background: #e6f4ff;
    padding: 1px 8px;
    border-radius: 10px;
  }
  .passage-image {
    text-align: center;
    margin: 3mm 0;
  }
  .passage-image img {
    max-width: 100%;
    max-height: 130mm;
    object-fit: contain;
  }
  .passage-text {
    margin: 3mm 0;
    white-space: pre-wrap;
    font-size: 11pt;
  }

  .page-break {
    page-break-before: always;
  }

  .answer-sheet {
    padding: 4mm;
  }
  .answer-sheet h2 {
    text-align: center;
    margin-bottom: 4mm;
  }
  .answer-table {
    width: 100%;
    border-collapse: collapse;
  }
  .answer-table th, .answer-table td {
    border: 1px solid #ccc;
    padding: 3mm;
    text-align: center;
  }
  .ans-num { width: 12%; font-weight: 600; }
  .ans-blank { width: 38%; height: 9mm; }
</style>
</head>
<body>

<div class="test-title">${escapeHtml(options.title)}</div>
<div class="test-subtitle">
  共 ${qIndex - 1} 题 · 生成于 ${new Date().toLocaleDateString('zh-CN')}
  · ${options.showAnswers ? '含解析' : '纯题目'}
</div>

${bodyHtml}
${answerSheetHtml}

</body>
</html>`
}

// ============ PDF Generation ============

export async function generatePdf(
  questionIds: string[],
  options: Partial<PdfOptions> = {}
): Promise<{ success: boolean; filePath?: string; error?: string; imageErrors: string[] }> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const imageErrors: string[] = []

  try {
    // 1. Fetch questions
    const questions = fetchQuestionsForTest(questionIds)
    if (questions.length === 0) {
      return { success: false, error: '未找到符合条件的错题', imageErrors: [] }
    }

    // 2. Fetch groups for any questions that have group_id
    const groupIds = new Set<string>()
    for (const q of questions) {
      if (q.group_id) groupIds.add(q.group_id)
    }
    const groups = groupIds.size > 0 ? fetchQuestionGroups(Array.from(groupIds)) : []

    // 3. Download images
    const allQuestions = [
      ...questions,
      ...groups.flatMap(g => g.questions)
    ]
    const allImageUrls = new Set<string>()
    for (const q of allQuestions) {
      if (q.image_url) allImageUrls.add(q.image_url)
    }
    for (const g of groups) {
      if (g.passage_image_url) allImageUrls.add(g.passage_image_url)
    }

    logger.info('pdf_gen', 'download_start', `开始下载 ${allImageUrls.size} 张图片`)

    const imageCache = await downloadImagesForQuestions(allQuestions)

    // Track missing images
    for (const q of allQuestions) {
      if (q.image_url && !imageCache.has(q.image_url)) {
        const label = buildCategoryLabel(q)
        imageErrors.push(`第${questions.indexOf(q) + 1}题 (${label}): 图片无法下载`)
      }
    }

    // 4. Build HTML
    const html = buildFullHtml(questions, groups, imageCache, opts)

    // 5. Write HTML to temp file (data URL hits size limit with embedded images)
    const tmpDir = require('os').tmpdir()
    const tmpHtmlPath = path.join(tmpDir, `test-paper-${Date.now()}.html`)
    fs.writeFileSync(tmpHtmlPath, html, 'utf-8')

    // 6. Render PDF via hidden BrowserWindow
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { sandbox: false, contextIsolation: true }
    })

    await win.loadFile(tmpHtmlPath)

    // Wait for images to render
    await new Promise(resolve => setTimeout(resolve, 500))

    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      landscape: false
    })

    win.destroy()
    // Clean up temp HTML
    try { fs.removeSync(tmpHtmlPath) } catch { }

    // 7. Write PDF to temp file for the save dialog flow
    const safeTitle = opts.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 50)
    const tmpPath = path.join(tmpDir, `${safeTitle}.pdf`)
    fs.writeFileSync(tmpPath, pdfBuffer)

    logger.info('pdf_gen', 'success', `PDF 生成成功: ${tmpPath}`, {
      questions: questions.length,
      groups: groups.length,
      imageErrors: imageErrors.length
    })

    return { success: true, filePath: tmpPath, imageErrors }
  } catch (err: any) {
    logger.error('pdf_gen', 'failed', `PDF 生成失败: ${err.message}`)
    return { success: false, error: err.message, imageErrors }
  }
}
