import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/misc'
import { cn } from '@/lib/utils'

const tones = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/12 text-danger',
  neutral: 'bg-muted text-muted-foreground',
}

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'neutral',
  loading,
  onClick,
  className,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon: LucideIcon
  tone?: keyof typeof tones
  loading?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <Card className={cn('p-4', onClick && 'hover:border-ring/40 cursor-pointer transition-colors', className)} onClick={onClick}>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-[13px]">{label}</span>
        <span className={cn('rounded-md p-1.5', tones[tone])}>
          <Icon className="size-3.5" strokeWidth={2.2} />
        </span>
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-7 w-16" />
      ) : (
        <div className="tabular mt-2 text-[26px] leading-tight font-semibold tracking-tight">{value}</div>
      )}
      {sub && <div className="text-muted-foreground mt-1 truncate text-xs">{sub}</div>}
    </Card>
  )
}
