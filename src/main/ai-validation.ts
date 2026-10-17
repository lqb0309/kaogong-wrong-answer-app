import { z } from 'zod'

/** 仅对已确认的官方推理模型预留思考额度，不向其他兼容接口发送专用参数。 */
export function aiOutputOptions(baseURL: string, model: string, requestedTokens: number, attempt = 1): { max_tokens: number; reasoning_effort?: 'low' } {
  let officialDeepSeek = false
  try { officialDeepSeek = new URL(baseURL).hostname === 'api.deepseek.com' } catch { /* 使用原预算 */ }
  if (officialDeepSeek && /^(?:deepseek-v4(?:[.-]|$)|deepseek-flash$)/i.test(model)) {
    return { max_tokens: Math.max(requestedTokens, attempt > 1 ? 16384 : 8192), reasoning_effort: 'low' }
  }
  if (officialDeepSeek && model === 'deepseek-reasoner') return { max_tokens: Math.max(requestedTokens, 8192) }
  return { max_tokens: requestedTokens }
}

const task = z.object({
  title: z.string().trim().min(1).max(160), detail: z.string().max(2000).default(''),
  minutes: z.number().finite().int().min(1).max(300),
  module: z.enum(['资料分析', '判断推理', '言语理解', '数量关系', '常识判断', '政治理论', '申论', '复盘', '其他']),
  kind: z.enum(['practice', 'review', 'other']).optional()
})
export const adjustmentSchema = z.object({
  tasks: z.array(task).max(8), remaining_minutes: z.number().finite().min(0).max(600).optional(),
  review_ratio: z.union([z.literal(1), z.literal(1.5)]).optional(), review_only: z.boolean().optional(),
  adjustment_summary: z.string().max(2000).optional(), future_note: z.string().max(2000).optional()
})
export const forwardSchema = z.object({
  overview: z.string().max(2000), days: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), title: z.string().min(1).max(160), detail: z.string().max(2000),
    review_ratio: z.union([z.literal(1), z.literal(1.5)]).optional(), tasks: z.array(task).min(1).max(3)
  })).length(7)
})
export const classifySchema = z.object({
  level1: z.string().trim().min(1).max(100), level2: z.string().max(160).default(''),
  level3: z.string().max(160).nullable().default(null), confidence: z.number().finite().min(0).max(1),
  ocr_text: z.string().max(60000).default(''), reasoning: z.string().max(10000).default(''),
  has_graphics: z.boolean().optional(), graphics_description: z.string().max(10000).optional(), reflection: z.string().max(30000).optional()
})
export const visionSchema = z.object({
  ocr_text: z.string().max(60000).default(''), description: z.string().max(15000).default(''),
  has_graphics: z.boolean().optional(), graphics_description: z.string().max(15000).optional()
}).refine(value => !!(value.ocr_text.trim() || value.description.trim()), '视觉模型未识别到可用内容')
export const materialGroupSchema = z.object({
  title: z.string().max(200), passage_text: z.string().max(60000), questions: z.array(z.object({
    question_number: z.string().max(20), ocr_text: z.string().min(1).max(15000),
    correct_answer: z.string().regex(/^[A-H]*$/), user_answer: z.string().regex(/^[A-H]*$/), is_wrong: z.boolean().nullable(),
    level1: z.string().min(1).max(100), level2: z.string().max(160), level3: z.string().max(160).nullable(),
    confidence: z.number().finite().min(0).max(1), error_type: z.string().max(160).default(''),
    reflection: z.string().max(20000).default(''), material_image_indexes: z.array(z.number().int().positive()).optional()
  })).min(1).max(50)
}).superRefine((value, context) => {
  const seen = new Set<string>()
  value.questions.forEach((q, index) => {
    if (q.is_wrong !== (q.correct_answer && q.user_answer ? q.correct_answer !== q.user_answer : null)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['questions', index, 'is_wrong'], message: '答案与错误判定矛盾' })
    if (q.question_number && seen.has(q.question_number)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['questions', index, 'question_number'], message: '重复题号' })
    seen.add(q.question_number)
  })
})
export const inductionEnvelopeSchema = z.object({ daily_note: z.object({}).passthrough(), card_operations: z.object({}).passthrough() }).passthrough()

/** Never salvage a valid-looking prefix from truncated output or reasoning text. */
export function parseValidatedAi<T>(content: string, schema: z.ZodType<T>, finishReason?: string | null): T {
  if (finishReason && finishReason !== 'stop') throw new Error(finishReason === 'length' ? 'AI 输出已截断' : 'AI 输出未正常完成')
  const text = (content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (!text || text.length > 100000) throw new Error('AI 输出为空或过长')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('AI 返回的 JSON 不完整或格式错误') }
  const result = schema.safeParse(raw)
  if (!result.success) throw new Error(`AI 输出字段不合格：${result.error.issues.slice(0, 3).map(issue => issue.path.join('.') || '根节点').join('、')}`)
  return result.data
}
