/**
 * 用量统计（明细环形缓冲 + **按天聚合**，支持时间窗）。
 *
 * ## 🔴 为什么必须有「按天聚合」（实测缺陷）
 *
 * 用户报「这个用量怎么始终是 500 不动」。
 *
 * 那不是 HTTP 500 —— 是 `total` **撞上了明细环形缓冲的上限**
 *（`USAGE_RING_SIZE = 500`）。而此前的实现**只有这一份明细**，
 * 于是无论用多久、用多少，概览永远显示 500：
 *
 * - 问「今天用了多少」→ 答不出来（环里混着跨天的历史条目）；
 * - 问「本周/本月用了多少」→ 更答不出来（更早的条目已被删除）。
 *
 * ⇒ 拆成**两份独立数据**（对齐参考实现 `token-ledger.ts` 的取舍）：
 *
 * | 数据 | 作用 | 保留 |
 * |---|---|---|
 * | 明细环 `ring` | 「每一笔长什么样」（最近的请求） | 最近 {@link USAGE_RING_SIZE} 条 |
 * | 按天聚合 `days` | 「今天/本周/本月用了多少」 | {@link USAGE_DAYS_KEPT} 天 |
 *
 * ⚠️ **两者不是冗余**：聚合是**只增不减**的计数（跨天保留），而明细会被淘汰。
 * 用明细去算「近 30 天」在超过 500 笔之后必然偏小。
 *
 * ## 存储：**一个 key** 装两份数据（不增加每笔请求的写次数）
 *
 * 参考实现是 Node 进程，可以「2 秒防抖落盘」。Workers **没有跨请求后台执行**，
 * 且 `recordUsage` 在推理的关键路径上（`ctx.waitUntil`），故不能引入定时器。
 *
 * ⇒ 把 `{ ring, days }` 一起放在**同一个 storage key**（`usage:state`）里：
 * `recordUsage` 仍是**一次读 + 一次写**，与改造前**完全相同的写入成本**。
 * 若拆成两个 key，每笔请求就要写两次 —— 白白翻倍 DO 行写入配额消耗。
 *
 * ## 兼容旧数据
 *
 * 旧版只写了 `usage:ring`（一个裸数组）。{@link migrateUsageState} 会在读不到
 * 新 key 时把它读进来并**回放成按天聚合** —— 用户已有的历史不会凭空消失。
 */

/** 一条用量明细记录。 */
export interface UsageRecord {
  /** 时刻（epoch ms）。 */
  at: number
  /** 账号 uid。 */
  uid: string
  /** 模型 id。 */
  model: string
  /** 输入 token。 */
  input: number
  /** 输出 token。 */
  output: number
  /** 是否成功。 */
  ok: boolean
  /** 失败时的错误类别。 */
  errorKind?: string
  /** 耗时（毫秒）。 */
  ms: number
}

/** 环形缓冲的最大长度（保留最近多少条明细）。 */
export const USAGE_RING_SIZE = 500

/**
 * 按天聚合的保留天数。
 *
 * ⚠️ 取 90 与参考实现（`token-ledger-store.ts` 的 `TOKEN_LEDGER_DAYS = 90`）一致：
 * 「看看历史」的诉求远小于无限增长。超出即淘汰最旧的日键。
 */
export const USAGE_DAYS_KEPT = 90

/** 维度小计（按模型 / 按账号共用形状）。 */
export interface UsageDim {
  count: number
  input: number
  output: number
  failed: number
}

/** 某一天里某个小时的计数（只用于「今日」的按小时趋势）。 */
export interface UsageHour {
  count: number
  failed: number
}

/**
 * **一天的聚合**。
 *
 * ⚠️ 只存**累加量**（count/input/output/…），不存明细 —— 这是它能跨天保留、
 * 而明细环不能的原因。
 */
export interface UsageDay {
  /** 请求数。 */
  count: number
  /** 成功数。 */
  ok: number
  /** 失败数。 */
  failed: number
  /** 输入 token 合计。 */
  input: number
  /** 输出 token 合计。 */
  output: number
  /** 耗时合计（用于算日均；**存合计而不是均值**，否则无法与别的天合并）。 */
  msSum: number
  /** 按模型 —— 键是模型 id。 */
  byModel: Record<string, UsageDim>
  /** 按账号 —— 键是 uid。 */
  byAccount: Record<string, UsageDim>
  /** 按小时 —— 键是 `HH:00`（UTC+8）。 */
  byHour: Record<string, UsageHour>
}

/** 用量存储的完整状态（**一个 key** 装两份数据，见文件头说明）。 */
export interface UsageState {
  /** 最近 {@link USAGE_RING_SIZE} 条明细（新在后）。 */
  ring: UsageRecord[]
  /** 按天聚合，键是 UTC+8 的 `YYYY-MM-DD`。 */
  days: Record<string, UsageDay>
}

/** 空状态。 */
export function emptyUsageState(): UsageState {
  return { ring: [], days: {} }
}

/** 一整天里的某个小时桶标签（`HH:00`，UTC+8）。 */
export function hourKeyUtc8(at: number): string {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  const d = new Date(at + CST_OFFSET)
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`
}

/**
 * **UTC+8 日键**（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术**换算（`ts + 8h` 后取 UTC 日期），**绝不能**用
 * `Date.setHours` 等本机时区方法 —— 与项目其它模块（签到日界、夜猫子窗口）
 * 同一条纪律：各渠道的每日额度都按 UTC+8 结算，本机时区不同（出差/改设置）
 * 会算错日界。而 Workers 恒为 UTC，用本机时区方法会直接偏 8 小时。
 */
export function utc8DayKey(at: number): string {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  const d = new Date(at + CST_OFFSET)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mm}-${dd}`
}

/** 取（或建）某一天的聚合桶。 */
function dayOf(state: UsageState, day: string): UsageDay {
  const hit = state.days[day]
  if (hit !== undefined) return hit
  const fresh: UsageDay = {
    count: 0, ok: 0, failed: 0, input: 0, output: 0, msSum: 0,
    byModel: {}, byAccount: {}, byHour: {},
  }
  state.days[day] = fresh
  return fresh
}

/** 累加一个维度小计（就地改）。 */
function addDim(map: Record<string, UsageDim>, key: string, r: UsageRecord): void {
  const d = map[key] ?? { count: 0, input: 0, output: 0, failed: 0 }
  d.count += 1
  d.input += r.input
  d.output += r.output
  if (!r.ok) d.failed += 1
  map[key] = d
}

/** 淘汰过老的日键（就地改）。返回删掉的个数。 */
export function pruneUsageDays(state: UsageState, now: number): number {
  const keys = Object.keys(state.days)
  if (keys.length <= USAGE_DAYS_KEPT) return 0
  // 日键是 `YYYY-MM-DD`（字典序安全）⇒ 直接排序取最新 N 个。
  const keep = new Set(keys.sort((a, b) => b.localeCompare(a)).slice(0, USAGE_DAYS_KEPT))
  let removed = 0
  for (const k of keys) {
    if (!keep.has(k)) { delete state.days[k]; removed += 1 }
  }
  // ⚠️ 顺带挡掉「未来日键」（时钟回拨 / 手工编辑）——它们会让窗口过滤失效。
  const today = utc8DayKey(now)
  for (const k of Object.keys(state.days)) {
    if (k > today) { delete state.days[k]; removed += 1 }
  }
  return removed
}

/**
 * 把一条记录记进状态（就地改）。**纯内存操作**，不碰存储。
 *
 * ⚠️ 明细环与按天聚合**必须一起更新** —— 只更新一个会让两个视图对不上，
 * 而用户看到的是「概览说 300 笔、明细只列 12 条」这种自相矛盾的界面。
 */
export function recordUsageInto(state: UsageState, r: UsageRecord, now: number = r.at): void {
  // ① 明细环
  state.ring.push(r)
  if (state.ring.length > USAGE_RING_SIZE) {
    state.ring = trimUsageRing(state.ring)
  }

  // ② 按天聚合
  const day = dayOf(state, utc8DayKey(r.at))
  day.count += 1
  if (r.ok) day.ok += 1
  else day.failed += 1
  day.input += r.input
  day.output += r.output
  day.msSum += r.ms
  addDim(day.byModel, r.model, r)
  addDim(day.byAccount, r.uid, r)
  const hk = hourKeyUtc8(r.at)
  const h = day.byHour[hk] ?? { count: 0, failed: 0 }
  h.count += 1
  if (!r.ok) h.failed += 1
  day.byHour[hk] = h

  pruneUsageDays(state, now)
}

/** 一行时间趋势（按天）。 */
export interface UsageTrendBar {
  /** 日键（`YYYY-MM-DD`，UTC+8）。 */
  day: string
  count: number
  failed: number
  input: number
  output: number
  /** 该日 token 合计（= input + output），画柱高直接用。 */
  tokens: number
}

/** 时间窗口聚合结果。 */
export interface UsageSummary {
  /** 总请求数（**当前窗口内**，不再被 500 封顶）。 */
  total: number
  /** 成功数。 */
  ok: number
  /** 失败数。 */
  failed: number
  /** 输入 / 输出 token 合计。 */
  inputTokens: number
  outputTokens: number
  /** 平均耗时（毫秒）。 */
  avgMs: number
  /** 按模型聚合（降序）。 */
  byModel: Array<{ model: string; count: number; input: number; output: number; failed: number }>
  /** 按账号聚合（降序）。 */
  byAccount: Array<{ uid: string; count: number; input: number; output: number; failed: number }>
  /** 按小时聚合（**仅「今日」窗口有意义**；更长窗口请看 `byDay`）。 */
  byHour: Array<{ hour: string; count: number; failed: number }>
  /** 按天趋势（新在前），用于画柱状图。 */
  byDay: UsageTrendBar[]
  /** 本次窗口的天数（0 = 全部）。 */
  windowDays: number
  /** 窗口内实际有数据的天数。 */
  activeDays: number
  /**
   * 明细环里的最早时刻（0 = 无记录）。
   *
   * ⚠️ 与「窗口起点」**不是一回事**：窗口可以比明细环长得多
   *（明细只留 500 条，聚合留 90 天）。展示层要能区分这两者。
   */
  since: number
  /** 明细环当前长度（用于提示「明细只保留最近 N 条」）。 */
  detailCount: number
  /** 明细环是否已满（满了就说明更早的**明细**已不可见，但聚合仍在）。 */
  detailCapped: boolean
}

/** 降序排序（按 count）。 */
function descByCount<T extends Record<string, UsageDim>>(
  map: T,
  keyOf: (k: string) => { model?: string; uid?: string },
): Array<UsageDim & { model?: string; uid?: string }> {
  return Object.entries(map)
    .map(([k, v]) => ({ ...keyOf(k), ...v }))
    .sort((a, b) => b.count - a.count)
}

/**
 * 把窗口内的天数换算成**起步日键**（含端点）。
 *
 * @param windowDays - 1 = 仅今日；7 = 今日 + 前 6 天；0/负数/非数 = 全部（返回 undefined）。
 */
export function windowStartDayKey(windowDays: number, now: number): string | undefined {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return undefined
  const days = Math.floor(windowDays)
  // ⚠️ 传**原始**时刻给 `utc8DayKey`（它自己会 +8h 平移）。
  // 先平移再传会让 cutoff 又多 8 小时 ⇒ cutoff 落到「明天」⇒ 连今天都被裁掉。
  return utc8DayKey(now - (days - 1) * 24 * 60 * 60 * 1000)
}

/**
 * 按**时间窗口**聚合状态（纯函数，便于单测）。
 *
 * ⚠️ 汇总走**按天聚合**而不是明细环 —— 后者只有最近 500 条，
 * 拿它算「近 30 天」在超过 500 笔之后必然偏小（这正是用户报的那个缺陷）。
 *
 * @param windowDays - 1 = 今日；7 = 近 7 天（含今天）；30 = 近 30 天；0 = 全部。
 */
export function summarizeUsageState(
  state: UsageState,
  windowDays: number,
  now: number = Date.now(),
): UsageSummary {
  const cutoff = windowStartDayKey(windowDays, now)
  const todayKey = utc8DayKey(now)

  const byModel: Record<string, UsageDim> = {}
  const byAccount: Record<string, UsageDim> = {}
  const byHour: Record<string, UsageHour> = {}

  let total = 0
  let ok = 0
  let failed = 0
  let inputTokens = 0
  let outputTokens = 0
  let msSum = 0

  // 日键降序（新在前）——`YYYY-MM-DD` 字典序即时间序。
  const dayKeys = Object.keys(state.days)
    .filter((d) => d <= todayKey)                 // 未来键不展示、不入合计
    .filter((d) => cutoff === undefined || d >= cutoff)
    .sort((a, b) => b.localeCompare(a))

  const byDay: UsageTrendBar[] = []
  let activeDays = 0

  for (const day of dayKeys) {
    const b = state.days[day]
    if (b === undefined) continue
    activeDays += 1
    total += b.count
    ok += b.ok
    failed += b.failed
    inputTokens += b.input
    outputTokens += b.output
    msSum += b.msSum

    for (const [k, v] of Object.entries(b.byModel)) {
      const cur = byModel[k] ?? { count: 0, input: 0, output: 0, failed: 0 }
      cur.count += v.count; cur.input += v.input; cur.output += v.output; cur.failed += v.failed
      byModel[k] = cur
    }
    for (const [k, v] of Object.entries(b.byAccount)) {
      const cur = byAccount[k] ?? { count: 0, input: 0, output: 0, failed: 0 }
      cur.count += v.count; cur.input += v.input; cur.output += v.output; cur.failed += v.failed
      byAccount[k] = cur
    }
    // ⚠️ 按小时只对**今日**有意义：跨天的小时标签会互相覆盖（如两个不同的
    // 「09:00」），合并起来没有任何解释力。更长窗口请看 `byDay`。
    if (day === todayKey) {
      for (const [k, v] of Object.entries(b.byHour)) {
        const cur = byHour[k] ?? { count: 0, failed: 0 }
        cur.count += v.count; cur.failed += v.failed
        byHour[k] = cur
      }
    }

    byDay.push({
      day,
      count: b.count,
      failed: b.failed,
      input: b.input,
      output: b.output,
      tokens: b.input + b.output,
    })
  }

  // 明细环里最早的时刻（用于「明细从何时起」的提示）
  let since = 0
  for (const r of state.ring) {
    if (since === 0 || r.at < since) since = r.at
  }

  return {
    total,
    ok,
    failed,
    inputTokens,
    outputTokens,
    avgMs: total === 0 ? 0 : Math.round(msSum / total),
    byModel: descByCount(byModel, (m) => ({ model: m })) as UsageSummary['byModel'],
    byAccount: descByCount(byAccount, (u) => ({ uid: u })) as UsageSummary['byAccount'],
    byHour: Object.entries(byHour)
      .map(([hour, v]) => ({ hour, ...v }))
      // 小时标签 `HH:00` 是定宽零填充 ⇒ 字典序即时间序。
      .sort((a, b) => a.hour.localeCompare(b.hour)),
    byDay,
    windowDays: Number.isFinite(windowDays) ? Math.floor(windowDays) : 0,
    activeDays,
    since,
    detailCount: state.ring.length,
    detailCapped: state.ring.length >= USAGE_RING_SIZE,
  }
}

/**
 * 截断到环形缓冲上限（保留**最新**的 N 条）。
 *
 * ⚠️ 必须按时间排序后再截断：写入顺序未必等于时间顺序（并发请求完成有先后），
 * 直接 `slice(-N)` 有可能丢掉更新的记录而留下旧的。
 */
export function trimUsageRing(records: UsageRecord[], limit = USAGE_RING_SIZE): UsageRecord[] {
  if (records.length <= limit) return records
  return [...records].sort((a, b) => a.at - b.at).slice(-limit)
}

/**
 * 把**只有明细环**的旧数据迁移成完整状态。
 *
 * 旧版把裸数组存在 `usage:ring`，没有按天聚合。迁移时按天回放，
 * 使用户已有的历史不会因为升级而凭空消失。
 *
 * ⚠️ 回放出的聚合**只覆盖被保留的那 500 条**（更早的明细本来就已经丢了）——
 * 这是旧数据的固有限制，不是迁移引入的损失。故迁移后 `detailCapped`
 * 通常为真，界面会如实说明。
 */
export function migrateUsageState(legacyRing: UsageRecord[], now: number): UsageState {
  const state = emptyUsageState()
  // 按时间正序回放，让 `pruneUsageDays` 的天键顺序与真实时间一致。
  for (const r of [...legacyRing].sort((a, b) => a.at - b.at)) {
    recordUsageInto(state, r, now)
  }
  return state
}

/**
 * 兼容入口：对**裸明细数组**做聚合（等价于「只有明细、没有历史」）。
 *
 * ⚠️ 仅供单测与旧调用方使用。生产路径请用 {@link summarizeUsageState}
 * —— 它才能看到跨天保留的聚合数据。
 */
export function summarizeUsage(records: UsageRecord[], now: number = Date.now()): UsageSummary {
  return summarizeUsageState(migrateUsageState(records, now), 0, now)
}

/**
 * 小时桶标签（`MM-DD HH:00`，UTC+8）。
 *
 * ⚠️ 保留此函数名与格式：面板的「按小时」旧视图与既有单测都在用。
 * 新代码请优先用 {@link hourKeyUtc8}。
 */
export function hourBucketUtc8(at: number): string {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  const d = new Date(at + CST_OFFSET)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:00`
}
