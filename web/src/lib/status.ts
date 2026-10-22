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

/**
 * 「还要等多久」：把剩余时长压成一句话，给「11/22 12:30恢复（还剩 7 分钟）」用。
 *
 * ## 为什么补这个函数（P1：产物领先于源码）
 *
 * 线上产物（`src/panel/web/assets/index-*.js.txt`）的账号表一直显示倒计时
 *（产物里的 `wbRemain`/`wbLeft` 是手写进去的），`web/src` 里没有 ——
 * 谁跑一次 `npm run build:web`，倒计时就消失。本轮把它补回源码。
 *
 * ⚠️ 与 `fmtRelative` 的分工：`fmtRelative` 表达「过去/未来都可能是」的相对时刻
 *（「3 分钟前」「12 分钟后」），用于「最近成功」这类字段；这里只表达
 *「还要等多久」，且**到点必须回空串** —— 否则会拼出「恢复（还剩 -3 分钟）」
 * 这种自相矛盾的提示，而它偏偏会出现在**已经恢复**的行上。
 *
 * ## ⚠️ 为什么放在 status.ts 而不是 utils.ts
 *
 * `utils.ts` 顶层 `import { clsx } from 'clsx'`（为了 `cn()`），而
 * **部署/单测流程不安装前端依赖**（README：「部署时不需要装前端依赖」，
 * 只有 `cd web && npm install` 之后 `web/node_modules` 才存在）。
 * 单测要能直接 import 本文件来钉住边界值，故这里**只能有类型导入** ——
 * 与 `lib/dsh.ts` 开头那条「本文件要能被网关单测直接打包」是同一条纪律。
 */
export function fmtRemaining(until: number, now = Date.now()): string {
  if (!until || until <= now) return ''
  const totalSec = Math.ceil((until - now) / 1000)
  if (totalSec < 60) return `${totalSec} 秒`
  // 向上取整到分钟：剩 61 秒说「2 分钟」而不是「1 分钟」，宁可让用户多等一会儿
  const totalMin = Math.ceil(totalSec / 60)
  if (totalMin < 60) return `${totalMin} 分钟`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/**
 * 「什么时候恢复、还剩多久」—— 账号行状态下面那行小字。
 *
 * ## 为什么放在这里而不是页面里（P1 收尾，2026-10-22）
 *
 * 原来它是 `ProvidersPage` 内部的私有函数，测试只能断言「函数体里出现过哪几个字段名」——
 * 复核者把实现换成产物那套 `Math.max(...)` 之后，**7 条断言仍然全绿**。
 * 也就是说：那条测试根本没钉住「按当前状态取各自截止时刻」这个**核心决策**。
 *
 * 挪成纯函数后可以直接喂数据断言结果，这个决策才真正被锁住。
 *
 * ## ⚠️ 不照抄产物的 `Math.max(...)` 口径
 *
 * 产物的 `wbUntil` 是 `max(until, breakerUntil, restrictedUntil, modelCooldowns)`。
 * 但一个号可能**同时**「上游封号 5 分钟后解除」与「降权 30 分钟后解除」，
 * 取 max 会让封号那行写成 30 分钟 —— 用户照着等就白等 25 分钟。
 * 故按**当前状态对应的那个截止时刻**算；只有熔断/冷却（都是账号级、
 * 且都会挡住选号）才取两者较晚者。
 *
 * ## ⚠️ 为什么不写「7 分钟后恢复（还剩 7 分钟）」
 *
 * 那两半由不同函数算（`fmtRelative` 四舍五入、`fmtRemaining` 向上取整），
 * 截止时刻在 7 分 01 秒后会渲染成「7 分钟后恢复（还剩 8 分钟）」——
 * 同一句话里两个数字打架，用户不知道该信哪个。只留倒计时，信息不重复也不矛盾。
 */
export function recoveryText(a: Account, s: AccountStatus, now = Date.now()): string {
  const until =
    s === 'restricted'
      ? (a.restrictedUntil ?? 0)
      : s === 'degraded'
        ? (a.degradeUntil ?? 0)
        : s === 'breaker'
          ? Math.max(a.until, a.breakerUntil)
          : s === 'cooling'
            ? a.until
            : s === 'model'
              ? Math.max(0, ...(a.modelCooldowns ?? []).map((m) => m.until))
              : 0
  // 截止时刻已过 ⇒ 空串（不显示「恢复（还剩 -3 分钟）」这种反话）
  if (!(until > now)) return ''
  const left = fmtRemaining(until, now)
  return left === '' ? '' : `恢复（还剩 ${left}）`
}
