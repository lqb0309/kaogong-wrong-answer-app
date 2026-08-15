import { BrowserRouter } from 'react-router-dom'
import { App as AntdApp } from 'antd'
import { AppRouter } from './router'
import { ErrorToast } from './components/toast'
import { ErrorBoundary } from './components/error-boundary'

export function App() {
  return (
    <BrowserRouter>
      <AntdApp>
        <ErrorBoundary>
          <AppRouter />
        </ErrorBoundary>
        <ErrorToast />
      </AntdApp>
    </BrowserRouter>
  )
}
