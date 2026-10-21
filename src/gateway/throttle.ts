/**
 * 上游请求限速与随机抖动（防封的「节奏」层）。
 *
 * ## 为什么需要它
 *
 * 封禁复盘 P2「限速与抖动」：真人操作有停顿，agent 是连发。
 * 上游把「高频连发」并进机器行为画像，与「超大上下文」一起算。
 * 本项目此前**完全没有**这一层 —— 请求能多快发多快。
 *
 * ## 与「换号」的关系
 *
 * ⚠️ 限速是**按账号**（key = uid）而不是全局：
 * 全局 QPS 会把多账号池的总吞吐压到单账号水平，白白浪费池子；
 * 而上游风控看到的是**单个账号**的节奏，按账号限才对准判据。
 *
 * ## ⚠️ 已知限制（诚实记录）
 *
 * 状态在**进程内存**里（`Map`）。Node 单容器部署准确；
 * Cloudflare Workers 是多 isolate，每个 isolate 一份 ⇒ 只能算**尽力而为**，
 * 跨 isolate 的合并 QPS 会高于配置值。要精确就得放进 AccountPoolDO
 * （每次请求多一次 DO 往返），成本高于收益，故不做。
 */

/** 当前生效的限速参数（由网关按面板配置刷新）。 */
let qps = 0
let jitterMs = 0

/** 每个账号上一次「放行」的时刻。 */
const lastReleaseAt = new Map<string, number>()

/** 记忆条数上限：超过就整体清空，避免长期运行无限增长（账号池规模有限，清空代价可忽略）。 */
const MAX_KEYS = 4096

/**
 * 更新限速参数。
 *
 * ⚠️ `qps <= 0` 与 `jitterMs <= 0` 都是**合法关闭**，不能用 `||` 兜默认值。
 */
export function configureThrottle(next: { qps: number; jitterMs: number }): void {
  qps = Number.isFinite(next.qps) && next.qps > 0 ? next.qps : 0
  jitterMs = Number.isFinite(next.jitterMs) && next.jitterMs > 0 ? next.jitterMs : 0
}

/** 仅供测试：清空记忆。 */
export function resetThrottle(): void {
  qps = 0
  jitterMs = 0
  lastReleaseAt.clear()
}

/** 当前参数（供测试与日志）。 */
export function throttleParams(): { qps: number; jitterMs: number } {
  return { qps, jitterMs }
}

/** 可注入的 sleep，便于单测不真的等待。 */
export type Sleeper = (ms: number) => Promise<void>
const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 在上游请求**之前**调用：按账号排队，并按配置抖动。
 *
 * - 关闭时**立即返回**（连 `Date.now()` 都不取，零开销）；
 * - 抖动是**额外的**随机延迟，叠加在排队之后 —— 队列本身已经整形了节奏，
 *   抖动只是把「整间隔」打散，避免出现精确等距的机器特征。
 */
export async function throttleUpstream(
  key: string,
  sleep: Sleeper = realSleep,
  now: () => number = Date.now,
): Promise<void> {
  if (qps <= 0 && jitterMs <= 0) return

  if (qps > 0) {
    const minInterval = 1000 / qps
    const last = lastReleaseAt.get(key)
    if (last !== undefined) {
      const wait = last + minInterval - now()
      if (wait > 0) await sleep(wait)
    }
  }

  if (jitterMs > 0) await sleep(Math.random() * jitterMs)

  if (lastReleaseAt.size > MAX_KEYS) lastReleaseAt.clear()
  lastReleaseAt.set(key, now())
}
