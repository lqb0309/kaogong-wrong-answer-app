import { useEffect, useState } from 'react'
import { Alert, Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'

/**
 * 首次使用引导横幅：检测到 AI Key / Vault 未配置时提示，一键跳转设置页。
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

  const missing: string[] = []
  if (!config.vision_api_key && !config.ai_api_key) missing.push('AI 模型 API Key')
  if (!config.obsidian_vault) missing.push('Obsidian Vault 路径')

  if (missing.length === 0) return null

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message={`尚未配置：${missing.join('、')}`}
      description="配置后才能使用 AI 自动分类与知识库写入功能。"
      action={
        <Button size="small" type="primary" onClick={() => navigate('/settings')}>
          去配置
        </Button>
      }
    />
  )
}
