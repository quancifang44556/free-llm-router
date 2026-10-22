import type { Tone } from '@/components/ui/badge'
import type { Account } from './types'

export type AccountStatus = 'ok' | 'cooling' | 'breaker' | 'model' | 'restricted' | 'degraded' | 'disabled'

/**
 * 账号状态判定。
 *
 * ⚠️ **必须与后端 `healthy()` 的五个维度对齐**（2026-10-22 补齐）。
 *
 * 这里原先只有 `disabled / breaker / cooling / model` 四态，漏了：
 * - `restrictedUntil`（上游明确封号 11140）—— 后端据此拒发，面板却显示「正常」；
 * - `degradeUntil`（降权）—— 后端 `healthy()` 也把它当不可用。
 *
 * 后果：用户看到绿着「正常」的号，点下去一直失败，然后去查凭据、查网络。
 *
 * 顺序也有讲究：`restricted` 要在 `breaker` 之前（封号比熔断更「硬」，
 * 提示用户该去换号而不是等它恢复）；`degraded` 在 `breaker` 之后、
 * `cooling` 之前（它比普通冷却更需要解释）。
 */
export function accountStatus(a: Account, now = Date.now()): AccountStatus {
  if (a.disabled) return 'disabled'
  if ((a.restrictedUntil ?? 0) > now) return 'restricted'
  if (a.breakerUntil > now) return 'breaker'
  if ((a.degradeUntil ?? 0) > now) return 'degraded'
  if (a.until > now) return 'cooling'
  if (a.modelCooldowns?.some((m) => m.until > now)) return 'model'
  return 'ok'
}

export const STATUS_META: Record<AccountStatus, { label: string; tone: Tone }> = {
  ok: { label: '正常', tone: 'success' },
  cooling: { label: '冷却中', tone: 'warning' },
  breaker: { label: '熔断', tone: 'danger' },
  degraded: { label: '降权中', tone: 'warning' },
  model: { label: '模型限流', tone: 'warning' },
  restricted: { label: '上游封号', tone: 'danger' },
  disabled: { label: '已停用', tone: 'neutral' },
}
