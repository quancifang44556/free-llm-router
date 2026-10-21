/**
 * 消耗速率异常熔断（burn-rate breaker）。
 *
 * ## 为什么需要（不是「锦上添花」的监控）
 *
 * `AccountState.credits` 只是**一个快照**。快照只能回答「现在还剩多少」，
 * 回答不了「它掉得有多快」：
 *
 * | 场景 | 快照看到的东西 |
 * |---|---|
 * | 正常慢慢用 | 2870 → 2800 → 2760 … |
 * | 账号被盗用 / 某模型倍率异常高 | 2870 → 2296（5 分钟烧 20%） |
 *
 * 后者的**唯一**区别是「同样的数字掉得快」，快照上完全看不出来。等它掉到 0
 * 时积分已经**不可撤回**地烧掉了。故这里保留一小段采样史，用「窗口内消耗
 * 占窗口起点余额的比例」作为判据。
 *
 * ## 判据（刻意保守，只抓「确定异常」）
 *
 * - **只看下降**：余额增加（充值 / 签到 / 上游退款）绝不判为消耗；
 * - **分母取窗口起点余额**：`credits = 0` 时无从算比例，直接跳过（不做 0 除）；
 * - **窗口内不足 2 个采样**时无从比较，跳过；
 * - 达到或超过阈值 → 交给**现有软冷却**（`AccountPoolDO.applyFailure({kind:'soft'})`），
 *   不新造第二套惩罚态。这样「冷却到期自动恢复」「已在冷却中不延长」
 *   「面板显示原因」全都自动复用，不会出现两套机制互相打架。
 *
 * ## 采样上限为什么是 6
 *
 * 采样只由 `updateBalance` 追加（整点 cron + 面板手动刷新）。6 条足够覆盖
 * 默认 5 分钟窗口内每分钟一次的刷新，同时把每个账号的落盘体积钉死
 * （每条 `{at, credits}` 约 30 字节，6 条 ~180 字节）—— 账号状态是**整条
 * JSON 重写**的，无上限的采样史会让每次写入线性变贵。
 */

/**
 * 一条余额采样。
 *
 * ⚠️ 只有两个字段：采样时刻与该时刻的**可用总额**。
 * 刻意不存 `expiring` / `earliestExpiry` —— 判据只用总额，
 * 多存一份只会让「两个字段不一致」这种坏数据有机会出现。
 */
export interface BalanceSample {
  /** 采样时刻（epoch ms）。 */
  at: number
  /** 该时刻的可用总积分（已归一为 ≥0 的整数，与 `AccountState.credits` 同口径）。 */
  credits: number
}

/** 每个账号最多保留的采样条数（满则挤掉最旧的一条）。 */
export const BURN_SAMPLE_LIMIT = 6

/** 消耗速率判据的配置。 */
export interface BurnRateConfig {
  /** 观察窗口（ms）。`0` = 关闭检测。 */
  windowMs: number
  /** 触发阈值（百分比，如 `20` 表示窗口内消耗 ≥ 起点余额的 20%）。`0` = 关闭检测。 */
  thresholdPct: number
}

/**
 * 默认观察窗口：**1 小时**。
 *
 * ## ⚠️ 为什么不是 5 分钟（这条踩过）
 *
 * 采样的**唯一生产调用点**是 `AccountPoolDO.updateBalance`，而它只由
 * **整点 cron**（`wrangler.jsonc` 的 `0 * * * *`）和面板手动刷新触发。
 * 也就是说正常运行时**每小时才有一个采样点**。
 *
 * 若窗口设成 5 分钟 ⇒ 窗口内最多命中 1 个采样 ⇒ 比较基准恒等于当前值 ⇒
 * **检测永远休眠**：既不误报，也**完全不生效**（等于白写）。
 *
 * 设成 1 小时则恰好覆盖「相邻两个整点采样」，语义变成
 * 「这一小时烧掉了起点余额的 20% 以上」，才是真正能咬人的判据。
 *
 * ⚠️ 若要更细的粒度，必须**先给网关请求路径加采样点**，再缩小窗口 ——
 * 只改窗口不改采样频率，只会让检测重新失效。
 */
export const DEFAULT_BURN_RATE_WINDOW_MS = 60 * 60_000

/** 默认阈值：20%。 */
export const DEFAULT_BURN_RATE_THRESHOLD_PCT = 20

/** 一次判定命中的结果（供日志与测试断言；不含任何凭据）。 */
export interface BurnRateTrip {
  /** 窗口起点采样的时刻（epoch ms）。 */
  fromAt: number
  /** 窗口起点余额（分母）。 */
  fromCredits: number
  /** 最新采样的时刻（epoch ms），通常等于本次 `now`。 */
  toAt: number
  /** 最新余额。 */
  credits: number
  /** 窗口内消耗的积分（`fromCredits - credits`，恒 > 0）。 */
  burned: number
  /** 消耗占窗口起点余额的百分比。 */
  pct: number
  /** 实际生效的窗口长度（ms）。 */
  windowMs: number
}

/**
 * 追加一条采样（**不修改入参**，返回新数组）。
 *
 * - 按 `at` 升序（旧数据顺序不可信，且判定依赖「首/尾」）；
 * - 超过 {@link BURN_SAMPLE_LIMIT} 条时挤掉**最旧**的。
 */
export function appendBalanceSample(
  samples: readonly BalanceSample[],
  at: number,
  credits: number,
): BalanceSample[] {
  const next: BalanceSample[] = [...samples, { at, credits }]
  // 条数 ≤ 7，稳定排序足够；`at` 相同时保持插入顺序（新的在后）。
  next.sort((a, b) => a.at - b.at)
  return next.length > BURN_SAMPLE_LIMIT ? next.slice(-BURN_SAMPLE_LIMIT) : next
}

/**
 * 判断「窗口内消耗速率是否异常」。
 *
 * 命中返回 {@link BurnRateTrip}（供日志与测试），未命中返回 `undefined`。
 * **纯函数**：不改状态、不写日志、不碰存储 —— 副作用留给调用方（DO），
 * 这样判定本身可以脱离运行时被穷举测试。
 */
export function detectBurnRate(
  samples: readonly BalanceSample[],
  now: number,
  config: BurnRateConfig,
): BurnRateTrip | undefined {
  // 0 / 负数 = 关闭检测（见 `env.ts:resolveBurnRate`，那里保证不会把 0 换成默认值）。
  if (config.windowMs <= 0 || config.thresholdPct <= 0) return undefined
  if (samples.length < 2) return undefined

  // 只取窗口内的采样：窗口外的消耗已经「太旧」，拿来算会把慢速消耗误判成爆发。
  const cutoff = now - config.windowMs
  const inWindow = samples.filter((s) => s.at >= cutoff && s.at <= now)
  if (inWindow.length < 2) return undefined

  const first = inWindow[0]
  const last = inWindow[inWindow.length - 1]
  if (first === undefined || last === undefined) return undefined

  // 同一时刻的两次采样无法构成「速率」（分母为 0），跳过而不是判成 ∞。
  if (last.at <= first.at) return undefined

  // 分母必须为正：起点余额为 0 时任何比例都无意义（且会除零）。
  if (!(first.credits > 0)) return undefined

  const burned = first.credits - last.credits
  // ⚠️ `burned <= 0` 一律不判：余额增加是充值 / 签到 / 退款，不是消耗。
  if (burned <= 0) return undefined

  const pct = (burned / first.credits) * 100
  // 「达到或超过」阈值即命中：20% 就是 20%，不该要求 20.0001%。
  if (pct < config.thresholdPct) return undefined

  return {
    fromAt: first.at,
    fromCredits: first.credits,
    toAt: last.at,
    credits: last.credits,
    burned,
    pct: Math.round(pct * 10) / 10,
    windowMs: config.windowMs,
  }
}
