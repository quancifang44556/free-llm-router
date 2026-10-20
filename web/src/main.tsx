import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ThemeProvider } from './lib/theme'
import './index.css'

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // 401 不重试（口令错了重试也没用），其余错误重试 1 次
      retry: (n, e) => (e as { status?: number }).status !== 401 && n < 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
