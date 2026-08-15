import { getDb } from './db'

interface TreeNode {
  id: string
  name: string
  level: number
  children: TreeNode[]
}

export function getTagTree(): TreeNode[] {
  const db = getDb()
  const row = db.prepare('SELECT data FROM tag_tree ORDER BY id DESC LIMIT 1').get() as { data: string } | undefined
  if (row) {
    return JSON.parse(row.data).tree || []
  }
  return []
}
