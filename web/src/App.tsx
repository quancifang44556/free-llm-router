import { useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { NAV_ITEMS } from '@/components/layout/nav'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { Sheet } from '@/components/ui/dialog'
import { auth } from '@/lib/api'
import { useView, type View } from '@/lib/router'
import { useTheme } from '@/lib/theme'
import { ApiKeysPage } from '@/pages/ApiKeysPage'
import { LoginPage } from '@/pages/LoginPage'
import { LogsPage } from '@/pages/LogsPage'
import { ProvidersPage } from '@/pages/providers/ProvidersPage'
// 图表库较大，用量页按需加载
const UsagePage = lazy(() => import('@/pages/UsagePage').then((m) => ({ default: m.UsagePage })))
const TasksPage = lazy(() => import('@/pages/TasksPage').then((m) => ({ default: m.TasksPage })))
const ModelsPage = lazy(() => import('@/pages/ModelsPage').then((m) => ({ default: m.ModelsPage })))
const ConfigPage = lazy(() => import('@/pages/ConfigPage').then((m) => ({ default: m.ConfigPage })))

export function App() {
  const [authed, setAuthed] = useState(() => !!auth.get())
  const { resolved } = useTheme()
  const qc = useQueryClient()

  useEffect(() => {
    const on = () => {
      auth.clear()
      qc.clear()
      setAuthed(false)
    }
    window.addEventListener('auth:expired', on)
    return () => window.removeEventListener('auth:expired', on)
  }, [qc])

  const logout = () => {
    auth.clear()
    qc.clear()
    setAuthed(false)
  }

  return (
    <>
      {authed ? <Shell onLogout={logout} /> : <LoginPage onLogin={() => setAuthed(true)} />}
      <Toaster theme={resolved} position="bottom-right" richColors closeButton />
    </>
  )
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useView()
  const [navOpen, setNavOpen] = useState(false)
  const item = NAV_ITEMS.find((i) => i.view === view)!
  const go = (v: View) => {
    setView(v)
    setNavOpen(false)
    window.scrollTo({ top: 0 })
  }

  return (
    <div className="min-h-dvh lg:pl-60">
      <aside className="bg-sidebar fixed inset-y-0 left-0 z-40 hidden w-60 border-r lg:block">
        <Sidebar view={view} onNavigate={go} onLogout={onLogout} />
      </aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen} title="导航" side="left" className="bg-sidebar">
        <Sidebar view={view} onNavigate={go} onLogout={onLogout} />
      </Sheet>

      <Topbar item={item} onOpenNav={() => setNavOpen(true)} />
      <main className="mx-auto max-w-[1400px] px-4 py-6 lg:px-8 lg:py-8">
        {view === 'providers' && <ProvidersPage />}
        {view === 'apikeys' && <ApiKeysPage />}
        {view === 'logs' && <LogsPage />}
        <Suspense fallback={null}>
          {view === 'usage' && <UsagePage />}
          {view === 'tasks' && <TasksPage />}
          {view === 'models' && <ModelsPage />}
          {view === 'config' && <ConfigPage />}
        </Suspense>
      </main>
    </div>
  )
}
