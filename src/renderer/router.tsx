import { Routes, Route, Navigate } from 'react-router-dom'
import { AppLayout } from './components/app-layout'
import { HomePage } from './pages/home'
import { PendingPage } from './pages/pending'
import { QuestionBankPage } from './pages/question-bank'
import { StatsPage } from './pages/stats'
import { TagManagerPage } from './pages/tag-manager'
import { LogViewerPage } from './pages/log-viewer'
import { SettingsPage } from './pages/settings'
import { ManualEntryPage } from './pages/manual-entry'
import { KnowledgePage } from './pages/knowledge'
import { TestBuilderPage } from './pages/test-builder'

export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/pending" element={<PendingPage />} />
        <Route path="/questions" element={<QuestionBankPage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/tags" element={<TagManagerPage />} />
        <Route path="/logs" element={<LogViewerPage />} />
        <Route path="/manual" element={<ManualEntryPage />} />
        <Route path="/test-builder" element={<TestBuilderPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
