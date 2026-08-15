import { BrowserRouter } from 'react-router-dom'
import { App as AntdApp } from 'antd'
import { AppRouter } from './router'
import { ErrorToast } from './components/toast'

export function App() {
  return (
    <BrowserRouter>
      <AntdApp>
        <AppRouter />
        <ErrorToast />
      </AntdApp>
    </BrowserRouter>
  )
}
