import { Component, type ReactNode } from 'react'
import { Button, Result, Space } from 'antd'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
}

/**
 * 全局错误边界：防止单个页面异常导致整个应用白屏。
 * 捕获到错误时上报主进程日志（PRD 埋点：未捕获异常 ERROR）。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(err: any): State {
    return { hasError: true, message: err?.message || '未知错误' }
  }

  componentDidCatch(err: any, info: any) {
    const detail = `${err?.stack || err?.message || 'Unknown error'}\n${info?.componentStack || ''}`
    window.api?.reportRendererError?.(detail.slice(0, 2000)).catch(() => {})
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f5f7fa' }}>
          <Result
            status="error"
            title="页面出错了"
            subTitle={this.state.message}
            extra={
              <Space>
                <Button type="primary" onClick={() => { this.setState({ hasError: false }); window.location.reload() }}>
                  重新加载
                </Button>
                <Button onClick={() => { this.setState({ hasError: false }) }}>返回上一页</Button>
              </Space>
            }
          />
        </div>
      )
    }
    return this.props.children
  }
}
