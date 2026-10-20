import { LogOut, Route } from 'lucide-react'
import { usePool } from '@/lib/queries'
import type { View } from '@/lib/router'
import { cn } from '@/lib/utils'
import { NAV } from './nav'

export function Sidebar({ view, onNavigate, onLogout }: { view: View; onNavigate: (v: View) => void; onLogout: () => void }) {
  const pool = usePool()
  const c = pool.data
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg shadow-sm">
          <Route className="size-[18px]" strokeWidth={2.2} />
        </div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[14px] font-semibold">free-llm-router</div>
          <div className="text-muted-foreground text-[11px]">控制台 · v{__APP_VERSION__}</div>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="text-muted-foreground/80 mb-1.5 px-2 text-[11px] font-medium tracking-wide">{g.group}</div>
            <div className="space-y-0.5">
              {g.items.map((it) => {
                const active = it.view === view
                return (
                  <button
                    key={it.view}
                    onClick={() => onNavigate(it.view)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors',
                      active ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <it.icon className="size-4 shrink-0" strokeWidth={active ? 2.2 : 1.9} />
                    <span className="truncate">{it.label}</span>
                    {it.view === 'providers' && c && c.cooling + c.disabled > 0 && (
                      <span className="bg-warning/15 text-warning ml-auto rounded-full px-1.5 text-[11px] font-medium">{c.cooling + c.disabled}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="space-y-2 border-t p-3">
        <div className="bg-muted/60 rounded-lg px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            <span className="relative flex size-2">
              <span className="bg-success absolute inline-flex size-full animate-ping rounded-full opacity-50" />
              <span className="bg-success relative inline-flex size-2 rounded-full" />
            </span>
            网关运行中
          </div>
          <div className="text-muted-foreground mt-1 text-[11.5px]">{c ? `${c.healthy} / ${c.total} 个账号可用` : '正在读取账号池…'}</div>
        </div>
        <button
          onClick={onLogout}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px]"
        >
          <LogOut className="size-4" /> 退出登录
        </button>
      </div>
    </div>
  )
}
