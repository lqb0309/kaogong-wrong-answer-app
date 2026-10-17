import path from 'path'
import fs from 'fs'

export function sanitizePathSegment(value: unknown, fallback = '未分类'): string {
  const cleaned = String(value ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .trim()
  return cleaned || fallback
}

export function safeMarkdownFileName(value: unknown, fallback: string): string {
  const base = sanitizePathSegment(path.basename(String(value || fallback)), fallback)
  return base.toLowerCase().endsWith('.md') ? base : `${base.replace(/\.[^.]+$/, '')}.md`
}

export function resolveInside(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...segments)
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('目标路径超出允许的数据目录')
  }
  // Resolve existing ancestors as well: a symlink must not bypass the boundary.
  let ancestor = target
  while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor)
  let rootAncestor = resolvedRoot
  while (!fs.existsSync(rootAncestor) && rootAncestor !== path.dirname(rootAncestor)) rootAncestor = path.dirname(rootAncestor)
  const realRoot = path.resolve(fs.realpathSync(rootAncestor), path.relative(rootAncestor, resolvedRoot))
  const realTarget = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target))
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error('符号链接指向数据目录以外，已取消操作')
  return target
}
