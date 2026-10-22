/**
 * 入站鉴权失败的限速（2026-10-21 审查补，安全面专项）。
 *
 * ## 缺陷
 * 全仓**没有入站限流**（`gateway/throttle.ts` 是**出站**打上游的节奏层）。
 * 实测 200 个乱猜的 Bearer 并发打完只要 **179 ms**（≈1100 rps），
 * 全部 `401`、**无 429、无延时、无锁定**，而且每次都要
 * 一次 SHA-256 + 一次 DO/SQLite 查询。
 *
 * 两条利用路径：
 * 1. **在线爆破弱主密钥**：`API_KEY` 默认无长度/强度校验（只 `trim()`），
 *    人类可记的 `apikey123` 可以被在线撞开 ⇒ 管理面全失守；
 * 2. **无凭据即可打满 CPU + 数据库**（每请求一次哈希 + 一次查询），单容器直接 503。
 *
 * ## 为什么是「按 IP 计失败次数」而不是全局限流
 * 合法客户端在正常使用下**几乎不会**鉴权失败；限的是**失败**而非成功流量，
 * 所以对正常用户的误伤面最小，也不会因为某个大户刷量把所有人限住。
 *
 * ⚠️ 这是**单进程内存**实现，刻意不上分布式：本项目是单容器部署，
 * 上 Redis/DO 只会给攻击面加一跳依赖。代价是进程重启后计数清零——
 * 对爆破来说重启并不频繁，可接受。
 */

/** 统计窗口：1 分钟。 */
const WINDOW_MS = 60_000

/**
 * 窗口内允许的鉴权失败次数。
 *
 * 定 30 而不是 5：反代/NAT 后面常有一整个办公室共用出口 IP，
 * 有人配错 key 重试几次不该把同事一起锁在外面。
 * 而 30 次/分钟对爆破来说已经慢到没有意义（穷举 40 位 key 需要天文数字时间）。
 */
const MAX_FAILURES = 30

/** 上限保护：别让伪造源 IP 把这张表撑爆。 */
const MAX_TRACKED_IPS = 10_000

/** ip → 失败时刻列表（升序） */
const failures = new Map<string, number[]>()

function prune(list: number[], now: number): number[] {
  // 只用时间戳，不用定时器（Workers 里没有 setTimeout）
  const cutoff = now - WINDOW_MS
  let i = 0
  while (i < list.length && list[i]! < cutoff) i += 1
  return i === 0 ? list : list.slice(i)
}

/**
 * 该 IP 现在是否应被拒绝（**先查后记**：判定发生在处理请求之前）。
 *
 * 返回 `retryAfterMs` 供 `Retry-After` 头使用 —— 让客户端知道等多久，
 * 而不是盲目重试（盲目重试正是爆破的形态）。
 */
export function authBlocked(ip: string, now: number = Date.now()): { limited: boolean; retryAfterMs: number } {
  if (ip === '') return { limited: false, retryAfterMs: 0 }
  const list = failures.get(ip)
  if (list === undefined) return { limited: false, retryAfterMs: 0 }
  const live = prune(list, now)
  if (live.length !== list.length) failures.set(ip, live)
  if (live.length < MAX_FAILURES) return { limited: false, retryAfterMs: 0 }
  // 最早一次失败滑出窗口时即可恢复
  const oldest = live[0] ?? now
  return { limited: true, retryAfterMs: Math.max(1000, oldest + WINDOW_MS - now) }
}

/** 记一次鉴权失败。 */
export function noteAuthFailure(ip: string, now: number = Date.now()): void {
  if (ip === '') return
  if (failures.size > MAX_TRACKED_IPS) failures.clear()
  const list = prune(failures.get(ip) ?? [], now)
  list.push(now)
  failures.set(ip, list)
}

/**
 * 鉴权成功 ⇒ 清掉该 IP 的失败计数。
 *
 * ⚠️ 必须清：否则一个正在被同事爆破的出口 IP，会在攻击者撞够次数后
 * 把**拿着正确 key 的合法用户**一起锁住 —— 那是「防爆破」变成「拒绝服务」。
 */
export function noteAuthSuccess(ip: string): void {
  if (ip === '') return
  failures.delete(ip)
}

/** 仅供测试：清空状态。 */
export function resetAuthLimiter(): void {
  failures.clear()
}

export const AUTH_LIMIT_CONSTANTS = { WINDOW_MS, MAX_FAILURES } as const
