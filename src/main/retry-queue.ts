import { readConfig, writeConfig } from './config'
import { writeToVault } from './obsidian'
import { logger } from './logger'
import { getDb } from './db'
import fs from 'fs-extra'
import { questionData, renderQuestionMarkdown } from './question-data'

// ============ Obsidian 离线重试队列（PRD：断网缓存，恢复后自动补写） ============

interface VaultRetryItem {
  questionData: any
  markdown: string
  queuedAt: string
  attempts: number
}

const QUEUE_KEY = 'vault_retry_queue'
const MAX_ATTEMPTS = 8

function readQueue(): VaultRetryItem[] {
  try {
    const raw = readConfig(QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueue(items: VaultRetryItem[]): void {
  writeConfig(QUEUE_KEY, JSON.stringify(items))
}

export function enqueueVaultWrite(questionData: any, markdown: string): void {
  const queue = readQueue().filter(item => item.questionData.id !== questionData.id)
  queue.push({ questionData, markdown, queuedAt: new Date().toISOString(), attempts: 0 })
  writeQueue(queue)
  logger.warn('retry', 'enqueue_retry', 'Vault 写入失败，已加入重试队列', {
    queueSize: queue.length,
    traceId: questionData.traceId
  })
}

export function removeVaultRetry(id: string): void {
  writeQueue(readQueue().filter(item => item.questionData.id !== id))
}

export function queueSize(): number {
  return readQueue().length
}

/**
 * 尝试刷新重试队列。vault 未配置或不存在时直接返回失败计数（等下次调用）。
 */
export function flushVaultQueue(): { flushed: number; failed: number } {
  const queue = readQueue()
  if (queue.length === 0) return { flushed: 0, failed: 0 }

  const vaultRoot = readConfig('obsidian_vault')
  if (!vaultRoot || !fs.existsSync(vaultRoot)) {
    return { flushed: 0, failed: queue.length }
  }

  let flushed = 0
  let failed = 0
  const remaining: VaultRetryItem[] = []
  const db = getDb()

  for (const item of queue) {
    const row = db.prepare(`SELECT questions.*,
      (SELECT passage_text FROM question_groups WHERE id = questions.group_id) AS group_passage_text
      FROM questions WHERE id = ? AND status = 'confirmed'`).get(item.questionData.id)
    if (!row) continue // Deleted/skipped questions must never be resurrected.
    const latest = questionData(row)
    const result = writeToVault({ ...latest, markdown: renderQuestionMarkdown(latest) })
    if (result.success) {
      flushed++
      logger.info('retry', 'flush_success', `重试写入成功: ${result.vaultPath}`, null, item.questionData.traceId)
      if (db && result.relativePath) {
        try {
          db.prepare("UPDATE questions SET obsidian_path = ?, sync_status = 'synced', sync_error = NULL, last_synced_at = ? WHERE id = ?")
            .run(result.relativePath, new Date().toISOString(), item.questionData.id)
        } catch { /* ignore */ }
      }
    } else {
      item.attempts += 1
      remaining.push(item) // Retain failures for recovery; never silently discard work.
      if (item.attempts >= MAX_ATTEMPTS) {
        try {
          db.prepare("UPDATE questions SET sync_status = 'failed', sync_error = ? WHERE id = ?")
            .run(`Vault 写入连续失败 ${item.attempts} 次`, item.questionData.id)
        } catch { /* database may be closing */ }
      }
      failed++
      logger.warn('retry', 'flush_failed', `重试写入仍失败（第 ${item.attempts} 次）`, {
        traceId: item.questionData.traceId
      })
    }
  }

  writeQueue(remaining)
  if (flushed > 0) {
    logger.info('retry', 'flush_done', `重试队列刷新完成: 成功 ${flushed}, 失败 ${failed}`, { queueSize: remaining.length })
  }
  return { flushed, failed }
}
