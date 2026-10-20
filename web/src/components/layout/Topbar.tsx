import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, Menu as MenuIcon, Monitor, Moon, RefreshCw, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { useTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import type { NavItem } from './nav'

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]

export function Topbar({ item, onOpenNav }: { item: NavItem; onOpenNav: () => void }) {
  const qc = useQueryClient()
  const fetching = useIsFetching() > 0
  const { theme, resolved, setTheme } = useTheme()
  return (
    <header className="bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur-md lg:px-8">
      <Button variant="ghost" size="icon-sm" className="-ml-1 lg:hidden" onClick={onOpenNav} aria-label="打开导航">
        <MenuIcon />
      </Button>
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="text-muted-foreground hidden sm:inline">控制台</span>
        <span className="text-muted-foreground/60 hidden sm:inline">/</span>
        <span className="truncate font-medium">{item.label}</span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="刷新数据" title="刷新数据" onClick={() => qc.invalidateQueries()}>
          <RefreshCw className={cn(fetching && 'animate-spin')} />
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="切换主题" title="切换主题">
              {resolved === 'dark' ? <Moon /> : <Sun />}
            </Button>
          </MenuTrigger>
          <MenuContent>
            {THEMES.map((t) => (
              <MenuItem key={t.value} onSelect={() => setTheme(t.value)} active={theme === t.value}>
                <t.icon /> {t.label}
                {theme === t.value && <Check className="ml-auto" />}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="项目文档"
          title="项目文档"
          onClick={() => window.open('https://github.com/quancifang44556/free-llm-router#readme', '_blank', 'noopener')}
        >
          <BookOpen />
        </Button>
      </div>
    </header>
  )
}
