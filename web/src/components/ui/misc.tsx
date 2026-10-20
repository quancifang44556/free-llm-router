import type { HTMLAttributes, ReactNode } from 'react'
import { cn, providerHue } from '@/lib/utils'

export const Skeleton = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('bg-muted animate-pulse rounded-md', className)} {...p} />
)

/** 分段选择器（时间窗口、过滤器）。 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  className?: string
}) {
  return (
    <div className={cn('bg-muted inline-flex h-9 items-center rounded-lg p-1', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 cursor-pointer rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors',
            o.value === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ProviderAvatar({ id, name, size = 'md' }: { id: string; name: string; size?: 'sm' | 'md' }) {
  const h = providerHue(id)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-semibold',
        size === 'sm' ? 'size-6 text-[11px]' : 'size-9 text-sm',
      )}
      style={{
        background: `oklch(0.62 0.15 ${h} / 0.14)`,
        color: `oklch(0.55 0.17 ${h})`,
      }}
    >
      {name
        .replace(/[^A-Za-z\u4e00-\u9fa5]/g, '')
        .slice(0, 1)
        .toUpperCase()}
    </span>
  )
}

export function Progress({
  value,
  tone = 'primary',
  className,
}: {
  value: number
  tone?: 'primary' | 'success' | 'warning' | 'danger'
  className?: string
}) {
  const bg = {
    primary: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
  }[tone]
  return (
    <div className={cn('bg-muted h-1.5 w-full overflow-hidden rounded-full', className)}>
      <div className={cn('h-full rounded-full transition-[width]', bg)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="bg-muted text-muted-foreground mb-3 rounded-xl p-3 [&_svg]:size-5">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <div className="text-muted-foreground mt-1 max-w-sm text-[13px]">{children}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="bg-muted text-muted-foreground rounded border px-1.5 font-mono text-[11px]">{children}</kbd>
}
