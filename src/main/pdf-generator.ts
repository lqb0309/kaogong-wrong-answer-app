import { getLocalDataDir } from './storage'
import crypto from 'crypto'
import { orderPaperQuestions } from './paper-order'
import { readImageBuffer } from './image-assets'
import { BrowserWindow } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import { getDb } from './db'
import { logger } from './logger'
import { renderReviewText, reliableOfficialAnalysis, cleanPersonalReflection } from './review-text'

// ============ Types ============

export interface PdfOptions {
  title: string
  showAnswers?: boolean
  answerMode?: 'none' | 'answer' | 'analysis' | 'full'
  questionsPerPage?: number
  pageSize?: 'A4' | 'Letter'
  includeAnswerSheet?: boolean
  imageMode?: 'auto' | 'graphics_only' | 'full'
  format?: 'pdf' | 'html'
  readerId?: string
  solutionsOnly?: boolean
  reviewLayout?: boolean
}

export interface QuestionData {
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
  question_number?: string | null
  material_image_ids?: string | null
  question_images?: string | null
  option_images?: string | null
  original_analysis?: string | null
  original_answer?: string | null
}

export interface QuestionGroup {
  id: string
  title: string | null
  passage_image_url: string | null
  passage_text: string | null
  group_type: string
  material_images: string[]
  questions: QuestionData[]
}

const DEFAULT_OPTIONS: PdfOptions = {
  title: '错题练习卷',
  showAnswers: false,
  answerMode: 'none',
  questionsPerPage: 3,
  pageSize: 'A4',
  includeAnswerSheet: false
}

export interface PaperSnapshot { questions: QuestionData[]; groups: QuestionGroup[] }

export function preparePaperSnapshot(ids: string[]): PaperSnapshot {
  if (!ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('请选择 1～100 道题')
  const questions = orderPaperQuestions(fetchQuestionsForTest([...new Set(ids)]))
  if (questions.length !== new Set(ids).size) throw new Error('题目已变更或被删除，请重新选题')
  const positions = new Map(questions.map((q, index) => [q.id, index]))
  const groupIds = [...new Set(questions.map(q => q.group_id).filter((id): id is string => !!id))]
  const groups = groupIds.length ? fetchQuestionGroups(groupIds).map(group => {
    const members = questions.filter(q => q.group_id === group.id).sort((a, b) => positions.get(a.id)! - positions.get(b.id)!)
    const dependencies = new Set(members.flatMap(q => parseStringArray(q.material_image_ids)))
    return { ...group, questions: members, material_images: dependencies.size ? group.material_images.filter(url => dependencies.has(url)) : group.material_images }
  }).filter(group => group.questions.length) : []
  return { questions, groups }
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
             ocr_text, error_count, source, reflection, error_type, group_id, obsidian_path, has_graphics, graphic_image_path,
             question_number, material_image_ids, question_images, option_images, original_analysis, original_answer
      FROM questions
      WHERE status = 'confirmed' AND id IN (${placeholders})
    `).all(...ids) as QuestionData[]
    // 按传入的选题顺序重排（组卷顺序 = 用户在界面调整后的顺序）
    const orderMap = new Map(ids.map((id, i) => [id, i]))
    rows.sort((a, b) => (orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER))
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
           ocr_text, error_count, source, reflection, error_type, group_id, obsidian_path, has_graphics, graphic_image_path,
           question_number, material_image_ids, question_images, option_images, original_analysis, original_answer
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
             ocr_text, error_count, source, reflection, error_type, group_id, obsidian_path, has_graphics, graphic_image_path,
             question_number, material_image_ids, question_images, option_images, original_analysis, original_answer
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
      material_images: parseStringArray(g.material_images, g.passage_image_url),
      questions
    })
  }

  return result
}

function parseStringArray(raw: string | null | undefined, fallback?: string | null): string[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string' && !!item)
    } catch { /* legacy/plain value */ }
  }
  return fallback ? [fallback] : []
}

// ============ Image Download ============

async function downloadImageAsBase64(url: string, timeout = 10000): Promise<string | null> {
  if (!url) return null
  try {
    const { buffer, mime } = await readImageBuffer(url, timeout)
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch (err: any) {
    logger.warn('pdf_gen', 'image_download_failed', `图片下载失败: ${url}`, { error: err.message })
    return null
  }
}

async function downloadImagesForQuestions(
  questions: QuestionData[],
  extraUrls: string[] = [],
  onProgress?: (done: number, total: number) => void,
  existingCache?: Map<string, string>
): Promise<Map<string, string>> {
  const cache = existingCache || new Map<string, string>()

  // Collect unique image URLs
  const urls = new Set<string>()
  for (const q of questions) {
    if (q.image_url) urls.add(q.image_url)
    if (q.graphic_image_path) urls.add(q.graphic_image_path)
    for (const url of parseStringArray(q.question_images)) urls.add(url)
    const optionImages = parseStringRecord(q.option_images)
    for (const images of Object.values(optionImages)) for (const url of images) urls.add(url)
  }
  for (const url of extraUrls) if (url) urls.add(url)

  // Download in parallel with concurrency limit
  const urlList = Array.from(urls).filter(url => !cache.has(url))
  const BATCH = 5
  for (let i = 0; i < urlList.length; i += BATCH) {
    const batch = urlList.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async (url) => {
        const local = questions.find(q => q.image_url === url && q.local_image_path)?.local_image_path
        let base64 = local ? await downloadImageAsBase64(local) : null
        if (!base64) base64 = await downloadImageAsBase64(url)
        return { url, base64 }
      })
    )
    for (const { url, base64 } of results) {
      if (base64) cache.set(url, base64)
    }
    onProgress?.(Math.min(i + batch.length, urlList.length), urlList.length)
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

function parseStringRecord(raw: string | null | undefined): Record<string, string[]> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, Array.isArray(value) ? value.filter(item => typeof item === 'string' && item) : []])) as Record<string, string[]>
  } catch { return {} }
}

function stripImportedAnswers(raw: string): string {
  return (raw || '').split(/\n\s*正确答案[：:]/)[0].trim()
}

function buildCategoryLabel(q: QuestionData): string {
  return [q.level1, q.level2, q.level3].filter(Boolean).join(' › ')
}

function buildQuestionHtml(
  index: number,
  q: QuestionData,
  imageBase64: string | undefined,
  options: PdfOptions,
  preferOriginalImage = false,
  imageCache: Map<string, string> = new Map()
): string {
  const category = buildCategoryLabel(q)
  const isGraphics = q.has_graphics === 1 || !!q.graphic_image_path
  const hasImage = imageBase64 && q.image_url
  const parsed = parseOcrText(stripImportedAnswers(q.ocr_text || ''))
  // Some legacy imports accidentally copied one OCR result onto several
  // different source images. In that case the original image is the only
  // reliable question body; keeping the copied OCR would pair the wrong stem
  // with this record's analysis/reflection.
  const hasBody = !preferOriginalImage && parsed.body.length > 0
  const optionImages = parseStringRecord(q.option_images)
  const displayOptions = parsed.options.length ? parsed.options : Object.keys(optionImages).sort().map(key => `${key}. `)
  const hasOptions = !preferOriginalImage && displayOptions.length > 0

  // Image display: 'graphics_only' = only questions marked has_graphics; 'full' = show all
  const mode = options.imageMode || 'auto'
  const showImage = preferOriginalImage
    ? !!imageBase64
    : mode === 'full'
    ? hasImage
    : mode === 'graphics_only'
      ? (hasImage && isGraphics)
      : (hasImage && (isGraphics || !hasBody))
  const imageClass = isGraphics || !hasBody || preferOriginalImage ? 'question-image' : 'question-image question-image-thumb'
  const answerMode = options.answerMode || (options.showAnswers ? 'full' : 'none')
  let importedAnswer: { correct?: string; user?: string } = {}
  try {
    const value = JSON.parse(q.original_answer || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) importedAnswer = value
  } catch { /* legacy */ }

  const official = reliableOfficialAnalysis(q.original_analysis)
  const reflection = cleanPersonalReflection(q.reflection)
  const solution = answerMode === 'none' ? '' : `
    <div class="correct-answer-line"><strong>正确答案：</strong>${escapeHtml(importedAnswer.correct || '暂无可靠答案')}${importedAnswer.user ? `　<strong>原作答：</strong>${escapeHtml(importedAnswer.user)}` : ''}</div>
    ${answerMode === 'analysis' || answerMode === 'full' ? `<div class="reflection"><strong>粉笔解析</strong>${official ? renderReviewText(official, source => imageCache.get(source)) : '<p>暂无可靠的粉笔解析，未用 AI 内容替代。</p>'}
    ${answerMode === 'full' ? `<h3>个人复盘</h3>${reflection ? renderReviewText(reflection) : '<p>暂无可用的个人复盘。</p>'}` : ''}</div>` : ''}`
  if (options.solutionsOnly) return `<section class="question" id="question-${index}" data-question-id="${escapeHtml(q.id)}"><div class="question-header"><b>第 ${index} 题</b> ${escapeHtml(category)}</div><p>${escapeHtml(parsed.body.slice(0, 100))}</p>${solution}</section>`

  return `
    <div class="question" id="question-${index}" data-question-id="${escapeHtml(q.id)}">
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
          ${displayOptions.map((opt, i) => `
            <div class="option-item">
              <span class="option-letter">${escapeHtml(opt.split('.')[0])}</span>
              <span class="option-text">${escapeHtml(opt.slice(opt.indexOf('.') + 2))}${(optionImages[opt.split('.')[0].trim()] || []).map(url => imageCache.has(url) ? `<img src="${imageCache.get(url)}" style="max-width:100%;max-height:110px;object-fit:contain" />` : '<span>（选项图片加载失败）</span>').join('')}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${parseStringArray(q.question_images).filter(url => url !== q.image_url && (!showImage || imageCache.get(url) !== imageBase64)).map(url => imageCache.has(url) ? `<div class="question-image"><img src="${imageCache.get(url)}" alt="题干图片" /></div>` : '<div>（题干图片加载失败）</div>').join('')}
      ${!showImage && !hasBody && !hasOptions ? `
        <div class="question-text-empty">
          （此题目为纯图形题，请查看原始图片。OCR 未能提取文本内容。）
        </div>
      ` : ''}

      <div class="answer-area">
        ${hasOptions
          ? '<span class="answer-label">答案：</span><span class="choice-blank"></span>'
          : '<div class="answer-label">作答：</div><div class="answer-line"></div><div class="answer-line"></div>'}
      </div>

      ${options.format === 'html' && solution ? `<details class="reader-solution"><summary>查看答案与解析</summary>${solution}</details>` : solution}

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
  const materialImages = group.material_images
    .map(url => imageCache.get(url))
    .filter((value): value is string => !!value)
  const fallbackImage = materialImages.length === 0 && group.questions[0]?.image_url
    ? imageCache.get(group.questions[0].image_url) : undefined

  let html = `
    <div class="question-group">
      <div class="group-intro">
      <div class="group-header">
        <span class="group-title">${escapeHtml(group.title || '资料分析')}</span>
        <span class="group-badge">共 ${group.questions.length} 题</span>
      </div>
  `

  // Render passage material
  if (materialImages.length > 0 || fallbackImage) {
    html += `
      <div class="passage-images">
        ${(materialImages.length > 0 ? materialImages : [fallbackImage!]).map((src, materialIndex) => `
          <div class="passage-image"><img src="${src}" alt="材料图表 ${materialIndex + 1}" /></div>
        `).join('')}
      </div>
    `
  }

  if (group.passage_text) {
    html += `
      <div class="passage-text">${escapeHtml(group.passage_text)}</div>
    `
  }

  if (group.material_images.some(url => !imageCache.has(url))) html += '<p class="reader-tip">部分公共资料图片无法读取，请检查原图后重新导出。</p>'
  html += '</div>'
  // Render sub-questions
  for (let questionOffset = 0; questionOffset < group.questions.length; questionOffset++) {
    const q = group.questions[questionOffset]
    const directImages = parseStringArray(q.question_images)
    const imgKey = directImages[0] || ((q.graphic_image_path && q.has_graphics && !q.group_id) ? q.graphic_image_path : '')
    const qImage = imgKey ? imageCache.get(imgKey) : undefined
    html += buildQuestionHtml(index + questionOffset, q, qImage, options, false, imageCache)
  }

  html += `</div>`
  return html
}

function continuousReaderControls(readerId: string, count: number): string {
  const key = JSON.stringify(`review-reader:${readerId}`).replace(/</g, '\\u003c')
  return `<style>
  body.continuous-reader { width:auto; max-width:900px; margin:0 auto; padding:0 20px 80px; background:#f3f6fa; color:#25334a; font-size:18px; line-height:1.9; }
  .continuous-reader .question-group,.continuous-reader .question { break-inside:auto; page-break-inside:auto; }
  .continuous-reader .question { background:white; padding:22px; border:1px solid #dfe6ef; border-radius:10px; margin:16px 0; }
  .continuous-reader .question-body,.continuous-reader .question-options,.continuous-reader .option-text,.continuous-reader .reflection,.continuous-reader .passage-text { font-size:1em; line-height:1.9; }
  .continuous-reader .question-options { display:block; }
  .continuous-reader .option-item { margin:10px 0; }
  .continuous-reader .question-image img,.continuous-reader .passage-image img { max-height:480px; max-width:100%; cursor:zoom-in; }
  .continuous-reader .answer-area { display:none; }
  .continuous-reader .reader-solution summary { cursor:pointer; padding:12px 0; color:#315cc6; }
  .continuous-reader .reflection { background:#f7f9fc; border-left-color:#94acd8; }
  .reflection h3 { font-size:1.05em; margin:12px 0 6px; }
  .reflection p { margin:6px 0; overflow-wrap:anywhere; }
  .reader-controls { position:sticky; top:0; z-index:2; display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:12px 0; background:#f3f6faf5; border-bottom:1px solid #dfe6ef; }
  .reader-controls button,.reader-controls select { padding:7px 12px; border:1px solid #cbd5e1; border-radius:6px; background:white; color:#25334a; font:inherit; font-size:14px; cursor:pointer; }
  .reader-tip { color:#64748b; font-size:13px; }
  #reader-zoom { border:0; padding:18px; max-width:96vw; max-height:94vh; border-radius:8px; }
  #reader-zoom img { max-width:88vw; max-height:82vh; object-fit:contain; }
  #reader-zoom::backdrop { background:#0009; }
  @media(max-width:600px) { body.continuous-reader { padding-inline:10px; } .continuous-reader .question { padding:14px; } .continuous-reader .passage-images { display:block; } }
  @media print { .reader-controls,.reader-tip,#reader-zoom { display:none; } }
  </style>
  <div class="reader-controls"><button id="reader-expand">展开全部解析</button><button id="reader-collapse">收起全部解析</button><button id="reader-smaller" aria-label="缩小字号">A−</button><button id="reader-larger" aria-label="放大字号">A＋</button>
  <select id="reader-jump" aria-label="跳转题目"><option value="">跳转题目</option>${Array.from({ length: count }, (_, i) => `<option value="${i + 1}">第 ${i + 1} 题</option>`).join('')}</select></div>
  <p class="reader-tip">离线阅读页 · 图片已嵌入 · 自动记住本机阅读位置。读完后回应用点“本批已复习”，不会自动标为答对或掌握。</p>
  <dialog id="reader-zoom"><button id="reader-close">关闭图片</button><br><img alt="放大图片"></dialog>
  <script>
  document.addEventListener('DOMContentLoaded',()=>{
    const key=${key}; let fontSize=18, saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')||{};fontSize=Math.max(14,Math.min(28,Number(saved.fontSize)||18));}catch{}
    const applyFont=()=>document.body.style.fontSize=fontSize+'px';applyFont();
    for(const id of Array.isArray(saved.open)?saved.open:[]){const detail=document.getElementById(id)?.querySelector('.reader-solution');if(detail)detail.open=true;}
    const save=()=>{try{localStorage.setItem(key,JSON.stringify({fontSize,scrollY:window.scrollY,open:[...document.querySelectorAll('.reader-solution[open]')].map(el=>el.closest('.question').id)}));}catch{}};
    let timer;window.addEventListener('scroll',()=>{clearTimeout(timer);timer=setTimeout(save,250);},{passive:true});window.addEventListener('pagehide',save);
    document.getElementById('reader-expand').onclick=()=>{document.querySelectorAll('.reader-solution').forEach(el=>el.open=true);save();};
    document.getElementById('reader-collapse').onclick=()=>{document.querySelectorAll('.reader-solution').forEach(el=>el.open=false);save();};
    document.addEventListener('toggle',event=>{if(event.target.classList.contains('reader-solution'))save();},true);
    document.getElementById('reader-smaller').onclick=()=>{fontSize=Math.max(14,fontSize-2);applyFont();save();};
    document.getElementById('reader-larger').onclick=()=>{fontSize=Math.min(28,fontSize+2);applyFont();save();};
    document.getElementById('reader-jump').onchange=event=>document.getElementById('question-'+event.target.value)?.scrollIntoView({block:'start'});
    const dialog=document.getElementById('reader-zoom');document.getElementById('reader-close').onclick=()=>dialog.close();
    document.addEventListener('click',event=>{if(event.target.tagName==='IMG'&&!dialog.contains(event.target)){dialog.querySelector('img').src=event.target.src;if(dialog.showModal)dialog.showModal();}});
    window.addEventListener('load',()=>{window.scrollTo(0,Math.max(0,Number(saved.scrollY)||0));},{once:true});
  });
  </script>`
}

function buildFullHtml(
  questions: QuestionData[],
  groups: QuestionGroup[],
  imageCache: Map<string, string>,
  options: PdfOptions
): string {
  const pageWidth = options.pageSize === 'A4' ? '210mm' : '215.9mm'
  const pageHeight = options.pageSize === 'A4' ? '297mm' : '279.4mm'
  const compactTraining = /速度专项|速度训练/.test(options.title || '')

  let bodyHtml = ''
  let qIndex = 1

  const normalizeOcrFingerprint = (raw?: string | null) => (raw || '')
    .replace(/\s+/g, '')
    .replace(/[，。；：、,.!?！？;:（）()\[\]]/g, '')
    .trim()
  const fingerprintImages = new Map<string, Set<string>>()
  for (const question of questions) {
    const fingerprint = normalizeOcrFingerprint(stripImportedAnswers(question.ocr_text || ''))
    if (fingerprint.length < 24 || !question.image_url) continue
    const images = fingerprintImages.get(fingerprint) || new Set<string>()
    images.add(question.image_url)
    fingerprintImages.set(fingerprint, images)
  }
  const conflictingFingerprints = new Set(
    Array.from(fingerprintImages.entries())
      .filter(([, images]) => images.size > 1)
      .map(([fingerprint]) => fingerprint)
  )

  // Preserve the exact selection order. A group is rendered at the position of its
  // first selected child, and only selected children are included.
  const groupsById = new Map(groups.map(group => [group.id, group]))
  const renderedGroups = new Set<string>()
  for (const q of questions) {
    if (!options.solutionsOnly && q.group_id && groupsById.has(q.group_id)) {
      if (renderedGroups.has(q.group_id)) continue
      const group = groupsById.get(q.group_id)!
      bodyHtml += buildGroupHtml(qIndex, group, imageCache, options)
      qIndex += group.questions.length
      renderedGroups.add(q.group_id)
      continue
    }
    // For graphics questions, use the cropped graphic image instead of full image
    const imgKey = (q.graphic_image_path && q.has_graphics) ? q.graphic_image_path : q.image_url
    const imageBase64 = imgKey ? imageCache.get(imgKey) : undefined
    const fingerprint = normalizeOcrFingerprint(stripImportedAnswers(q.ocr_text || ''))
    const preferOriginalImage = conflictingFingerprints.has(fingerprint) && !!imageBase64
    bodyHtml += buildQuestionHtml(qIndex, q, imageBase64, options, preferOriginalImage, imageCache)
    qIndex++
  }

  // Answer sheet
  let answerSheetHtml = ''
  if (options.includeAnswerSheet) {
    const totalQuestions = qIndex - 1
    const answerRows = []
    const half = Math.ceil(totalQuestions / 2)
    for (let i = 1; i <= half; i++) {
      const right = i + half
      answerRows.push(`
        <tr>
          <td class="ans-num">${i}</td>
          <td class="ans-blank"></td>
          <td class="ans-num">${right <= totalQuestions ? right : ''}</td>
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
  @page {
    size: ${pageWidth} ${pageHeight};
    margin: ${compactTraining ? '9mm 10mm' : '18mm 16mm'};
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 12pt;
    line-height: 1.8;
    color: #1a1a1a;
  }
  body.compact-training { font-size: 9.5pt; line-height: 1.45; }

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
    break-inside: avoid;
    page-break-inside: avoid;
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
  .question-assets {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 3mm;
    margin: 3mm 0 5mm;
    break-inside: avoid;
  }
  .question-assets > img, .option-image img {
    display: block;
    width: 100%;
    max-height: 70mm;
    object-fit: contain;
  }
  .option-image {
    padding: 2mm;
    border: 1px solid #ddd;
    border-radius: 2mm;
    background: #fff;
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
    margin: 4mm 0 3mm;
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
  .choice-blank {
    display: inline-block;
    width: 20mm;
    height: 6mm;
    margin-left: 2mm;
    border-bottom: 1px solid #666;
    vertical-align: bottom;
  }

  .reflection {
    margin-top: 3mm;
    padding: 3mm;
    background: #f6ffed;
    border-left: 3px solid #52c41a;
    font-size: 10pt;
    color: #555;
  }
  .correct-answer-line {
    margin: 3mm 0;
    padding: 2mm 3mm;
    background: #fffbe6;
    border-left: 3px solid #faad14;
    font-size: 10pt;
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
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
  .group-intro {
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: avoid;
    page-break-after: avoid;
  }
  .group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4mm;
    padding-bottom: 2mm;
    border-bottom: 1px solid #91caff;
    break-after: avoid-page;
    page-break-after: avoid;
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
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .passage-images {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(62mm, 1fr));
    gap: 3mm;
    align-items: center;
    break-inside: avoid-page;
    page-break-inside: avoid;
    break-after: avoid-page;
    page-break-after: avoid;
  }
  .passage-image img {
    max-width: 100%;
    max-height: 95mm;
    object-fit: contain;
  }
  .passage-text {
    margin: 3mm 0;
    white-space: pre-wrap;
    font-size: 11pt;
    break-after: avoid-page;
    page-break-after: avoid;
  }

  .question-group .question-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 6mm;
  }
  .compact-training .test-title { font-size: 14pt; margin-bottom: 1.5mm; padding-bottom: 1.5mm; }
  .compact-training .test-subtitle { font-size: 8.5pt; margin-bottom: 3mm; }
  .compact-training .question-group { padding: 2.5mm; margin-bottom: 4mm; break-inside: avoid-page; page-break-inside: avoid; }
  .compact-training .group-header { margin-bottom: 2mm; padding-bottom: 1mm; break-after: avoid-page; page-break-after: avoid; }
  .compact-training .group-title { font-size: 10.5pt; }
  .compact-training .passage-images { display: flex; align-items: center; justify-content: center; gap: 2mm; break-inside: avoid-page; page-break-inside: avoid; break-after: avoid-page; page-break-after: avoid; }
  .compact-training .passage-image { flex: 1 1 0; margin: 1mm 0; }
  .compact-training .passage-image img { max-width: 100%; max-height: 72mm; }
  .compact-training .passage-text { font-size: 9pt; line-height: 1.45; margin: 1.5mm 0; break-after: avoid-page; page-break-after: avoid; }
  .compact-training .question { margin-bottom: 2mm; padding: 1.5mm 0; }
  .compact-training .question-header { margin-bottom: 1mm; }
  .compact-training .question-number { font-size: 10pt; }
  .compact-training .question-category, .compact-training .error-count, .compact-training .source, .compact-training .answer-area { display: none; }
  .compact-training .question-body { margin: 1mm 0; text-indent: 0; line-height: 1.5; font-size: 9.5pt; }
  .compact-training .question-options { margin: 1mm 0 1mm 2mm; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 4mm; }
  .compact-training .option-item { margin-bottom: .5mm; line-height: 1.4; }
  .compact-training .option-letter, .compact-training .option-text { font-size: 9pt; }
  .compact-training .question-image img { max-height: 55mm; }
  .compact-training .question-assets > img, .compact-training .option-image img { max-height: 45mm; }
  .review-paper .test-title { font-size: 16pt; margin-bottom: 2mm; }
  .review-paper .test-subtitle { margin-bottom: 5mm; }
  .review-paper .question { padding: 2mm 0; margin-bottom: 4mm; }
  .review-paper .question-header { margin-bottom: 1.5mm; }
  .review-paper .question-body { margin: 2mm 0; line-height: 1.65; text-indent: 0; }
  .review-paper .question-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1mm 6mm; margin:2mm 0; }
  .review-paper .option-item { margin-bottom:0; line-height:1.6; }
  .review-paper .answer-area { margin-top:1.5mm; padding-top:1mm; }
  .review-paper .question-group { break-inside:auto; page-break-inside:auto; padding:3mm; margin-bottom:5mm; }
  .review-paper .passage-image img { max-height:80mm; }
  .review-paper .reflection h3 { margin:6px 0 3px; break-after:avoid; }
  .review-paper .reflection p { margin:3px 0; }

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
<body class="${options.format === 'html' ? 'continuous-reader' : options.reviewLayout ? 'review-paper' : compactTraining ? 'compact-training' : ''}">
${options.format === 'html' ? continuousReaderControls(options.readerId || questions.map(q => q.id).join('-'), questions.length) : ''}

<div class="test-title">${escapeHtml(options.title)}</div>
<div class="test-subtitle">
  共 ${qIndex - 1} 题 · 生成于 ${new Date().toLocaleDateString('zh-CN')}
  · ${{ none: '纯题目', answer: '含答案', analysis: '含粉笔解析', full: '含完整复盘' }[options.answerMode || (options.showAnswers ? 'full' : 'none')]}
</div>

${bodyHtml}
${answerSheetHtml}

</body>
</html>`
}

// ============ PDF Generation ============

export async function generatePdf(
  questionIds: string[],
  options: Partial<PdfOptions> = {},
  onProgress?: (stage: string, done?: number, total?: number) => void,
  snapshot?: PaperSnapshot,
  sharedImageCache?: Map<string, string>
): Promise<{ success: boolean; filePath?: string; error?: string; imageErrors: string[]; questionIds?: string[] }> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const imageErrors: string[] = []
  let renderWindow: BrowserWindow | undefined
  let tempHtmlPath: string | undefined

  try {
    // 1. Fetch questions
    const prepared = snapshot || preparePaperSnapshot(questionIds)
    const questions = orderPaperQuestions(prepared.questions)
    if (questions.length !== new Set(questionIds).size) throw new Error('所选题目已变更或被删除，请刷新后重新导出')
    if (questions.length === 0) {
      return { success: false, error: '未找到符合条件的错题', imageErrors: [] }
    }
    onProgress?.('preparing', 0, questions.length)

    // 2. Fetch groups for any questions that have group_id
    const groupIds = new Set<string>()
    for (const q of questions) {
      if (q.group_id) groupIds.add(q.group_id)
    }
    const selectedIdSet = new Set(questions.map(q => q.id))
    const selectedOrder = new Map(questions.map((question, index) => [question.id, index]))
    const groups = groupIds.size > 0
      ? prepared.groups.map(group => ({
          ...group,
          questions: group.questions
            .filter(question => selectedIdSet.has(question.id))
            .sort((a, b) => (selectedOrder.get(a.id) || 0) - (selectedOrder.get(b.id) || 0))
        })).map(group => {
          const dependencies = new Set(group.questions.flatMap(question => parseStringArray(question.material_image_ids)))
          return {
            ...group,
            material_images: dependencies.size > 0
              ? group.material_images.filter(url => dependencies.has(url))
              : group.material_images
          }
        }).filter(group => group.questions.length > 0)
      : []

    // 3. Download images
    const allQuestions = [
      ...questions,
      ...groups.flatMap(g => g.questions)
    ]
    const allImageUrls = new Set<string>()
    for (const q of allQuestions) {
      if (q.image_url) allImageUrls.add(q.image_url)
      if (q.graphic_image_path) allImageUrls.add(q.graphic_image_path)
      for (const url of parseStringArray(q.question_images)) allImageUrls.add(url)
      for (const images of Object.values(parseStringRecord(q.option_images))) for (const url of images) allImageUrls.add(url)
    }
    for (const g of groups) {
      if (g.passage_image_url) allImageUrls.add(g.passage_image_url)
    }

    logger.info('pdf_gen', 'download_start', `开始下载 ${allImageUrls.size} 张图片`)
    onProgress?.('download', 0, allImageUrls.size)

    const answerMode = opts.answerMode || (opts.showAnswers ? 'full' : 'none')
    const analysisUrls = answerMode === 'analysis' || answerMode === 'full'
      ? allQuestions.flatMap(q => [...String(q.original_analysis || '').matchAll(/!\[[^\]]*\]\(<([^>]+)>\)/g)].map(match => match[1])) : []
    const materialUrls = [...groups.flatMap(group => group.material_images), ...analysisUrls]
    for (const url of materialUrls) allImageUrls.add(url)
    const imageCache = await downloadImagesForQuestions(allQuestions, materialUrls, (done, total) => {
      onProgress?.('download', done, total)
    }, sharedImageCache)

    // Track missing images
    for (const url of allImageUrls) if (!imageCache.has(url)) imageErrors.push(`题目、选项或公共资料图片无法读取：${url.slice(0, 160)}`)

    // 4. Build HTML
    const html = buildFullHtml(questions, groups, imageCache, opts)
    if (opts.format === 'html') {
      const filePath = path.join(require('os').tmpdir(), `review-reader-${crypto.randomUUID()}.html`)
      fs.writeFileSync(filePath, html, 'utf8')
      return { success: true, filePath, imageErrors, questionIds: questions.map(q => q.id) }
    }
    onProgress?.('render', 1, 1)

    // 5. Write HTML to temp file (data URL hits size limit with embedded images)
    const tmpDir = require('os').tmpdir()
    const tmpHtmlPath = path.join(tmpDir, `test-paper-${crypto.randomUUID()}.html`)
    tempHtmlPath = tmpHtmlPath
    fs.writeFileSync(tmpHtmlPath, html, 'utf-8')

    // 6. Render PDF via hidden BrowserWindow
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { sandbox: false, contextIsolation: true }
    })

    renderWindow = win
    await win.loadFile(tmpHtmlPath)

    // Wait for actual image/font readiness rather than an arbitrary delay.
    await win.webContents.executeJavaScript(`Promise.all([document.fonts.ready, ...[...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; image.onerror = resolve }))])`)

    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      landscape: false,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="font-size:8px;text-align:center;width:100%;color:#7b8796"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    })

    win.destroy()
    // Clean up temp HTML
    try { fs.removeSync(tmpHtmlPath) } catch { }

    // 7. Write PDF to temp file for the save dialog flow
    const safeTitle = opts.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 50)
    const tmpPath = path.join(tmpDir, `${safeTitle}-${crypto.randomUUID()}.pdf`)
    fs.writeFileSync(tmpPath, pdfBuffer)

    logger.info('pdf_gen', 'success', `PDF 生成成功: ${tmpPath}`, {
      questions: questions.length,
      groups: groups.length,
      imageErrors: imageErrors.length
    })

    return { success: true, filePath: tmpPath, imageErrors, questionIds: questions.map(question => question.id) }
  } catch (err: any) {
    logger.error('pdf_gen', 'failed', `PDF 生成失败: ${err.message}`)
    return { success: false, error: err.message, imageErrors }
  } finally {
    if (renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy()
    if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.removeSync(tempHtmlPath)
  }
}
