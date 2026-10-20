import { Pin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { PinMode } from '@/lib/types'
import { cn } from '@/lib/utils'

export const PIN_META: Record<PinMode, { label: string; short: string; hint: string }> = {
  only: {
    label: '只用它',
    short: '只用它',
    hint: '该供应商的请求只走这个账号；它不可用时直接报错，不换号',
  },
  prefer: {
    label: '优先用它',
    short: '优先',
    hint: '该供应商的请求优先走这个账号；它不可用时自动换号',
  },
}

/** 「已指定」小徽章（账号名旁边）。 */
export function PinBadge({ mode, className }: { mode: PinMode; className?: string }) {
  return (
    <Badge tone="info" className={cn('h-[18px] gap-1 px-1.5 text-[11px]', className)} title={PIN_META[mode].hint}>
      <Pin className="size-3" strokeWidth={2.5} />
      {PIN_META[mode].short}
    </Badge>
  )
}
