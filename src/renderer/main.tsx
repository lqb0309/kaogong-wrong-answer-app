import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { App } from './App'
import { appTheme } from './theme'
import './index.css'
import 'katex/dist/katex.min.css'

// 渲染进程全局异常上报（PRD 埋点：未捕获异常 ERROR）
window.addEventListener('error', (e) => {
  window.api?.reportRendererError?.(`[window.onerror] ${e.message} @ ${e.filename || ''}:${e.lineno || 0}`).catch(() => {})
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = (e.reason as any)?.message || String(e.reason)
  window.api?.reportRendererError?.(`[unhandledrejection] ${reason}`).catch(() => {})
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={appTheme}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
