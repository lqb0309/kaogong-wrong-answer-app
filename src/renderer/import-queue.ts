export async function loadImportQueue(fetchPage: (params: { page: number; pageSize: number; status: string }) => Promise<{ items: any[]; total: number }>): Promise<any[]> {
  const rows = new Map<string, any>()
  const pageSize = 500
  for (let page = 1; ; page++) {
    const result = await fetchPage({ page, pageSize, status: 'queue' })
    for (const row of result.items) if (row.status !== 'confirmed') rows.set(row.id, row)
    if (page * pageSize >= result.total || result.items.length === 0) break
  }
  return [...rows.values()]
}

export function selectableQueueItems<T extends { status: string }>(items: T[]): T[] {
  return items.filter(item => item.status === 'pending' || item.status === 'classified')
}

export function queueItemTitle(row: { id: string; local_image_path?: string; image_url?: string; ocr_text?: string; source?: string }): string {
  const text = String(row.ocr_text || '').replace(/\s+/g, ' ').trim()
  if (text) return text
  const source = row.local_image_path || row.image_url || ''
  if (source && !source.startsWith('data:')) {
    try { return decodeURIComponent(source.split(/[\\/]/).pop()!.split(/[?#]/)[0]) || `截图 ${row.id}` } catch { /* malformed legacy URL */ }
  }
  return row.source || `截图 ${row.id}`
}
