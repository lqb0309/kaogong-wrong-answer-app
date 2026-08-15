import { useEffect, useRef } from 'react'
import { notification, Button } from 'antd'
import { useNavigate } from 'react-router-dom'

export function ErrorToast() {
  const navigate = useNavigate()
  // 同一 trace_id 5 分钟内不重复弹通知（PRD 3.7.5）
  const lastNotifiedRef = useRef<Record<string, number>>({})

  useEffect(() => {
    const unsub = window.api.onLogError((data) => {
      const key = data.trace_id || `${data.module}:${data.event}`
      const now = Date.now()
      const last = lastNotifiedRef.current[key]
      if (last && now - last < 5 * 60 * 1000) return

      lastNotifiedRef.current[key] = now
      notification.error({
        message: `${data.module} 模块错误`,
        description: data.message,
        duration: 6,
        placement: 'bottomRight',
        btn: (
          <Button size="small" type="primary" onClick={() => navigate('/logs')}>
            查看详情
          </Button>
        )
      })
    })
    return () => unsub?.()
  }, [navigate])

  return null
}
