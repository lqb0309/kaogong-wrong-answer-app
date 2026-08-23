import path from 'path'

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
  return target
}
