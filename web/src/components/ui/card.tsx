import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type P = HTMLAttributes<HTMLDivElement>

export const Card = ({ className, ...p }: P) => <div className={cn('bg-card rounded-xl border shadow-xs', className)} {...p} />
export const CardHeader = ({ className, ...p }: P) => (
  <div className={cn('flex items-start justify-between gap-4 px-5 pt-5 pb-3', className)} {...p} />
)
export const CardTitle = ({ className, ...p }: P) => <div className={cn('text-[15px] leading-none font-semibold', className)} {...p} />
export const CardDescription = ({ className, ...p }: P) => <div className={cn('text-muted-foreground mt-1.5 text-[13px]', className)} {...p} />
export const CardContent = ({ className, ...p }: P) => <div className={cn('px-5 pb-5', className)} {...p} />
