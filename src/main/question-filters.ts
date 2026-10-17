// Read-only compatibility for historical combined labels and structured Fenbi answers.
// Do not infer overtime from a fixed per-question threshold, especially for material groups.
const answer = "(CASE WHEN json_valid(original_answer) THEN original_answer ELSE '{}' END)"
const field = (key: string) => `json_extract(${answer}, '$.${key}')`
const option = (key: string) => `UPPER(TRIM(CAST(${field(key)} AS TEXT)))`
const validOption = (key: string) => `(${option(key)} != '' AND ${option(key)} NOT GLOB '*[^A-H]*')`
const label = `COALESCE(NULLIF(TRIM(error_type), ''), NULLIF(TRIM(${field('weaknessType')}), ''), '')`

export const answerResultSql = `(CASE
  WHEN ${validOption('correct')} AND ${validOption('user')}
    THEN CASE WHEN ${option('correct')} = ${option('user')} THEN 'correct' ELSE 'wrong' END
  WHEN ${label} IN ('正确但超时', '正确且超时', '答对', '正确') THEN 'correct'
  WHEN ${label} IN ('结果错误', '错误且超时', '答错', '错误') THEN 'wrong'
  WHEN COALESCE(error_count, 0) > 0 AND COALESCE(TRIM(${field('correct')}), '') = '' AND COALESCE(TRIM(${field('user')}), '') = '' THEN 'wrong'
  ELSE 'unknown' END)`

export const timeStatusSql = `(CASE
  WHEN ${label} IN ('正确但超时', '正确且超时', '错误且超时') THEN 'overtime'
  WHEN ${field('isOvertime')} = 1 THEN 'overtime'
  WHEN CAST(${field('overtimeSeconds')} AS REAL) > 0 THEN 'overtime'
  WHEN ${field('isOvertime')} = 0 THEN 'within'
  WHEN json_type(${answer}, '$.overtimeSeconds') IN ('integer', 'real') AND ${field('overtimeSeconds')} = 0
    AND CAST(${field('targetSeconds')} AS REAL) > 0
    AND COALESCE(${field('answerTime')}, '') GLOB '*[0-9]*' THEN 'within'
  ELSE 'unknown' END)`

export function performanceFilters(params: { answerResult?: string; timeStatus?: string }): { conditions: string[]; values: string[] } {
  const conditions: string[] = []
  const values: string[] = []
  if (params.answerResult && params.answerResult !== 'all') {
    if (!['wrong', 'correct', 'unknown'].includes(params.answerResult)) throw new Error('答题结果筛选无效')
    conditions.push(`${answerResultSql} = ?`)
    values.push(params.answerResult)
  }
  if (params.timeStatus) {
    if (!['overtime', 'within', 'unknown'].includes(params.timeStatus)) throw new Error('用时筛选无效')
    conditions.push(`${timeStatusSql} = ?`)
    values.push(params.timeStatus)
  }
  return { conditions, values }
}
