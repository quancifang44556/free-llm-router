/**
 * 账号状态模型：四维**正交**的惩罚状态机。
 *
 * ## 为什么是「四维正交」而不是一个统一的「不可用」标志
 *
 * 移植自 Go 侧 `internal/pool/entry.go` + `transition.go` 的实测设计。四个维度
 * 由**不同的现实原因**驱动，混在一起会导致误伤：
 *
 * | 维度 | 触发原因 | 语义 | 恢复条件 |
 * |---|---|---|---|
 * | `until` / `coolKind` | 402 余额耗尽、429 限流、403 WAF | 「近期被限流/没钱」 | 到期、**面板「解冻」**、或**余额刷新确认余额 > 0**（仅 `hard`） |
 * | `modelCooldowns` | 429 `code=6004`、`11102` | 「仅对**某几个模型**不可用」 | 各模型自己的重置墙钟 |
 * | `breakerUntil` | 连续 5xx/网络失败 | 「这个号反复失败，先别打」 | 指数退避到期 |
 * | `degradeUntil` | 连续业务失败 | **完全不可用**（不是「降权但仍可发」） | 固定时长到期 |

 *
 * ⚠️ **`degradeUntil` 的语义是「不可用」，不是「降级但仍派单」**（2026-10-22 澄清）。
 * `healthy()` 对它直接 `return false`。原表写「降权，别当首选」，
 * 会让人以为降权号还能接活 —— 与实现相反。若将来真要「降权但可用」，
 * 那是改 `healthy()` 的事，**不能只改这张表**。
 *
 * ⚠️ **`hard`（402 余额耗尽）的「余额恢复 ⇒ 自动解冻」曾长期只写在文档里**（2026-10-21 审查澄清）。
 * 本表原先写的是「到期，或余额恢复（仅 CoolHard）」，但全仓**从未实现**那条路径：
 * `updateBalance` 刻意「绝不动惩罚态」（否则 cron 每轮刷余额都会偷偷解冻，
 * 探测数据一抖账号就反复解冻/锁定 —— `tests/balance-refresh.test.ts`、
 * `tests/burn-rate.test.ts` 专门守这条）。
 * ⇒ 现在由**独立方法** {@link AccountPoolDO.clearHardIfRecovered} 实现：两条余额刷新入口
 *（`/admin/accounts/balance` 与整点 cron）在**余额落盘之后**显式调用它。
 * 之所以不塞进 `updateBalance`：那个方法被现有单测钉住「只写额度、不碰惩罚态」，
 * 而且「余额恢复」是一个**有条件的判断**（新余额 > 0 且确实因 `hard` 在冷却），
 * 不是每次写余额都成立的副作用 —— 把它做成显式一步，才能被测试直接调用、也才能只清一维。
 *
 * 故 `hard` 的实际恢复方式有三种：**等次日 04:00**、**用户在面板点「解冻」**
 *（`clearCooldowns`，清掉全部维度，见该方法的说明）、**余额刷新确认余额 > 0**。
 *
 * **关键正交性**（Go 侧 `transition.go:9-26` 明确记录）：
 * - `disableLocked`（禁用）只清**冷却域**，**不动熔断** —— 禁用是授权/session
 *   终态，不应覆盖熔断观测；
 * - `NoteSuccess` 清熔断与降权，**不碰 `modelCooldowns`** —— 一次成功不能证明
 *   某个模型已解除限流。
 *
 * `healthy()` 是**并列或门**（任一未到期即不可选），天然「取最远者」，不需要
 * 显式比较长短。
 */

import { BURN_SAMPLE_LIMIT, type BalanceSample } from './burn-rate.js'

/** 冷却种类。`hard` 是余额耗尽（到次日 04:00），`soft` 是可恢复的限流。 */
export type CoolKind = '' | 'soft' | 'hard'

/**
 * 单个 (账号, 模型) 的独立冷却记录。
 *
 * 承载**两种语义**（Go 侧 `entry.go:141-160`）：
 * - **6004 限流**：`until` 对齐上游重置墙钟（`resetAt` 保留原始值供展示）；
 * - **11102 该后端无此模型**：指数退避（6h 起，封顶 24h）。
 */
export interface ModelCooldown {
  /** 冷却截止（epoch ms）。 */
  until: number
  /** 上游给出的原始重置时刻（epoch ms）；0 表示无。 */
  resetAt: number
  /** 原因标签，用于区分 6004 与 11102（清理由此判定，不可混淆）。 */
  reason: string
  /**
   * **跨冷却周期的坐实次数**（不随 `pruneExpired` 归零）。
   *
   * ⚠️ 为什么不复用 `hits`：`hits` 存在冷却条目内部，条目被 `pruneExpired`
   * 删掉后计数即归零 —— 于是「短观察窗」永远无法升级成「长冷却」，
   * 一个真不存在的模型会每 2 分钟被重试一次，永远停留在观察窗档位。
   *
   * `confirmed` 放在**账号状态**的同级表里（见 `modelConfirm`），
   * 与冷却条目解耦，只在「同一模型连续坐实」时递增、在真实成功时清零。
   */
  confirmed?: number
  /**
   * 结构化成因（`'busy'` / `'absent'` / `'denied'`）。
   *
   * ⚠️ 旧实现靠 `reason` 文案做 `includes('not found')` 判断，匹配面过宽 ⇒ 误杀。
   * 现在由调用方从 `classify()` 的结果直接传入，不再解析文案。
   * 缺省（旧数据）按 `'busy'` 处理：那是代价最小的解释。
   */
  cause?: 'busy' | 'absent' | 'denied'
  /**
   * 已连续命中次数，驱动 11102 的指数退避。
   * ⚠️ 刻意**不落盘**（Go 侧同口径）：重启后从基数重新学习，避免陈旧计数永久放大。
   */
  hits: number
  /**
   * 仅审计用途，**不参与**可用性判定。
   * ⚠️ `healthyForModel` / `modelExempt` 必须忽略它，否则审计条目会误伤选号。
   */
  auditOnly: boolean
}

/** 实测扣费账本条目（用于判断某模型是否免费，决定积分保底是否拦截）。 */
export interface ModelCost {
  /** 每 1k token 的实测单价。 */
  per1k: number
  /** 最近一次观测时间（epoch ms）。 */
  lastSeen: number
}

/** 令牌用量统计（纯观测，不影响调度）。 */
export interface TokenUsage {
  input: number
  output: number
}

/**
 * 账号的完整持久化状态。
 *
 * ⚠️ 与 Go 侧 `stateAccount` 的差异：Go 用 `*time.Time` + `omitempty` 实现
 * 「过期不落盘」。这里用 `number`（epoch ms）+ `0` 表示「无」——
 * `0` 在 JS 里是 falsy 但**语义明确**，且 JSON 里可省略。
 * 判据统一走 {@link isActive}，不靠 truthiness。
 */
/**
 * 上游账号级限制（`11140`）的保守冷却时长：**2 小时**。
 *
 * 依据 workbuddy2api-hub #422 的 `restrictedUntil` 口径。上游官方对申诉的答复是
 * 「1-3 工作日自动解除」，但那是人工工单的时间线；这个常量要表达的是
 * **「多久之后值得再探一次」**，而不是「保证那时已解封」——
 * 探到仍然 11140 会顺延下一次 2 小时，代价只是一个请求。
 *
 * 取 2 小时而非更短：11140 是设备/账号维度的风控标记，短时间内反复试探
 * 本身就会被记为异常行为（社区复盘：「看到 11140 立即停手」）。
 */
export const RESTRICTED_HOLD_MS = 2 * 60 * 60 * 1000

export interface AccountState {
  /** 上游 uid（账号主键）。 */
  uid: string
  /**
   * 供应商 id（`workbuddy` / `cline` / …）。
   *
   * ⚠️ 加这一维是**必须**的，不是锦上添花：不同供应商的 uid 空间互相独立，
   * 且同一份凭据在不同供应商下语义完全不同（端点、鉴权、错误分类都不同）。
   * 没有它就无法回答「这个号该用哪套协议」。
   *
   * 缺省值 `workbuddy` 是为了兼容升级前已存的账号（它们只可能是 WorkBuddy）。
   */
  provider: string
  /** 昵称（仅展示）。 */
  nickname: string
  /** 域：`cn` / `global`。 */
  realm: string
  /**
   * 是否被禁用。
   *
   * ⚠️ **只有人工能解**（面板「启用」/ `setAccountDisabled(false)`）。
   * 原文写「需人工或**余额恢复**解冻」—— 那是假的：
   * `clearHardIfRecovered` 只清 `hard` 冷却，`revive` 也不碰 `disabled`
   *（它只在导入凭据时被调用）。留着这句话，会让人以为充钱就能恢复。
   */
  disabled: boolean
  /**
   * 禁用原因 —— ⚠️ **与「冷却原因」共用同一字段**。
   *
   * 因此任何清理冷却的代码都**不得**无条件 `reason = ''`：
   * 那会把「已被手动停用」「session dead (12153 ×3)」这类真实故障从面板抹掉。
   * 参见 `clearHardIfRecovered` 里的 `if (!state.disabled)` 守卫。
   */
  reason: string

  // ── 冷却域 ──
  /** 账号级冷却截止（epoch ms，0 = 无）。 */
  until: number
  /** 冷却种类。 */
  coolKind: CoolKind
  /** 连续软冷却次数，驱动指数退避。`NoteSuccess` 清零。 */
  softStreak: number
  /** 模型级冷却表。 */
  modelCooldowns: Record<string, ModelCooldown>
  /**
   * 每个模型的**跨周期坐实次数**（键为模型名，值为连续失败轮次）。
   *
   * 与 `modelCooldowns[model].confirmed` 冗余保存一份在账号级，
   * 这样 `pruneExpired` 删掉冷却条目后，坐实进度**不会丢失**。
   * 真实成功（`noteSuccess`）时清零。
   */
  modelConfirm: Record<string, number>

  // ── 熔断域 ──
  /** 熔断截止（epoch ms，0 = 无）。 */
  breakerUntil: number
  /**
   * 上游**账号级限制**（`11140`）的解除时刻（epoch ms，0 = 未受限）。
   *
   * 与 `breakerUntil` 刻意分开（两者语义不同，不能共用一个字段）：
   * - `breakerUntil`：**我们自己**怀疑这个号不行（连续 5xx），指数退避，
   *   上游并没有对它做任何标记 —— 换个时间重试就可能好；
   * - `restrictedUntil`：**上游明确标记**了该账号（"account has been restricted"），
   *   一次即生效，固定 2 小时。它与请求内容无关、与其它账号无关。
   *
   * ⚠️ 持久化在 SQLite 里，重启 / 刷新 token 都不会丢 —— 这正是
   * workbuddy2api-hub #422 修掉的那个 bug（冷却只存内存，重启就重新送死）。
   */
  restrictedUntil: number
  /** 已熔断次数（指数退避的指数）。 */
  retryCount: number
  /** 连续失败计数（喂熔断器）。**唯一**权威连续失败计数。 */
  fails: number

  // ── 降权域 ──
  /** 降权截止（epoch ms，0 = 无）。 */
  degradeUntil: number
  /** 连败降权进度。 */
  consecutiveFails: number

  // ── session 死亡计数 ──
  /** 连续 12153 计数。达阈值（3）才禁用 —— 单次多为网络抖动。 */
  sessionDeadFails: number

  // ── 观测与账本 ──
  successCount: number
  errTotal: number
  lastSuccess: number
  lastErr: number
  /** 最近一次签到成功的 UTC+8 日期（`YYYY-MM-DD`）。 */
  lastCheckinDay: string
  tokenUsage: TokenUsage
  modelCosts: Record<string, ModelCost>

  // ── 积分快照 ──
  credits: number
  /** 快过期积分子集（`credits` 的子集）。 */
  creditsExpiring: number
  /** 最早到期时刻（epoch ms）。 */
  creditsEarliestExpiry: number
  /**
   * 最近 {@link BURN_SAMPLE_LIMIT} 次余额采样（升序，末位最新）。
   *
   * ⚠️ **只由 `updateBalance` 追加**（整点 cron 与面板手动刷新）。
   * 用途唯一：判断「窗口内烧掉的比例」是否异常（见 `burn-rate.ts`）——
   * 快照只能回答「还剩多少」，回答不了「掉得多快」，而后者才是账号被盗用 /
   * 某模型倍率异常高的**唯一**早期信号。
   *
   * ⚠️ 旧数据没有这个字段（升级前的记录）⇒ `normalizeAccountState` 补 `[]`，**不清号、不报错**。
   */
  samples: BalanceSample[]
}

/** 连续 12153 达此值才禁用（Go 侧 `entry.go:516`）。 */
export const SESSION_DEAD_THRESHOLD = 3

/** 创建一个空白账号状态（所有计数字段显式归零，不依赖 undefined）。 */
export function createAccountState(input: {
  uid: string
  nickname: string
  realm: string
  /**
   * 供应商 id。
   *
   * ⚠️ 缺省必须是 **`buddy`**，与 `normalizeAccountState`、`DEFAULT_PROVIDER`
   * 保持一致（2026-10-22 统一）。
   *
   * 原注释写「缺省 `workbuddy`（兼容升级前只可能是它）」，但那是**错的**：
   * 读路径（`normalizeAccountState` / 选号 / 面板）对缺失字段一律按 `buddy` 解释，
   * 于是「新建时缺省 workbuddy、老记录缺省 buddy」—— 同一份数据两种默认值。
   * 结果是同一批账号按创建时间不同，被当成国内版/国际版两种东西。
   */
  provider?: string
}): AccountState {
  return {
    uid: input.uid,
    provider: input.provider ?? 'buddy',
    nickname: input.nickname,
    realm: input.realm,
    disabled: false,
    reason: '',
    until: 0,
    coolKind: '',
    softStreak: 0,
    modelCooldowns: {},
    modelConfirm: {},
    breakerUntil: 0,
    restrictedUntil: 0,
    retryCount: 0,
    fails: 0,
    degradeUntil: 0,
    consecutiveFails: 0,
    sessionDeadFails: 0,
    successCount: 0,
    errTotal: 0,
    lastSuccess: 0,
    lastErr: 0,
    lastCheckinDay: '',
    tokenUsage: { input: 0, output: 0 },
    modelCosts: {},
    credits: 0,
    creditsExpiring: 0,
    creditsEarliestExpiry: 0,
    samples: [],
  }
}

/**
 * 归一采样史。
 *
 * ⚠️ 这里**不是**「信任已存数据」而是逐条校验：
 * 采样史参与「是否熔断」的判定，一个 `NaN` / 字符串 `credits` 会让
 * `burned = from - to` 变成 `NaN` ⇒ `pct < threshold` 恒为 false ⇒
 * **熔断永不触发**（静默失效，没有任何报错）。故坏条目直接丢弃，
 * 并在超出上限时只保留**最新**的若干条。
 */
function normalizeSamples(raw: unknown): BalanceSample[] {
  if (!Array.isArray(raw)) return []
  const out: BalanceSample[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const s = item as Record<string, unknown>
    if (typeof s.at !== 'number' || !Number.isFinite(s.at)) continue
    if (typeof s.credits !== 'number' || !Number.isFinite(s.credits)) continue
    out.push({ at: s.at, credits: s.credits })
  }
  // 升序：判定依赖「窗口内首/尾」，顺序不可信就必须先排好。
  out.sort((a, b) => a.at - b.at)
  return out.length > BURN_SAMPLE_LIMIT ? out.slice(-BURN_SAMPLE_LIMIT) : out
}

/**
 * 把已存的 JSON 归一成完整 `AccountState`。
 *
 * ## 为什么需要它（而不是直接 `as AccountState`）
 *
 * 账号状态是**跨版本持久化**的：升级前存的记录里没有后来新增的字段。
 * 直接断言类型会让那些字段变成 `undefined` —— 而 `undefined` 在布尔语境里
 * 是 falsy、在算术里是 `NaN`，会在**很远的地方**引发难以定位的故障。
 *
 * 故每次从存储读出都过一遍这里，显式补默认值。
 * 这与本项目「不静默接受坏数据」的纪律一致：宁可在这里补，也不要在业务逻辑里猜。
 */
export function normalizeAccountState(raw: unknown): AccountState | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const uid = typeof o.uid === 'string' ? o.uid : ''
  if (uid === '') return undefined

  const base = createAccountState({
    uid,
    nickname: typeof o.nickname === 'string' ? o.nickname : '',
    realm: typeof o.realm === 'string' ? o.realm : 'cn',
    // ⚠️ 缺省供应商为国内版默认供应商 buddy
    provider: typeof o.provider === 'string' && o.provider !== '' ? o.provider : 'buddy',
  })

  // 逐字段合并（只认类型正确的值，其余保留默认）
  const num = (k: string, d: number): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : d)
  const str = (k: string, d: string): string => (typeof o[k] === 'string' ? (o[k] as string) : d)
  const bool = (k: string, d: boolean): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d)
  const obj = <T>(k: string, d: T): T =>
    o[k] !== null && typeof o[k] === 'object' && !Array.isArray(o[k]) ? (o[k] as T) : d

  return {
    ...base,
    disabled: bool('disabled', base.disabled),
    reason: str('reason', base.reason),
    until: num('until', base.until),
    coolKind: str('coolKind', base.coolKind) as AccountState['coolKind'],
    softStreak: num('softStreak', base.softStreak),
    modelCooldowns: obj('modelCooldowns', base.modelCooldowns),
    modelConfirm: obj('modelConfirm', (base as Partial<AccountState>).modelConfirm ?? {}),
    breakerUntil: num('breakerUntil', base.breakerUntil),
    // ⚠️ 必须显式列出：`normalizeAccountState` 是**逐字段重建**对象的，
    // 没列出的字段不会从 `base` 继承 —— 老记录读出来就是 `undefined`。
    // 线上实测后果：`Math.max(undefined, x)` = NaN → 写库后读回 0，
    // 表现为「11140 罚了却看不出罚」，排查极难。
    restrictedUntil: num('restrictedUntil', base.restrictedUntil),
    retryCount: num('retryCount', base.retryCount),
    fails: num('fails', base.fails),
    degradeUntil: num('degradeUntil', base.degradeUntil),
    consecutiveFails: num('consecutiveFails', base.consecutiveFails),
    sessionDeadFails: num('sessionDeadFails', base.sessionDeadFails),
    successCount: num('successCount', base.successCount),
    errTotal: num('errTotal', base.errTotal),
    lastSuccess: num('lastSuccess', base.lastSuccess),
    lastErr: num('lastErr', base.lastErr),
    lastCheckinDay: str('lastCheckinDay', base.lastCheckinDay),
    tokenUsage: obj('tokenUsage', base.tokenUsage),
    modelCosts: obj('modelCosts', base.modelCosts),
    credits: num('credits', base.credits),
    creditsExpiring: num('creditsExpiring', base.creditsExpiring),
    creditsEarliestExpiry: num('creditsEarliestExpiry', base.creditsEarliestExpiry),
    // ⚠️ 旧数据（升级前）没有该字段 ⇒ `[]`。补空是**必须**的：`undefined` 会让
    // `appendBalanceSample` 的展开抛 `TypeError`（整个余额刷新路径 500）。
    samples: normalizeSamples(o.samples),
  }
}

/** 该时刻是否仍在未来（`0` = 无，恒为 false）。 */
export function isActive(deadline: number, now: number): boolean {
  return deadline > 0 && now < deadline
}

/**
 * 是否**正因余额耗尽（`hard` / 402）处于冷却中**。
 *
 * ## 为什么必须是一个共用函数，而不是各处手抄 `coolKind === 'hard' && isActive(...)`
 *
 * 这个判据有**三个**用途，含义必须完全一致，否则状态会自相矛盾：
 *
 * 1. `applyFailure` 的 `soft` 分支：命中时**不得**把 `coolKind` 改写成 `'soft'`。
 *    缺陷现象：账号因 402 余额耗尽被锁到次日 04:00，随后一次普通 429 失败
 *    就把它改写成「临时冷却（soft）」—— 面板上「余额问题」变成「限流」，
 *    用户按「等一分钟」去处理，实际要等到 04:00 或充值。**这是误导，不是显示问题。**
 * 2. `enforceBurnRate`：命中时**跳过**消耗速率判定（余额为 0 时谈不上「烧太快」，
 *    且软冷却分支会把 `hard` 降级成 `soft`）。
 * 3. `clearHardIfRecovered`：只有命中时才允许「余额恢复 ⇒ 解冻」清掉它。
 *
 * ⚠️ 三处**只抄其中一处**正是本仓库反复踩到的「同一概念两处判据」缺陷
 *（`modelExempt` 曾手抄 `healthy()` 的 4 个维度、漏了 `restrictedUntil`）。
 * 故这里只写一份，三处都调它。
 *
 * ⚠️ 只看**冷却域**这一个维度：`breakerUntil` / `degradeUntil` / `restrictedUntil`
 * 各有各的现实原因（我们自己怀疑它不行 / 连败降权 / 上游明确封号），
 * 混进来会让「余额恢复」顺手清掉真实故障的观测。
 */
export function hardCooldownActive(state: AccountState, now: number): boolean {
  return state.coolKind === 'hard' && isActive(state.until, now)
}

/**
 * 账号当前是否可选。
 *
 * ⚠️ 这是**并列或门**，不是加权叠加：任一维度未到期即不可选。
 * 因此天然「取最远者」，无需显式比较三个截止时间的长短。
 */
export function healthy(state: AccountState, now: number): boolean {
  if (state.disabled) return false
  if (isActive(state.until, now)) return false
  if (isActive(state.breakerUntil, now)) return false
  if (isActive(state.degradeUntil, now)) return false
  // 上游账号级限制（11140）：区别于上面三个「我们自己怀疑它不行」的维度 ——
  // 这条是上游**明确标记**过该账号，必须真的不派单，否则会持续撞同一堵墙。
  if (isActive(state.restrictedUntil, now)) return false
  return true
}

/**
 * 该账号对指定模型是否可用。
 *
 * 只有**该模型的**冷却未过期才拦截；其他模型的冷却不影响本模型 ——
 * 这正是「6004 不该罚整个账号」的实现。
 */
export function healthyForModel(state: AccountState, now: number, model: string): boolean {
  if (!healthy(state, now)) return false
  if (model === '') return true
  const mc = state.modelCooldowns[model]
  if (mc === undefined) return true
  // ⚠️ 审计条目不参与判定，否则会误伤选号。
  if (mc.auditOnly) return true
  return !isActive(mc.until, now)
}

/**
 * 是否处于「6004 模型级软冷却」形态：账号本身健康，但存在某模型的独立冷却。
 *
 * 此形态下账号**仅对限流中的模型不可用**，其他模型仍可选。
 * 供 `/healthz` 探活与选号共用，保证两者口径一致（Go 侧 issue #31 的教训）。
 */
export function modelExempt(state: AccountState, now: number): boolean {
  /**
   * 🔴 **账号级判据必须直接用 `healthy()`，不要手抄**
   *（2026-10-21 审查补，重复实现专项）。
   *
   * 原来这里逐个抄了 4 个维度，**漏了 `restrictedUntil`**（上游明确封号，11140）——
   * 而 `healthy()` 有 5 个。于是「被封号 + 同时有模型限流」的账号会走进
   * `modelExempt` 的 `true` 分支，池摘要把它算成「模型限流」，
   * 而 `/admin/accounts/diagnose` 说是「上游标记账号受限，还剩 1 小时 58 分」。
   *
   * 用户按「换个模型」去处理，实际要等 2 小时或点解冻。
   * 手抄一份判据 = 等着下次加维度时再漏一次。
   */
  if (!healthy(state, now)) return false
  for (const mc of Object.values(state.modelCooldowns)) {
    if (!mc.auditOnly && mc.until > 0) return true
  }
  return false
}

/**
 * 清理已过期的模型冷却与陈旧成本账本（惰性剪枝）。
 *
 * ⚠️ 必须**在每次读取前**调用，否则过期条目会一直留在表里，
 * 让 `modelExempt` 误报「有模型在冷却」。
 */
export function pruneExpired(state: AccountState, now: number, costTtlMs: number): boolean {
  let changed = false

  for (const [model, mc] of Object.entries(state.modelCooldowns)) {
    if (mc.until > 0 && now >= mc.until) {
      delete state.modelCooldowns[model]
      changed = true
    }
  }

  for (const [model, cost] of Object.entries(state.modelCosts)) {
    if (cost.lastSeen <= 0 || now - cost.lastSeen > costTtlMs) {
      delete state.modelCosts[model]
      changed = true
    }
  }

  return changed
}

// ─────────────────────────────────────────────────────────────────────────────
// 账号状态诊断（供 `/admin/accounts/diagnose` 与面板使用）
// ─────────────────────────────────────────────────────────────────────────────

/** 单个维度的诊断结果。 */
export interface DimensionView {
  active: boolean
  /** 到期时刻（epoch ms）。`0` = 无。 */
  until: number
  /** 还剩多少毫秒（已 clamp 到 >= 0）。前端不该自己减，避免时钟漂移两处不一致。 */
  remainingMs: number
  /** 可读原因。 */
  reason: string
}

/** 模型级冷却的诊断条目（比 DimensionView 多模型名与计数）。 */
export interface ModelDimensionView extends DimensionView {
  model: string
  hits: number
  /**
   * 审计条目（`auditOnly`）不参与选号判定。
   *
   * ⚠️ 必须暴露：否则用户看到「这个模型冷却中」却发现请求能通，会以为面板在骗人。
   */
  auditOnly: boolean
  /** 上游给出的原始重置时刻；`0` = 无。 */
  resetAt: number
}

/** 一个账号的完整诊断。 */
export interface AccountDiagnosis {
  uid: string
  provider: string
  nickname: string
  disabled: boolean
  /** 是否可派单。**与 `blockedBy` 同源**（都用 `healthy()` 的判据），不会自相矛盾。 */
  healthy: boolean
  /**
   * 命中了哪些维度（可多个）。
   *
   * 取值：`disabled` / `account_cooldown` / `model_cooldown` / `breaker` /
   * `degrade` / `restricted`
   */
  blockedBy: string[]
  /**
   * 一句人话总结。
   *
   * ⚠️ 多维度同时命中时取「**最远的那个**」作为主因 —— 因为用户真正关心的是
   * 「什么时候能恢复」，而恢复时刻由最远的那个维度决定。
   */
  summary: string
  dimensions: {
    accountCooldown: DimensionView & { kind: string }
    modelCooldowns: ModelDimensionView[]
    breaker: DimensionView
    degrade: DimensionView
    restricted: DimensionView
  }
  counters: {
    fails: number
    softStreak: number
    consecutiveFails: number
    successCount: number
    errTotal: number
    lastSuccess: number
    lastErr: number
  }
  /** `AccountState.reason` 原文（上游/我们的最后一条原因）。 */
  reason: string
}

/** 把毫秒转成人话（`42 秒` / `12 分钟` / `1 小时 58 分`）。 */
export function humanizeMs(ms: number): string {
  if (ms <= 0) return '0 秒'
  const totalSec = Math.ceil(ms / 1000)
  if (totalSec < 60) return `${totalSec} 秒`
  const totalMin = Math.ceil(totalSec / 60)
  if (totalMin < 60) return `${totalMin} 分钟`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/** 构造单个维度视图。 */
function dimensionOf(until: number, now: number, reason: string): DimensionView {
  const active = isActive(until, now)
  return {
    active,
    until: active ? until : 0,
    remainingMs: active ? Math.max(0, until - now) : 0,
    reason: active ? reason : '',
  }
}

/**
 * 生成一个账号的完整诊断。
 *
 * ⚠️ **所有判据都复用 `isActive()`**，不另写一套 —— 本项目反复踩过
 * 「同一概念两处判据不一致」的坑（`healthy()` 说能用、`blockedBy` 说有冷却）。
 */
export function diagnoseAccount(state: AccountState, now: number): AccountDiagnosis {
  const blockedBy: string[] = []

  const accountCooldownRaw = dimensionOf(state.until, now, state.reason)
  const breaker = dimensionOf(state.breakerUntil, now, '连续失败熔断')
  const degrade = dimensionOf(state.degradeUntil, now, '连续业务失败降权')
  const restricted = dimensionOf(state.restrictedUntil, now, '上游标记账号受限（11140）')

  const modelCooldowns: ModelDimensionView[] = Object.entries(state.modelCooldowns)
    .map(([model, mc]) => {
      const view = dimensionOf(mc.until, now, mc.reason)
      return {
        ...view,
        model,
        hits: mc.hits ?? 0,
        auditOnly: mc.auditOnly === true,
        resetAt: mc.resetAt ?? 0,
      }
    })
    // 只列「正在冷却」或「审计条目」；已过期的由 pruneExpired 清理，不必展示噪音
    .filter((m) => m.active || m.auditOnly)
    .sort((a, b) => b.remainingMs - a.remainingMs)

  if (state.disabled) blockedBy.push('disabled')
  if (accountCooldownRaw.active) blockedBy.push('account_cooldown')
  if (modelCooldowns.some((m) => m.active && !m.auditOnly)) blockedBy.push('model_cooldown')
  if (breaker.active) blockedBy.push('breaker')
  if (degrade.active) blockedBy.push('degrade')
  if (restricted.active) blockedBy.push('restricted')

  /**
   * `healthy` 直接复用 `healthy()`。
   *
   * ⚠️ 注意 `healthy()` **不看 `modelCooldowns`**（那是 `healthyForModel()` 的事）——
   * 因为模型级冷却不阻止账号被选去服务**别的**模型。
   * 故 `blockedBy` 里可能有 `model_cooldown` 而 `healthy === true`，
   * 这**不是矛盾**，而是正确语义：账号可用，但那几个模型暂时不行。
   */
  const isHealthy = healthy(state, now)

  // 主因：取剩余时间最远的那个维度（恢复时刻由它决定）
  const candidates: Array<{ label: string; ms: number }> = []
  if (state.disabled) candidates.push({ label: '账号已停用', ms: Number.MAX_SAFE_INTEGER })
  if (accountCooldownRaw.active) {
    const kindText = state.coolKind === 'hard' ? '余额耗尽' : '限流'
    candidates.push({ label: `账号冷却中（${kindText}），还剩 ${humanizeMs(accountCooldownRaw.remainingMs)}`, ms: accountCooldownRaw.remainingMs })
  }
  if (breaker.active) candidates.push({ label: `连续失败熔断中，还剩 ${humanizeMs(breaker.remainingMs)}`, ms: breaker.remainingMs })
  if (degrade.active) candidates.push({ label: `降权中，还剩 ${humanizeMs(degrade.remainingMs)}`, ms: degrade.remainingMs })
  if (restricted.active) candidates.push({ label: `上游标记账号受限，还剩 ${humanizeMs(restricted.remainingMs)}`, ms: restricted.remainingMs })

  const activeModels = modelCooldowns.filter((m) => m.active && !m.auditOnly)
  if (activeModels.length > 0) {
    const furthest = activeModels[0]!
    const names = activeModels.map((m) => m.model).join('、')
    candidates.push({
      label: `模型 ${names} 冷却中，还剩 ${humanizeMs(furthest.remainingMs)}（账号本身可用）`,
      ms: furthest.remainingMs,
    })
  }

  let summary = '可用'
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.ms - a.ms)
    summary = candidates[0]!.label
  }

  return {
    uid: state.uid,
    provider: state.provider ?? '',
    nickname: state.nickname ?? '',
    disabled: state.disabled,
    healthy: isHealthy,
    blockedBy,
    summary,
    dimensions: {
      accountCooldown: { ...accountCooldownRaw, kind: state.coolKind },
      modelCooldowns,
      breaker,
      degrade,
      restricted,
    },
    counters: {
      fails: state.fails,
      softStreak: state.softStreak,
      consecutiveFails: state.consecutiveFails,
      successCount: state.successCount,
      errTotal: state.errTotal,
      lastSuccess: state.lastSuccess,
      lastErr: state.lastErr,
    },
    reason: state.reason,
  }
}
