/** Material groups stay together; the returned manifest is the answer-card order. */
export function orderPaperQuestions<T extends { id: string; group_id?: string | null }>(questions: T[]): T[] {
  const unique = [...new Map(questions.map(question => [question.id, question])).values()]
  const emitted = new Set<string>()
  const result: T[] = []
  for (const question of unique) {
    if (question.group_id) {
      if (emitted.has(question.group_id)) continue
      emitted.add(question.group_id)
      result.push(...unique.filter(item => item.group_id === question.group_id))
    } else result.push(question)
  }
  return result
}
