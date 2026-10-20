import type { Tone } from '@/components/ui/badge'
import type { Account } from './types'

export type AccountStatus = 'ok' | 'cooling' | 'breaker' | 'model' | 'disabled'

export function accountStatus(a: Account, now = Date.now()): AccountStatus {
  if (a.disabled) return 'disabled'
  if (a.breakerUntil > now) return 'breaker'
  if (a.until > now) return 'cooling'
  if (a.modelCooldowns?.some((m) => m.until > now)) return 'model'
  return 'ok'
}

export const STATUS_META: Record<AccountStatus, { label: string; tone: Tone }> = {
  ok: { label: '正常', tone: 'success' },
  cooling: { label: '冷却中', tone: 'warning' },
  breaker: { label: '熔断', tone: 'danger' },
  model: { label: '模型限流', tone: 'warning' },
  disabled: { label: '已停用', tone: 'neutral' },
}
