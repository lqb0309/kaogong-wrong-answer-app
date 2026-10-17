import { useEffect, useState } from 'react'
import { Alert, Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'

/**
 * AI 是分析必需配置；Obsidian 只是可选同步，不能提示成整个本地题库不可用。
 */
export function SetupBanner() {
  const navigate = useNavigate()
  const { config, loaded, load } = useSettingsStore()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (!loaded) load().finally(() => setChecked(true))
    else setChecked(true)
  }, [loaded, load])

  if (!checked) return null

  const missingAi = !config.vision_api_key && !config.ai_api_key
  if (!missingAi) return null

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="尚未配置 AI 模型 API Key"
      description="配置后可使用 AI 分类与复盘。本地题库可正常使用；Obsidian 同步为可选功能。"
      action={
        <Button size="small" type="primary" onClick={() => navigate('/settings')}>
          去配置
        </Button>
      }
    />
  )
}
