import { lazy, Suspense, type ReactNode } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import { AppLayout } from './components/app-layout'

// 路由级代码分割：按页面拆包，首屏只加载首页，提升启动速度
const HomePage = lazy(() => import('./pages/home').then(m => ({ default: m.HomePage })))
const PendingPage = lazy(() => import('./pages/pending').then(m => ({ default: m.PendingPage })))
const QuestionBankPage = lazy(() => import('./pages/question-bank').then(m => ({ default: m.QuestionBankPage })))
const StatsPage = lazy(() => import('./pages/stats').then(m => ({ default: m.StatsPage })))
const TagManagerPage = lazy(() => import('./pages/tag-manager').then(m => ({ default: m.TagManagerPage })))
const LogViewerPage = lazy(() => import('./pages/log-viewer').then(m => ({ default: m.LogViewerPage })))
const SettingsPage = lazy(() => import('./pages/settings').then(m => ({ default: m.SettingsPage })))
const ManualEntryPage = lazy(() => import('./pages/manual-entry').then(m => ({ default: m.ManualEntryPage })))
const KnowledgePage = lazy(() => import('./pages/knowledge').then(m => ({ default: m.KnowledgePage })))
const TestBuilderPage = lazy(() => import('./pages/test-builder').then(m => ({ default: m.TestBuilderPage })))

function lazyPage(node: ReactNode) {
  return (
    <Suspense fallback={
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <Spin size="large" />
      </div>
    }>
      {node}
    </Suspense>
  )
}

export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={lazyPage(<HomePage />)} />
        <Route path="/pending" element={lazyPage(<PendingPage />)} />
        <Route path="/questions" element={lazyPage(<QuestionBankPage />)} />
        <Route path="/stats" element={lazyPage(<StatsPage />)} />
        <Route path="/knowledge" element={lazyPage(<KnowledgePage />)} />
        <Route path="/tags" element={lazyPage(<TagManagerPage />)} />
        <Route path="/logs" element={lazyPage(<LogViewerPage />)} />
        <Route path="/manual" element={lazyPage(<ManualEntryPage />)} />
        <Route path="/test-builder" element={lazyPage(<TestBuilderPage />)} />
        <Route path="/settings" element={lazyPage(<SettingsPage />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
