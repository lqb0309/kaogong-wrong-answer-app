/** Synchronous status checks prevent a stale selection from deleting confirmed or active work. */
export function deleteQueueItems(ids: unknown, operations: {
  getStatus: (id: string) => string | undefined
  remove: (id: string) => void
}): { deletedIds: string[]; failed: Array<{ id: string; error: string }> } {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('删除参数无效，每批最多 1000 条')
  }
  const deletedIds: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const id of new Set<string>(ids)) {
    try {
      const status = operations.getStatus(id)
      if (status !== undefined && status !== 'pending' && status !== 'classified') {
        throw new Error(status === 'confirmed' ? '题目已入库，请在错题库中处理' : '题目正在处理，请稍后再试')
      }
      if (status !== undefined) operations.remove(id)
      deletedIds.push(id)
    } catch (error: any) {
      failed.push({ id, error: error.message || '删除失败' })
    }
  }
  return { deletedIds, failed }
}
