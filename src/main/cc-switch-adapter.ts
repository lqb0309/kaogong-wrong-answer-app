import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'

export type ModelPrice = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  source: 'cc-switch' | 'builtin'
}

const builtinPrices: Record<string, Omit<ModelPrice, 'model' | 'source'>> = {
  'deepseek-chat': { input: 0.28, output: 0.42, cacheRead: 0.028, cacheCreation: 0.28 },
  'deepseek-reasoner': { input: 0.28, output: 0.42, cacheRead: 0.028, cacheCreation: 0.28 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheCreation: 2.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheCreation: 0.15 }
}

let cache: { mtime: number; prices: Map<string, ModelPrice>; path: string } | null = null

function databasePath(): string {
  return path.join(app.getPath('home'), '.cc-switch', 'cc-switch.db')
}

function normalize(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, '')
}

function readPrices(): { prices: Map<string, ModelPrice>; path: string; mtime: number } | null {
  const dbPath = databasePath()
  if (!fs.existsSync(dbPath)) return null
  const mtime = fs.statSync(dbPath).mtimeMs
  if (cache?.path === dbPath && cache.mtime === mtime) return cache
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`SELECT model_id, input_cost_per_million, output_cost_per_million,
      cache_read_cost_per_million, cache_creation_cost_per_million FROM model_pricing`).all() as Array<Record<string, unknown>>
    const prices = new Map<string, ModelPrice>()
    for (const row of rows) {
      const model = String(row.model_id)
      prices.set(normalize(model), {
        model,
        input: Number(row.input_cost_per_million || 0),
        output: Number(row.output_cost_per_million || 0),
        cacheRead: Number(row.cache_read_cost_per_million || 0),
        cacheCreation: Number(row.cache_creation_cost_per_million || 0),
        source: 'cc-switch'
      })
    }
    cache = { prices, path: dbPath, mtime }
    return cache
  } finally {
    db.close()
  }
}

export function getCcSwitchStatus() {
  const dbPath = databasePath()
  try {
    const result = readPrices()
    return { detected: Boolean(result), path: dbPath, modelCount: result?.prices.size || 0, modifiedAt: result ? new Date(result.mtime).toISOString() : null }
  } catch (error) {
    return { detected: false, path: dbPath, modelCount: 0, modifiedAt: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export function resolveModelPrice(model: string): ModelPrice | null {
  const key = normalize(model)
  try {
    const prices = readPrices()?.prices
    const exact = prices?.get(key)
    if (exact) return exact
    const alias = [...(prices?.values() || [])].find(item => key.includes(normalize(item.model)) || normalize(item.model).includes(key))
    if (alias) return alias
  } catch { /* CC Switch is an optional source */ }
  const fallback = builtinPrices[key]
  return fallback ? { model: key, ...fallback, source: 'builtin' } : null
}
