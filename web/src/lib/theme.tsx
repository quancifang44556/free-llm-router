import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'system'
const KEY = 'wb_theme'
const media = matchMedia('(prefers-color-scheme: dark)')

function read(): Theme {
  const t = localStorage.getItem(KEY)
  return t === 'light' || t === 'dark' ? t : 'system' // 兼容旧面板存的 'auto'
}

const Ctx = createContext<{
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
} | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(read)
  const [systemDark, setSystemDark] = useState(media.matches)

  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    media.addEventListener('change', on)
    return () => media.removeEventListener('change', on)
  }, [])

  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
  }, [resolved])

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(KEY, t)
    setThemeState(t)
  }, [])

  return <Ctx.Provider value={{ theme, resolved, setTheme }}>{children}</Ctx.Provider>
}

export function useTheme() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return v
}
