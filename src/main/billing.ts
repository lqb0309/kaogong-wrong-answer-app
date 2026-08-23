import { readConfig } from './config'
import { decryptToken } from './safe-storage'
import { getCostOverview } from './ai-usage'
import { getCcSwitchStatus } from './cc-switch-adapter'

type BalanceResult = {
  available: boolean
  provider: string
  balances: Array<{ currency: string; total: string; granted: string; toppedUp: string }>
  error?: string
}

async function getDeepSeekBalance(): Promise<BalanceResult> {
  if (readConfig('ai_provider') !== 'deepseek') return { available: false, provider: 'deepseek', balances: [] }
  const encryptedKey = readConfig('ai_api_key')
  if (!encryptedKey) return { available: false, provider: 'deepseek', balances: [], error: '未配置 DeepSeek API Key' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${decryptToken(encryptedKey)}` },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`余额接口返回 ${response.status}`)
    const data = await response.json() as { is_available?: boolean; balance_infos?: Array<Record<string, string>> }
    return {
      available: Boolean(data.is_available), provider: 'deepseek',
      balances: (data.balance_infos || []).map(item => ({
        currency: item.currency || '', total: item.total_balance || '0',
        granted: item.granted_balance || '0', toppedUp: item.topped_up_balance || '0'
      }))
    }
  } catch (error) {
    return { available: false, provider: 'deepseek', balances: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function getBillingOverview() {
  return { usage: getCostOverview(), ccSwitch: getCcSwitchStatus(), balance: await getDeepSeekBalance() }
}
