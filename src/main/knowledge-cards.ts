import fs from 'fs-extra'
import { join } from 'path'
import { readConfig } from './config'
import { logger } from './logger'

// ============ Types ============

export interface ExistingCard {
  title: string
  file_path: string
  knowledge_type: string
  level1: string
  level2: string
  level3: string | null
}

export interface NewCardInput {
  file_path: string
  title: string
  knowledge_type: string
  body: string
  linked_cards: string[]
  related_questions: string[]
}

export interface UpdateCardInput {
  existing_file: string
  add_to_section: string
  new_content: string
  increment_error_count: number
  new_linked_cards: string[]
  new_related_questions: string[]
}

export interface MocUpdateInput {
  moc_file: string
  action: string
  card_path?: string
  group?: string
}

// ============ Vault Path Helpers ============

function getVaultRoot(): string {
  return (readConfig('obsidian_vault') || '').replace(/\/+$/, '')
}

function resolvePath(relativePath: string): string {
  return join(getVaultRoot(), relativePath)
}

// ============ Scan Existing Cards ============

export function scanExistingCards(): ExistingCard[] {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot || !fs.existsSync(vaultRoot)) return []

  const cards: ExistingCard[] = []

  function scanDir(dir: string, relativeDir: string) {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(dir, entry.name)
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        // Skip 错题 directories and non-笔记本 dirs at level2+
        if (entry.name === '笔记本') {
          scanDir(fullPath, relPath)
        } else {
          // Only scan one level deeper for 笔记本 subdirectories
          scanDir(fullPath, relPath)
        }
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_') && !entry.name.startsWith('错题-')) {
        // Parse frontmatter to extract knowledge card metadata
        try {
          const content = fs.readFileSync(fullPath, 'utf-8')
          const fm = parseFrontmatter(content)
          if (fm.type === 'knowledge_card') {
            const pathParts = relPath.split('/')
            // Determine classification from path: vault/level1/笔记本/card.md or vault/level1/level2/笔记本/card.md
            let level1 = '', level2 = '', level3: string | null = null
            const notebookIdx = pathParts.indexOf('笔记本')
            if (notebookIdx === 1) {
              level1 = pathParts[0]
            } else if (notebookIdx === 2) {
              level1 = pathParts[0]
              level2 = pathParts[1]
            } else if (notebookIdx === 3) {
              level1 = pathParts[0]
              level2 = pathParts[1]
              level3 = pathParts[2]
            }

            cards.push({
              title: entry.name.replace(/\.md$/, ''),
              file_path: relPath,
              knowledge_type: fm.knowledge_type || 'pitfall',
              level1: fm.category?.split('/')[0] || level1,
              level2: fm.category?.split('/')[1] || level2,
              level3: fm.category?.split('/')[2] || level3
            })
          }
        } catch {
          // Skip unparseable files
        }
      }
    }
  }

  scanDir(vaultRoot, '')
  return cards
}

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const yaml = match[1]
  const result: Record<string, any> = {}

  // Simple YAML parser for frontmatter
  const lines = yaml.split('\n')
  let currentKey = ''
  for (const line of lines) {
    const arrayMatch = line.match(/^\s+-\s+(.+)/)
    if (arrayMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = []
      result[currentKey].push(arrayMatch[1].replace(/^"|"$/g, ''))
      continue
    }
    const kvMatch = line.match(/^(\w+):\s*(.+)/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      let value: any = kvMatch[2].trim()
      if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (/^\d+$/.test(value)) value = parseInt(value)
      else value = value.replace(/^"|"$/g, '')
      result[currentKey] = value
    }
  }
  return result
}

// ============ Similarity (for dedup) ============

export function calculateSimilarity(a: string, b: string): number {
  const aNorm = a.toLowerCase().replace(/\s+/g, '')
  const bNorm = b.toLowerCase().replace(/\s+/g, '')
  if (aNorm === bNorm) return 1
  // Full containment
  if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return 0.9

  // Bigram overlap (works for both Chinese characters and English words)
  function bigrams(s: string): Set<string> {
    const bg = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) {
      bg.add(s.slice(i, i + 2))
    }
    return bg
  }
  const aBg = bigrams(aNorm)
  const bBg = bigrams(bNorm)
  if (aBg.size === 0 && bBg.size === 0) return 0
  const intersection = new Set([...aBg].filter(x => bBg.has(x)))
  const union = new Set([...aBg, ...bBg])

  // Jaccard on bigrams
  const jaccard = union.size === 0 ? 0 : intersection.size / union.size

  // Also check single-character overlap as a boost
  const aChars = new Set(aNorm.split(''))
  const bChars = new Set(bNorm.split(''))
  const charIntersection = new Set([...aChars].filter(x => bChars.has(x)))
  const charUnion = new Set([...aChars, ...bChars])
  const charOverlap = charUnion.size === 0 ? 0 : charIntersection.size / charUnion.size

  // Weighted: bigrams matter more (60%), char overlap (40%)
  return 0.6 * jaccard + 0.4 * charOverlap
}

// ============ Read Card Content ============

export function readCardContent(filePath: string): { success: boolean; content?: string; error?: string } {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot) return { success: false, error: '未配置 Obsidian Vault' }
  const fullPath = resolvePath(filePath)
  if (!fs.existsSync(fullPath)) return { success: false, error: `文件不存在: ${filePath}` }
  try {
    const content = fs.readFileSync(fullPath, 'utf-8')
    return { success: true, content }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

// ============ Daily Notes ============

export interface DailyNoteSummary {
  date: string
  file_path: string
  title: string
  total_questions: number
  preview: string
}

export function scanDailyNotes(): DailyNoteSummary[] {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot) return []

  const dir = resolvePath('每日笔记')
  if (!fs.existsSync(dir)) return []

  const notes: DailyNoteSummary[] = []
  try {
    const files = fs.readdirSync(dir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('_'))
      .sort()
      .reverse() // newest first

    for (const file of files) {
      const filePath = join(dir, file)
      const content = fs.readFileSync(filePath, 'utf-8')
      const fm = parseFrontmatter(content)

      // Extract first heading as title
      const headingMatch = content.match(/^#\s+(.+)/m)
      const title = headingMatch ? headingMatch[1] : file.replace(/\.md$/, '')

      // Extract first paragraph after frontmatter as preview
      const bodyStart = content.indexOf('\n---\n') + 5
      const body = content.slice(bodyStart > 4 ? bodyStart : 0)
      const preview = body.replace(/^#.+$/m, '').trim().slice(0, 150)

      notes.push({
        date: file.replace(/\.md$/, ''),
        file_path: `每日笔记/${file}`,
        title,
        total_questions: fm.total_questions || 0,
        preview
      })
    }
  } catch { /* vault not ready */ }

  return notes
}

export function readDailyNote(date: string): { success: boolean; content?: string; error?: string } {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot) return { success: false, error: '未配置 Obsidian Vault' }
  const filePath = resolvePath(`每日笔记/${date}.md`)
  if (!fs.existsSync(filePath)) return { success: false, error: `每日笔记 ${date} 不存在` }
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return { success: true, content }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

// ============ Write Knowledge Card ============

export function writeKnowledgeCard(card: NewCardInput): { success: boolean; fullPath: string; error?: string; warning?: string } {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot) return { success: false, fullPath: '', error: '未配置 Obsidian Vault' }

  try {
    // Ensure knowledge card path includes "笔记本" directory
    // Expected format: level1/笔记本/card.md or level1/level2/笔记本/card.md
    // If missing, insert 笔记本 before the filename
    let fixedPath = card.file_path
    const pathParts = fixedPath.replace(/\\/g, '/').split('/')
    if (!pathParts.includes('笔记本')) {
      const fileName = pathParts.pop()!
      pathParts.push('笔记本', fileName)
      const oldPath = fixedPath
      fixedPath = pathParts.join('/')
      logger.warn('knowledge', 'card_path_fixed', `知识卡片路径缺少"笔记本"，已自动修复: "${oldPath}" → "${fixedPath}"`)
      card.file_path = fixedPath
    }

    const fullPath = resolvePath(card.file_path)
    const dir = join(fullPath, '..')

    // Dedup check 1: exact same file exists
    if (fs.existsSync(fullPath)) {
      logger.warn('knowledge', 'card_duplicate_exact', `卡片已存在(同名): ${card.file_path}`)
      return { success: false, fullPath, error: `卡片已存在: ${card.file_path}` }
    }

    // Dedup check 2: similar title in same directory
    if (fs.existsSync(dir)) {
      const existingFiles = fs.readdirSync(dir).filter((f: string) => f.endsWith('.md'))
      for (const existing of existingFiles) {
        const existingTitle = existing.replace(/\.md$/, '')
        const sim = calculateSimilarity(card.title, existingTitle)
        if (sim >= 0.6) {
          logger.warn('knowledge', 'card_duplicate_similar', `疑似重复卡片: "${card.title}" ≈ "${existingTitle}" (相似度 ${(sim * 100).toFixed(0)}%)`)
          return {
            success: false, fullPath,
            error: `疑似重复卡片：已存在 "${existingTitle}"（相似度 ${(sim * 100).toFixed(0)}%），请手动确认后再创建`
          }
        }
      }
    }

    fs.ensureDirSync(dir)

    const now = new Date().toISOString().slice(0, 10)
    const parts = card.file_path.replace(/\.md$/, '').split('/')
    const category = parts.filter(p => p !== '笔记本').join('/')

    const markdown = `---
type: knowledge_card
category: ${category}
knowledge_type: ${card.knowledge_type}
confidence: low
error_count: 1
last_seen: ${now}
created: ${now}
updated: ${now}
related_questions:
${card.related_questions.map(q => `  - "${q}"`).join('\n')}
tags:
  - 知识点
${parts.filter(p => p !== '笔记本').map(p => `  - ${p}`).join('\n')}
---

# ${card.title}

${card.body}

## 关联知识点
${card.linked_cards.length > 0 ? card.linked_cards.map(c => `- ${c}`).join('\n') : '暂无关联知识点。'}

## 统计
- 出现次数: 1 次 | 最近: ${now}
`

    fs.writeFileSync(fullPath, markdown, 'utf-8')
    logger.info('knowledge', 'card_created', `知识卡片已创建: ${card.file_path}`)
    return { success: true, fullPath }
  } catch (err: any) {
    logger.error('knowledge', 'card_create_failed', `知识卡片创建失败: ${card.file_path}`, { error: err.message })
    return { success: false, fullPath: '', error: err.message }
  }
}

// ============ Update Knowledge Card ============

export function updateKnowledgeCard(input: UpdateCardInput): { success: boolean; error?: string } {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot) return { success: false, error: '未配置 Obsidian Vault' }

  const fullPath = resolvePath(input.existing_file)
  if (!fs.existsSync(fullPath)) {
    return { success: false, error: `文件不存在: ${input.existing_file}` }
  }

  try {
    let content = fs.readFileSync(fullPath, 'utf-8')
    const fm = parseFrontmatter(content)
    const now = new Date().toISOString().slice(0, 10)

    // Update frontmatter fields
    if (input.increment_error_count > 0) {
      const currentCount = fm.error_count || 0
      content = content.replace(
        /^error_count:\s*\d+/m,
        `error_count: ${currentCount + input.increment_error_count}`
      )
    }
    content = content.replace(/^last_seen:\s*.+/m, `last_seen: ${now}`)
    content = content.replace(/^updated:\s*.+/m, `updated: ${now}`)

    // Update confidence if error_count >= 3
    const newErrorCount = (fm.error_count || 0) + input.increment_error_count
    if (newErrorCount >= 3 && fm.confidence === 'low') {
      content = content.replace(/^confidence:\s*low/m, 'confidence: medium')
    } else if (newErrorCount >= 5) {
      content = content.replace(/^confidence:\s*medium/m, 'confidence: high')
    }

    // Append to specified section
    const sectionHeader = `## ${input.add_to_section}`
    const sectionIdx = content.indexOf(sectionHeader)
    if (sectionIdx >= 0 && input.new_content) {
      const nextSectionIdx = content.indexOf('\n## ', sectionIdx + 1)
      const insertIdx = nextSectionIdx >= 0 ? nextSectionIdx : content.length
      const newLine = input.new_content.startsWith('-') ? `\n${input.new_content}` : `\n- ${input.new_content}`
      content = content.slice(0, insertIdx) + newLine + content.slice(insertIdx)
    }

    // Merge linked cards
    if (input.new_linked_cards.length > 0) {
      const linkedSection = content.indexOf('## 关联知识点')
      if (linkedSection >= 0) {
        const existingLinks = new Set<string>()
        const linkRegex = /^-\s*(\[\[.+?\]\])/gm
        let m: RegExpExecArray | null
        while ((m = linkRegex.exec(content)) !== null) {
          existingLinks.add(m[1])
        }
        const toAdd = input.new_linked_cards.filter(c => !existingLinks.has(c))
        if (toAdd.length > 0) {
          const nextSection = content.indexOf('\n## ', linkedSection + 1)
          const insertAt = nextSection >= 0 ? nextSection : content.length
          const additions = toAdd.map(c => `- ${c}`).join('\n')
          content = content.slice(0, insertAt) + '\n' + additions + content.slice(insertAt)
        }
      }
    }

    // Merge related questions
    if (input.new_related_questions.length > 0) {
      content = content.replace(
        /^related_questions:\s*\n([\s\S]*?)(?=^\w+:|\Z)/m,
        (_match, existing) => {
          const existingQs = new Set(
            (existing as string).split('\n').filter((l: string) => l.trim()).map((l: string) => l.trim())
          )
          const toAdd = input.new_related_questions.filter(q => !existingQs.has(`- "${q}"`))
          return `related_questions:\n${existing}${toAdd.map(q => `  - "${q}"`).join('\n')}\n`
        }
      )
    }

    // Update stats footer
    content = content.replace(
      /- 出现次数:.*/,
      `- 出现次数: ${newErrorCount} 次 | 最近: ${now}`
    )

    fs.writeFileSync(fullPath, content, 'utf-8')
    logger.info('knowledge', 'card_updated', `知识卡片已更新: ${input.existing_file}`, {
      errorIncrement: input.increment_error_count
    })
    return { success: true }
  } catch (err: any) {
    logger.error('knowledge', 'card_update_failed', `知识卡片更新失败: ${input.existing_file}`, { error: err.message })
    return { success: false, error: err.message }
  }
}

// ============ Write Daily Note ============

export function writeDailyNote(date: string, fullMarkdown: string): { success: boolean; fullPath: string; error?: string } {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot) return { success: false, fullPath: '', error: '未配置 Obsidian Vault' }

  try {
    const dir = resolvePath('每日笔记')
    fs.ensureDirSync(dir)
    const filePath = join(dir, `${date}.md`)
    fs.writeFileSync(filePath, fullMarkdown, 'utf-8')
    logger.info('knowledge', 'daily_note_written', `每日笔记已写入: 每日笔记/${date}.md`)
    return { success: true, fullPath: filePath }
  } catch (err: any) {
    logger.error('knowledge', 'daily_note_failed', `每日笔记写入失败: ${date}.md`, { error: err.message })
    return { success: false, fullPath: '', error: err.message }
  }
}

// ============ MOC Maintenance ============

export function updateMoc(update: MocUpdateInput): { success: boolean; error?: string } {
  const vaultRoot = getVaultRoot()
  if (!vaultRoot) return { success: false, error: '未配置 Obsidian Vault' }

  const fullPath = resolvePath(update.moc_file)

  try {
    if (update.action === 'update_stats') {
      if (!fs.existsSync(fullPath)) return { success: false, error: `MOC 文件不存在: ${update.moc_file}` }
      let content = fs.readFileSync(fullPath, 'utf-8')
      const now = new Date().toISOString().slice(0, 10)
      content = content.replace(/^updated:\s*.+/m, `updated: ${now}`)
      content = content.replace(/\*最近更新:.+/g, `*最近更新: ${now} | AI 自动维护*`)
      fs.writeFileSync(fullPath, content, 'utf-8')
      return { success: true }
    }

    if (update.action === 'add_card' && update.card_path && update.group) {
      // Ensure MOC exists
      if (!fs.existsSync(fullPath)) {
        const parts = update.moc_file.replace(/\.md$/, '').split('/')
        const category = parts.filter(p => p !== '笔记本' && !p.startsWith('_')).join(' > ')
        const mocMarkdown = `---
type: moc
category: ${category}
updated: ${new Date().toISOString().slice(0, 10)}
---

# ${parts[parts.length - 1]?.replace('_', '').replace('-总览', '') || '索引'} · 知识笔记

> 本页面是知识卡片的索引，由 AI 自动维护。

## 易错点

## 概念辨析

## 速解技巧

## 公式定理

---

*最近更新: ${new Date().toISOString().slice(0, 10)} | 共 0 张知识卡片*
`
        fs.ensureDirSync(join(fullPath, '..'))
        fs.writeFileSync(fullPath, mocMarkdown, 'utf-8')
      }

      let content = fs.readFileSync(fullPath, 'utf-8')
      const groupSection = `## ${update.group}`
      const groupIdx = content.indexOf(groupSection)

      if (groupIdx >= 0) {
        // Check if card already exists
        if (content.includes(update.card_path!)) return { success: true }

        // Add card under the group section
        const nextSectionIdx = content.indexOf('\n## ', groupIdx + 1)
        const insertIdx = nextSectionIdx >= 0 ? nextSectionIdx : content.lastIndexOf('\n---')
        const finalInsertIdx = insertIdx >= 0 ? insertIdx : content.length
        content = content.slice(0, finalInsertIdx) + `\n- ${update.card_path}` + content.slice(finalInsertIdx)
      }

      // Update stats
      const now = new Date().toISOString().slice(0, 10)
      content = content.replace(/^updated:\s*.+/m, `updated: ${now}`)
      const cardCount = (content.match(/^-\s*\[\[/gm) || []).length
      content = content.replace(/\*最近更新:.+/g, `*最近更新: ${now} | 共 ${cardCount} 张知识卡片*`)

      fs.writeFileSync(fullPath, content, 'utf-8')
      logger.info('knowledge', 'moc_updated', `MOC 已更新: ${update.moc_file}`, {
        action: update.action,
        card: update.card_path
      })
      return { success: true }
    }

    return { success: false, error: `未知的 MOC 操作: ${update.action}` }
  } catch (err: any) {
    logger.error('knowledge', 'moc_update_failed', `MOC 更新失败: ${update.moc_file}`, { error: err.message })
    return { success: false, error: err.message }
  }
}

// ============ Batch Operations ============

export interface InductionWriteResult {
  dailyNote: { success: boolean; path: string; error?: string }
  newCards: Array<{ title: string; success: boolean; path: string; error?: string }>
  updatedCards: Array<{ file: string; success: boolean; error?: string }>
  mocUpdates: Array<{ file: string; success: boolean; error?: string }>
}

export function writeInductionResults(
  dailyNoteMarkdown: string,
  date: string,
  newCards: NewCardInput[],
  updatedCards: UpdateCardInput[],
  mocUpdates: MocUpdateInput[]
): InductionWriteResult {
  const result: InductionWriteResult = {
    dailyNote: { success: false, path: '' },
    newCards: [],
    updatedCards: [],
    mocUpdates: []
  }

  // Write daily note
  const dnResult = writeDailyNote(date, dailyNoteMarkdown)
  result.dailyNote = { success: dnResult.success, path: dnResult.fullPath, error: dnResult.error }

  // Write new cards
  for (const card of newCards) {
    const r = writeKnowledgeCard(card)
    result.newCards.push({ title: card.title, success: r.success, path: r.fullPath, error: r.error })
  }

  // Update existing cards
  for (const update of updatedCards) {
    const r = updateKnowledgeCard(update)
    result.updatedCards.push({ file: update.existing_file, success: r.success, error: r.error })
  }

  // Update MOCs
  for (const moc of mocUpdates) {
    const r = updateMoc(moc)
    result.mocUpdates.push({ file: moc.moc_file, success: r.success, error: r.error })
  }

  return result
}
