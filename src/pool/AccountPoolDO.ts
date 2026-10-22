/**
 * AccountPool Durable Object：账号池的**唯一权威状态**。
 *
 * ## 为什么必须是一个 DO，而不是 Worker 内存
 *
 * 账号池的冷却/熔断/降权/租约是**必须跨请求共享且必须串行修改**的状态。
 * Workers 会水平扩展 + 随时回收 isolate，模块级变量等于「每个 isolate 一份」，
 * 状态必然撕裂（AGENTS.md §4.2）。
 *
 * DO 提供三件这里正需要的东西：
 * 1. **单点串行** —— 无需自己实现锁；
 * 2. **持久化存储** —— 替代 Go 侧的 `data/state.json`；
 * 3. **alarm** —— 替代进程内 ticker（本 DO 暂不需要，见下）。
 *
 * 按 realm（`cn` / `global`）**分片**而不是全局单例：避免单 DO 的
 * ~1000 req/s 软上限成为瓶颈。
 *
 * ## 分层纪律（重要）
 *
 * 本 DO **只做状态读写与选号**，不做上游网络请求。
 * 理由：DO 的每次调用都消耗 10ms CPU 预算（Free 计划），
 * 把上游 fetch 放进 DO 会把 I/O 等待与状态修改耦合在一起，
 * 让「一次调用 = 一步」的纪律失效。上游请求由 Worker 侧发起。
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.js'
import { resolveBurnRate, resolveMaxContextMessages } from '../env.js'
// ⚠️ 限速参数解析放在 `gateway/safety.ts`（与 `envFallback` 同处），
// 由 DO 在"面板没存值"时回落到此 —— 这是限速唯一的开启途径。
import { resolveRateJitterMs, resolveRateLimitQps } from '../gateway/safety.js'
import { appendBalanceSample, detectBurnRate } from './burn-rate.js'
import {
  type AccountState,
  createAccountState,
  hardCooldownActive,
  healthy,
  healthyForModel,
  isActive,
  modelExempt,
  normalizeAccountState,
  pruneExpired,
  RESTRICTED_HOLD_MS,
} from './state.js'
import {
  deleteAccount,
  deleteSession,
  listAccounts,
  listCredentialUids,
  migrate,
  pruneLoginSessions,
  pruneSessions,
  readAccount,
  readCredential,
  readLoginSession,
  readSession,
  writeAccount,
  writeCredential,
  writeLoginSession,
  writeSession,
  deleteCredential,
  deleteLoginSession,
} from '../store/db.js'
import { decryptCredential, encryptCredential, requireCredentialKey } from '../store/crypto.js'
import { cstDay } from '../upstream/travel.js'
import {
  emptyUsageState,
  migrateUsageState,
  pruneUsageDays,
  recordUsageInto,
  summarizeUsageState,
  trimUsageRing,
  type UsageRecord,
  type UsageState,
  type UsageSummary,
} from '../store/usage.js'
import {
  type ApiKeyLimits,
  type ApiKeyRecord,
  type ApiKeyUsage,
  defaultApiKeyLimits,
  emptyApiKeyUsage,
  isWindowExpired,
  newApiKeyId,
  normalizeApiKeyLimits,
  normalizeApiKeyRecord,
  resetUsageWindow,
} from '../store/apikeys.js'

/**
 * 用量状态的存储键（**一个 key 装明细环 + 按天聚合**）。
 *
 * ⚠️ 为什么合并成一个 key：`recordUsage` 在推理的关键路径上，每次都是一次
 * 读 + 一次写。拆成两个 key 会让每笔请求写两次 —— 在 Free 计划下白白
 * 翻倍 DO 行写入配额消耗，换不到任何好处。
 */
/**
 * 子密钥记录的存储键。
 *
 * ⚠️ 与用量计数**分开两个 key**：记录只在增删改时写（低频），
 * 而用量计数在**每个** `/v1/*` 请求后都要写（高频）。合并成一个 key 会让
 * 每次请求都重写整个记录数组 —— 白白放大 DO 写入量与冲突面。
 */
const API_KEYS_KEY = 'apiKeys'

/** 子密钥用量计数的存储键（按 id 索引）。 */
const API_KEY_USAGE_KEY = 'apiKeyUsage'

/**
 * **永久积分锁**开关表的存储键（per-provider，如 `{ buddy: true }`）。
 *
 * ## ⚠️⚠️ 为什么必须是**独立的 storage key**（真实事故，参考实现记录）
 *
 * 账号池主状态是**整体替换**语义（读全量 → 改 → 写全量）。若把开关放在
 * 主状态里，任何一次「读改写」都可能抹掉它 —— 参考实现记录过完整事故链：
 *
 * | 步骤 | 发生了什么 |
 * |---|---|
 * | 1 | 新代码写入 `permanentLocks: { buddy: true }` |
 * | 2 | 旧代码（不认识该字段）触发任意一次整体写入 |
 * | 3 | 旧代码只写它认识的键 ⇒ 锁**被静默抹掉** |
 * | 4 | 选号继续消耗永久积分 —— **烧掉不可撤回** |
 *
 * ⇒ 独立 key = 旧代码**从不读写**它，两条代码路径互不干扰。
 */
const PERMANENT_LOCKS_KEY = 'permanentLocks'

/**
 * **指定账号**（per-provider）的存储键，形如 `{ buddy: { uid, mode } }`。
 *
 * ⚠️ 与 {@link PERMANENT_LOCKS_KEY} 同一纪律：独立 key，不放进账号主状态，
 * 免得任何一次「读改写」把它静默抹掉。
 *
 * 只存在**账号所在分片**的 DO 里 —— `pick()` 读的是自身存储，
 * 存到别的分片等于没设（永久积分锁曾因此在 global 分片失效）。
 */
const ACCOUNT_PINS_KEY = 'accountPins'

/**
 * 规范化一条用量记录（读库时用）。
 *
 * ⚠️ 字段缺失不能抛错、也不能算出 `NaN`：`NaN` 会让面板显示 `NaN`
 * 且**所有配额比较都为 false**（于是「超限」永远判不出来）。
 */
function normalizeApiKeyUsage(raw: unknown): ApiKeyUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  return {
    windowStart: num(o.windowStart),
    requests: num(o.requests),
    inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens),
    rejected: num(o.rejected),
    lastAt: num(o.lastAt),
    lastIp: typeof o.lastIp === 'string' ? o.lastIp : '',
    lastModel: typeof o.lastModel === 'string' ? o.lastModel : '',
  }
}

/**
 * 用量状态的存储键（**一个 key 装明细环 + 按天聚合**）。
 *
 * ⚠️ 两份数据放同一个 key 是**刻意的**：`recordUsage` 在推理关键路径上
 *（`ctx.waitUntil`），必须保持「一次读 + 一次写」。拆成两个 key 会让每笔请求
 * 写两次 —— 在 Free 计划下白白翻倍 DO 行写入配额消耗，换不到任何好处。
 */
const USAGE_STATE_KEY = 'usage:state'

/** 旧版的键（只存裸明细数组）。仅用于**一次性迁移**，见 `loadUsageState`。 */
const LEGACY_USAGE_RING_KEY = 'usage:ring'

/** 模型成本账本的存活时长：6h 外的价格不再采信（Go 侧 `modelCostTTL` 同口径）。 */
/**
 * 上游给的 `resetAt` 的**最大前瞻窗口**（2026-10-21 审查补，M2 指出无上限）。
 *
 * ## 为什么必须钳制
 * `applyFailure` 原来直接 `state.until = input.resetAt`，**没有任何上限**。
 * 而 `resetAt` 来自上游响应里的文本（`parseResetAt` 解析 `reset at … UTC+8`）。
 * 一旦上游给了**远期时刻**（或文案格式变化让解析跑偏），
 * 账号/模型就会被锁到任意远的未来 —— 实测过的真实风险：
 * 一个「日次数上限」的响应若被解析成 2027 年，账号就整整一年不派单，
 * 而面板上只显示「冷却中」，用户完全不知道要等到哪一年。
 *
 * ## 为什么是 24 小时
 * 已知的合法 `resetAt` 语义都是**日内**的：
 * - 日次数上限（qoder `110`）⇒ 次日 00:00 或 04:00
 * - 频率限制 ⇒ 几分钟到几小时
 * 故 24 小时足以覆盖全部合法情形，同时挡住「解析跑偏到远期」。
 *
 * ⚠️ 钳制**只缩短、不延长**：上游说 5 分钟后恢复，仍然 5 分钟。
 */
const MAX_RESET_AHEAD_MS = 24 * 60 * 60 * 1000

const MODEL_COST_TTL_MS = 6 * 60 * 60 * 1000

/** 会话粘性默认 TTL。 */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

/**
 * 防惊群的「冷却窗口」：{@link SPREAD_WINDOW_MS} 内刚被选中过的账号，
 * 下次选号会被**优先排除**（除非排除后一个不剩）。
 *
 * ## 为什么需要（实测缺陷）
 *
 * 上游对**同一账号的并发流**不友好：后来者会把先前的流**踢掉** ⇒
 * 用户看到「长回答中途突然停止、没有任何输出」。
 * 纯加权随机每次都独立掷骰，完全可能连中同一账号。
 *
 * 值取 3 秒：足够把「并发几秒内到达的请求」摊开，
 * 又不至于让账号在半天内被闲置（长回答动辄几十秒，
 * 窗口太长会让后续单发请求也被迫换号，反而丢 prompt cache）。
 */
export const SPREAD_WINDOW_MS = 3_000


/**
 * IP 级 WAF 拦截的判定窗口与阈值。
 *
 * ## 为什么需要「IP 级」这一层（Go 侧 `internal/server/wafip.go` 的教训）
 *
 * 实测记录：**3 个账号在 1 秒内全部命中 403** —— 那不是账号问题，是**出口 IP 被拦**。
 * 若只有账号级冷却，轮转逻辑会把一次客户端请求**放大 MaxRotate 倍**：
 * 每个号都去撞一次同一堵墙，反而加重风控。
 *
 * ⇒ 判据是「**短窗内多个不同账号**接连命中」，而不是「同一账号反复命中」：
 * - 同一个号反复 403 → 账号级偶发，交给软冷却（已有的逻辑）；
 * - **不同号**在 60 秒内接连 403 → 已有 IP 级证据 ⇒ fail-fast，不再轮转。
 *
 * 阈值取 2：「多号」的最小定义。Go 侧同值（实测 3 号 1s 全拦，阈值 2 更早止损）。
 */
const WAF_IP_WINDOW_MS = 60_000
const WAF_IP_THRESHOLD = 2

/**
 * `11140`（账号级限制）**波次暂停**参数 —— 对齐 workbuddy2api-hub #425。
 *
 * ## 与上面 `WAF_IP_*` 的区别（不能共用一个 gate）
 *
 * | | IP 级（`WAF_IP_*`） | 账号级波次（本组） |
 * |---|---|---|
 * | 触发 | 短窗内多号接连 **403/WAF** | 短窗内多号被 **11140 标记** |
 * | 含义 | 出口 IP 被拦 | 上游在对这一批账号做风控 |
 * | 处置 | 暂停 60s | 暂停 30 分钟（上游风控是小时级） |
 *
 * 两者都导致「一个上游请求都不发」，但判据与恢复节奏完全不同，
 * 混用会让 IP 偶发拦截拖住半小时、或让真正的账号波次只停 1 分钟。
 *
 * ## 为什么必须整池暂停（事故依据）
 *
 * workbuddy2api-hub #425：同一区域在 900 秒内被限制 2 个账号，就暂停该区域派发
 * 1800 秒。依据是社区复盘的红线「看到 11140 立即停手」——
 * **风控惩罚与持续请求正相关**，继续送号只会让更多号进标记。
 */
const RESTRICTION_WAVE_WINDOW_MS = 15 * 60 * 1000
const RESTRICTION_WAVE_THRESHOLD = 2
/**
 * 整池暂停时长。⚠️ 与 `state.ts` 的 {@link RESTRICTED_HOLD_MS}（**单账号** 2 小时）
 * 是两个不同层次的口径，名字刻意区分：
 * - `RESTRICTED_HOLD_MS`：这一个号多久后再探；
 * - `RESTRICTION_POOL_HOLD_MS`：整个区域多久不发任何上游请求。
 */
const RESTRICTION_POOL_HOLD_MS = 30 * 60 * 1000

/** 选号候选上限（Go 侧 top5）。 */
const TOP_N = 5

/**
 * 选号输入。
 *
 * ⚠️ `model` 必须**真的传**：传空串会让模型级冷却过滤整体短路
 * （Go 侧 `account-pool.ts:917` 记录过的缺陷）。
 */
export interface PickRequest {
  realm: string
  /**
   * 只要该供应商的账号（空串 = 不限）。
   *
   * ⚠️ 过滤必须在这里做，**不能**在 `pick()` 返回之后再筛（实测踩到）：
   * 后者会先选中一个别家的账号、再把它丢掉，于是
   * 「池里有账号但当前供应商没账号」时表现为 `pick()` 返回了号、
   * 调用方却拿不到人 → 直接被当成「没有可用账号」。
   */
  provider?: string
  /** 目标模型；空串表示「还没定模型」——此时不做模型级过滤。 */
  model: string
  /**
   * **优先**使用的账号（会话粘性）。
   *
   * ⚠️ 语义是「优先」不是「只要」：它在候选集里**排到最前**，
   * 但若它已不可用（冷却/熔断/模型限流/被 exclude），
   * 会**自然回落到**其余候选 —— 绝不能因为「粘性的那个挂了」就报「没有可用账号」。
   *
   * ## 为什么值得做（上游 prompt cache）
   *
   * 同一会话若每次都落不同账号，上游的 prompt cache **永远不命中**：
   * 每一轮都要重新处理整个上下文 ⇒ **更慢、更贵**（按 token 计费时尤其明显）。
   * 绑定会话到账号后，第二轮起就能命中缓存。
   *
   * ⚠️ 只在**候选集内**提升优先级，不绕过任何健康检查 ——
   * 粘性不该让一个正在冷却的账号被强行使用。
   */
  preferred?: string
  /**
   * **请求级**指定账号（来自请求头 `X-FLR-Account`），语义恒为「只用它」。
   *
   * 优先级高于面板里给该供应商设的指定账号。
   */
  pinned?: string
  /** 已尝试过的 uid，必须排除（跨重试保留，否则会在账号间无限来回）。 */
  exclude: string[]
  now: number
}

/** 选号结果。 */
export interface PickResult {
  uid: string
  state: AccountState
  /**
   * **永久积分锁**把全部候选滤空时为 `true`（uid 为空、state 缺省）。
   *
   * ⚠️ 网关必须把这种情况翻译成**用户可见的明确错误**：
   * 「账号正常，只是永久积分已上锁」—— 绝不能静默回落换号或报含糊的
   * 「无可用账号」，否则用户会误判服务故障、甚至解锁烧掉不可撤回的永久积分。
   */
  lockedByPermanent?: true
  /** 因锁被滤掉的候选数（仅供错误信息展示）。 */
  lockedSkipped?: number
  /** 「只用指定账号」但它不可用（见 {@link PinnedUnavailable}）。 */
  pinnedUnavailable?: true
  pinnedUid?: string
  pinnedLabel?: string
  pinnedReason?: string
}

/**
 * 指定账号的模式。
 *
 * - `only`：**只用它**。它不可用时直接报错（说明原因），不换别的号 ——
 *   用户明确要求「就用这个号」，静默换号会让人误以为指定生效了。
 * - `prefer`：**优先用它**。它不可用时自然回落到其余候选（同会话粘性）。
 */
export type PinMode = 'only' | 'prefer'

/** 某供应商的指定账号。 */
export interface AccountPin {
  uid: string
  mode: PinMode
}

/**
 * 「只用指定账号」但它此刻不可用时 `pick()` 的返回（uid 为空、state 缺省）。
 *
 * ⚠️ 网关必须把它翻译成**用户可见的明确错误**（带 {@link reason}），
 * 不能回落换号，也不能报含糊的「无可用账号」。
 */
export interface PinnedUnavailable {
  pinnedUnavailable: true
  pinnedUid: string
  /** 账号昵称（找不到账号时为空串）。 */
  pinnedLabel: string
  /** 人话原因，如「已停用」「冷却中，约 3 分钟后恢复」。 */
  pinnedReason: string
}

function isPinMode(v: unknown): v is PinMode {
  return v === 'only' || v === 'prefer'
}

/** 剩余时间的人话（≥1 分钟）。 */
function minutesLeft(until: number, now: number): string {
  const mins = Math.max(1, Math.round((until - now) / 60_000))
  return mins >= 120 ? `约 ${Math.round(mins / 60)} 小时` : `约 ${mins} 分钟`
}

/**
 * 某账号此刻为什么**不能**被选（可选时返回空串）。
 *
 * ⚠️ 判据与 `pick()` 的候选过滤**逐条对应**，只用于给「指定账号不可用」生成说明；
 * 顺序与 `healthy()` 一致，先报最根本的原因（停用 > 冷却 > 模型限流）。
 */
function unavailableReason(
  state: AccountState,
  now: number,
  model: string,
  opts: { excluded: boolean; permLocked: boolean },
): string {
  if (opts.excluded) return '这次请求里它已经失败过'
  if (state.disabled) return '已停用'
  const cool = Math.max(
    isActive(state.until, now) ? state.until : 0,
    isActive(state.breakerUntil, now) ? state.breakerUntil : 0,
    isActive(state.degradeUntil, now) ? state.degradeUntil : 0,
    isActive(state.restrictedUntil, now) ? state.restrictedUntil : 0,
  )
  if (cool > 0) return `冷却中，${minutesLeft(cool, now)}后恢复`
  if (model !== '') {
    const mc = state.modelCooldowns[model]
    if (mc !== undefined && !mc.auditOnly && isActive(mc.until, now)) {
      return `模型 ${model} 在它上面限流中，${minutesLeft(mc.until, now)}后恢复`
    }
  }
  if (opts.permLocked) return '只剩永久积分，且已被「永久积分锁」保护'
  return ''
}

/** 账号池的对外 RPC 面（Worker 通过 stub 调用）。 */
export interface RoutingConfig {
  strategy: 'expiry' | 'roundrobin' | 'random'
  maxRetries: number
  softCooldownSeconds: number
  autoTaskCron: boolean
  autoRefreshCredential: boolean
}

/**
 * 防封（风控规避）配置。**全部即时生效**，改完不用重启 —— 面板写 DO，网关照读。
 *
 * ## ⚠️ 为什么单独于 {@link RoutingConfig} 一个键
 *
 * 两者的**受众**不同：`RoutingConfig` 影响「用哪个号」，`SafetyConfig` 影响
 * 「请求长什么样」。混在一个键里会让「只想调限速」的写入也必须携带路由字段，
 * 一旦某次合并写漏字段就会把路由策略悄悄重置。
 *
 * ## ⚠️ 默认值来自环境变量（不是硬编码）
 *
 * 本项目原先只有环境变量能配这些，已有部署依赖那一套。故 `getSafetyConfig()`
 * 在**没有存过值**时回落到 `resolveMaxContextMessages` / `resolveBurnRate`，
 * 保证「升级到有面板的版本」不会把一个原本配好的部署悄悄改回默认。
 *
 * ## ⚠️ `0` 的语义各不相同，每个字段都在注释里写清
 */
export interface SafetyConfig {
  /**
   * 会话链：补 `x-b3-*` 三件套与 `x-conversation-*` 链。
   *
   * 关掉 = 退回「孤立请求」形态（更像脚本、更不像官方客户端）。
   * 默认 **true** —— 复盘里这是 P1 的核心对抗项。
   */
  sessionTrace: boolean
  /** 单请求消息数上限。**`0` = 不限制**（不是「默认值」）。 */
  maxContextMessages: number
  /** 消耗速率熔断的观察窗口（ms）。**`0` = 关闭检测**。 */
  burnRateWindowMs: number
  /** 消耗速率熔断的阈值（百分比）。**`0` = 关闭检测**。 */
  burnRateThresholdPct: number
  /**
   * 每账号 QPS 上限。**`0` = 不限速**（默认）。
   *
   * ⚠️ 限速是「刹车」不是「加速」：开启后同一账号的上游请求会被**排队**，
   * 吞吐必然下降。只在被 429 咬过之后才值得开。
   */
  rateLimitQps: number
  /** 每次上游请求前的随机抖动上限（ms）。**`0` = 不抖动**（默认）。 */
  rateJitterMs: number
  /**
   * 是否启用**模型级冷却**。默认 `true`（保持既有行为）。
   *
   * ## 为什么要这个开关（用户 2026-10-22 明确要求）
   *
   * 用户原话：「为啥又冷却，不能加个开关让我把冷却关了吗，实际上完全没有冷却」。
   *
   * 这个判断是对的，而且我方确实在**过度锁模型**：实测面板上 3 个 workbuddy 账号
   * 同时挂着 `deepseek-v4.1-flash` 的 **5 小时**模型级冷却（上游 `6004` 说
   * 「19:34 重置」，我们就照锁到 19:34），而 qodercn 那个 `dfmodel` 冷却期内
   * **直接打上游 3/3 全 200** —— 冷却与被冷却对象的真实可用性**完全脱钩**。
   *
   * 根因不是某条判据写错，而是**惩罚粒度选错了**：
   * - 模型级冷却把「一次请求失败」放大成「这个 (账号,模型) 组合在 N 小时内不可用」；
   * - `absent` 阶梯一升就是 2min → 30min → 2h → 6h → 24h；
   * - 400 系列带上游墙钟时更狠（上游给的是**最坏**恢复时刻，我们当成了**必然**）；
   * - 而实测这些 429 / 10605 大多是**瞬时排队**，几秒后同一请求就能成功。
   *
   * ⇒ 关掉后：失败的请求照样如实报错、照样换号、照样记日志，
   * **只是不再把模型锁起来**。
   *
   * ⚠️ 关掉的代价（不能只讲好处）：那个模型会在**每次**请求里重新尝试。
   * 上游持续失败时，用户每次都要等一次失败往返，而不是立刻拿到「稍后重试」。
   * 对单账号池这正是用户想要的（多试几次往往就通了）；
   * 对多账号池，`breaker` / `until` 这些**账号级**维度仍然生效，不会失控。
   *
   * ⚠️ **只影响 `model` 维度**。`until` / `breakerUntil` / `degradeUntil` /
   * `restrictedUntil` / `session_dead` 一概不受影响 —— 那些是「账号真的有问题」，
   * 与「某个模型这一瞬间排队」是两回事。
   */
  modelCooldownEnabled: boolean
}

/**
 * `lastUsedAt` 的写回精度。
 *
 * 面板展示的是相对时间（「3 分钟前」），60 秒精度完全够用；
 * 而每次写回都要把**全部子密钥记录**整体序列化 —— 不值得为每个请求付这笔钱。
 */
const LAST_USED_AT_RESOLUTION_MS = 60_000

export class AccountPoolDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // 建表必须完成后再放行任何请求，否则首次调用会撞上不存在的表。
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql)
    })
  }

  /** 写入 / 覆盖一个账号的完整状态。 */
  async upsertAccount(state: AccountState, now: number): Promise<void> {
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
  }

  /** 读取一个账号。 */
  async getAccount(uid: string): Promise<AccountState | undefined> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    return raw === undefined ? undefined : normalizeAccountState(JSON.parse(raw))
  }

  /**
   * 读账号 + **归一**（`JSON.parse` + `normalizeAccountState`），供所有「读-改-写」路径共用。
   *
   * ## 为什么必须抽出来（2026-10-21 审查，写路径口径分叉）
   *
   * `noteSuccess` / `revive` / `noteCheckinDone` / `disable` 这四条写路径当时是裸的
   * `JSON.parse(raw) as AccountState`，**没过 `normalizeAccountState`**，而
   * `applyFailure` / `updateBalance` / `setAccountDisabled` / `clearCooldowns` /
   * `pick` / `listAccounts` 全都过了。后果是**新增字段会在这四条路径上静默丢失**：
   *
   * - `normalizeAccountState` 是**逐字段重建**对象的，裸 `JSON.parse` 则是原样返回 ——
   *   升级前落盘的记录缺 `provider` / `samples` / `restrictedUntil` 时，
   *   这四条路径把对象**整体写回**，缺的字段就永远是 `undefined`；
   * - 而 `undefined` 在算术里是 `NaN`、在布尔语境里是 falsy，故障会出现在
   *   **很远的地方**（`Math.max(undefined, x)` → 写库读回 0，见 `state.ts` 的注释），
   *   排查极难。
   *
   * ## 为什么返回 `undefined` 而不是抛错
   *
   * 调用方原有的语义都是「账号不存在 ⇒ 什么都不做」（`if (raw === undefined) return`），
   * 归一失败（缺 `uid` 等）同理属于「这条记录不可用」，保持一致即可。
   */
  private readState(uid: string): AccountState | undefined {
    const raw = readAccount(this.ctx.storage.sql, uid)
    return raw === undefined ? undefined : normalizeAccountState(JSON.parse(raw))
  }

  /**
   * 一次性数据迁移：把 `provider: 'workbuddy'`（当时指**国内版**）改成 `'buddy'`。
   *
   * ## ⚠️ 为什么必须做（否则是静默的数据错误）
   *
   * 本项目早期只有国内版，它当时的 id 就是 `workbuddy`。
   * 接入国际版后 `workbuddy` 的含义**变成了国际版** ——
   * 若不迁移，既有的国内账号会被当成国际账号，
   * 于是拿国内凭据去打 `www.workbuddy.ai`，**必然 401**，
   * 且用户看到的是「凭据失效」，真实原因（id 语义变了）完全看不出来。
   *
   * 判据：`provider === 'workbuddy'` **且**凭据里的 domain 不含 `workbuddy.ai`。
   * 幂等：跑第二次时已经是 `buddy`，不再命中。
   */
  private async migrateBuddyIds(realm: string, now: number): Promise<number> {
    const raws = listAccounts(this.ctx.storage.sql, realm)
    let migrated = 0
    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      if (state === undefined || state.provider !== 'workbuddy') continue

      // 读凭据看 domain —— 国际版凭据的 domain 含 workbuddy.ai
      const stored = readCredential(this.ctx.storage.sql, state.uid)
      let domain = ''
      if (stored !== undefined) {
        try {
          const key = requireCredentialKey(this.env.CREDENTIAL_KEY)
          const cred = (await decryptCredential(key, stored)) as { extras?: { domain?: string } } | undefined
          domain = cred?.extras?.domain ?? ''
        } catch {
          // 凭据解不开（如换了 CREDENTIAL_KEY）→ 不猜，保持原样
          continue
        }
      }

      // 是国际账号就保留 workbuddy；否则迁到 buddy
      if (domain.includes('workbuddy.ai')) continue
      state.provider = 'buddy'
      writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
      migrated += 1
    }
    return migrated
  }

  /** 列出某 realm 的全部账号（惰性剪枝过期条目）。 */
  async listAccounts(realm: string, now: number): Promise<AccountState[]> {
    // ⚠️ 惰性跑一次 id 迁移（幂等 + 用 storage 标志保证只跑一次）。
    // 放在这里而不是启动钩子：DO 没有可靠的「启动」时机，而 listAccounts
    // 是所有读路径的必经之处，天然覆盖「老数据第一次被访问」。
    const migrated = await this.ctx.storage.get<boolean>('buddyIdMigrated')
    if (migrated !== true) {
      await this.migrateBuddyIds(realm, now).catch(() => 0)
      await this.ctx.storage.put('buddyIdMigrated', true)
    }

    const raws = listAccounts(this.ctx.storage.sql, realm)
    const out: AccountState[] = []
    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      // ⚠️ 解析失败（数据损坏）时跳过该条，而不是让整个列表 500
      if (state === undefined) continue
      // 供应商不匹配的直接跳过（不同家的凭据/协议完全不同）
      if (pruneExpired(state, now, MODEL_COST_TTL_MS)) {
        // 剪枝结果不回写：过期条目不影响判定，回写反而多一次 SQLite 往返。
        // 下次真实状态变更时会一并落盘。
      }
      out.push(state)
    }
    return out
  }

  /** 删除账号（连带其会话绑定与凭据内存缓存）。 */
  async removeAccount(uid: string): Promise<void> {
    this.credentialCache.delete(uid)
    deleteAccount(this.ctx.storage.sql, uid)
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE uid = ?', uid)
    // ⚠️ 连带清掉指向它的「指定账号」：否则「只用它」会让该供应商永远报
    // 「指定的账号不存在」，而用户已经不记得设过指定了。
    const pins = await this.getPins()
    let changed = false
    for (const [provider, pin] of Object.entries(pins)) {
      if (pin.uid === uid) {
        delete pins[provider]
        changed = true
      }
    }
    if (changed) await this.ctx.storage.put(ACCOUNT_PINS_KEY, pins)
  }

  /**
   * 选号。
   *
   * 严格照 Go 侧 `pick.go` 的**顺序**（顺序即语义，不可调换）：
   * 1. 健康过滤（含模型级）
   * 2. 排除已尝试
   * 3. 在途过滤（**本实现暂不做租约**，见下方注记）
   * 4. 权重计算 → 加权随机
   *
   * ⚠️ **有意未实现**：Go 侧的 `costTier` 三层硬分层与「积分保底拦截」依赖
   * 实测扣费账本（`modelCosts`）。第一版账号数少（1–3 个），分层收益低于
   * 实现复杂度，故只保留**积分保底**所需的账本字段，不做分层选号。
   * 这是**刻意**的范围裁剪，不是遗漏（AGENTS.md §3.2）。
   */
  async pick(request: PickRequest): Promise<PickResult | undefined> {
    const { realm, model, exclude, now } = request
    const wantProvider = request.provider ?? ''
    const excludeSet = new Set(exclude)

    // ⚠️ IP 级拦截激活期内**直接放弃**，连一个号都不试。
    // 理由见 WAF_IP_WINDOW_MS 的注释：继续轮转只会把一次请求放大成 N 次撞墙。
    if (await this.wafGateActive(now)) return undefined

    const raws = listAccounts(this.ctx.storage.sql, realm)
    // ── 永久积分锁（per-provider）──
    //
    // ⚠️ 锁的语义是「**只剩永久额度**的账号不参与选号」，不是「provider 停用」。
    // 有临期额度的账号照常可选 —— 这正是锁的意义：让临期额度先烧，永久的不动。
    //
    // ⚠️ 锁定且**全部**候选都被滤掉时，**不许静默回落**到「无可用账号」之外的行为
    //（参考实现的纪律：回落会绕过锁、照样烧永久积分，使锁形同虚设）。
    const permLocks = await this.getPermanentLocks()
    let permLockSkipped = 0
    // ⚠️ 在读账号**之前**取（`getSafetyConfig` 有缓存，代价可忽略），
    // 避免循环里每条账号都 await 一次。
    // 见 `SafetyConfig.modelCooldownEnabled`：关掉后模型级冷却既不写入也不拦截。
    const modelCooldownEnabled = (await this.getSafetyConfig()).modelCooldownEnabled

    // ── 指定账号 ──
    //
    // 请求级（`X-FLR-Account`，恒为「只用它」）优先于面板里给该供应商设的指定。
    // ⚠️ 面板指定按 provider 存，`wantProvider` 为空（不限供应商）时不适用。
    const requestPin = (request.pinned ?? '').trim()
    const configPin = wantProvider === '' ? undefined : (await this.getPins())[wantProvider]
    const pin: AccountPin | undefined =
      requestPin !== '' ? { uid: requestPin, mode: 'only' } : configPin
    /** 指定账号不在候选里的原因（找到该账号才会被赋值）。 */
    let pinReason: string | undefined
    let pinLabel = ''

    const candidates: AccountState[] = []
    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      // ⚠️ 解析失败（数据损坏）时跳过该条，而不是让整个列表 500
      if (state === undefined) continue
      const isPin = pin !== undefined && state.uid === pin.uid
      // 供应商不匹配的直接跳过（不同家的凭据/协议完全不同）
      if (wantProvider !== '' && (state.provider ?? 'buddy') !== wantProvider) {
        if (isPin) {
          pinLabel = state.nickname
          pinReason = `它属于供应商「${state.provider ?? 'buddy'}」，不是这次请求的「${wantProvider}」`
        }
        continue
      }
      if (isPin) pinLabel = state.nickname
      if (excludeSet.has(state.uid)) {
        if (isPin) pinReason = unavailableReason(state, now, model, { excluded: true, permLocked: false })
        continue
      }
      pruneExpired(state, now, MODEL_COST_TTL_MS)
      // ⚠️ 模型冷却关闭时，**已存在的**旧冷却条目也必须一并忽略
      //（用户关开关的那一刻，池里已经挂着 5 小时的条目；只挡新写入不够）。
      // 判据：`modelCooldownEnabled ? healthyForModel(...) : healthy(...)` ——
      // 即「账号级 5 维照旧，模型级 1 维跳过」。
      const usable = modelCooldownEnabled ? healthyForModel(state, now, model) : healthy(state, now)
      if (!usable) {
        if (isPin) pinReason = unavailableReason(state, now, model, { excluded: false, permLocked: false })
        continue
      }

      // ── 永久积分锁过滤 ──
      //
      // 判定「只剩永久额度」用**快照三元组**（AccountState 已有，无需再打上游）：
      //   creditsExpiring === 0 且 credits > 0
      //   ⇒ 没有任何临期/赠送额度，剩下的全是永久积分。
      //
      // ⚠️ credits === 0 时**不滤**：那是「没钱了」，走的是 402 硬冷却路径，
      // 不是「只剩永久」—— 混淆会把真正的额度耗尽误报成锁。
      if (permLocks[state.provider ?? 'buddy'] === true && state.credits > 0 && state.creditsExpiring === 0) {
        permLockSkipped += 1
        if (isPin) pinReason = unavailableReason(state, now, model, { excluded: false, permLocked: true })
        continue
      }

      candidates.push(state)
    }

    // ── 指定账号命中 / 不可用 ──
    //
    // ⚠️ 放在「候选为空」判断**之前**：「只用它」时即便别的号全挂了，
    // 只要它可用就该用它；它不可用时也要报**它**的原因，而不是笼统的「无可用账号」。
    // 只在候选**内**命中 —— 指定不绕过任何健康检查（冷却中的号不会被强行使用）。
    if (pin !== undefined) {
      const hit = candidates.find((s) => s.uid === pin.uid)
      if (hit !== undefined) {
        this.notePicked(hit.uid, now)
        return { uid: hit.uid, state: hit }
      }
      if (pin.mode === 'only') {
        const unavailable: PinnedUnavailable = {
          pinnedUnavailable: true,
          pinnedUid: pin.uid,
          pinnedLabel: pinLabel,
          pinnedReason: pinReason ?? '账号不存在（可能已被删除，或不在这个分片）',
        }
        // ⚠️ 同 lockedByPermanent：独立判别类型，经 PickResult 的可选字段透出
        return unavailable as unknown as PickResult
      }
      // prefer：自然回落到下面的常规选号
    }

    if (candidates.length === 0) {
      // ⚠️ 因永久锁被滤空时，返回值里带上**可读的原因**（而不是 undefined）。
      // 调用方（网关）把它翻译成用户可见错误 —— 这正是 §7.2「失败必须显式」：
      // 用户必须知道「账号是好的，只是永久积分锁住了」，否则会误以为服务故障。
      if (permLockSkipped > 0) {
        // ⚠️ 刻意用独立类型（不塞进 PickResult）：state 是必填字段，
        // 把它置 undefined 会骗过类型系统、让所有调用方都要判空 ——
        // 独立判别联合让「锁了」与「选到号」在类型层就分开。
        return { lockedByPermanent: true, lockedSkipped: permLockSkipped } as PickResult
      }
      return undefined
    }

    // 权重：积分越多越优先（温和偏好，不是硬门槛）。
    // ⚠️ 刻意**不**用 `Math.random()` 之外的全局状态：DO 单线程，无需防并发。
    // ⚠️ **会话粘性**：把 `preferred` 提到候选集最前，**直接返回**。
    //
    // 为什么直接返回而不是「加权倾斜」：加权仍会**随机落到别的账号**，
    // 那样 prompt cache 照样不命中 —— 粘性就失去意义了。
    // 而「优先账号挂了怎么办」已由上游的候选过滤解决：
    // 它不可用时压根不在 `candidates` 里，自然回落到其余候选。
    const preferred = request.preferred ?? ''
    if (preferred !== '') {
      const hit = candidates.find((s) => s.uid === preferred)
      if (hit !== undefined) {
        this.notePicked(hit.uid, now)
        return { uid: hit.uid, state: hit }
      }
    }

    // ⚠️ **防惊群：并发请求要摊到不同账号**（实测踩到的严重缺陷）。
    //
    // ## 为什么必须做（用户报「思考 78 秒又断了」）
    //
    // 上游对**同一账号的并发流**不友好：后来者会把先前的流**踢掉**，
    // 表现为「长回答中途突然停止、没有任何输出」。
    //
    // 实测对照（3 个相同 prompt 并发）：
    // - 加粘性前/未摊开 ⇒ **1 个被切断**；
    // - 强制落到不同账号 ⇒ **3/3 全部完整**。
    //
    // ⇒ 纯加权随机不够：它**每次都独立掷骰**，完全可能连中同一个账号。
    //
    // ## 做法：优先选「最近没被选中」的账号
    //
    // 在 `pick()` 时给账号打一个时间戳，下次选号**优先排除**
    // 「{@link SPREAD_WINDOW_MS} 内刚被选中过」的账号。
    // 若排除后一个都不剩，**就回落到全部候选**（绝不因此报「无可用账号」）。
    //
    // ⚠️ **刻意放在 `preferred` 之后**：显式声明了会话的客户端
    //（`user` / `conversation_id`）**优先保 prompt cache**，不参与摊开。
    // 只有「没声明会话」的请求才摊 —— 它们本来就没有缓存可命中。
    const fresh = candidates.filter((s) => now - this.notePickedAt(s.uid) >= SPREAD_WINDOW_MS)
    const pool = fresh.length > 0 ? fresh : candidates

    // ⚠️ 必须 await 读取（缓存未命中就读 storage）：此前只读内存缓存，
    // DO 重启 / Node 进程重启后缓存为空就静默回落到轮询，面板上选的策略形同虚设。
    const strategy = (await this.routingConfig()).strategy

    if (strategy === 'random') {
      const weights = pool.map((s) => 1 + Math.max(0, s.credits) / 100)
      const total = weights.reduce((a, b) => a + b, 0)
      let roll = Math.random() * total
      for (let i = 0; i < pool.length; i += 1) {
        roll -= weights[i] ?? 0
        if (roll <= 0) {
          const pickedFallback = pool[i]
          if (pickedFallback !== undefined) {
            this.notePicked(pickedFallback.uid, now)
            return { uid: pickedFallback.uid, state: pickedFallback }
          }
        }
      }
    } else {
      // ⚠️ 真实 Round-Robin 轮换与负载均衡：
      // 优先选择「最久没有被调用过的健康账号」（notePickedAt 升序排序），
      // 当调用时间戳相同时（如均为 0），按 uid 字符串稳定排序，
      // 确保请求严格在池中多个账号之间均匀交替轮转，
      // 单账号 RPM 严格压低至 1/N，避免单个账号连续承载高频流量导致上游频次瞬间超限。
      // `expiry`（临期优先）：有到期时刻的号按「最早到期」升序排在前面，先烧快过期的积分；
      // 不知道到期时刻（0 / 已过）的号视为最晚，彼此之间仍按最久未用轮换。
      // `roundrobin`：只按最久未用轮换。
      const expiryOf = (s: AccountState): number =>
        strategy === 'expiry' && s.creditsEarliestExpiry > now ? s.creditsEarliestExpiry : Number.POSITIVE_INFINITY
      const sorted = [...pool].sort((a, b) => {
        const ea = expiryOf(a)
        const eb = expiryOf(b)
        if (ea !== eb) return ea < eb ? -1 : 1
        const diff = this.notePickedAt(a.uid) - this.notePickedAt(b.uid)
        return diff !== 0 ? diff : a.uid.localeCompare(b.uid)
      })
      const chosen = sorted[0]
      if (chosen !== undefined) {
        this.notePicked(chosen.uid, now)
        return { uid: chosen.uid, state: chosen }
      }
    }

    // 浮点误差兜底：取最后一个候选（而不是返回 undefined —— 那会被上层误判为「无可用账号」）。
    const last = pool[pool.length - 1]
    if (last === undefined) return undefined
    this.notePicked(last.uid, now)
    return { uid: last.uid, state: last }
  }

  /**
   * 缓存的系统路由与调度配置（避免每次 pick 高频读 storage）。
   */
  private cachedRoutingConfig?: RoutingConfig
  private cachedSafetyConfig?: SafetyConfig

  /**
   * 解密凭据的内存缓存（避免每次对话高频执行 SQLite 读取与 AES-GCM 解密，节约 CPU 预算）。
   */
  private credentialCache = new Map<string, unknown>()

  /**
   * 最近一次选中该账号的时刻（**进程内**，不落存储）。
   *
   * ⚠️ 刻意只在内存里：① 每个 pick 都写存储会白烧 Free 计划的 DO 行写入配额；
   * ② DO 实例被回收后重置「只是少摊开一次」，不是正确性问题
   *（最坏情形退化成原来的加权随机）。
   */
  private recentlyPicked = new Map<string, number>()

  /** 读某账号最近被选中的时刻（从未选中过返回 0 ⇒ 视为「很久没用」）。 */
  private notePickedAt(uid: string): number {
    return this.recentlyPicked.get(uid) ?? 0
  }

  /** 记录该账号刚被选中。 */
  private notePicked(uid: string, now: number): void {
    this.recentlyPicked.set(uid, now)
  }

  /**
   * 读**供应商面板设置**（顺序 + 是否启用）。
   *
   * ## 语义（用户 2026-10-07 明确）
   *
   * - **关闭供应商 = 彻底关掉**：该家的模型从 `/v1/models` 消失、
   *   `/v1/chat/completions` 也拒绝路由到它（故这里是**服务端**状态，
   *   不是浏览器 localStorage —— 后者只在面板生效，API 仍可调用）。
   * - **排序只影响面板展示顺序**，**不**改变默认供应商
   *   （裸模型名仍回落到 `DEFAULT_PROVIDER`）—— 那会悄悄改掉既有请求的路由。
   *
   * ⚠️ 存在 `cn` 分片的 DO 里当**全局**设置用：它描述的是「面板怎么显示」，
   * 与 realm 无关；按 realm 各存一份会让两个分片显示不一致。
   */
  async getProviderSettings(): Promise<{ order: string[]; disabled: string[] }> {
    const raw = await this.ctx.storage.get<{ order?: unknown; disabled?: unknown }>('providerSettings')
    const order = Array.isArray(raw?.order) ? raw!.order.filter((x): x is string => typeof x === 'string') : []
    const disabled = Array.isArray(raw?.disabled)
      ? raw!.disabled.filter((x): x is string => typeof x === 'string')
      : []
    return { order, disabled }
  }

  /** 写供应商面板设置（整体覆盖，调用方负责传完整值）。 */
  async setProviderSettings(input: { order: string[]; disabled: string[] }): Promise<void> {
    await this.ctx.storage.put('providerSettings', {
      order: input.order.filter((x) => typeof x === 'string'),
      disabled: input.disabled.filter((x) => typeof x === 'string'),
    })
  }

  /** 当前路由配置（优先内存缓存，未命中再读 storage）。 */
  private async routingConfig(): Promise<RoutingConfig> {
    return this.cachedRoutingConfig ?? (await this.getRoutingConfig())
  }

  /** 获取系统调度与路由配置。 */
  async getRoutingConfig(): Promise<RoutingConfig> {
    const raw = await this.ctx.storage.get<Partial<RoutingConfig>>('systemRoutingConfig')
    const config: RoutingConfig = {
      strategy: raw?.strategy === 'roundrobin' || raw?.strategy === 'random' ? raw.strategy : 'expiry',
      maxRetries: typeof raw?.maxRetries === 'number' && raw.maxRetries >= 0 && raw.maxRetries <= 10 ? raw.maxRetries : 3,
      softCooldownSeconds: typeof raw?.softCooldownSeconds === 'number' && raw.softCooldownSeconds >= 10 && raw.softCooldownSeconds <= 3600 ? raw.softCooldownSeconds : 60,
      autoTaskCron: raw?.autoTaskCron !== false,
      autoRefreshCredential: raw?.autoRefreshCredential !== false,
    }
    this.cachedRoutingConfig = config
    return config
  }

  /** 更新系统调度与路由配置。 */
  async setRoutingConfig(input: Partial<RoutingConfig>): Promise<RoutingConfig> {
    const cur = await this.getRoutingConfig()
    const next: RoutingConfig = {
      strategy: input.strategy === 'roundrobin' || input.strategy === 'random' || input.strategy === 'expiry' ? input.strategy : cur.strategy,
      maxRetries: typeof input.maxRetries === 'number' && input.maxRetries >= 0 && input.maxRetries <= 10 ? input.maxRetries : cur.maxRetries,
      softCooldownSeconds: typeof input.softCooldownSeconds === 'number' && input.softCooldownSeconds >= 10 && input.softCooldownSeconds <= 3600 ? input.softCooldownSeconds : cur.softCooldownSeconds,
      autoTaskCron: typeof input.autoTaskCron === 'boolean' ? input.autoTaskCron : cur.autoTaskCron,
      autoRefreshCredential: typeof input.autoRefreshCredential === 'boolean' ? input.autoRefreshCredential : cur.autoRefreshCredential,
    }
    await this.ctx.storage.put('systemRoutingConfig', next)
    this.cachedRoutingConfig = next
    return next
  }

  /** 获取防封配置（未存过 ⇒ 回落到环境变量，见 {@link SafetyConfig} 的说明）。 */
  async getSafetyConfig(): Promise<SafetyConfig> {
    if (this.cachedSafetyConfig !== undefined) return this.cachedSafetyConfig
    const raw = await this.ctx.storage.get<Partial<SafetyConfig>>('systemSafetyConfig')
    const envMax = resolveMaxContextMessages(this.env)
    const envBurn = resolveBurnRate(this.env)
    // 只接受范围内的有限数：越界/非数一律当「没存」，回落默认。
    // ⚠️ 不能用 `||`：`0` 是合法且**有意义**的值（不限制 / 关闭 / 不限速）。
    const num = (v: unknown, min: number, max: number): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined
    const config: SafetyConfig = {
      // ⚠️ 只认显式 `false` 才算关；`undefined` / 非法值都保持开启。
      sessionTrace: raw?.sessionTrace !== false,
      // 同上：只认显式 `false`。默认开启以保持既有行为不变
      //（升级后突然「全部冷却消失」会让持续 429 的场景每次请求都白打一次）。
      modelCooldownEnabled: raw?.modelCooldownEnabled !== false,
      maxContextMessages: num(raw?.maxContextMessages, 0, 100_000) ?? envMax,
      burnRateWindowMs: num(raw?.burnRateWindowMs, 0, 86_400_000) ?? envBurn.windowMs,
      burnRateThresholdPct: num(raw?.burnRateThresholdPct, 0, 100) ?? envBurn.thresholdPct,
      // 限速与抖动：面板未存值时**回落环境变量**（`RATE_LIMIT_QPS` / `RATE_JITTER_MS`）。
      //
      // ## 优先级（实测踩过坑，务必按这个顺序理解）
      //   1. 面板存过的值（`systemSafetyConfig`）—— **最高优先，环境变量改不动它**
      //   2. 没存过才用环境变量
      //   3. 都没有才是 0（关闭）
      //
      // ⚠️ **这是最容易误判的一层**：我在排查「配了 `RATE_LIMIT_QPS=0.5` 却不生效」时，
      // 先怀疑了构建产物、DO 生命周期、`this.env` 可见性，全都不是。真实原因是
      // 数据库里**早就存了** `systemSafetyConfig`（含 `rateLimitQps: 0`），
      // `num(raw?.rateLimitQps, ...)` 返回 0 且 0 是合法值，于是**永远不会**走到回落。
      //
      // 教训：限速不生效时**先查面板配置（`GET /admin/config/safety`）**，
      // 而不是查环境变量或代码路径 —— 面板值会静默覆盖环境变量。
      //
      // ⚠️ 这里原先写死 `?? 0`，注释理由是「环境变量里没有对应项」。那在当时是事实，
      // 但后果是：一旦 `systemSafetyConfig` 不存在（新部署），限速就**只能是关的**。
      // 与同函数的 maxContextMessages / burnRate* 保持同一口径，限速不该是例外。
      rateLimitQps: num(raw?.rateLimitQps, 0, 50) ?? resolveRateLimitQps(this.env),
      rateJitterMs: num(raw?.rateJitterMs, 0, 10_000) ?? resolveRateJitterMs(this.env),
    }
    this.cachedSafetyConfig = config
    return config
  }

  /**
   * 更新防封配置（**只写调用方真正提供的字段**）。
   *
   * 🔴 **不能一次写全六个字段**（2026-10-21 审查补，配置健壮性专项）。
   *
   * ## 缺陷
   * 原实现把六个字段**全部**算好再整体写入 —— 其中没提供的用 `cur` 顶替，
   * 而 `cur` 是「已存值 ?? 环境变量」的合并结果。于是：
   * 用户只要在面板点一下「会话链」开关，就把当时的**环境变量值**（常常还是 `0`）
   * 固化进 `systemSafetyConfig`；此后 `num(stored)` 恒命中，`?? resolve*()` 永不执行
   * ⇒ **环境变量被一个 UI 点击永久冻结，且零提示**。
   *
   * 实测（真 DO + 真 SQLite）：
   * ```
   * 面板保存 {"sessionTrace":true} 写成 rateLimitQps=0
   * 之后把 env 改成 "0.5" 并重读：rateLimitQps=0   ⚠️ 被压住
   * ```
   * 用户视角就是「我设了 0.5，面板显示 0」。
   *
   * ## 修法
   * 只把**本次显式提供的合法字段**落到存储；没提到的字段**不写**
   * ⇒ 它们继续走环境变量回落，改动 env 立刻生效。
   */
  async setSafetyConfig(input: Partial<SafetyConfig>): Promise<SafetyConfig> {
    const stored = (await this.ctx.storage.get<Partial<SafetyConfig>>('systemSafetyConfig')) ?? {}
    const next: Partial<SafetyConfig> = { ...stored }
    const num = (v: unknown, min: number, max: number): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined
    const rejected: string[] = []

    // ⚠️ 布尔字段统一走这张表。
    //
    // ## 为什么必须抽成表（2026-10-22，我自己刚踩）
    // 加 `modelCooldownEnabled` 时若只加到 `getSafetyConfig()`（读侧）就完事，
    // 写侧这里是一条条 `if (input.sessionTrace !== undefined)` 手写的 ——
    // 新字段**会被静默丢弃**：`POST /admin/config/safety` 回 `ok:true`、
    // GET 回显还是旧值，而用户以为「已经关了」。
    // ⇒ 这正是本项目最反复的一类缺陷（同一语义两处判据）。故此表是**唯一**入口。
    for (const key of ['sessionTrace', 'modelCooldownEnabled'] as const) {
      if (input[key] === undefined) continue
      if (typeof input[key] === 'boolean') next[key] = input[key]
      else rejected.push(key)
    }
    for (const [key, min, max] of [
      ['maxContextMessages', 0, 100_000],
      ['burnRateWindowMs', 0, 86_400_000],
      ['burnRateThresholdPct', 0, 100],
      ['rateLimitQps', 0, 50],
      ['rateJitterMs', 0, 10_000],
    ] as const) {
      const raw = input[key]
      if (raw === undefined) continue
      const v = num(raw, min, max)
      if (v === undefined) rejected.push(key)
      else next[key] = v
    }

    if (rejected.length > 0) {
      // ⚠️ 越界值**不静默**：以前是「保持原值 + 回 ok:true」，脚本会误判成功。
      console.warn(`[safety] 以下字段越界或非数，已忽略：${rejected.join(', ')}`)
    }

    await this.ctx.storage.put('systemSafetyConfig', next)
    // ⚠️ 必须清缓存：合并结果（stored ?? env）变了，不复算的话本实例继续用旧值。
    this.cachedSafetyConfig = undefined
    return await this.getSafetyConfig()
  }

  /** 账号池计数摘要（供 `/healthz` 与面板）。 */
  async counts(realm: string, now: number): Promise<{
    total: number
    healthy: number
    disabled: number
    cooling: number
    modelExempt: number
  }> {
    const raws = listAccounts(this.ctx.storage.sql, realm)
    let healthyCount = 0
    let disabled = 0
    let cooling = 0
    let exempt = 0

    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      // ⚠️ 解析失败（数据损坏）时跳过该条，而不是让整个列表 500
      if (state === undefined) continue
      // 供应商不匹配的直接跳过（不同家的凭据/协议完全不同）
      pruneExpired(state, now, MODEL_COST_TTL_MS)
      if (state.disabled) {
        disabled += 1
        continue
      }
      // ⚠️ 判定顺序有语义：**先判模型级限流**，再判整体健康。
      //
      // 根因（线上实测踩到）：`healthy()` 只看账号级的四个维度
      // （until / breakerUntil / degradeUntil / disabled），**不看** modelCooldowns。
      // 而 `modelExempt()` 要求「账号级健康 且 存在未过期的模型冷却」。
      // 于是「账号健康但有模型在冷却」时**两个都返回 true** ——
      // 若先判 healthy，模型限流就永远统计不到（面板恒为 0）。
      //
      // 语义上正确：该账号对**部分模型**不可用，不该算「完全健康」。
      if (modelExempt(state, now)) {
        exempt += 1
      } else if (healthy(state, now)) {
        healthyCount += 1
      } else {
        cooling += 1
      }
    }

    return { total: raws.length, healthy: healthyCount, disabled, cooling, modelExempt: exempt }
  }

  /** 读会话粘性绑定。 */
  async getSession(key: string, now: number): Promise<string | undefined> {
    return readSession(this.ctx.storage.sql, key, now)
  }

  /** 写会话粘性绑定（滚动续期）。 */
  async bindSession(key: string, uid: string, now: number, ttlMs = DEFAULT_SESSION_TTL_MS): Promise<void> {
    writeSession(this.ctx.storage.sql, key, uid, now + ttlMs)
  }

  /** 解绑会话（绑定的账号失败时调用）。 */
  async unbindSession(key: string): Promise<void> {
    deleteSession(this.ctx.storage.sql, key)
  }

  /**
   * 清理过期会话（`sessions` + `login_sessions`），返回总清理条数。
   *
   * 🔴 **这个方法此前零调用者**（2026-10-21 审查补，M6 指出）：
   * 两个 pruner 都实现好了，却没有任何地方调用 ⇒ **`sessions` 表只增不减**，
   * 浏览器每次登录都插一行，永不过期删除。长期运行后查询变慢、库文件膨胀。
   *
   * 现在由 `scheduled()` 每小时调一次（见 `src/index.ts` 的注释）。
   * 它顺带也有 `pruneLoginSessions` 的用途 —— 登录会话同样是只增不减。
   */
  async pruneStaleSessions(now: number): Promise<number> {
    return pruneSessions(this.ctx.storage.sql, now) + pruneLoginSessions(this.ctx.storage.sql, now)
  }

  /** 清理过期会话（保留旧名，兼容既有调用）。 */
  async pruneSessions(now: number): Promise<number> {
    return pruneSessions(this.ctx.storage.sql, now)
  }

  /**
   * 记录一次失败，按**错误类别**落到正确的维度。
   *
   * ⚠️ 这里刻意做成**一个显式入参的入口**，而不是「一个通用的 punish()」：
   * 错误分类（AGENTS.md §6.7）决定罚哪个维度，混在一起必然误伤。
   */
  async applyFailure(input: {
    uid: string
    kind: 'soft' | 'hard' | 'breaker' | 'degrade' | 'session_dead' | 'model' | 'restricted'
    now: number
    /** `kind === 'model'` 时的目标模型。 */
    model?: string
    /** 上游给出的重置时刻（epoch ms），优先于本地退避计算。 */
    resetAt?: number
    reason?: string
    /**
     * 模型级失败的**结构化成因**。
     *
     * ⚠️ 不要靠 `reason` 文案反推（旧实现就是这么错的：`includes('not found')`
     * 把一堆无关文案也判成「模型不存在」，一次误判锁 6 小时）。
     * 调用方在拿到 `classify()` 的 `kind` 时就已知道语义，直接传进来。
     *
     * - `'absent'`  —— 上游确证无此模型（11102 `service info not found`）
     * - `'denied'`  —— 模型存在但账号档位不支持（11158 `not allowed for user type`）
     * - `'busy'`    —— 模型繁忙/限频（6004 / 14003）
     */
    modelCause?: 'absent' | 'denied' | 'busy'
  }): Promise<{ disabled: boolean }> {
    // 软冷却起步时长来自路由配置（默认 60 秒）。⚠️ 在读账号**之前**取，
    // 避免「读账号 → await → 写回」之间插入别的写。
    const softBaseMs = input.kind === 'soft' ? (await this.routingConfig()).softCooldownSeconds * 1000 : 60_000
    const raw = readAccount(this.ctx.storage.sql, input.uid)
    if (raw === undefined) return { disabled: false }
    const state = normalizeAccountState(JSON.parse(raw))
    if (state === undefined) return { disabled: false }
    const { now } = input

    /**
     * 🔴 **统一的失败记账日志**（这是排查「账号莫名进冷却」的唯一可靠依据）。
     *
     * ## 为什么必须加在这里
     * 全项目的 `applyFailure` 调用点有 **12 处**（gateway/server.ts），
     * 但其中**只有 3 处**带日志。于是无论哪条路径触发冷却，用户都**看不到任何记录** ——
     * 表现为「账号明明能用，却突然 503 说在冷却中」，而我只能靠猜。
     *
     * 放在这里而不是各调用点：**一处覆盖全部路径**，不会再「只修一半」。
     *
     * ## 怎么读这条日志
     * - `kind=soft` + `model=` 空 ⇒ 账号级软冷却（**这就是误判的症状**）
     * - `kind=model`            ⇒ 只冷却该模型，不罚账号（正常）
     * - `reason` 里带 `rate_limited: ...` ⇒ 上游返回了限流类错误码
     *
     * 若 `kind=soft` 但 `reason` 里的上游原文根本不像限流 ⇒ **分类错了**，要改 `classify`。
     */
    console.warn(
      `[punish] uid=${input.uid.slice(0, 8)} kind=${input.kind}` +
        `${input.model !== undefined && input.model !== '' ? ` model=${input.model}` : ''}` +
        ` reason=${(input.reason ?? '').slice(0, 160)}`,
    )

    switch (input.kind) {
      case 'hard': {
        // 余额耗尽：冷却到次日 04:00（UTC+8）。
        //
        // 恢复方式三种（`tests/hard-recovery.test.ts` 钉住第一条）：
        //   1. **余额刷新确认余额 > 0** ⇒ {@link clearHardIfRecovered} 立刻清掉；
        //   2. 等次日 04:00 自然到期；
        //   3. 面板点「解冻」（`clearCooldowns`，清全部维度）。
        //
        // ⚠️ 第 1 条曾长期只写在注释里、全仓从未实现（2026-10-21 审查发现）：
        // 原注释声称「签到后余额恢复会自动解冻」，但 `updateBalance` 刻意
        // 「绝不动惩罚态」（否则 cron 每轮刷余额都会偷偷解冻，探测数据一抖
        // 账号就反复解冻/锁定），于是充值后仍被锁到 04:00 —— 用户只能干等到次日。
        // 现在改由**独立一步**在余额落盘之后显式判定，且**只清这一维**。
        state.until = nextDay4AmUtc8(now)
        state.coolKind = 'hard'
        state.reason = input.reason ?? 'credit exhausted'
        break
      }
      case 'soft': {
        // 🔴 当前是「余额耗尽（hard）」且仍在冷却期内 ⇒ 本次 soft 失败**一个字都不许改**。
        //
        // ## 缺陷（2026-10-21 审查，`AccountPoolDO.ts:1141`）
        //
        // 下面第一行是无条件赋值，于是「因 402 余额耗尽被锁到次日 04:00」的账号，
        // 只要再来一次普通 429 失败，`coolKind` 就被改写成 `'soft'` ——
        // 面板从「余额耗尽」变成「临时冷却」，`/admin/accounts/diagnose` 说
        // 「账号冷却中（限流），还剩 40 分钟」，而真实恢复时刻仍是次日 04:00。
        // 用户按「等一分钟」去处理，永远等不到 —— 这比不显示更糟。
        //
        // 更隐蔽的一层：若这次 soft 带上游重置墙钟（`resetAt`），下面会把
        // `until` **提前缩短**到那个墙钟，于是「余额问题」凭空变成一次短冷却。
        //
        // 全仓此前只有 `enforceBurnRate` 挡了一处（同一个判据），这就是
        // 「同一个概念两处判据、只修一处」的典型 ⇒ 现在统一走
        // {@link hardCooldownActive}，两处（以及解冻判定）共用同一份判据。
        //
        // ⚠️ `reason` 也保持不动：冷却域的 `reason` 会被面板当作「冷却原因」展示，
        // 留下 `credit exhausted` 与 `coolKind='hard'` 才是自洽的一对；
        // 若改成 `rate limited`，界面就会出现「余额耗尽（rate limited）」这种自相矛盾。
        // ⚠️ `softStreak` 也不推进：它不是 soft 冷却，不该累计退避档位。
        if (hardCooldownActive(state, now)) break
        state.coolKind = 'soft'
        state.reason = input.reason ?? 'rate limited'
        // 有上游重置墙钟就对齐它，否则按连续次数指数退避（封顶 30 分钟）。
        //
        // ⚠️ 上游墙钟**必须钳制**（见 `MAX_RESET_AHEAD_MS`）：否则一个解析跑偏的
        // 远期时刻就能把账号锁到任意远，而本地退避本身是有上限的 ——
        // 「本地封顶、上游不封顶」这种不对称正是漏洞来源。
        if (input.resetAt !== undefined && input.resetAt > now) {
          state.until = Math.min(input.resetAt, now + MAX_RESET_AHEAD_MS)
        } else if (!isActive(state.until, now)) {
          state.softStreak += 1
          // 起步时长 = 路由配置 `softCooldownSeconds`（默认 60 秒，对齐上游「Wait about a minute」），之后逐次翻倍、封顶 30 分钟
          const backoff = Math.min(softBaseMs * 2 ** (state.softStreak - 1), 30 * 60 * 1000)
          state.until = now + backoff
        }
        // ⚠️ 「已在冷却中」时**不推进不延长**（Go 侧 `cooldown.go:321`）——
        // 那会让一个持续失败的号被无限推远。
        break
      }
      // `11140` 账号级限制：上游明说 "this account has been restricted"，
      // **第一次就生效**，且固定 2 小时（对齐 workbuddy2api-hub #422 的
      // `restrictedUntil`；社区复盘给的官方口径是「1-3 工作日自动解除」，
      // 2 小时只是保守的重试间隔，真正解除靠上游）。
      //
      // ⚠️ 为什么不能用 `breaker`：breaker 要**连续 3 次**失败才冷却，而 11140
      // 是账号级封禁 —— 前 2 次会继续把请求打到一个已被封的号上，期间如果发生
      // 换号（默认已禁止），被牵连的号会更多。账号级限制必须一次即罚。
      case 'restricted': {
        // ⚠️ 用 `Number.isFinite` 兜一层：`Math.max(NaN, x)` 是 NaN，
        // 写进库再读回就成了 0 —— 惩罚被静默吞掉，比不罚更危险（以为罚了）。
        const prevRestricted = Number.isFinite(state.restrictedUntil) ? state.restrictedUntil : 0
        state.restrictedUntil = Math.max(prevRestricted, now + RESTRICTED_HOLD_MS)
        break
      }
      case 'breaker': {
        state.fails += 1
        if (state.fails >= 3) {
          state.breakerUntil = now + Math.min(30 * 60 * 1000 * 2 ** state.retryCount, 6 * 60 * 60 * 1000)
          state.retryCount += 1
          state.fails = 0
        }
        break
      }
      case 'degrade': {
        state.consecutiveFails += 1
        if (state.consecutiveFails >= 5) {
          state.degradeUntil = now + 10 * 60 * 1000
          state.consecutiveFails = 0
        }
        break
      }
      case 'session_dead': {
        // ⚠️ 连续 3 次才禁用：单次 12153 多为网络抖动，一次就杀号会误杀健康账号
        // （Go 侧 `state.go:27-40` 记录过 P0 事故：13 个 disabled 号 refresh 全部成功）。
        state.sessionDeadFails += 1
        if (state.sessionDeadFails >= 3) {
          state.sessionDeadFails = 0
          state.disabled = true
          state.reason = 'session dead (12153 ×3)'
        }
        break
      }
      case 'model': {
        const model = input.model ?? ''
        if (model === '') break
        /**
         * 🔴 **模型级冷却总开关**（用户 2026-10-22 要求：「实际上完全没有冷却」）。
         *
         * 关掉时**什么都不写**：不建条目、不动 `modelConfirm`。
         *
         * ⚠️ 为什么连 `modelConfirm` 也不涨：那是「这个模型确实不存在」的
         * **坐实计数**，只在冷却阶梯里有意义。冷却关了还继续累加，等到某天
         * 用户重新打开开关，这些陈年计数会让第一次失败直接吃到封顶 24 小时 ——
         * 也就是"关开关期间的表现"污染了"开开关之后的行为"。
         */
        if (!(await this.getSafetyConfig()).modelCooldownEnabled) {
          console.log(`[punish] 模型冷却已关闭，跳过记账 uid=${input.uid} model=${model}`)
          break
        }
        // ⚠️ 先剪枝再读 `hits`：否则一个**已自然到期**的旧冷却会让本次新失败
        // 从上次的陈旧 `hits` 继续往上叠（11102 路径 6h→12h→24h），使一次新
        // 失败直接吃到封顶退避。`state.ts` 明确要求 `hits` 从新鲜基数重新学习。
        pruneExpired(state, now, MODEL_COST_TTL_MS)
        const prev = state.modelCooldowns[model]
        // ⚠️ 坐实次数取自**账号级** `modelConfirm`，不是冷却条目里的 `hits`。
        // 原因：`pruneExpired` 会把过期条目整体删掉，`hits` 随之归零，
        // 于是「短观察窗 → 长冷却」的阶梯**永远不会升级**（实测踩到）。
        const confirmed = (state.modelConfirm[model] ?? 0) + 1
        const hits = confirmed
        // ═══════════════════════════════════════════════════════════════════
        // 「验证式冷却」—— 一次失败**绝不**直接锁长冷却
        // ═══════════════════════════════════════════════════════════════════
        //
        // ## 旧策略的错在哪（2026-10-20 实测事故）
        //
        // 旧实现只要 `reason` 里出现 `'not found'`，就按 11102 处理：**一次失败锁 6 小时**
        // （`hits=1` 即 `6h * 2^0`）。当天实测后果：
        //   - `default-model` / `deepseek-v4.1-flash-sg` 被锁 5.56h，
        //     而它们**连续 3 次真实调用全部 200** —— 纯粹误杀；
        //   - `'not found'` 是个过宽的字符串匹配：任何含该词的文案都会命中，
        //     包括那批失败的**根因是模型名前缀拼错**的场景（AGENTS.md §9 事故）。
        //
        // ## 新策略：先短锁、再坐实
        //
        // 一次模型级失败**只短锁**（busy 15s / 存疑 2 分钟），让账号立刻还有机会被复查：
        //   - `busy`（6004/14003）：15s 起、封顶 90s —— 实测国际服约 8 秒一发即不撞；
        //   - `absent` / `denied`：**首次也只锁 2 分钟**（不是 6 小时）；
        //     若上游确实没有该模型，2 分钟后必然**再次失败**并 `hits+1`，
        //     此时才逐级升到 30 分钟 → 2 小时 → 6 小时（封顶 24 小时）。
        //
        // ⇒ 「真不存在」的模型会在 10 分钟内自然收敛到长冷却（代价：多几次无效探测）；
        //   「其实可用」的模型则最多受影响 2 分钟就自动恢复（旧策略是 5.56 小时）。
        //
        // 额外好处：不需要探测线程、不需要额外状态字段 —— 复用失败计数本身即验证。
        //
        // ⚠️ `denied`（11158 档位不支持）虽然语义确定，仍走同一阶梯：
        //   因为换号后**别的档位账号可能可用**，一次锁死会让整个模型在全池消失。
        const cause = input.modelCause ?? 'busy'
        let fallbackCooldown: number
        if (cause === 'busy') {
          // 6004 / 14003 模型繁忙：短退避，快速自愈。
          // 原实现 60s 起、封顶 10 分钟，实测窗口只有 8~12 秒 ⇒ 白白关掉整池。
          fallbackCooldown = Math.min(15_000 * 2 ** Math.min(hits - 1, 3), 90_000)
        } else {
          // absent / denied：**阶梯式**坐实。hits=1 时只锁 2 分钟作观察窗。
          const LADDER = [
            2 * 60 * 1000, // 第 1 次：2 分钟（观察窗，误判代价极低）
            30 * 60 * 1000, // 第 2 次：30 分钟（基本坐实）
            2 * 60 * 60 * 1000, // 第 3 次：2 小时
            6 * 60 * 60 * 1000, // 第 4 次：6 小时
            24 * 60 * 60 * 1000, // 第 5 次起：24 小时封顶
          ] as const
          // 取第 `hits` 级（从 0 起），越界则取最后一档（24h 封顶）
          const tier = Math.min(hits - 1, LADDER.length - 1)
          if (tier <= 0) fallbackCooldown = LADDER[0]
          else if (tier === 1) fallbackCooldown = LADDER[1]
          else if (tier === 2) fallbackCooldown = LADDER[2]
          else if (tier === 3) fallbackCooldown = LADDER[3]
          else fallbackCooldown = LADDER[4]
          if (input.modelCause === 'denied') {
            // 档位拒绝是确定性的 ⇒ 观察窗可以更短（90s），但仍不一次锁死。
            fallbackCooldown = Math.min(fallbackCooldown, hits === 1 ? 90_000 : fallbackCooldown)
          }
        }
        // ⚠️ 同样必须钳制（见 `MAX_RESET_AHEAD_MS`）：模型级冷却若被上游
        // 一个远期时刻拉长，该模型会长期不可用，而账号看起来「健康」——
        // 用户只会觉得「这个模型坏了」，完全看不出是冷却没上限。
        const until =
          input.resetAt !== undefined && input.resetAt > now
            ? Math.min(input.resetAt, now + MAX_RESET_AHEAD_MS)
            : now + fallbackCooldown
        state.modelCooldowns[model] = {
          until,
          resetAt: input.resetAt ?? 0,
          reason: input.reason ?? 'model cooldown',
          hits,
          confirmed,
          cause,
          auditOnly: false,
        }
        state.modelConfirm[model] = confirmed
        break
      }
    }

    state.errTotal += 1
    state.lastErr = now
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    return { disabled: state.disabled }
  }

  /**
   * 记录一次成功：清熔断与降权；**仅清除「过期或弱证据」的模型冷却**。
   *
   * ## 为什么不再一刀切「完全不碰 modelCooldowns」
   *
   * 原来的理由是「一次成功不能证明某个模型已解除限流」（Go 侧 `state.go:141-144`），
   * 这对**限频类**（busy）是成立的 —— 换个模型能跑通，不代表原模型不忙。
   *
   * 但那条规则被套用到了 `absent` / `denied` 上就产生了死锁：
   * 一次**误判**写入的「模型不存在」会钉死 6 小时，而期间哪怕该模型**一直在成功**，
   * 也永远清不掉 —— 用户看到的就是「账号明明是好的，但就是用不了」（2026-10-20 事故）。
   *
   * ⇒ 现在按**证据强度**分治：
   *   - `busy`：**不动**。限频是随时间的，成功一次不构成解除证据；
   *   - `absent` / `denied`：**真实成功即清除**。成功本身就是最强反证 ——
   *     一个刚被 200 走通的模型，绝不可能「不存在」。
   *
   * ⚠️ 读账号走 {@link readState}（`JSON.parse` + `normalizeAccountState`）。
   * 原来是裸的 `JSON.parse(raw) as AccountState` —— 升级前落盘的记录缺新字段时，
   * 这里会把**整体对象原样写回**，缺的字段永远是 `undefined`（详见 `readState` 的说明）。
   */
  async noteSuccess(
    uid: string,
    now: number,
    usage?: { input: number; output: number },
    /** 本次成功实际使用的模型名（用于反证对应的模型冷却）。 */
    model?: string,
  ): Promise<void> {
    const state = this.readState(uid)
    if (state === undefined) return

    state.successCount += 1
    state.lastSuccess = now
    state.fails = 0
    state.retryCount = 0
    state.breakerUntil = 0
    state.softStreak = 0
    state.sessionDeadFails = 0
    state.consecutiveFails = 0
    state.degradeUntil = 0

    if (usage !== undefined) {
      state.tokenUsage.input += usage.input
      state.tokenUsage.output += usage.output
    }

    // 用「真实成功」反证弱证据的模型冷却（见上方注释）。
    if (model !== undefined && model !== '') {
      const mc = state.modelCooldowns[model]
      // 真实成功是「该模型可用」的最强证据 ⇒ 清掉弱证据冷却并重置坐实计数。
      if (mc !== undefined && (mc.cause === 'absent' || mc.cause === 'denied')) {
        delete state.modelCooldowns[model]
      }
      if (mc === undefined || mc.cause === 'absent' || mc.cause === 'denied') {
        delete state.modelConfirm[model]
      }
    }

    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
  }

  /**
   * 更新账号的**余额快照**（只写额度三元组 + 采样史，**不碰任何惩罚态**）。
   *
   * ## 为什么不能用 `revive()` 代替
   *
   * `revive()` 的语义是「解冻」—— 它会清空冷却、熔断、降权、模型冷却。
   * 拿它来同步余额会**顺手把惩罚态全清掉**，等于每次刷新都偷偷解冻所有账号，
   * 熔断机制形同虚设。
   *
   * ## 为什么必须有这个方法
   *
   * `credits` / `creditsExpiring` / `creditsEarliestExpiry` 三个字段此前
   * **只在 `revive()` 里写入**，正常流程无刷新入口 ⇒ 它们恒为初始值 0。后果：
   *   1. 面板上所有账号都显示「0 积分」，与上游真实余额完全脱节；
   *   2. `random` 策略的加权 `1 + credits/100` 退化成等权；
   *   3. **永久积分锁**的判据 `credits > 0` 永不命中 ⇒ 锁形同虚设，
   *      本该被拦下的「只剩永久额度」账号照样被选中、照样烧不可撤回的积分；
   *   4. `expiry` 策略（默认）依赖 `creditsExpiring` 排序 ⇒ 键全等，
   *      退化成按 uid 轮转，没有实现它名字承诺的「临期先烧」。
   *
   * ## 消耗速率异常熔断（`burn-rate.ts`）
   *
   * 这里是**唯一**的采样入口：每次刷新把 `{at, credits}` 追加进 `state.samples`
   *（上限 6 条），然后判「窗口内烧掉的比例」是否 ≥ 阈值。
   * 命中时**复用现有软冷却**（`applyFailure({kind:'soft'})`）而**不是**新造一套惩罚态 ——
   * 这样「到期自动恢复」「已在冷却中不延长」「面板显示原因」全都自动一致，
   * 不会出现两套机制互相拆台（本项目吃过「同一个概念两处判据」的亏多次）。
   *
   * ⚠️ 顺序是**先写余额与采样，再判速率**：判定读的必须是刚刚落盘的那条采样，
   * 否则会一直拿「上一次的余额」当终点，永远差一拍。
   *
   * @param credits   可用总额；`undefined` 表示本次没查到，**保持原值**（不清零）
   * @param expiring  快过期子集（0 = 无）
   * @param earliest  最早过期时刻（0 = 无）
   */
  async updateBalance(
    uid: string,
    now: number,
    balance: { credits: number; expiring: number; earliestExpiry: number },
  ): Promise<boolean> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    if (raw === undefined) return false
    const state = normalizeAccountState(JSON.parse(raw))
    if (state === undefined) return false

    // ⚠️ 只改额度与采样。**绝不动** until / breakerUntil / degradeUntil /
    // modelCooldowns / disabled / fails —— 那是惩罚态，与余额无关。
    const credits = Math.max(0, Math.trunc(balance.credits))
    state.credits = credits
    state.creditsExpiring = Math.max(0, Math.trunc(balance.expiring))
    state.creditsEarliestExpiry = Math.max(0, Math.trunc(balance.earliestExpiry))
    state.samples = appendBalanceSample(state.samples, now, credits)

    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)

    await this.enforceBurnRate(state, now)
    return true
  }

  /**
   * 按**已落盘**的采样史判一次消耗速率，异常则软冷却。
   *
   * ⚠️ 必须单独成一个方法而不是内联进 `updateBalance`：`applyFailure` 内部
   * 会**重新读**账号再整体写回，与 `updateBalance` 的「读-改-写」不是同一次事务。
   * 分开写让这条「写完再判」的时序在代码上就看得见，不会被后人误合并成一次读改写。
   */
  private async enforceBurnRate(state: AccountState, now: number): Promise<void> {
    // ⚠️ 读**面板配置**而不是环境变量：面板改完要能立刻生效，
    // 否则「关掉熔断」还得重启容器，用户会以为开关坏了。
    const safety = await this.getSafetyConfig()
    const config = { windowMs: safety.burnRateWindowMs, thresholdPct: safety.burnRateThresholdPct }
    // 关闭时直接返回：连判定函数都不进，省掉每条账号一次遍历。
    if (config.windowMs <= 0 || config.thresholdPct <= 0) return

    // ⚠️ 已在**硬冷却**（余额耗尽，直到次日 04:00）时不再判：软冷却分支会把
    // `coolKind` 从 `hard` 改写成 `soft`，等于把「没钱」降级成「被限流」，
    // 而 `until` 仍指向次日 —— 状态自相矛盾。余额为 0 时也谈不上「烧太快」。
    //
    // ⚠️ 判据统一走 `hardCooldownActive()`，**不要在这里手抄一遍**
    //（`applyFailure` 的 soft 分支与 `clearHardIfRecovered` 用的是同一份）——
    // 手抄判据 = 等着下次改判据时再漏一处，本仓库已经因此踩过多次。
    if (hardCooldownActive(state, now)) return

    const trip = detectBurnRate(state.samples, now, config)
    if (trip === undefined) return

    // 已在冷却中就不再刷日志（整点 cron 会在同一窗口内重复命中同一批采样）。
    // 冷却本身仍交给 `applyFailure` —— 它对「已冷却」是幂等的（不推进、不延长）。
    if (!isActive(state.until, now)) {
      // ⚠️ 日志只放 uid **前 8 位**与额度数字，**不含任何凭据**。
      console.warn(
        `[burn] 消耗速率异常：账号 ${state.uid.slice(0, 8)}… 在 ${Math.round(trip.windowMs / 1000)}s 内` +
          `消耗 ${trip.burned} 积分（${trip.pct}%），起点 ${trip.fromCredits} → 现 ${trip.credits}，已软冷却`,
      )
    }

    // 复用现有软冷却：`until` + `coolKind='soft'` + `softStreak` 指数退避，
    // 到期自动恢复，无需在这里另写恢复逻辑。
    await this.applyFailure({
      uid: state.uid,
      kind: 'soft',
      now,
      reason: `credits burn ${trip.pct}% / ${Math.round(trip.windowMs / 1000)}s`,
    })
  }

  /**
   * 解冻账号（面板「解冻」/ 导入新凭据后重置）。清全部惩罚态，但不动 `disabled`。
   *
   * ⚠️ 注释里原先还写着「签到后余额恢复」—— 那条路径**从未实现**，也不要在这里实现：
   * 「余额恢复」只该清 **`hard` 一维**（见 {@link clearHardIfRecovered}），
   * 而 `revive` 会把熔断/降权/模型冷却一起清掉。用 `revive` 做余额恢复
   * 等于「充了钱就顺手抹掉所有真实故障的观测」。
   *
   * ⚠️ 读账号走 {@link readState}（原来裸 `JSON.parse`，缺字段会随整体写回被固化）。
   */
  async revive(uid: string, now: number, credits?: number): Promise<boolean> {
    const state = this.readState(uid)
    if (state === undefined) return false

    state.until = 0
    state.coolKind = ''
    // ⚠️ **`reason` 是共用字段**：它同时承载「冷却原因」与「停用原因」
    //（`state.ts` 里 `disabled` 的注释就写着 reason 是停用原因）。
    // 无条件清空会把「已被手动停用」「session dead (12153 ×3)」这类真实故障
    // 从面板 hint 上抹掉 —— 账号明明还停着，却看不到为什么。
    // ⇒ 只在**没被停用**时才清；停用原因必须留着。
    if (!state.disabled) state.reason = ''
    state.softStreak = 0
    state.breakerUntil = 0
    state.retryCount = 0
    state.fails = 0
    state.degradeUntil = 0
    state.consecutiveFails = 0
    state.sessionDeadFails = 0
    state.modelCooldowns = {}
    /**
     * ⚠️ **`restrictedUntil` 必须一起清**（S9，2026-10-22）。
     *
     * `revive` 的语义是「人工判定这个号是好的，重新开始」——面板「解冻」与
     * 「重新导入凭据」都走它。原来清了 until / breaker / degrade / model，
     * **唯独漏了 `restrictedUntil`**（11140 上游封号标记）⇒ 用户点完「解冻」，
     * 面板显示正常，账号却仍被 `healthy()` 排除 —— 又一例「状态看着对、行为不对」。
     *
     * ⚠️ 与 `setAccountDisabled` 无关：`disabled` 不在本方法里动（见上面的 `reason` 守卫）。
     */
    state.restrictedUntil = 0
    // ⚠️ **必须一起清空采样历史**：revive 的语义是「人工判定这个号是好的，解冻」。
    // 若不清，上一轮触发熔断前的高消耗采样仍在观察窗口内（默认 1 小时），
    // 下一次 `updateBalance` 会拿它当基准**立刻再锁一次** ——
    // 用户会看到「点了解冻，一分钟后又被锁」，且找不到原因。
    state.samples = []
    if (credits !== undefined) state.credits = credits

    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    return true
  }

  /**
   * **余额恢复 ⇒ 解冻 `hard`（402 余额耗尽）冷却**。
   *
   * ## 🔴 缺陷（2026-10-21 审查：这条能力曾只存在于注释里）
   *
   * `applyFailure` 的 `hard` 分支注释、`state.ts` 的维度表、`plans.ts:90` 与
   * `actions.ts:144` 都写着「余额恢复的冷却账号由调用方解冻」/「签到后余额恢复会自动解冻」，
   * 但全仓**从未实现**那条路径 —— `updateBalance` 刻意「绝不动惩罚态」，
   * `revive` 又只在导入凭据时被调用。后果是**实测可复现的**：
   * 用户充了钱、余额已是 2870，账号仍被锁到次日 04:00，
   * 面板显示「余额耗尽」，只能干等或手动点「解冻」。
   *
   * ## 为什么是「独立一步」而不是塞进 `updateBalance`
   *
   * 1. `updateBalance` 的语义被现有单测钉死为「只写额度三元组 + 采样，不碰惩罚态」
   *   （`tests/balance-refresh.test.ts`、`tests/burn-rate.test.ts`）。把解冻塞进去，
   *    那两个测试立刻红，而且「余额写入」会重新变成「会偷偷改惩罚态」的操作 ——
   *    正是当初它们要防的东西。
   * 2. 解冻是有**条件**的（新余额 > 0 且确实因 `hard` 在冷却），不是一个无条件的副作用。
   *    做成显式一步，调用点读起来就是「先落盘余额，再判是否恢复」，时序看得见。
   *
   * ## ⚠️ 只清 `hard` 这一维（这是本方法的全部要点）
   *
   * `until` / `coolKind` 是**冷却域**，与另外四维正交：
   * `breakerUntil`（我们自己怀疑它反复失败）、`degradeUntil`（连败降权）、
   * `restrictedUntil`（上游明确封号）、`modelCooldowns`（模型级限流）。
   * 它们各有**不同的现实原因**，充钱不能证明它们也好了 ——
   * 顺手清掉会掩盖真实故障（本仓库反复踩过「混清一维、真实故障被抹掉」的坑）。
   * 故这里**只**动 `until` / `coolKind` / `reason`，其余一个字段都不碰。
   *
   * ⚠️ `reason` 必须一起清：它是**冷却域**的展示文案（面板把它当作冷却原因），
   * 留着 `credit exhausted` 而冷却已解除，就会出现「账号可用但带着一条余额错误」，
   * 与 `setAccountDisabled(…, false)` 清 `reason` 的理由完全一致。
   *
   * @param credits 本次刷新到的**可用余额**（未取整前的原值即可，负数/NaN 一律视为未恢复）
   * @returns 是否真的清掉了一个 `hard` 冷却（供调用方记日志 / 测试断言）
   */
  async clearHardIfRecovered(uid: string, credits: number, now: number): Promise<boolean> {
    // ⚠️ 余额 0 / 负数 / NaN 都表示「没恢复」：上游偶尔回负值，而
    // `NaN <= 0` 是 false —— 若只写 `credits <= 0` 就会把 NaN 当成「有余额」。
    if (!Number.isFinite(credits) || credits <= 0) return false

    const state = this.readState(uid)
    if (state === undefined) return false
    // 只认「因 hard 且在冷却期内」这一种形态。已过期的 hard（等到了次日 04:00）
    // 不需要清 —— 它自己已经失效，动它只会产生一次无意义的写。
    if (!hardCooldownActive(state, now)) return false

    state.until = 0
    state.coolKind = ''
    // ⚠️ `reason` 是共用字段（冷却原因 + 停用原因）。停用中的账号必须留着它，
    // 否则面板上「停用」那一行的原因变成空白，用户不知道是谁、为什么停的。
    if (!state.disabled) state.reason = ''

    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    // ⚠️ 日志只放 uid 前 8 位与余额数字，**不含任何凭据**（与本文件其它日志同口径）。
    // 这条日志是「为什么账号突然能用了」的唯一可观测依据。
    console.log(
      `[pool] 余额恢复，解冻 hard 冷却：uid=${state.uid.slice(0, 8)}… credits=${credits}`,
    )
    return true
  }

  /**
   * 记录「**今天已签到**」（首次成功与幂等命中都要调）。
   *
   * ## ⚠️ 为什么必须有这个方法
   *
   * `AccountState.lastCheckinDay` 早就存在（`state.ts:133`），面板也在读它
   *（账号列表的「签到 YYYY-MM-DD」标签）——
   * 但**从来没有代码写过它**，于是那个标签永远不显示。
   *
   * 这与 Go 侧的能力不对等：Go 在签到成功与幂等两条分支后都调
   * `Pool.NoteCheckinDone`（`internal/panel/panel.go:494,499`、
   * `internal/scheduler/scheduler.go:445,453`）。本项目漏了这一步。
   *
   * 「幂等命中也算今天已签」的理由同 Go 侧（`panel.go:491-493`）：
   * 上游对重复签到回的是业务码而不是错误，用户看到的状态就该是「已签」。
   *
   * ⚠️ 日期用**固定 UTC+8**（复用 `upstream/travel.ts:45` 的 `cstDay`，
   * 与签到活动的日界口径一致），不取本机时区 —— Workerd 恒为 UTC。
   *
   * ⚠️ 读账号走 {@link readState}（原来裸 `JSON.parse`，缺字段会随整体写回被固化）。
   */
  async noteCheckinDone(uid: string, now: number): Promise<void> {
    const state = this.readState(uid)
    if (state === undefined) return
    state.lastCheckinDay = cstDay(now)
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
  }

  /**
   * **人工**启用/停用某个账号（面板的「停用 / 启用」按钮）。
   *
   * ## ⚠️ 与 `disable()` / `applyFailure` 的区别（不要混用）
   *
   * | 入口 | 语义 | 谁能解除 |
   * |---|---|---|
   * | {@link setAccountDisabled} | **用户显式**停用 | 只有用户再点「启用」 |
   * | {@link disable} | 上游强信号（如 11140）判死 | 重新登录 / 人工清状态 |
   * | `applyFailure` | 失败累积到阈值后的自动熔断 | 时间到期自动恢复 |
   *
   * ⚠️ 故这里**同时清掉自动熔断/冷却**：
   * 用户说「启用」，意思是「我要用这个号」—— 若留着旧的 `until` /
   * `breakerUntil`，号虽然 `disabled=false` 但**仍然选不到**，
   * 面板上看起来「启用了却没用」。那是本项目反复踩到的
   * 「状态看着对、行为不对」型缺陷。
   *
   * ⚠️ 也清 `reason`：那是上一次失败的原因，留着会让面板显示
   * 「正常」却带着一条旧错误，误导排查。
   */
  async setAccountDisabled(uid: string, disabled: boolean, now: number): Promise<boolean> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    if (raw === undefined) return false
    const state = normalizeAccountState(JSON.parse(raw))
    if (state === undefined) return false
    state.disabled = disabled
    if (disabled) {
      state.reason = '已被手动停用'
    } else {
      // ⚠️ 启用时**必须一并清掉自动惩罚状态**，否则「启用了仍选不到」。
      state.reason = ''
      state.until = 0
      state.breakerUntil = 0
      state.degradeUntil = 0
      state.coolKind = ''
      state.fails = 0
      state.retryCount = 0
      state.softStreak = 0
      state.consecutiveFails = 0
      state.sessionDeadFails = 0
    }
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    return true
  }

  /**
   * 显式禁用（人工操作）。
   *
   * ⚠️ **不是 11140 的入口**（S10，2026-10-22 澄清）：上游封号走
   * `applyFailure(kind:'restricted')`，只写 `restrictedUntil`、**不动 `disabled`** ——
   * 因为「上游封了这个号」和「用户主动停用」是两件事，前者会到期恢复，后者不会。
   * 原注释把两者混成一句，会让人以为封号会自动把账号打成终态。
   *
   * ⚠️ 读账号走 {@link readState}（原来裸 `JSON.parse`）。这条路径尤其不能漏归一：
   * 它写的是 `disabled=true` —— **终态**，用户之后很可能再也不会碰这条记录，
   * 缺字段（`provider` / `samples` / `restrictedUntil`）就被永久固化在库里。
   */
  async disable(uid: string, reason: string, now: number): Promise<void> {
    const state = this.readState(uid)
    if (state === undefined) return
    state.disabled = true
    state.reason = reason
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
  }

  /** 创建账号（供导入 / 登录流程调用）。已存在则覆盖凭证以外的状态。 */
  async createAccount(
    input: { uid: string; nickname: string; realm: string; provider?: string },
    now: number,
  ): Promise<AccountState> {
    const existing = readAccount(this.ctx.storage.sql, input.uid)
    if (existing !== undefined) {
      const parsed = normalizeAccountState(JSON.parse(existing))
      if (parsed !== undefined) return parsed
    }
    const state = createAccountState(input)
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    return state
  }

  // ─────────────────────── 凭据（加密存储） ───────────────────────

  /**
   * 写入凭据（**自动加密**）。
   *
   * ⚠️ 未配置 `CREDENTIAL_KEY` 时**抛错**，不静默明文落盘（AGENTS.md §7.1）。
   * 静默降级是最糟的选择 —— 用户会以为已经加密了。
   */
  async putCredential(uid: string, credential: unknown, now: number): Promise<void> {
    this.credentialCache.set(uid, credential)
    const key = requireCredentialKey(this.env.CREDENTIAL_KEY)
    const ciphertext = await encryptCredential(key, credential)
    writeCredential(this.ctx.storage.sql, uid, ciphertext, now)
  }

  /**
   * 读取并解密凭据。优先读内存缓存，不存在读 SQLite 并解密。
   *
   * ⚠️ 返回 `unknown` 而不是泛型：**DO RPC 的类型映射不支持把泛型参数透传**
   * （写成 `getCredential<T>()` 会在调用点报 `Expected 0 type arguments`）。
   * 由调用方在边界处断言一次具体类型。
   */
  async getCredential(uid: string): Promise<unknown | undefined> {
    const cached = this.credentialCache.get(uid)
    if (cached !== undefined) return cached

    const ciphertext = readCredential(this.ctx.storage.sql, uid)
    if (ciphertext === undefined) return undefined
    const key = requireCredentialKey(this.env.CREDENTIAL_KEY)
    const cred = await decryptCredential(key, ciphertext)
    this.credentialCache.set(uid, cred)
    return cred
  }

  /**
   * 批量取「各账号凭据的过期时刻」（一次 RPC，不是 N 次）。
   *
   * ## 为什么需要它
   *
   * 用户报「动不动就掉登录」时，面板要能回答「是凭据过期了，还是账号被限流」——
   * 这两者的处置**完全不同**（前者等自动续期，后者要重新登录）。
   * 而 `expiresAt` 是加密存在凭据里的，逐账号 `getCredential` 会产生 N 次
   * DO RPC（账号多时开销明显）。
   *
   * ⚠️ **解密失败/DTO 异常一律记 `null`**，绝不让一个坏凭据把整个列表打成 500
   *（与 `listAccounts` 里「解析失败就跳过该条」同一取舍）。
   *
   * @returns `uid → 过期时刻(ms)`；未知/读不到为 `null`。
   */
  async listCredentialExpiry(now: number): Promise<Record<string, number | null>> {
    void now
    const out: Record<string, number | null> = {}
    // ⚠️ `requireCredentialKey` 返回的是**字符串密钥**（内部再派生），
    // 而 `decryptCredential(secret: string, stored: string)` 收的也是字符串 ——
    // 我第一版误标成 `CryptoKey` 并传给 `decryptCredential`，两处类型都不对。
    let key: string
    try {
      key = requireCredentialKey(this.env.CREDENTIAL_KEY)
    } catch {
      // 未配密钥 ⇒ 全部无从判断（不是错误，是「读不到」）。
      return out
    }
    // ⚠️ `listCredentialUids()` 是 **async**（DO 方法），必须 await。
    for (const uid of await this.listCredentialUids()) {
      const ciphertext = readCredential(this.ctx.storage.sql, uid)
      if (ciphertext === undefined) {
        out[uid] = null
        continue
      }
      try {
        const credential = (await decryptCredential(key, ciphertext)) as { expiresAt?: unknown }
        const e = credential?.expiresAt
        out[uid] = typeof e === 'number' && Number.isFinite(e) && e > 0 ? e : null
      } catch {
        // 解密失败（密钥换了 / 数据损坏）⇒ 如实记 null，不让整表失败。
        out[uid] = null
      }
    }
    return out
  }

  /** 删除凭据。 */
  async removeCredential(uid: string): Promise<void> {
    /**
     * ⚠️ **必须先清内存缓存**（S12，2026-10-22）。
     *
     * 原来这里只删库，不清 `credentialCache` —— 而 `deleteCredential()` 会清。
     * 于是「删掉凭据」之后，`getCredential` 仍能从缓存里拿到那份已删的凭据：
     * 面板上账号没了凭据，实际却还能用（用户报「删了怎么还在跑」）。
     * 两条删除路径必须同一口径。
     */
    this.credentialCache.delete(uid)
    deleteCredential(this.ctx.storage.sql, uid)
  }

  /** 列出持有凭据的 uid（**不返回密文**）。 */
  async listCredentialUids(): Promise<string[]> {
    return listCredentialUids(this.ctx.storage.sql)
  }

  // ─────────────────────── 登录会话（设备码） ───────────────────────

  /**
   * 保存登录会话。
   *
   * ⚠️ 必须持久化：isolate 随时可能被回收，「发起登录」与「轮询结果」
   * 会落到不同 isolate。放内存会表现为「state 永远未知」。
   */
  async saveLoginSession(state: string, payload: unknown, expiresAt: number): Promise<void> {
    writeLoginSession(this.ctx.storage.sql, state, JSON.stringify(payload), expiresAt)
  }

  /**
   * 读登录会话（已过期视为不存在）。
   *
   * ⚠️ 同 `getCredential`：返回 `unknown`，泛型不透传 DO RPC。
   */
  async getLoginSession(state: string, now: number): Promise<unknown | undefined> {
    const raw = readLoginSession(this.ctx.storage.sql, state, now)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  /** 删除登录会话（完成或放弃后清理）。 */
  async removeLoginSession(state: string): Promise<void> {
    deleteLoginSession(this.ctx.storage.sql, state)
  }

  /** 清理过期登录会话。 */
  async pruneLoginSessions(now: number): Promise<number> {
    return pruneLoginSessions(this.ctx.storage.sql, now)
  }

  // ─────────────────────── 模型开关 ───────────────────────

  /**
   * 读某供应商被**停用**的模型 id 列表。
   *
   * ⚠️ 这是「面板层」的开关，与「模型级冷却」（上游限流）是两回事：
   * - 冷却：上游说这个模型暂时不可用，**自动**恢复；
   * - 停用：用户**手动**选择不用它，只有手动才能恢复。
   *
   * 两者不能混用一个字段 —— 混了会导致「手动停用的模型在冷却到期后
   * 自动复活」，或「被限流的模型被误认为用户停用」。
   */
  async getDisabledModels(provider: string): Promise<string[]> {
    const all = (await this.ctx.storage.get<Record<string, string[]>>('disabledModels')) ?? {}
    return all[provider] ?? []
  }

  /** 设置某供应商的停用模型列表。 */
  /**
   * 清账号级冷却与熔断（`until` / `breakerUntil` / `degradeUntil` / 连续失败计数）。
   *
   * ⚠️ 运维入口：排查「账号明明健康却选不到号」时用 ——
   * 实测踩到：codearts 账号因连续失败进了熔断（`breakerUntil` 未来 7 分钟），
   * 面板显示 disabled=false、until=0，但 pick 就是不返回它，
   * 报的是「没有可用账号」—— 完全看不出是熔断。
   *
   * 与 `clearModelCooldowns` 分开：那个清**模型级**，这个清**账号级**。
   */
  async clearCooldowns(realm: string, uid?: string): Promise<number> {
    const states: Array<AccountState | undefined> = uid === undefined
      ? listAccounts(this.ctx.storage.sql, realm).map((r) => normalizeAccountState(JSON.parse(r)))
      : [normalizeAccountState(JSON.parse(readAccount(this.ctx.storage.sql, uid) ?? 'null'))]
    let n = 0
    for (const state of states) {
      if (state === undefined) continue
      /**
       * 🔴 **必须把「全部维度」都清掉**（2026-10-21 审查补，M2 指出语义碎片化）。
       *
       * 原来只清账号级的 `until / breakerUntil / degradeUntil / coolKind / fails / …`，
       * **漏了 `modelCooldowns` 与 `restrictedUntil`**：
       * - 用户点面板「解冻」，模型级冷却还在 ⇒ 该模型仍然选不到，
       *   面板却显示「正常」⇒ 典型的「状态看着对、行为不对」。
       * - `restrictedUntil`（11140 上游封号标记）也留着 ⇒ 用户以为解冻了，
       *   实际仍被排除。
       *
       * ⚠️ 「解冻」的语义是**用户显式要求重新开始**，故这里清掉**所有**惩罚态。
       * 与 `setAccountDisabled` 的区别：那个只切 `disabled` 位，顺带清自动熔断；
       * 本方法是「把惩罚态归零」，是面板「解冻」按钮的语义。
       */
      const hasModelCooldowns = Object.keys(state.modelCooldowns).length > 0
      if (
        state.until !== 0
        || state.breakerUntil !== 0
        || state.degradeUntil !== 0
        || state.restrictedUntil !== 0
        || state.fails !== 0
        || hasModelCooldowns
      ) {
        state.until = 0
        state.breakerUntil = 0
        state.degradeUntil = 0
        state.restrictedUntil = 0
        state.coolKind = ''
        state.fails = 0
        state.retryCount = 0
        state.softStreak = 0
        state.consecutiveFails = 0
        state.sessionDeadFails = 0
        // 模型级冷却与确认计数一并归零（否则 `modelConfirm` 会让下次更快熔断）
        state.modelCooldowns = {}
        state.modelConfirm = {}
        writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
        n += 1
      }
    }
    return n
  }

  async setDisabledModels(provider: string, models: string[]): Promise<void> {
    const all = (await this.ctx.storage.get<Record<string, string[]>>('disabledModels')) ?? {}
    all[provider] = models
    await this.ctx.storage.put('disabledModels', all)
  }

  // ─────────────────────── 用量统计 ───────────────────────

  /**
   * 记录一次请求的用量。
   *
   * ⚠️ 整条环形缓冲存在**一个 storage key** 里（`usage:ring`），而不是一行一条记录。
   * 理由：Free 计划 DO 行写入配额 100,000/天，一次对话写一行会在正常使用下撞配额；
   * 而我们要的是**近期趋势**，不是审计账本。
   *
   * 单次读改写：DO 是单线程的，不存在并发写覆盖问题。
   */
  async recordUsage(record: UsageRecord): Promise<void> {
    const state = await this.loadUsageState()
    recordUsageInto(state, record, record.at)
    // ⚠️ **一次写**（`ring` + `days` 同在一个 key）—— 见 `store/usage.ts` 文件头：
    // 拆成两个 key 会让每笔请求写两次，白白翻倍 DO 行写入配额消耗。
    await this.ctx.storage.put(USAGE_STATE_KEY, state)
  }

  /**
   * 读取用量概览（聚合在内存里做）。
   *
   * @param windowDays - 1 = 今日；7 = 近 7 天；30 = 近 30 天；0 = 全部。
   */
  async usageSummary(windowDays = 0): Promise<UsageSummary> {
    const state = await this.loadUsageState()
    return summarizeUsageState(state, windowDays, Date.now())
  }

  /**
   * 清空用量记录（**明细与按天聚合一起清**）。
   *
   * ⚠️ 必须两个都清：只清明细会让「近 30 天」仍然报出旧数字，
   * 而用户刚点了「清空」—— 那是本项目反复警告的「状态看着对、行为不对」。
   */
  async clearUsage(): Promise<void> {
    await this.ctx.storage.put(USAGE_STATE_KEY, emptyUsageState())
    // 顺带清掉旧 key，免得下次迁移又把旧数据搬回来。
    await this.ctx.storage.delete(LEGACY_USAGE_RING_KEY)
  }

  /**
   * 读用量状态，并把**旧版数据迁移**过来。
   *
   * 旧版只把裸明细数组存在 `usage:ring`，没有按天聚合（这正是
   * 「用量始终 500」那个缺陷的成因）。升级后第一次读时把它回放成聚合，
   * 用户已有的历史不会凭空消失。
   *
   * ⚠️ 迁移是**幂等**的：写完新 key 后删掉旧 key，故只会发生一次。
   * ⚠️ 迁移**不回放成未来日键**：`pruneUsageDays` 会挡掉时钟异常产生的键。
   */
  private async loadUsageState(): Promise<UsageState> {
    const state = await this.ctx.storage.get<UsageState>(USAGE_STATE_KEY)
    if (state !== undefined && Array.isArray(state.ring) && typeof state.days === 'object') {
      return state
    }
    const legacy = await this.ctx.storage.get<UsageRecord[]>(LEGACY_USAGE_RING_KEY)
    if (legacy === undefined || !Array.isArray(legacy)) {
      return emptyUsageState()
    }
    const migrated = migrateUsageState(legacy, Date.now())
    await this.ctx.storage.put(USAGE_STATE_KEY, migrated)
    await this.ctx.storage.delete(LEGACY_USAGE_RING_KEY)
    return migrated
  }

  // ─────────────────────── 请求日志（环形缓冲） ───────────────────────

  /**
   * 追加一条请求日志。
   *
   * ⚠️ 与用量分开存：日志条目更大（含 UA、IP 等），且只用于排查，
   * 不应挤占用量统计的空间。上限更小（200 条）。
   */
  async appendLog(entry: Record<string, unknown>): Promise<void> {
    const ring = (await this.ctx.storage.get<Array<Record<string, unknown>>>('log:ring')) ?? []
    ring.push(entry)
    // 只保留最近 200 条（按插入顺序，日志天然有序）
    await this.ctx.storage.put('log:ring', ring.slice(-200))
  }

  /** 读日志（最新的在前）。 */
  async readLogs(limit = 100): Promise<Array<Record<string, unknown>>> {
    const ring = (await this.ctx.storage.get<Array<Record<string, unknown>>>('log:ring')) ?? []
    return ring.slice(-Math.max(1, Math.min(limit, 200))).reverse()
  }

  /** 清空日志。 */
  async clearLogs(): Promise<void> {
    await this.ctx.storage.put('log:ring', [])
  }

    /**
   * 清除模型级冷却（面板「解冻」用）。
   *
   * ## 为什么必须有这个入口
   *
   * 模型级冷却的退避是 **6 小时起步、封顶 24 小时**（对齐上游语义：11102 =
   * 该后端没有这个模型）。但有些失败**并不是上游真的没有这个模型**，
   * 而是我方请求有问题（实测：模型名带了 `provider/` 前缀，
   * 上游回 `model [...] service info not found`，被记成 11102）。
   *
   * 那种情况下用户会看到「这个模型选不到号」并**只能等 6 小时** ——
   * 而真实原因是我们的 bug 已经修好了。故必须留人工纠正入口。
   *
   * @param model 指定模型则只清它；不传则清全部。
   */
  async clearModelCooldowns(realm: string, uid: string | undefined, model?: string): Promise<number> {
    // ⚠️ 只有传了 uid 时才需要读单条；不传就扫整个 realm。
    // （DO 本身按 realm 分片，故 realm 只是过滤条件，不是路由信息。）
    if (uid !== undefined) {
      const raw = readAccount(this.ctx.storage.sql, uid)
      if (raw === undefined) return 0
      const state = normalizeAccountState(JSON.parse(raw))
      if (state === undefined) return 0
      const keys = model === undefined ? Object.keys(state.modelCooldowns) : (state.modelCooldowns[model] === undefined ? [] : [model])
      if (keys.length === 0) return 0
      for (const k of keys) delete state.modelCooldowns[k]
      writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
      return keys.length
    }

    const raws = listAccounts(this.ctx.storage.sql, realm)
    let cleared = 0
    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      if (state === undefined) continue
      const keys = model === undefined ? Object.keys(state.modelCooldowns) : (state.modelCooldowns[model] === undefined ? [] : [model])
      if (keys.length === 0) continue
      for (const k of keys) delete state.modelCooldowns[k]
      writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
      cleared += keys.length
    }
    return cleared
  }

  // ─────────────────────── IP 级 WAF 拦截护栏 ───────────────────────

  /**
   * 记录一次**某个账号**命中 WAF 403，返回记账后 IP 级拦截是否激活。
   *
   * ## 语义（逐条对齐 Go 侧 `wafip.go:50-72`）
   *
   * - **已激活期内**新命中：不续期、不记账 —— 保守地「自然解除」，
   *   而不是被持续命中无限延长；
   * - **未激活**：记 `hits[uid] = now`（同号重复命中**覆盖**而不累计 ——
   *   判据是「不同号数」），剪掉窗外的旧命中；
   * - 不同 uid 数达阈值 → 激活到 `now + window`，并**清空判定窗**
   *   （解除后需要全新命中重新判定，不叠旧账）。
   */
  async noteWaf(uid: string, now: number): Promise<boolean> {
    const gate = await this.loadWafGate()

    if (gate.until > now) {
      // 激活期内：不续期、不记账
      return true
    }

    gate.hits[uid] = now
    // 剪枝：删掉窗口外的
    for (const [u, t] of Object.entries(gate.hits)) {
      if (now - t > WAF_IP_WINDOW_MS) delete gate.hits[u]
    }

    if (Object.keys(gate.hits).length >= WAF_IP_THRESHOLD) {
      gate.until = now + WAF_IP_WINDOW_MS
      gate.hits = {} // 清空：解除后需全新命中重新判定
      await this.saveWafGate(gate)
      // 面板与日志都需要看到「这是 IP 级，不是账号级」
      console.warn(
        `[waf] IP 级拦截激活：${WAF_IP_WINDOW_MS / 1000}s 内 ${WAF_IP_THRESHOLD} 个不同账号命中 403，` +
          `暂停轮转至 +${WAF_IP_WINDOW_MS / 1000}s`,
      )
      return true
    }

    await this.saveWafGate(gate)
    return false
  }

  /**
   * 记录一个账号被上游 `11140` 限制，判定是否形成**波次**（整池暂停）。
   *
   * 判据与 {@link noteWaf} 同一个形状（不同账号数），但窗口/时长按账号级风控取值。
   * 同号重复命中**覆盖**而不累计 —— 判的是「几个不同的号被打标」，
   * 一个号反复撞不构成波次（它自己已被 `restrictedUntil` 挡住）。
   */
  async noteRestriction(uid: string, now: number): Promise<boolean> {
    const gate = await this.loadRestrictionGate()
    if (gate.until > now) return true

    gate.hits[uid] = now
    for (const [u, t] of Object.entries(gate.hits)) {
      if (now - t > RESTRICTION_WAVE_WINDOW_MS) delete gate.hits[u]
    }

    if (Object.keys(gate.hits).length >= RESTRICTION_WAVE_THRESHOLD) {
      gate.until = now + RESTRICTION_POOL_HOLD_MS
      gate.hits = {}
      await this.saveRestrictionGate(gate)
      console.warn(
        `[restriction] 账号级限制波次：${RESTRICTION_WAVE_WINDOW_MS / 60_000} 分钟内 ` +
          `${RESTRICTION_WAVE_THRESHOLD} 个不同账号被 11140 标记，` +
          `暂停该区域派发 ${RESTRICTION_POOL_HOLD_MS / 60_000} 分钟`,
      )
      return true
    }

    await this.saveRestrictionGate(gate)
    return false
  }

  /** 账号级限制波次是否仍在暂停期（只读，不记账）。 */
  async restrictionGateActive(now: number): Promise<boolean> {
    const gate = await this.loadRestrictionGate()
    return gate.until > now
  }

  /** 波次暂停的完整状态（面板展示用）。 */
  async restrictionGateStatus(now: number): Promise<{ active: boolean; until: number; recentUids: number }> {
    const gate = await this.loadRestrictionGate()
    let recent = 0
    for (const t of Object.values(gate.hits)) {
      if (now - t <= RESTRICTION_WAVE_WINDOW_MS) recent += 1
    }
    return { active: gate.until > now, until: gate.until, recentUids: recent }
  }

  /** 人工解除波次暂停（与 `clearWafGate` 同样的可纠正入口）。 */
  async clearRestrictionGate(): Promise<void> {
    await this.ctx.storage.put('restrictionGate', { until: 0, hits: {} })
  }

  /**
   * 人工解除**单个账号**的 `restrictedUntil`（波次暂停之外的另一个层次）。
   *
   * ⚠️ 为什么需要这个：`clearRestrictionGate` 只清「波次暂停」，不动账号自身状态。
   * 于是出现「误判后无法解冻」——线上真实发生过：模型下线返回的错误被归到
   * 账号级限制，三个号被各锁 2 小时，面板提供的新端点也清不掉，只能等自然过期。
   *
   * 用途限定在**确认误判**时：上游限制有 2 小时自然过期，
   * 不要拿它当"绕过限制"的常规手段（见 RESTRICTED_HOLD_MS 的注释）。
   */
  async clearAccountRestriction(uid: string): Promise<{ found: boolean; cleared: boolean }> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    if (raw === undefined || raw === '') return { found: false, cleared: false }
    const state = normalizeAccountState(JSON.parse(raw))
    if (state === undefined) return { found: false, cleared: false }
    const wasRestricted = state.restrictedUntil !== 0
    state.restrictedUntil = 0
    state.fails = 0
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
    return { found: true, cleared: wasRestricted }
  }

  private async loadRestrictionGate(): Promise<{ until: number; hits: Record<string, number> }> {
    const raw = await this.ctx.storage.get<{ until?: unknown; hits?: unknown }>('restrictionGate')
    const until = typeof raw?.until === 'number' ? raw.until : 0
    const hits: Record<string, number> = {}
    if (raw !== undefined && raw.hits !== null && typeof raw.hits === 'object') {
      for (const [k, v] of Object.entries(raw.hits as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) hits[k] = v
      }
    }
    return { until, hits }
  }

  private async saveRestrictionGate(gate: { until: number; hits: Record<string, number> }): Promise<void> {
    await this.ctx.storage.put('restrictionGate', gate)
  }

  /** IP 级拦截是否激活（只读，不记账）。 */
  async wafGateActive(now: number): Promise<boolean> {
    const gate = await this.loadWafGate()
    return gate.until > now
  }

  /** 查询 gate 完整状态（供面板展示「是不是 IP 被拦了」）。 */
  async wafGateStatus(now: number): Promise<{ active: boolean; until: number; recentUids: number }> {
    const gate = await this.loadWafGate()
    let recent = 0
    for (const t of Object.values(gate.hits)) {
      if (now - t <= WAF_IP_WINDOW_MS) recent += 1
    }
    return { active: gate.until > now, until: gate.until, recentUids: recent }
  }

  /**
   * 人工解除 IP 级拦截（面板「解冻」用）。
   *
   * ⚠️ 刻意提供这个入口：gate 是**保守的推测**，接受人工纠正。
   * 若实际是账号级问题却被误判成 IP 级，用户需要能立刻恢复。
   */
  async clearWafGate(): Promise<void> {
    await this.ctx.storage.put('wafGate', { until: 0, hits: {} })
  }

  /** 读 gate 状态（不存在时返回空表）。 */
  private async loadWafGate(): Promise<{ until: number; hits: Record<string, number> }> {
    const raw = await this.ctx.storage.get<{ until?: unknown; hits?: unknown }>('wafGate')
    const until = typeof raw?.until === 'number' ? raw.until : 0
    const hits: Record<string, number> = {}
    if (raw?.hits !== null && typeof raw?.hits === 'object' && !Array.isArray(raw?.hits)) {
      for (const [k, v] of Object.entries(raw.hits as Record<string, unknown>)) {
        if (typeof v === 'number') hits[k] = v
      }
    }
    return { until, hits }
  }

  /** 写 gate 状态（**必须持久化**：DO 随时可能被回收）。 */
  private async saveWafGate(gate: { until: number; hits: Record<string, number> }): Promise<void> {
    await this.ctx.storage.put('wafGate', gate)
  }

  // ─────────────────────── 自定义 API Key ───────────────────────

  /**
   * 列出全部子密钥记录（**不含明文**，只有哈希）。
   *
   * ⚠️ 与「供应商设置」一样存在 `cn` 分片的 DO 里当**全局**设置用 ——
   * 子密钥描述的是「谁能调 `/v1/*`」，与 realm 无关；按 realm 各存一份
   * 会让同一个 Key 在不同分片下鉴权结果不一致。
   */
  // ─────────────────────── 永久积分锁 ───────────────────────

  /**
   * 读永久积分锁开关表（per-provider）。
   *
   * @returns 形如 `{ buddy: true }`；未配置过返回空对象（**缺省 = 不锁**）。
   */
  async getPermanentLocks(): Promise<Record<string, boolean>> {
    const raw = await this.ctx.storage.get<unknown>(PERMANENT_LOCKS_KEY)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      // 只认 boolean true；损坏条目跳过而不是让整个表失效
      if (v === true) out[k] = true
    }
    return out
  }

  /**
   * 设置某供应商的永久积分锁。
   *
   * ⚠️ ``permanentLocks` 的语义是「该 provider 下、**只剩永久额度**的账号
   * 不参与选号」。**不**是「该 provider 完全停用」—— 有临期额度的账号照常可用。
   */
  async setPermanentLock(provider: string, locked: boolean): Promise<Record<string, boolean>> {
    const locks = await this.getPermanentLocks()
    if (locked) locks[provider] = true
    else delete locks[provider]
    await this.ctx.storage.put(PERMANENT_LOCKS_KEY, locks)
    return locks
  }

  // ─────────────────────── 指定账号 ───────────────────────

  /**
   * 读本分片的指定账号表（per-provider）。
   *
   * @returns 形如 `{ buddy: { uid, mode: 'only' } }`；未配置过返回空对象（缺省 = 不指定）。
   */
  async getPins(): Promise<Record<string, AccountPin>> {
    const raw = await this.ctx.storage.get<unknown>(ACCOUNT_PINS_KEY)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, AccountPin> = {}
    for (const [provider, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      // 损坏条目跳过，而不是让整个表失效
      if (typeof o.uid !== 'string' || o.uid === '' || !isPinMode(o.mode)) continue
      out[provider] = { uid: o.uid, mode: o.mode }
    }
    return out
  }

  /**
   * 把某账号设为**其所属供应商**的指定账号（每个供应商最多一个）。
   *
   * ⚠️ 供应商从账号本身取，不信调用方传的 —— 把 A 家的号指定给 B 家
   * 只会让 B 家永远报「指定账号不属于该供应商」。
   *
   * @returns 成功时带更新后的整张表；账号不存在时 `ok: false`。
   */
  async setPin(
    uid: string,
    mode: PinMode,
    /** 调用方以为的供应商（可选）；与账号实际所属不一致时拒绝，**不写入**。 */
    expectedProvider?: string,
  ): Promise<
    | { ok: true; provider: string; pins: Record<string, AccountPin> }
    | { ok: false; error: string; code: 'invalid' | 'not_found' }
  > {
    if (!isPinMode(mode)) return { ok: false, error: 'mode 只能是 only 或 prefer', code: 'invalid' }
    const account = await this.getAccount(uid)
    if (account === undefined) return { ok: false, error: `账号 ${uid} 不存在`, code: 'not_found' }
    const provider = account.provider ?? 'buddy'
    if (expectedProvider !== undefined && expectedProvider !== '' && expectedProvider !== provider) {
      return { ok: false, error: `账号 ${uid} 属于供应商「${provider}」，不是「${expectedProvider}」`, code: 'invalid' }
    }
    const pins = await this.getPins()
    pins[provider] = { uid, mode }
    await this.ctx.storage.put(ACCOUNT_PINS_KEY, pins)
    return { ok: true, provider, pins }
  }

  /** 取消某供应商的指定账号（未设过也返回成功，幂等）。 */
  async clearPin(provider: string): Promise<Record<string, AccountPin>> {
    const pins = await this.getPins()
    if (pins[provider] !== undefined) {
      delete pins[provider]
      await this.ctx.storage.put(ACCOUNT_PINS_KEY, pins)
    }
    return pins
  }

  /**
   * 整张替换永久积分锁表（跨分片同步用）。
   *
   * ⚠️ 只给管理接口做「cn 是权威、其余分片镜像」的同步，不做合并。
   */
  async replacePermanentLocks(locks: Record<string, boolean>): Promise<void> {
    const clean: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(locks)) if (v === true) clean[k] = true
    await this.ctx.storage.put(PERMANENT_LOCKS_KEY, clean)
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const raw = await this.ctx.storage.get<unknown>(API_KEYS_KEY)
    if (!Array.isArray(raw)) return []
    const out: ApiKeyRecord[] = []
    for (const item of raw) {
      const rec = normalizeApiKeyRecord(item)
      // 跳过损坏条目，而不是让整个列表 500
      if (rec !== undefined) out.push(rec)
    }
    return out
  }

  /** 整体覆盖子密钥列表（调用方负责传完整值）。 */
  private async saveApiKeys(records: ApiKeyRecord[]): Promise<void> {
    await this.ctx.storage.put(API_KEYS_KEY, records)
  }

  /**
   * 新增一把子密钥。
   *
   * ⚠️ **必须做哈希唯一性检查**：哈希碰撞意味着两把不同的 Key 会互相鉴权通过。
   * 概率极低，但一旦发生就是「钥能当另钥用」—— 而这里的代价只是多查一次。
   */
  async addApiKey(input: { name: string; hash: string; prefix: string }): Promise<ApiKeyRecord> {
    const records = await this.listApiKeys()
    if (records.some((r) => r.hash === input.hash)) {
      throw new Error('哈希冲突：请重试（极小概率事件）')
    }
    const record: ApiKeyRecord = {
      id: newApiKeyId(),
      name: input.name,
      hash: input.hash,
      prefix: input.prefix,
      createdAt: Date.now(),
      lastUsedAt: 0,
      enabled: true,
      limits: defaultApiKeyLimits(),
    }
    records.push(record)
    await this.saveApiKeys(records)
    return record
  }

  /**
   * 改一把子密钥（名称 / 启用 / 限制）。
   *
   * @returns 改后的记录；找不到时 `undefined`。
   */
  async updateApiKey(id: string, patch: {
    name?: string
    enabled?: boolean
    limits?: ApiKeyLimits
    hash?: string
    prefix?: string
  }): Promise<ApiKeyRecord | undefined> {
    const records = await this.listApiKeys()
    const idx = records.findIndex((r) => r.id === id)
    if (idx < 0) return undefined
    const cur = records[idx]!
    const next: ApiKeyRecord = {
      ...cur,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.limits === undefined ? {} : { limits: normalizeApiKeyLimits(patch.limits) }),
      ...(patch.hash === undefined ? {} : { hash: patch.hash }),
      ...(patch.prefix === undefined ? {} : { prefix: patch.prefix }),
    }
    records[idx] = next
    await this.saveApiKeys(records)
    return next
  }

  /** 删除一把子密钥（连带清掉它的用量计数）。 */
  async removeApiKey(id: string): Promise<boolean> {
    const records = await this.listApiKeys()
    const next = records.filter((r) => r.id !== id)
    if (next.length === records.length) return false
    await this.saveApiKeys(next)
    const usages = await this.loadApiKeyUsages()
    if (usages[id] !== undefined) { delete usages[id]; await this.ctx.storage.put(API_KEY_USAGE_KEY, usages) }
    return true
  }

  /** 读全部用量计数（按 id 索引）。 */
  private async loadApiKeyUsages(): Promise<Record<string, ApiKeyUsage>> {
    const raw = await this.ctx.storage.get<Record<string, unknown>>(API_KEY_USAGE_KEY)
    const out: Record<string, ApiKeyUsage> = {}
    if (raw === null || typeof raw !== 'object') return out
    for (const [k, v] of Object.entries(raw)) {
      const u = normalizeApiKeyUsage(v)
      if (u !== undefined) out[k] = u
    }
    return out
  }

  /** 读一把子密钥的用量计数（不存在时返回空）。 */
  async getApiKeyUsage(id: string): Promise<ApiKeyUsage> {
    const usages = await this.loadApiKeyUsages()
    return usages[id] ?? emptyApiKeyUsage()
  }

  /** 读全部用量（面板一次拉完，避免 N 次往返）。 */
  async listApiKeyUsages(): Promise<Record<string, ApiKeyUsage>> {
    return await this.loadApiKeyUsages()
  }

  /**
   * 记一次子密钥用量（**在 `/v1/*` 的关键路径上**）。
   *
   * ## ⚠️ 为什么把「重置窗口 + 计数」放在**同一个方法**里
   *
   * 分成「先读、判断、再写」三步会有一个真实的竞态：同一把 Key 的两个
   * 并发请求都读到旧计数、都判定「没超」，然后都放行 —— 配额被突破。
   * DO 的串行保证让这个方法内部成为原子操作，把窗口重置与累加收口在一处，
   * 就只剩「鉴权时的读」与「记账时的写」之间那一小段
   *（那一段的偏差最多多放行并发中的几个请求，可接受且无法完全避免）。
   */
  async recordApiKeyUse(input: {
    id: string
    ip: string
    model: string
    input: number
    output: number
    rejected?: boolean
  }): Promise<void> {
    const records = await this.listApiKeys()
    const rec = records.find((r) => r.id === input.id)
    if (rec === undefined) return

    const usages = await this.loadApiKeyUsages()
    const now = Date.now()
    let usage = usages[input.id] ?? emptyApiKeyUsage()
    // ⚠️ 窗口过期时**先在本地重置再累加**，且必须把新起点写回去 ——
    // 只清零不写起点会让下一次判定又认为「窗口没过期」而永久失效。
    if (isWindowExpired(usage, rec.limits, now)) usage = resetUsageWindow(usage, now)
    if (usage.windowStart === 0) usage = { ...usage, windowStart: now }

    if (input.rejected === true) {
      usage.rejected += 1
    } else {
      usage.requests += 1
      usage.inputTokens += input.input
      usage.outputTokens += input.output
    }
    usage.lastAt = now
    usage.lastIp = input.ip
    usage.lastModel = input.model
    usages[input.id] = usage

    await this.ctx.storage.put(API_KEY_USAGE_KEY, usages)
    /**
     * 记录上的 `lastUsedAt` 也要更新（面板列表直接展示它，不必再读用量表）。
     *
     * 🔴 **但不必每个请求都重写整个 keys 数组**（2026-10-21 审查补，并发专项）。
     *
     * 原实现每次请求都 `saveApiKeys(records)` —— 即把**全部子密钥记录**序列化后
     * 整体写回，只为把一个 `lastUsedAt` 时间戳推进几百毫秒。
     * 加上上面那次 `put(API_KEY_USAGE_KEY)`，**每个请求两次整表写**。
     *
     * 面板上的「最后使用」精确到分钟就够用了（显示的是相对时间），
     * 故 60 秒内的重复更新直接跳过：写入次数从「每请求 2 次」降到
     * 「每分钟至多 1 次」，而界面观感无差别。
     */
    const idx = records.findIndex((r) => r.id === input.id)
    if (idx >= 0) {
      const prev = records[idx]!.lastUsedAt ?? 0
      if (now - prev >= LAST_USED_AT_RESOLUTION_MS) {
        records[idx] = { ...records[idx]!, lastUsedAt: now }
        await this.saveApiKeys(records)
      }
    }
  }

  /**
   * 只补录 token（**不动请求数**）。
   *
   * ⚠️ 与 `recordApiKeyUse` 分开是必要的：请求结束补 token 时若复用
   * `recordApiKeyUse`，`requests` 会被**再加一次**（放行时已加过），
   * 于是「请求数」直接翻倍 —— 面板上会看到「用了 100 次」而实际只有 50 次。
   * 配额判定也会因此提前触发。
   */
  async adjustApiKeyTokens(input: {
    id: string
    ip: string
    model: string
    input: number
    output: number
  }): Promise<void> {
    const records = await this.listApiKeys()
    const rec = records.find((r) => r.id === input.id)
    if (rec === undefined) return
    const usages = await this.loadApiKeyUsages()
    let usage = usages[input.id] ?? emptyApiKeyUsage()
    const now = Date.now()
    if (isWindowExpired(usage, rec.limits, now)) usage = resetUsageWindow(usage, now)
    if (usage.windowStart === 0) usage = { ...usage, windowStart: now }
    usage.inputTokens += input.input
    usage.outputTokens += input.output
    usage.lastAt = now
    if (input.ip !== '') usage.lastIp = input.ip
    if (input.model !== '') usage.lastModel = input.model
    usages[input.id] = usage
    await this.ctx.storage.put(API_KEY_USAGE_KEY, usages)
  }

  /**
   * 按哈希查找一把子密钥。
   *
   * ## ⚠️ 为什么用哈希而不是明文比较
   *
   * 库里根本没有明文（只存哈希），所以「比较」天然就是查表。
   * 这样**不需要**再写恒定时间比较 —— 哈希是单向的，攻击者从哈希反推
   * 不出明文；而查表的命中/不命中耗时差异不构成时序侧信道
   *（它不能揭示**明文**，只能揭示「这个哈希在不在表里」，而哈希由攻击者自己提供）。
   */
  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    const records = await this.listApiKeys()
    return records.find((r) => r.hash === hash)
  }

  /**
   * 清空一把 Key 的用量计数（面板「重置用量」用）。
   *
   * @returns 该 Key **是否存在**。
   *
   * ⚠️ 返回值语义是「密钥存在与否」，**不是**「用量条目存在与否」：
   * 一把从未用过的密钥没有用量条目，但重置它**完全合理**（用户就想把它
   * 归零），返回 404 会让面板报「找不到 API Key」—— 而它明明就在列表里。
   */
  async resetApiKeyUsage(id: string): Promise<boolean> {
    const records = await this.listApiKeys()
    if (!records.some((r) => r.id === id)) return false
    const usages = await this.loadApiKeyUsages()
    usages[id] = emptyApiKeyUsage()
    await this.ctx.storage.put(API_KEY_USAGE_KEY, usages)
    return true
  }
}

/**
 * 次日 04:00（UTC+8）。
 *
 * 用**固定 +8 偏移**而不是 `Intl` / 本机时区：Workers 恒为 UTC，
 * 且 Go 侧明确记录「不依赖容器 tzdata」（`travel.go:36`）。
 *
 * 边界语义：04:00 **之前**返回当天 04:00（此时当日签到还没跑，等当天签到即可），
 * 04:00 之后返回次日 04:00。与 Go 侧 `cooldown.go:409-418` 逐字一致。
 */
export function nextDay4AmUtc8(now: number): number {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  const shifted = now + CST_OFFSET
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000
  const today4am = dayStart + 4 * 60 * 60 * 1000
  const target = shifted < today4am ? today4am : today4am + 86_400_000
  return target - CST_OFFSET
}
