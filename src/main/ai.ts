import { readConfig } from './config'
import { decryptToken } from './safe-storage'
import { getTagTree } from './tag-service'
import { logger } from './logger'
import { generateTraceId, toImageUrl } from './utils'
import OpenAI from 'openai'

interface ClassifyResult {
  level1: string
  level2: string
  level3: string | null
  confidence: number
  ocr_text: string
  reasoning: string
  has_graphics?: boolean
  graphics_description?: string
  reflection?: string
  warning?: string
  fuzzy_match_type?: string
  fuzzy_match_score?: number
  /** AI 原始输出（未经过模糊匹配改写），用于确认页展示原始文本 */
  raw_level1?: string
  raw_level2?: string
  raw_level3?: string
}

export type ProgressCallback = (stage: string, message: string) => void

export async function classifyImage(imageUrl: string, traceId?: string, onProgress?: ProgressCallback): Promise<ClassifyResult> {
  const tid = traceId || generateTraceId()
  const emit = (stage: string, msg: string) => { logger.debug('ai', stage, msg, null, tid); onProgress?.(stage, msg) }

  const visionKey = readConfig('vision_api_key')
  const visionURL = readConfig('vision_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const visionModel = readConfig('vision_model') || 'qwen-vl-max'

  const reasonKey = readConfig('ai_api_key')
  const reasonURL = readConfig('ai_base_url') || 'https://api.deepseek.com'
  const reasonModel = readConfig('ai_model') || 'deepseek-chat'

  const pipelineMode = readConfig('ai_pipeline_mode') || 'two_stage'

  const hasVision = !!visionKey
  const hasReason = !!reasonKey

  if (!hasVision && !hasReason) {
    throw new Error('未配置 AI 模型，请在设置页填写图像理解模型或推理模型的 API Key')
  }

  const tagTree = getTagTree()
  const startTime = Date.now()

  let ocrText = ''
  let imageDescription = ''
  let classifyResult: ClassifyResult

  try {
    // ---- Mode: vision_only ----
    // Single call: vision model does OCR + classification in one shot
    if (pipelineMode === 'vision_only' || (!hasReason && hasVision)) {
      logger.info('ai', 'classify_start', '单模型模式：视觉模型直出分类', { model: visionModel, mode: 'vision_only' }, tid)
      emit('vision', `正在调用 ${visionModel} 分析图片并分类...`)

      const client = new OpenAI({ apiKey: decryptToken(visionKey ?? ''), baseURL: visionURL })
      const systemPrompt = buildSystemPrompt(tagTree)

      const resp = await client.chat.completions.create({
        model: visionModel,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: toImageUrl(imageUrl) } },
              { type: 'text', text: '请分析这道题目的图片，进行 OCR 识别并完成分类。' }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 2000
      })

      const duration = Date.now() - startTime
      const content = resp.choices[0]?.message?.content || '{}'
      const result = JSON.parse(content) as ClassifyResult

      logger.info('ai', 'classify_success', '单模型分类完成', {
        model: visionModel,
        level1: result.level1,
        confidence: result.confidence,
        duration,
        mode: 'vision_only'
      }, tid)

      classifyResult = result
    } else {
    // ---- Mode: two_stage ----
    // Stage 1: Vision model → OCR + description (with auto-retry if empty)

    const visionClient = new OpenAI({ apiKey: decryptToken(visionKey ?? ''), baseURL: visionURL })
    let visionResult: any = {}

    for (let attempt = 1; attempt <= 2; attempt++) {
      logger.info('ai', 'vision_start', `视觉模型分析图片 (第${attempt}次)`, { model: visionModel, attempt, mode: 'two_stage' }, tid)
      emit('vision', `正在调用 ${visionModel} 识别图片${attempt > 1 ? ' (重试)' : ''}...`)

      const visionResp = await visionClient.chat.completions.create({
      model: visionModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: toImageUrl(imageUrl) } },
            {
              type: 'text',
              text: `请仔细识别这道公务员考试题目的图片，输出以下信息：
1. OCR文本：图片中所有的文字内容（题目、选项、解析等），尽可能完整
2. 题目描述：这道题考察的知识点是什么？题干的核心内容是什么？
3. 题型判断：这属于行测中哪一类题型？

请用 JSON 格式输出：{"ocr_text": "...", "description": "...", "subject_type": "...", "has_graphics": true/false, "graphics_description": "..."}
其中 has_graphics 表示图片中是否包含非纯文本的图形区域（几何图形、图表、示意图等），graphics_description 简要描述图形位置和类型。
不要输出 JSON 以外的内容。`
            }
          ]
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    })

    const visionContent = visionResp.choices[0]?.message?.content || '{}'
    visionResult = JSON.parse(visionContent)
    ocrText = visionResult.ocr_text || ''
    imageDescription = visionResult.description || ''

    logger.info('ai', 'vision_success', `视觉分析完成 (第${attempt}次)`, {
      model: visionModel,
      ocrLength: ocrText.length,
      descLength: imageDescription.length,
      attempt,
      duration: Date.now() - startTime
    }, tid)

    if (ocrText.length > 0) break
    if (attempt < 2) {
      logger.warn('ai', 'vision_retry', '视觉模型返回空 OCR，自动重试', { model: visionModel, attempt }, tid)
      emit('vision', '视觉识别为空，正在重试...')
    }
    }

    // Stage 2: Reasoning model → classification
    const classifyClient = new OpenAI({ apiKey: decryptToken(reasonKey ?? ''), baseURL: reasonURL })

    logger.info('ai', 'classify_start', '推理模型开始分类', { model: reasonModel }, tid)
    emit('reason', `正在调用 ${reasonModel} 深度推理分类...`)

    const systemPrompt = buildSystemPrompt(tagTree)
    const userText = `以下是一道公务员考试错题的描述，请进行分类：

${ocrText ? `【OCR识别文本】\n${ocrText}\n` : ''}
${imageDescription ? `【题目分析】\n${imageDescription}\n` : ''}

请根据以上信息对这道题进行分类。`

    const classifyResp = await classifyClient.chat.completions.create({
      model: reasonModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500
    })

    const totalDuration = Date.now() - startTime
    const content = classifyResp.choices[0]?.message?.content || '{}'
    const result = JSON.parse(content) as ClassifyResult

    if (!result.ocr_text && ocrText) result.ocr_text = ocrText
    // Bridge graphics detection from vision stage (vision sees the image)
    if (visionResult.has_graphics && !result.has_graphics) {
      result.has_graphics = true
      result.graphics_description = result.graphics_description || visionResult.graphics_description || ''
    }

    logger.info('ai', 'classify_success', '两阶段分类完成', {
      visionModel,
      classifyModel: reasonModel,
      level1: result.level1,
      confidence: result.confidence,
      duration: totalDuration,
      mode: 'two_stage'
    }, tid)

    classifyResult = result
    }

    classifyResult = applyFuzzyMatch(classifyResult, tagTree)

    // Validate: flag abnormal results so the frontend can warn the user
    if (!classifyResult.level1 || classifyResult.level1 === '未分类' || !classifyResult.confidence) {
      classifyResult.warning = 'AI 分类异常：模型返回了空值，分类标签不可信，请手动确认'
      classifyResult.level1 = classifyResult.level1 || '未分类'
      classifyResult.confidence = classifyResult.confidence || 0
      logger.warn('ai', 'classify_abnormal', 'AI 分类结果为空，已标记 warning', {
        level1: classifyResult.level1,
        confidence: classifyResult.confidence
      }, tid)
    }

    return classifyResult
  } catch (err: any) {
    const duration = Date.now() - startTime
    logger.error('ai', 'classify_failed', `AI 分类失败: ${err.message}`, {
      duration,
      pipelineMode,
      statusCode: err.status,
      errorBody: err.message?.slice(0, 300)
    }, tid)
    throw err
  }
}

function applyFuzzyMatch(result: ClassifyResult, tagTree: TreeNode[]): ClassifyResult {
  // Preserve the raw AI output before fuzzy matching rewrites it,
  // so the confirmation page can show the original text (PRD 视觉规范).
  result.raw_level1 = result.raw_level1 || result.level1
  result.raw_level2 = result.raw_level2 || result.level2
  result.raw_level3 = result.raw_level3 || result.level3 || undefined
  const matchResult = fuzzyMatch(result, tagTree)
  result.fuzzy_match_type = matchResult.type
  result.fuzzy_match_score = matchResult.score
  if (matchResult.node) {
    result.level1 = matchResult.node.level1 || result.level1
    result.level2 = matchResult.node.level2 || result.level2
    result.level3 = matchResult.node.level3 || result.level3
  }
  return result
}

interface TreeNode {
  id: string
  name: string
  level: number
  children: TreeNode[]
}

function buildSystemPrompt(tree: TreeNode[]): string {
  // 设置页可自定义 Prompt（PRD：System Prompt 可在设置中编辑）
  const custom = readConfig('classify_prompt')
  if (custom && custom.trim()) return custom.trim()

  const flatten = (nodes: TreeNode[], depth = 0): string[] => {
    let result: string[] = []
    for (const n of nodes) {
      const indent = '  '.repeat(depth)
      result.push(`${indent}- ${n.name}`)
      if (n.children?.length) {
        result = result.concat(flatten(n.children, depth + 1))
      }
    }
    return result
  }

  const treeText = flatten(tree).join('\n')

  return `你是一位专业的公务员考试题目分类专家。请分析这道错题，严格按以下分类体系输出：

${treeText}

一级分类（必填）：言语理解 / 数量关系 / 判断推理 / 资料分析 / 常识判断 / 申论
二级分类（必填）：参考内置分类体系，若无匹配则输出你认为最准确的分类名称，不要输出"其他"
三级分类（选填）：具体考点，如"部分数""增长率"等，若无匹配则输出你认为最准确的名称
置信度（必填）：0.0~1.0 之间的浮点数
reasoning（必填）：简要说明你的分类依据，指出题干的关键特征
has_graphics（必填，布尔值）：题目图片中是否包含非纯文本的图形区域（如几何图形、图表、示意图、九宫格等）。纯文字题目为 false
graphics_description（选填，字符串）：如果 has_graphics=true，简要描述图形的位置和类型，如"题干上方有一组三角形折叠示意图"

以 JSON 格式返回，字段：level1, level2, level3, confidence, ocr_text, reasoning, has_graphics, graphics_description
不要输出任何 JSON 以外的内容。`
}

function fuzzyMatch(aiResult: any, tree: TreeNode[]): { type: string; node?: any; score?: number } {
  const flattenTree = (nodes: TreeNode[], path: string[] = []): { name: string; path: string[]; node: TreeNode }[] => {
    let result: { name: string; path: string[]; node: TreeNode }[] = []
    for (const n of nodes) {
      const currentPath = [...path, n.name]
      result.push({ name: n.name, path: currentPath, node: n })
      if (n.children?.length) {
        result = result.concat(flattenTree(n.children, currentPath))
      }
    }
    return result
  }

  const allNodes = flattenTree(tree)

  // Exact match on level2 + level3
  for (const node of allNodes) {
    if (node.name === aiResult.level2 || node.name === aiResult.level3) {
      return {
        type: 'exact',
        node: {
          level1: node.path[0] || aiResult.level1,
          level2: node.path[1] || node.name,
          level3: node.path[2] || null
        },
        score: 1
      }
    }
  }

  // Fuzzy match: simple includes + character overlap
  const scored = allNodes
    .map((node) => {
      const target = aiResult.level2 || aiResult.level3 || aiResult.level1 || ''
      const score = calculateSimilarity(target, node.name)
      return { node, score }
    })
    .sort((a, b) => b.score - a.score)

  if (scored[0]?.score >= 0.8) {
    const top = scored[0]
    return {
      type: 'fuzzy',
      node: {
        level1: top.node.path[0] || aiResult.level1,
        level2: top.node.path[1] || top.node.name,
        level3: top.node.path[2] || null
      },
      score: top.score
    }
  }

  return { type: 'unknown' }
}

function calculateSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()

  if (aLower === bLower) return 1
  if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.85

  // Simple character overlap
  const aChars = new Set(aLower.split(''))
  const bChars = new Set(bLower.split(''))
  const intersection = new Set([...aChars].filter((x) => bChars.has(x)))
  const union = new Set([...aChars, ...bChars])
  return intersection.size / union.size
}

export async function getAiSuggestion(statsData: any): Promise<string> {
  const reasonKey = readConfig('ai_api_key')
  const reasonURL = readConfig('ai_base_url') || 'https://api.deepseek.com'
  const reasonModel = readConfig('ai_model') || 'deepseek-chat'

  if (!reasonKey) {
    // Try vision key as fallback
    const visionKey = readConfig('vision_api_key')
    const visionURL = readConfig('vision_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    const visionModel = readConfig('vision_model') || 'qwen-vl-max'
    if (!visionKey) {
      throw new Error('未配置 AI 模型，请在设置页填写 API Key')
    }
    const client = new OpenAI({ apiKey: decryptToken(visionKey), baseURL: visionURL })
    const resp = await client.chat.completions.create({
      model: visionModel,
      messages: [
        { role: 'system', content: '你是一位公务员考试备考顾问，擅长分析错题数据并给出针对性的备考建议。请用中文回复。' },
        { role: 'user', content: buildSuggestionPrompt(statsData) }
      ],
      max_tokens: 1200
    })
    return resp.choices[0]?.message?.content || '无法生成建议'
  }

  const client = new OpenAI({ apiKey: decryptToken(reasonKey), baseURL: reasonURL })
  const resp = await client.chat.completions.create({
    model: reasonModel,
    messages: [
      { role: 'system', content: '你是一位公务员考试备考顾问，擅长分析错题数据并给出针对性的备考建议。请用中文回复。' },
      { role: 'user', content: buildSuggestionPrompt(statsData) }
    ],
    max_tokens: 1200
  })
  return resp.choices[0]?.message?.content || '无法生成建议'
}

function buildSuggestionPrompt(stats: any): string {
  const byLevel1 = stats.byLevel1 || []
  const topErrors = stats.topErrors || []
  const dailyStats = stats.dailyStats || []

  const level1Summary = byLevel1
    .map((l: any) => `- ${l.level1}: ${l.cnt} 题`)
    .join('\n')

  const topSummary = topErrors
    .slice(0, 10)
    .map((t: any) => `- ${t.level1}/${t.level2}${t.level3 ? '/' + t.level3 : ''}: ${t.error_count} 次错误`)
    .join('\n')

  const recent = dailyStats.slice(-7).map((d: any) => d.cnt).reduce((a: number, b: number) => a + b, 0)
  const earlier = dailyStats.slice(-14, -7).map((d: any) => d.cnt).reduce((a: number, b: number) => a + b, 0)
  const trend = earlier > 0 ? ((recent - earlier) / earlier * 100).toFixed(1) : 'N/A'

  return `以下是一位考公备考用户的错题统计数据，请分析并给出备考建议：

总错题数: ${stats.total || 0}
本周新增: ${stats.recentNew || 0}（较上周${earlier > 0 ? (stats.recentNew >= earlier ? '+' : '') + (stats.recentNew - earlier) : ''}）
近7日趋势: ${trend}%

各分类分布:
${level1Summary}

高频错题 TOP10:
${topSummary}

请从以下维度给出分析：
1. 薄弱点诊断：哪些模块是主要失分点？
2. 趋势判断：近期错题是在变多还是变少？需要注意什么？
3. 备考建议：针对薄弱模块的复习优先级和具体建议
4. 风险预警：哪些题型需要立即加强？

请用中文回复，200-400 字即可。`
}

export async function generateReflection(params: { level1: string; level2?: string; level3?: string | null; ocrText: string; traceId?: string }, onProgress?: ProgressCallback): Promise<string> {
  const reasonKey = readConfig('ai_api_key')
  const reasonURL = readConfig('ai_base_url') || 'https://api.deepseek.com'
  const reasonModel = readConfig('ai_model') || 'deepseek-chat'

  if (!reasonKey) {
    const visionKey = readConfig('vision_api_key')
    if (!visionKey) throw new Error('未配置推理模型')
  }

  const apiKey = decryptToken(reasonKey || readConfig('vision_api_key') || '')
  const client = new OpenAI({ apiKey, baseURL: reasonKey ? reasonURL : (readConfig('vision_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1') })
  const model = reasonKey ? reasonModel : (readConfig('vision_model') || 'qwen-vl-max')

  const levelPath = [params.level1, params.level2, params.level3].filter(Boolean).join(' > ')
  const prompt = `你是一位公务员考试辅导专家。请为下面这道错题写出详细的复盘思路。

【题目分类】${levelPath}
【OCR文本】
${params.ocrText || '（无OCR文本，请根据题目类型给出通用解法）'}

请从以下两个方面给出解题思路，用 Markdown 格式输出：

## 正常解题思路
写出这道题的常规完整解法。包括：
- 题目分析：这道题在考什么？
- 解题步骤：分步骤详细推导
- 关键知识点：涉及哪些公式、定理、技巧
- 易错点提示：常见错误和避坑方法

## 应试快速思路
写出在考试时间紧张时的快速解法。包括：
- 快速定位：如何从题干/选项中快速锁定关键信息
- 排除技巧：如何用排除法缩小范围
- 秒杀口诀/公式：可直接套用的快速方法
- 蒙题策略：实在不会时的合理猜测思路

直接输出 Markdown，不要输出其他无关内容。`

  const tid = params.traceId || generateTraceId()

  for (let attempt = 1; attempt <= 2; attempt++) {
    onProgress?.('reflection', `正在生成复盘思路${attempt > 1 ? ' (重试)' : ''}...`)
    logger.info('ai', 'reflection_start', `开始生成复盘思路 (第${attempt}次)`, { model, attempt }, tid)

    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8192
      })

      const msg = resp.choices[0]?.message as any
      const result = msg?.content || msg?.reasoning_content || ''

      // Check if response was truncated by token limit
      if (resp.choices[0]?.finish_reason === 'length') {
        logger.warn('ai', 'reflection_truncated', '复盘思路可能被截断（达到 token 上限）', { model, attempt }, tid)
      }

      logger.info('ai', 'reflection_success', `复盘思路生成完成 (第${attempt}次)`, {
        model,
        reflectionLength: result.length,
        attempt
      }, tid)

      if (result) return result
      if (attempt < 2) {
        logger.warn('ai', 'reflection_retry', '复盘思路返回空内容，自动重试', { model, attempt }, tid)
      }
    } catch (err: any) {
      logger.warn('ai', 'reflection_failed', `复盘思路生成失败 (第${attempt}次): ${err.message}`, { attempt }, tid)
      if (attempt >= 2) throw err
    }
  }

  return ''
}

// ============ Daily Knowledge Induction (PRD v0.2 Section 3) ============

export interface DailyInductionInput {
  todayQuestions: Array<{
    id: string
    level1: string
    level2: string
    level3: string | null
    ocr_text: string | null
    error_type: string | null
    reflection: string | null
    obsidian_path: string | null
    error_count: number
  }>
  existingCards: Array<{
    title: string
    file_path: string
    knowledge_type: string
    level1: string
    level2: string
    level3: string | null
  }>
}

export interface DailyInductionOutput {
  daily_note: {
    date: string
    total_questions: number
    categories_studied: string[]
    overview: string
    error_distribution: string
    new_findings: string
    cards_new: string[]
    cards_updated: string[]
    full_markdown: string
  }
  card_operations: {
    new_cards: Array<{
      file_path: string
      title: string
      knowledge_type: string
      body: string
      linked_cards: string[]
      related_questions: string[]
    }>
    updated_cards: Array<{
      existing_file: string
      add_to_section: string
      new_content: string
      increment_error_count: number
      new_linked_cards: string[]
      new_related_questions: string[]
    }>
    moc_updates: Array<{
      moc_file: string
      action: string
      card_path?: string
      group?: string
    }>
  }
}

export async function generateDailyInduction(
  input: DailyInductionInput,
  onProgress?: (stage: string, message: string, progress?: number, tokens?: number) => void
): Promise<DailyInductionOutput> {
  const reasonKey = readConfig('ai_api_key')
  const reasonURL = readConfig('ai_base_url') || 'https://api.deepseek.com'
  const reasonModel = readConfig('ai_model') || 'deepseek-chat'

  if (!reasonKey) {
    const visionKey = readConfig('vision_api_key')
    if (!visionKey) throw new Error('未配置 AI 模型，请在设置页填写 API Key')
  }

  const apiKey = decryptToken(reasonKey || readConfig('vision_api_key') || '')
  const baseURL = reasonKey ? reasonURL : (readConfig('vision_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  const model = reasonKey ? reasonModel : (readConfig('vision_model') || 'qwen-vl-max')

  // Phase 1: Filter existing cards by relevance (memory system)
  onProgress?.('induct', '正在分析今日错题，筛选相关知识点...', 5, 0)

  const relevantCards = filterRelevantCards(input.existingCards, input.todayQuestions)
  const filteredInput = { ...input, existingCards: relevantCards }

  if (input.existingCards.length > 0) {
    onProgress?.('induct', `从 ${input.existingCards.length} 张已有卡片中匹配到 ${relevantCards.length} 张相关卡片`, 10, 0)
  }

  // Phase 2: Build prompt
  onProgress?.('induct', '正在组装分析数据...', 15, 0)
  const userPrompt = buildInductionPrompt(filteredInput)
  const systemPrompt = buildInductionSystemPrompt()

  // Estimate total tokens based on data size
  const estimatedTokens = Math.min(8000, Math.max(2000,
    800 + input.todayQuestions.length * 150 + relevantCards.length * 40
  ))

  onProgress?.('induct', `正在调用 ${model} 分析 ${input.todayQuestions.length} 道错题...`, 20, 0)

  // Phase 3: Streaming AI call with real progress
  const client = new OpenAI({ apiKey, baseURL })
  let fullContent = ''
  let tokenCount = 0
  let lastProgress = 20

  const stream = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 8000,
    stream: true
  })

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content
    if (delta) {
      fullContent += delta
      tokenCount++

      // Update progress: map 20-90% across the token range
      const progress = Math.min(90, 20 + Math.round((tokenCount / estimatedTokens) * 70))
      if (progress > lastProgress + 2 || tokenCount % 5 === 0) {
        lastProgress = progress
        onProgress?.('induct', `AI 正在归纳知识点...`, progress, tokenCount)
      }
    }
  }

  // Phase 4: Parse and finalize
  onProgress?.('induct', '正在解析归纳结果...', 92, tokenCount)

  // Clean up any markdown code fences the model might have wrapped the JSON in
  let cleaned = fullContent.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  const result = JSON.parse(cleaned) as DailyInductionOutput

  // Build the full daily note markdown
  onProgress?.('induct', '正在生成每日笔记...', 96, tokenCount)
  result.daily_note.full_markdown = buildDailyNoteMarkdown(result.daily_note)

  onProgress?.('induct', '归纳完成', 100, tokenCount)
  return result
}

/**
 * Memory system: filter existing cards to only those relevant to today's questions.
 * Three-tier matching:
 *   1. Exact level3 match (same knowledge point) → score 30
 *   2. Same level2 → score 20
 *   3. Same level1 → score 10
 * Keeps top 20 most relevant cards to prevent prompt bloat.
 */
function filterRelevantCards(
  cards: DailyInductionInput['existingCards'],
  questions: DailyInductionInput['todayQuestions']
): DailyInductionInput['existingCards'] {
  if (cards.length === 0) return cards

  // Build lookup sets from today's questions
  const todayLevel1 = new Set(questions.map(q => q.level1))
  const todayLevel2 = new Set(questions.map(q => `${q.level1}|${q.level2}`))
  const todayLevel3 = new Set(questions.map(q => `${q.level1}|${q.level2}|${q.level3 || ''}`))

  const scored = cards.map(card => {
    let score = 0
    const cardL3 = `${card.level1}|${card.level2}|${card.level3 || ''}`
    const cardL2 = `${card.level1}|${card.level2}`

    if (todayLevel3.has(cardL3)) score += 30   // exact knowledge point match
    else if (todayLevel2.has(cardL2)) score += 20  // same sub-category
    else if (todayLevel1.has(card.level1)) score += 10  // same top category

    return { card, score }
  })

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(s => s.card)
}

function buildInductionPrompt(input: DailyInductionInput): string {
  // Group questions by level3 (knowledge point)
  const groups: Record<string, typeof input.todayQuestions> = {}
  for (const q of input.todayQuestions) {
    const key = `${q.level1} > ${q.level2}${q.level3 ? ' > ' + q.level3 : ''}`
    if (!groups[key]) groups[key] = []
    groups[key].push(q)
  }

  // Build card lookup: map level3 key → matching cards
  const cardByKey: Record<string, typeof input.existingCards> = {}
  for (const card of input.existingCards) {
    const key = `${card.level1}|${card.level2}|${card.level3 || ''}`
    if (!cardByKey[key]) cardByKey[key] = []
    cardByKey[key].push(card)
  }

  let prompt = `今天共有 ${input.todayQuestions.length} 道已确认错题。按知识点分组如下：\n\n`

  for (const [category, questions] of Object.entries(groups)) {
    const [l1, l2, l3] = category.split(' > ')
    const matchKey = `${l1}|${l2}|${l3 || ''}`
    const matchedCards = cardByKey[matchKey] || []

    prompt += `【${category}】(${questions.length}题)\n`
    for (const q of questions) {
      const parts: string[] = []
      if (q.ocr_text) parts.push(`OCR: ${q.ocr_text.slice(0, 200)}`)
      if (q.error_type) parts.push(`错误类型: ${q.error_type}`)
      if (q.reflection) parts.push(`复盘: ${q.reflection.slice(0, 200)}`)
      prompt += `- ${parts.join(' | ')}\n`
    }

    // Show exact matching cards for this knowledge point
    if (matchedCards.length > 0) {
      prompt += `📄 已有知识卡片（同一知识点）:\n`
      for (const c of matchedCards) {
        prompt += `  - ${c.title} (${c.knowledge_type}) → ${c.file_path}\n`
      }
    } else {
      prompt += `📄 已有知识卡片: （无，可能是新知识点）\n`
    }
    prompt += '\n'
  }

  prompt += `---\n\n请完成两项任务：\n1. 生成今日学习笔记（每日笔记）\n2. 归纳知识点，新建或更新知识卡片\n\n`
  prompt += `重要规则：\n`
  prompt += `- 每个知识点只建一张卡片，不要把同一概念拆成多张\n`
  prompt += `- 如果已有卡片覆盖了这个知识点，必须用 updated_cards 追加，不要新建\n`
  prompt += `- 只有确定是全新的、已有卡片完全没覆盖的知识点，才在 new_cards 中创建\n`
  prompt += `- new_cards 最多 3 张，超过的改为在已有卡片中追加\n\n以 JSON 格式返回结果。`

  return prompt
}

function buildInductionSystemPrompt(): string {
  return `你是一位专业的公务员考试备考导师，同时也是一位知识管理专家。
你的任务是分析用户每天的错题，完成两项工作：

## 任务一：生成每日学习笔记
写一篇简洁的今日学习总结，包括：
- 今日概览：错题总数和分类分布
- 错题分布表：按分类列出题数和主要错误类型
- 新发现的知识点：从今天的错题中首次暴露的薄弱点
- 再次踩坑：今天再次出现的已有知识点（参考已有卡片列表）
- 今日收获：一段 100 字左右的自然语言总结，给出复习建议

## 任务二：知识卡片管理
从多道错题中找共性，提炼原子化知识卡片。
- 知识卡片类型：pitfall(易错点) / concept(概念辨析) / shortcut(速解技巧) / formula(公式定理)
- 如果多道错题涉及同一知识点 → 新建或更新该知识点卡片
- 每张卡片只讲一个知识点，保持原子化
- 如果已有相关卡片 → 更新它，在指定 section 末尾追加新发现的易错点
- 为每个知识点标注 [[双链]] 引用到关联的其他知识点卡片
- 双链路径使用 vault 中的相对路径
- 知识卡片 file_path 必须严格遵循格式：level1/笔记本/card_name.md（一级分类）或 level1/level2/笔记本/card_name.md（二级分类）。"笔记本"目录必须存在，卡片绝不可直接放在分类目录下
- 同时更新对应的 MOC 索引文件
- 如果今天没有可归纳的新知识点，new_cards 和 updated_cards 可以都为空数组

⚠️ 重要防重复规则：
- 一个知识点只建一张卡片，不要把同一知识点拆成"XX的定义""XX的特征""XX的技巧"等多张卡片
- 如果已有卡片路径中已包含该知识点关键词，必须选择更新而非新建
- 卡片标题用知识点的核心名称，不要加修饰词（如只要"选言推理"不要"选言推理的核心技巧"）
- 命名时问自己：这张卡片和已有卡片讲的是不是同一件事？如果是，更新已有的

## 输出要求
- 以 JSON 格式返回，不要输出任何 JSON 以外的内容
- daily_note 中的字段：date(日期字符串), total_questions(数字), categories_studied(字符串数组), overview(今日概览文本), error_distribution(Markdown表格文本), new_findings(自然语言总结文本,100字左右), cards_new(wikilink字符串数组), cards_updated(wikilink字符串数组)
- card_operations 中有三个数组：new_cards, updated_cards, moc_updates
- new_cards 每项包含：file_path, title, knowledge_type, body(Markdown正文), linked_cards(wikilink数组), related_questions(wikilink数组)
- updated_cards 每项包含：existing_file, add_to_section(如"典型错法"), new_content, increment_error_count(数字), new_linked_cards, new_related_questions
- moc_updates 每项包含：moc_file, action("add_card"|"update_stats"), card_path(wikilink), group("易错点"|"概念辨析"|"速解技巧"|"公式定理")
- daily_note.new_findings 用自然流畅的中文写作，像一位老师在给学生做日总结`
}

function buildDailyNoteMarkdown(dn: DailyInductionOutput['daily_note']): string {
  const frontmatter = `---
type: daily_note
date: ${dn.date}
total_questions: ${dn.total_questions}
categories_studied:
${dn.categories_studied.map(c => `  - ${c}`).join('\n')}
new_cards:
${dn.cards_new.map(c => `  - "${c}"`).join('\n')}
updated_cards:
${dn.cards_updated.map(c => `  - "${c}"`).join('\n')}
tags:
  - 每日笔记
---`

  return `${frontmatter}

# 📅 ${dn.date} 学习笔记

## 今日概览
${dn.overview}

## 错题分布
${dn.error_distribution}

## 新发现的知识点 ✨
${dn.cards_new.length > 0 ? dn.cards_new.map(c => `- ${c}`).join('\n') : '今日无新发现的知识点。'}

## 再次踩坑 ⚠️
${dn.cards_updated.length > 0 ? dn.cards_updated.map(c => `- ${c}`).join('\n') : '今日无再次踩坑的知识点。'}

## 今日收获
> ${dn.new_findings}
`
}
