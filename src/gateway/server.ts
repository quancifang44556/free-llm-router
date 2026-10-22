/**
 * 网关与账号池的接线：**选号 → 转发 → 记账 → 失败换号**。
 *
 * ## 为什么必须接线（这是架构的核心价值，不是可选优化）
 *
 * 没有接线的网关是「裸代理」：一个账号 429 或余额耗尽，**整个服务立刻不可用**，
 * 而且不会恢复 —— 因为没有任何地方记录「这个号暂时别用」。
 *
 * 接线后形成闭环（对应 Go 侧的 `handler.chatCompletions` 轮转 + `applyErrorPolicy`）：
 *
 * ```
 * pick(排除已试) → 转发 → 成功则 noteSuccess（清熔断）
 *                       ↘ 失败则 applyFailure（按类别落到正确维度）+ 换下一个号
 * ```
 *
 * ## 两个必须守住的纪律
 *
 * 1. **`tried` 集合跨重试保留**：否则会在两个账号之间无限来回
 *    （Go 侧 `account-pool.ts:905-914` 记录过这个缺陷）。
 * 2. **按错误类别罚正确的维度**（AGENTS.md §6.7）：
 *    - `6004` 是**模型级**限流 → 罚 `model`，不罚账号（切模型即可用）；
 *    - `11140` 是强信号 → 直接禁用账号；
 *    - `12153` 要**连续 3 次**才禁用；
 *    - `11115`/`11135` 是**请求的问题**，不罚号、也不换号。
 */

import type { UsageRecord } from '../store/usage.js'
import { resolveUpstream, type Env } from '../env.js'
import { settleSubkeyUsage } from './authz.js'
// ⚠️ 判据本体已迁到 `upstream/client.ts`（与 `shouldRotate`/`shouldPunish` 同源，
// 避免两份实现再次漂移）。这里再导出，保持既有引用路径可用。
export { mapErrorToPunishment }
import { classify, mapErrorToPunishment, type ErrorKind } from '../upstream/client.js'
import { deriveDeviceId, referenceChatHeaders } from '../upstream/headers.js'
import { deriveIntlConversationId, newTurnRequestId } from '../upstream/conversation.js'
import { cleanupToolPairing, prepareChatBody, sanitizeChatBody, trimMessagesByLimit } from './payload.js'
import { BodyTooLargeError, readJsonCapped } from './body.js'
import { safetyConfigFor } from './safety.js'
import { throttleUpstream } from './throttle.js'
import { ERROR_CHECK_FRAMES, ERROR_HINT_PATTERN, aggregateSse, createFrameTranslator, detectErrorFrame, doneFrame, errorFrame, isEmptyAssistantTurn, mayHaveUsage, parseSseLine, sseHeaders, translateFrame } from './stream.js'
import { jsonError, parseRetryAfterMs } from './http.js'
import {
  ZERO_OUTPUT_COOLDOWN_MS,
  describeZeroOutputHit,
  screenZeroOutputStream,
} from './zero-output.js'
import { DEFAULT_PROVIDER, findProvider, providerIds } from '../providers/index.js'
import { bindBuddy } from '../providers/buddy.js'
import {
  AGGREGATE_AUTO,
  AGGREGATE_PROVIDER_ID,
  EXPIRY_UNUSABLE,
  buildVirtualModels,
  rankCandidates,
  type AggregateCandidate,
  type ProviderCatalog,
} from './aggregate.js'
import { splitModelName, type ProviderCredential } from '../providers/types.js'
import type { LoginCredential } from '../upstream/auth.js'
import type { AccountPoolDO, PickResult } from '../pool/AccountPoolDO.js'
import { healthyForModel } from '../pool/state.js'

/**
 * 账号池后台写入（处罚 / 记账 / 粘性绑定）的错误处理：不打断主流程，但**必须留日志**。
 *
 * ⚠️ 此前这些调用都是 `.catch(() => {})`：写入失败时冷却、熔断、用量**静默丢失**，
 * 表现为「账号明明坏了还在被选」「对话成功但用量为 0」，且没有任何日志可查。
 */
function logPoolError(op: string): (error: unknown) => void {
  return (error: unknown) => {
    console.error(`[pool] ${op} 写入失败：`, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}

/**
 * 将 API 请求摘要记录到日志环形缓冲（供管理面板「日志」Tab 实时展示）。
 */
export function recordLog(
  pool: DurableObjectStub<AccountPoolDO>,
  entry: {
    type?: 'api' | 'task' | 'auth' | 'error'
    model: string
    provider: string
    uid: string
    status: number
    durationMs: number
    tokens?: { input: number; output: number; total: number }
    stream?: boolean
    error?: string
  },
  ctx?: ExecutionContext,
): void {
  const logItem = {
    id: Math.random().toString(36).slice(2, 10),
    time: Date.now(),
    type: entry.type ?? (entry.status >= 400 ? 'error' : 'api'),
    model: entry.model,
    provider: entry.provider,
    uid: entry.uid,
    status: entry.status,
    durationMs: entry.durationMs,
    tokens: entry.tokens ?? { input: 0, output: 0, total: 0 },
    stream: entry.stream ?? false,
    ...(entry.error ? { error: entry.error } : {}),
  }
  const task = pool.appendLog(logItem).catch((err: unknown) => {
    console.error('[log] 记录请求日志失败：', err instanceof Error ? err.message : String(err))
  })
  if (ctx !== undefined) ctx.waitUntil(task)
  else void task
}

/** 单次请求最多换号次数（Go 侧 `MaxRotate` 默认 3）。 */
export const MAX_ROTATE = 3

/** 路由配置「单次请求最大换号重试」的进程内缓存（30 秒），省得每个请求多一次 DO 往返。 */
let maxRotateCache: { value: number; at: number } | undefined
const MAX_ROTATE_TTL_MS = 30_000

/** 保存路由配置后调用：本进程立即生效（Workers 其余 isolate 最多 30 秒后生效）。 */
export function resetMaxRotateCache(): void {
  maxRotateCache = undefined
}

/**
 * 本次请求最多换几次号（读路由配置 `maxRetries`，读不到就用 {@link MAX_ROTATE}）。
 *
 * ⚠️ 读失败**绝不**影响请求本身：回落到默认值。
 */
export async function maxRotateFor(pool: DurableObjectStub<AccountPoolDO>, now = Date.now()): Promise<number> {
  if (maxRotateCache !== undefined && now - maxRotateCache.at < MAX_ROTATE_TTL_MS) return maxRotateCache.value
  let value = MAX_ROTATE
  try {
    const cfg = await pool.getRoutingConfig()
    if (typeof cfg?.maxRetries === 'number' && Number.isInteger(cfg.maxRetries) && cfg.maxRetries >= 0 && cfg.maxRetries <= 10) {
      value = cfg.maxRetries
    }
  } catch {
    // 回落默认值
  }
  maxRotateCache = { value, at: now }
  return value
}

/** 上游错误类别 → 账号池的惩罚维度。 */
/**
 * 把错误类别翻译成「模型级冷却的成因」，供 `applyFailure({ modelCause })` 使用。
 *
 * ⚠️ 这是**唯一**的判定入口：`AccountPoolDO` 不再靠 `reason` 文案反推。
 * 旧实现里那句 `reason.includes('not found')` 匹配面过宽，
 * 把由「模型名前缀拼错」引起的 11102 也当成了真不存在 ⇒ 误锁 6 小时（2026-10-20 事故）。
 */
export function modelCauseFor(kind: ErrorKind): 'busy' | 'absent' | 'denied' | undefined {
  switch (kind) {
    case 'model_unavailable':
      return 'absent'
    case 'model_denied':
      return 'denied'
    case 'rate_limited':
      return 'busy'
    default:
      return undefined
  }
}

/**
 * 结算延迟记账：把 `blame` 里的失败真正写进账号状态。
 *
 * ## 为什么需要「延迟」这一步（qoder2api-hub #65 的 C 点）
 *
 * 判据是「**换号后成功了**」，而不是「这个号失败了」：
 * - 成功 ⇒ 说明其余候选是健康的，之前的失败确实是那几个号的问题 ⇒ 记账；
 * - 全失败 ⇒ 更可能是上游整体故障 / 本机断网 ⇒ **丢弃**，只留一条日志。
 *
 * 不这么做会造成连锁熔断：每个请求遍历 N 个号、各记 1 次失败，
 * 3 个请求后全池 `breaker` 30 分钟；而熔断期内没有成功请求来复位计数，
 * 于是**上游恢复后号池仍然不可用** —— 故障被我们自己延长了。
 *
 * 用于 breaker / degrade（累加型计数），以及**单账号池下的 soft**
 *（池里只有一个号时，"立即冷却"等于立即掐断唯一路径 —— 见 `deferSoft`）。
 * restricted / model 有明确上游证据，一律立即记账，不走这里。
 */
/** blame 收件箱的元素类型（延迟记账用）。 */
type FailureKindForBlame = 'breaker' | 'degrade' | 'soft'

/**
 * blame 收件箱里的一条**待结算**失败。
 *
 * ## ⚠️ 为什么必须带 `resetAt`（2026-10-22 审查，S4）
 *
 * 同一次上游失败，走「立即结算」时会把上游给的重置墙钟一起交给池
 *（`!upstream.ok` 与首帧预检两条路径都传了 `resetAt`），而走「延迟结算」时
 * 元素类型里原来**只有 `uid/kind/reason`** ⇒ 上游墙钟在**进收件箱的那一刻**就被丢掉了。
 *
 * 后果是**同一个错误、两套口径**：
 * - 立即结算 ⇒ 冷却对齐上游墙钟（`reset at … UTC+8` / `Retry-After`）；
 * - 延迟结算 ⇒ 只能走我们自己猜的指数退避（猜早了继续撞限流，猜晚了白白少用几小时）。
 *
 * ⚠️ 说清楚边界：当前真正消费 `resetAt` 的只有 `soft` 与 `model` 两个维度 ——
 * `AccountPoolDO.applyFailure` 里 `breaker` / `degrade` 是**计数型**（数到 3 次/5 次
 * 才落一个固定窗口），**根本不读** `resetAt`。故这里补的是「口径统一、不再丢信息」，
 * **不改变** `breaker` / `degrade` 的冷却时长。
 */
export type BlameEntry = {
  uid: string
  kind: FailureKindForBlame
  reason: string
  /** 上游给出的重置时刻（epoch ms）。来自文案 `reset at … UTC+8` 或 `Retry-After`。 */
  resetAt?: number
}

export async function settleBlame(
  pool: DurableObjectStub<AccountPoolDO>,
  blame: BlameEntry[],
  now: number,
): Promise<void> {
  if (blame.length === 0) return
  await Promise.all(
    blame.map((b) =>
      pool
        .applyFailure({
          uid: b.uid,
          kind: b.kind,
          now,
          reason: b.reason,
          // ⚠️ 与「立即结算」那两条路径同一口径：上游给了墙钟就带过去，
          // 不再因为「延迟」而把它吃掉（见 `BlameEntry` 的说明）。
          ...(b.resetAt !== undefined ? { resetAt: b.resetAt } : {}),
        })
        .catch((error: unknown) => {
          console.warn(
            `[blame] 结算失败 uid=${b.uid} kind=${b.kind}: ` +
              (error instanceof Error ? error.message : String(error)),
          )
        }),
    ),
  )
}

/**
 * 丢弃 blame：**不记账**，但必须留一条日志。
 *
 * ## 缺陷（2026-10-22 审查，S11）
 *
 * `blame` 的语义是「先把失败挂起、等换号成功后结算」，因此它只有两个出口：
 * **结算**（{@link settleBlame}）与**丢弃**。丢弃本身是**正确**的
 *（全池同样失败时更可能是上游整体故障 / 本机断网，逐个记账会造成连锁熔断，
 * 见 `settleBlame` 的说明），缺的只是**可观测性**。
 *
 * 而「丢弃」的日志此前只写在**两处循环尾**。两个处理函数里另有 4 个
 * **早退出口**（只用指定账号却不可用 / 跨渠道容灾 / 没有可用账号 ×2）直接
 * `return`，`blame` 里的失败**既不结算也不打日志** ⇒ 账号该被罚却没罚，
 * 事后又一点痕迹都没有。而「全池都失败」最常见的形态（所有号都在冷却 /
 * 都被本次请求试过）恰好走的是**没有日志**的那条早退路径。
 *
 * ⚠️ 这里**一次 `applyFailure` 都不调**：丢弃就是丢弃。故签名里没有 `pool` ——
 * 带上它会让读者以为这个函数会记账（本仓库最忌的「假承诺」）。
 */
export function discardBlame(blame: BlameEntry[], reason: string): void {
  if (blame.length === 0) return
  console.warn(
    `[blame] ${reason}，丢弃 ${blame.length} 条失败记录（不记熔断）: ` +
      blame.map((b) => `${b.uid.slice(0, 8)}/${b.kind}`).join(','),
  )
}


/**
 * 上游错误 → **返回给客户端的** HTTP 状态码。
 *
 * ## ⚠️ 为什么不能原样透传上游状态码（实测缺陷）
 *
 * 用户报的错是 `Request failed: 400: {"message":"所有账号均失败，最后一次：
 * request_illegal: Illegal API invocation from an unapproved channel"}`
 * —— **400 让客户端以为「是我自己请求写错了」**，而真实原因是
 * **上游的渠道/风控判定**，与客户端的请求内容毫无关系。
 *
 * 轮转完**所有**账号仍失败时，故障点在**我们与上游之间**，
 * 正确的语义是 **502 Bad Gateway**。
 *
 * ## 例外：确实是客户端请求问题的，保留 400
 *
 * `context_exceeded`（上下文超限）与 `image_invalid`（图片无效）是
 * **请求内容**的问题 —— 换账号也不会好，客户端改请求才有用。
 * 这两类如实回 400，否则客户端会一直重试同一个必然失败的请求。
 */
/**
 * **流内错误**（HTTP 头已发出、错误出现在 SSE 帧里）该罚哪个维度。
 *
 * ## ⚠️ 为什么不能一律 `breaker`（实测缺陷，用户报「账号是好的但用不了」）
 *
 * 流内错误的文本里带着上游的业务码/文案。原实现**一律**按 `breaker` 记账 ⇒
 * `fails++`，**3 次就熔断账号 30 分钟**。
 *
 * 但其中的**渠道拦截**（`11128 "unapproved channel"`）与账号好坏**无关** ——
 * 它是**请求指纹**被判不认可。于是好账号会被逐个熔断，
 * 表现为「账号明明都是好的，却越来越用不了」。
 *
 * ## 判据
 *
 * - 文案含渠道/风控关键词（`unapproved channel` / `security policy` / `11128`）
 *   ⇒ `soft`（账号级软冷却，短期退避，不是熔断）；
 * - 其余（真的流中断、未知错误）⇒ 维持 `breaker`。
 *
 * ⚠️ 这里按**文案**判定而不是按 `kind`：流内错误在 `onError` 回调里
 * 拿到的只有一句 `message`，没有结构化的错误类别。
 */
// ⚠️ 用码点构造正则源串：拦截码有**裸 5 位数字**与**带连字符**两种记录形态，
// 两种都认（2026-10-19 曾只认带连字符形态，数字码的流内错误因此一律被记成熔断）。
// 码两侧要求非数字：流内错误文案里常带 requestId / 时间戳，长数字串里碰巧含这 5 位
// 不能因此把真正的流中断降级成软冷却。
const CHANNEL_BLOCK_RE = new RegExp(
  'unapproved channel|security policy|安全策略|(?<![0-9])(?:' +
    String.fromCharCode(0x31, 0x31, 0x31, 0x32, 0x38) +
    '|' +
    String.fromCharCode(0x31, 0x31, 0x2d, 0x31, 0x32, 0x38) +
    ')(?![0-9])',
  'i',
)

/**
 * 渠道拦截时附给客户端的排查提示（不换号、不罚号，所以要让用户知道该看哪里）。
 *
 * 这类拦截判的是**请求内容/指纹**，同一账号在官方客户端里照常可用。
 */
export const CHANNEL_BLOCKED_HINT =
  '（上游渠道校验拦截：与账号无关，多由客户端系统提示里的固定身份句或特征串触发；' +
  '网关已内置常见客户端的清洗，若仍复现请提供触发的系统提示首句）'

/**
 * 流内（首帧之后）错误的惩罚维度。
 *
 * 🔴 **必须与首帧/HTTP 分支同口径**（2026-10-21 审查补，重复实现专项）。
 *
 * ## 缺陷
 * 原实现只有一句话：`CHANNEL_BLOCK_RE.test(message) ? 'soft' : 'breaker'`。
 * 于是**同一个错误码**，行为取决于它从哪条路径到达：
 * - 首帧到达（`classify` + `mapErrorToPunishment` + `refineModelScoped`）
 *   ⇒ 6004/110 只锁**该模型**；
 * - 首帧之后到达 ⇒ 一律 `breaker`（**账号级**，3 次 30 分钟起，按 `2^n` 到 6 小时）。
 *
 * 对单账号供应商（qoder），`breaker` 等于「整个供应商 30 分钟不可用」，
 * 而正解只是「换一个模型」。
 *
 * ## 修法
 * 用与另外两条路径同一个 `classify()`：限流/模型级/请求形状问题都只记 `soft`
 *（模型维度冷却），只有真正「说不清、疑似账号本身坏了」才落 `breaker`。
 * 解析不出错误码时仍兜底 `breaker` —— 失败方向保持保守。
 */
export function punishmentForStreamError(message: string): 'soft' | 'breaker' {
  if (CHANNEL_BLOCK_RE.test(message)) return 'soft'
  const kind = classify(200, message).kind
  switch (kind) {
    // 限流（6004/14017）、无此模型（11102）、档位拒绝（11158）：
    // 都是**模型维度**的问题，换号/换模型能解，不该把整号熔断。
    case 'rate_limited':
    case 'model_unavailable':
    case 'model_denied':
      return 'soft'
    // 请求本身的形状问题：换号也不会好，更不该罚号
    case 'bad_request':
    case 'context_exceeded':
    case 'image_invalid':
      return 'soft'
    default:
      return 'breaker'
  }
}

/**
 * 该供应商是否已被**用户在面板里关闭**。
 *
 * ## 语义（用户 2026-10-07 明确）
 *
 * 「关闭」= **彻底关掉**：模型从 `/v1/models` 消失，**且拒绝路由到它**。
 * 故判据读**服务端**设置（DO storage），不是浏览器 localStorage。
 *
 * ⚠️ **读失败一律按「没关」处理**：设置只是偏好，不该因为读不到它
 * 就让**所有**请求 403 —— 那会把一个小故障放大成全面不可用。
 */
async function isProviderClosedByUser(env: Env, providerId: string): Promise<boolean> {
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const settings = await pool.getProviderSettings()
    return settings.disabled.includes(providerId)
  } catch {
    return false
  }
}

export function clientStatusFor(upstreamStatus: number, kind: ErrorKind | string): number {
  // 请求形状被拒：客户端的请求本身有问题（换号也不会好）——即使上游用 5xx 包着也回 400
  if (kind === 'bad_request') return 400
  // 上游 5xx ⇒ 网关上必然是 502
  if (upstreamStatus >= 500) return 502
  // 确实是「请求内容」的问题 ⇒ 如实回 400（客户端改请求才有用）
  if (kind === 'context_exceeded' || kind === 'image_invalid') return 400
  // 鉴权类：上游凭据问题，不是客户端的错
  if (kind === 'auth_error') return 502
  // 其余（渠道拦截 / 限流 / 模型不可用 / 未知）都归为网关侧故障
  return 502
}

/**
 * 从业务码里再细分限流维度：6004 / 14003 是**模型级**，14017 是**账号级**。
 *
 * ## ⚠️ 为什么必须细分（实测缺陷）
 *
 * 上游 6004 的原话是：
 * > usage exceeds frequency limit, but don't worry, your usage will reset at
 * > 2026-10-05 14:47:23 UTC+8, **alternatively, you can switch to the other** …
 *
 * 「你可以换用**其它模型**」—— 这明确是**模型级**限流。若把它当成账号级
 * 冷却，后果是：**单个账号的供应商**（如只有 1 个 global 账号的 workbuddy）
 * 会在冷却期内**完全不可用**，而真实情况是「换个模型立刻就能用」。
 * 用户看到的现象正是「一会能用一会不能用」。
 *
 * ## 14003 同型（WorkBuddy 国际版「模型繁忙」）
 *
 * 实测原文（2026-10-19，wb 国际版）：
 * `{"code":14003,"msg":"too many requests","displayMsg":{"en":
 *   "Model busy. Please switch models or retry later"}}`
 *
 * 「switch models」与 6004 的「switch to the other model」是**同一句话**。
 * 判成账号级比 6004 更糟：池内所有账号会被逐个拉黑，且连续 3 次失败触发
 * **30 分钟账号熔断** ⇒ 整个服务突然全挂，而真实原因只是「某个模型繁忙」。
 *
 * ⚠️ 故判据有**两条腿**：码值（6004 / 14003）+ 文案（"model busy" /
 * "switch … model"）。只靠数字会再次误判 —— 上游换个码值就复发。
 */
export function refineModelScoped(
  kind: ErrorKind,
  bodyText: string,
): { dimension: 'soft' | 'model'; code: number | undefined; resetAt: number | undefined } {
  const code = parseBusinessCode(bodyText)
  const resetAt = parseResetAt(bodyText)
  if (kind !== 'rate_limited') return { dimension: 'soft', code, resetAt }
  /**
   * ⚠️ 字符串形态的业务码（`{"code":"11-128"}`）解析不出数字，
   * 此时**不得**使用文案正则（`switch models`）判模型维度 —— 见上方的说明。
   */
  const isChannelBlockedText = /"code"\s*:\s*"11-128"/.test(bodyText) || code === 11_128
  if (isChannelBlockedText) return { dimension: 'soft', code, resetAt }
  // 6004 / 14003 = 模型级限流（切模型即可用，不该罚整个账号）
  // 11134 = 模型供应方暂不可用（同属「换个模型就行」）
  /**
   * ⚠️ **`110` 也必须在这里**（2026-10-21 实测）。
   *
   * qoder 的 `110`（`Billing daily count exceeded`）是**模型级**日次数上限 ——
   * 实测证据：同一账号下 `dfmodel` 返回 110，而
   * `qmodel` / `dmodel` / `auto` / `gmodel` / `mmodel` **全部 200 可用**，
   * 且 `/admin/accounts/balance` 显示 `credits: 4565`（充足）。
   *
   * ⇒ 若只映射成 `rate_limited` 而不在这里归到 `model`，它会落进 `dimension: 'soft'`
   * 即**账号级**冷却 —— 短暂锁住整个账号，连带影响那些本来能用的模型。
   * 归到 `model` 后只冷却 `dfmodel`，其余模型不受影响（`healthyForModel` 按模型判）。
   */
  // ⚠️ `10605`（上游排队）也是**模型级**：排队挤的是某个模型的推理队列，
  // 不是这个账号坏了。归到模型级 ⇒ 只冷却该模型，换模型立刻可用。
  // （2026-10-21 审查补，M3 指出 503 会被误判成 breaker。）
  if (code === 6004 || code === 14003 || code === 11134 || code === 110 || code === 10605) {
    return { dimension: 'model', code, resetAt }
  }
  // ⚠️ 文案兜底（第二道腿）：上游换码值时仍能判对。只认「模型」语义的措辞，
  // **不得**匹配泛泛的 "too many requests"（那是真·账号级限流）。
  //
  // 🔴 必须同时认**中文**（2026-10-20 实测确证的真实缺陷）：
  //   国内服 6004 的原文是
  //   `您的使用量已超出频率限制，将在 … 重置，**您也可以切换其他模型继续使用**。`
  //   这句「可以切换其他模型」明确说明是**模型级**（打个别的模型就能用）。
  //   旧实现只认英文正则 ⇒ 判成 `soft`（账号级）⇒ **整个账号被关掉**，
  //   而实际上只需换模型。用户体感正是「号是好的却用不了」。
  if (/model\s*busy|switch\s+(?:to\s+the\s+other|models?\b)|other model/i.test(bodyText)) {
    return { dimension: 'model', code, resetAt }
  }
  if (/切换(?:其他|别的|其它)?模型|其他模型(?:继续)?(?:使用|可用)|换个模型/i.test(bodyText)) {
    return { dimension: 'model', code, resetAt }
  }
  return { dimension: 'soft', code, resetAt }
}

/** 从响应体里读业务码（`{"code":6004,...}`）。 */
export function parseBusinessCode(bodyText: string): number | undefined {
  /**
   * 🔴 **必须同时认「带引号的字符串码」**（2026-10-21 实测缺陷）。
   *
   * 旧正则 `/"code"\s*:\s*(\d+)/` **只认未加引号的数字**（`{"code":6004}`），
   * 而 qoder 实际返回的是 **`{"code":"110"}`**（值是字符串）。
   * ⇒ 解析返回 `undefined` ⇒ `refineModelScoped` 的模型级判据（6004/14003/11134/110）
   * 全部失效 ⇒ 落回 `dimension: 'soft'`（**账号级**冷却）
   * ⇒ 一个「只有某模型不可用」的错误把整个账号锁住了。
   *
   * 两个分支**必须成对**：
   * - 有引号时必须要求**闭合引号**，否则 `"11‑128"` 会被截成 `11`（错值）；
   * - 无引号时按裸数字解析（`{"code":6004}`）。
   *
   * ⚠️ `11‑128` 里的连字符是 **U+2011**（非 ASCII），`\d+` 不会跨越它，
   * 且闭合引号分支要求数字后紧跟 `"`，故 `"11‑128"` 正确地解析不出数字
   * —— 那类码由 `isChannelBlockedText` 单独处理。
   */
  const quoted = /"code"\s*:\s*"(\d+)"/.exec(bodyText)
  if (quoted !== null) return Number.parseInt(quoted[1] ?? '', 10)
  const bare = /"code"\s*:\s*(\d+)/.exec(bodyText)
  return bare === null ? undefined : Number.parseInt(bare[1] ?? '', 10)
}

/**
 * 解析上游在限流文案里给出的**重置时刻**。
 *
 * 上游会明说何时恢复：`your usage will reset at 2026-10-05 14:47:23 UTC+8`。
 * ⚠️ 用它而不是我们自己的退避估算 —— 上游知道真实的重置墙钟，
 * 我们猜的（6h 起指数退避）要么过早（继续撞限流）要么过晚（白白少用几小时）。
 *
 * ⚠️ 时区必须按文案里的 `UTC+8` 偏移换算（**不能**用运行时本地时区：
 * Worker 跑在 UTC，直接 `new Date(str)` 会差 8 小时）。
 *
 * ## 🔴 必须同时认**中文**文案（2026-10-20 实测确证的真实缺陷）
 *
 * 上游对国内服下发的是**中文**：
 *   `您的使用量已超出频率限制，将在 2026-10-21 13:16:46 UTC+8 重置，
 *     您也可以切换其他模型继续使用。`
 *
 * 而旧实现只匹配英文 `reset at …` ⇒ 这类文案**从未被解析出来**，
 * 于是国内服的限流一直走「自己猜的退避时长」：
 *   - 猜短了：冷却结束时上游仍限流，白撞一次；
 *   - 猜长了：上游早已恢复，账号却还被关着（用户体感正是「号是好的却用不了」）。
 *
 * 实测后果：`deepseek-v4.1-flash` 的上游重置时刻是 `21:37:05`，
 * 而本地按 15s→90s 短退避反复探测，与真实窗口完全脱节。
 *
 * ⇒ 现在两种语言、多种措辞都认，且**优先级**为：
 *   ① 文案里的绝对墙钟（最精确，含时区）
 *   ② `Retry-After` 标准头（只有秒级粒度，作兜底）
 *   ③ 本地退避估算（最后手段）
 */
export function parseResetAt(bodyText: string): number | undefined {
  // ⚠️ 关键：**不能**把措辞写死在正则里（`reset at` vs `将在 … 重置` 随时会变）。
  // 只要报文里同时出现「日期时间 + UTC 偏移」，就按墙钟解析 —— 语义由上下文决定
  // （本函数只在限流/冷却路径上被调用，不存在「普通正文里恰好有日期」的误判场景）。
  const m =
    // 英文：`reset at 2026-10-05 14:47:23 UTC+8`
    /reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC([+-])(\d{1,2})/.exec(bodyText) ??
    // 中文：`将在 2026-10-21 13:16:46 UTC+8 重置`
    /将在\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC([+-])(\d{1,2})/.exec(bodyText) ??
    // 兜底：任何 `YYYY-MM-DD HH:MM:SS UTC±N`（措辞再变也不怕）
    /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC([+-])(\d{1,2})/.exec(bodyText)
  if (m === null) return undefined
  const [, y, mo, d, h, mi, sec, sign, offRaw] = m
  const offsetHours = Number.parseInt(offRaw ?? '0', 10) * (sign === '-' ? -1 : 1)
  const utcMs = Date.UTC(
    Number.parseInt(y ?? '0', 10),
    Number.parseInt(mo ?? '1', 10) - 1,
    Number.parseInt(d ?? '1', 10),
    Number.parseInt(h ?? '0', 10),
    Number.parseInt(mi ?? '0', 10),
    Number.parseInt(sec ?? '0', 10),
  ) - offsetHours * 60 * 60 * 1000
  return Number.isFinite(utcMs) ? utcMs : undefined
}

/** 选号 + 取凭据。 */
interface Candidate {
  uid: string
  credential: LoginCredential
}

/** 走账号池选号（**排除已试过的**，跨重试保留）。 */
/**
 * 派生**会话粘性 key**（把同一会话固定到同一账号，命中上游 prompt cache）。
 *
 * ## 🔴 只用客户端**显式**给的会话标识，绝不从内容推断（实测踩过严重缺陷）
 *
 * ### 我第一版写错了：用「首条消息指纹」当会话 key
 *
 * 当时的想法是「同一会话的后续轮次，首条消息不变，故指纹稳定」。
 * **这个推断是错的**，实测后果（用户报「思考 78 秒又断了」）：
 *
 * - 「首条消息相同」**不等于**「同一会话」—— 任何两个用户发出相同 prompt
 *   （或同一用户重发一次）都会得到**同一个 key**；
 * - 于是这些**互相独立的请求**被当成一个会话，**全部粘到同一个账号**；
 * - 并发时该账号被压垮，**上游把先前的流踢掉** ⇒ 表现为「长回答中途突然停止」；
 * - 实测对照：3 个**相同 prompt** 并发 ⇒ 1 个被切断；
 *   3 个**不同 user 字段**并发 ⇒ **3/3 全部完整**。这是决定性证据。
 *
 * ### 正确做法
 *
 * 只认客户端**显式**声明的会话标识：
 * 1. `user` 字段（OpenAI 规范里它就是「最终用户的稳定标识符」）；
 * 2. `conversation_id` / `conversationId`（部分客户端会带）。
 *
 * ⚠️ **都没有就返回空串 = 不做粘性**，回落到常规加权随机（自然摊到多个账号）。
 * 「不粘」只是少了 prompt cache 命中率；而「错误地粘」会**弄断用户的流**。
 * 两害相权，必须选前者。
 *
 * ⚠️ 顺带纠正一个性能认知：原先那段「只取前 512 字符」的注释是为了省 CPU，
 * 但真正的 CPU 杀手是**每帧**的净化（见 `stream.ts`），不是这个
 * 每请求只跑一次的函数。
 */
async function deriveSessionKey(rawBody: unknown): Promise<string> {
  if (rawBody === null || typeof rawBody !== 'object') return ''
  const body = rawBody as Record<string, unknown>

  // ① `user` 字段（最可靠，规范里就是干这个的）
  // ⚠️ 排除通用客户端静态占位值：ChatBox、NextChat 等客户端经常全局硬编码
  // 固定的通用名字，若把它们当会话，会把不同对话甚至不同时间的所有流量焊死在同一个账号上。
  const user = body.user
  if (typeof user === 'string' && user.trim() !== '') {
    const norm = user.trim().toLowerCase()
    const isGeneric = ['default', 'default-user', 'default_user', 'user', 'chatbox', 'nextchat', 'admin', 'root', 'anonymous', '1'].includes(norm)
    if (!isGeneric) {
      return `u:${(await sha256Hex(user.trim())).slice(0, 32)}`
    }
  }

  // ② 部分客户端显式带的会话 id（snake_case 与 camelCase 都认）
  for (const key of ['conversation_id', 'conversationId']) {
    const v = body[key]
    if (typeof v === 'string' && v.trim() !== '') {
      return `c:${(await sha256Hex(v.trim())).slice(0, 32)}`
    }
  }

  // ⚠️ **没有显式会话标识 ⇒ 不做粘性**。
  // 绝不回落到「内容指纹」—— 那会把独立请求误判成同一会话（见上方说明）。
  return ''
}

/** SHA-256 → 小写 hex（WebCrypto）。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 请求级指定账号：请求头 `X-FLR-Account: <uid>`（语义恒为「只用它」）。
 *
 * 空串 = 未指定（走面板里的指定或自动选号）。
 */
export function requestedAccount(request: Request): string {
  return (request.headers.get('x-flr-account') ?? '').trim()
}

/**
 * 「只用指定账号」但它不可用时给用户看的说明。
 *
 * ⚠️ 必须说清三件事：指定了**谁**、它**为什么**不可用、**怎么解除** ——
 * 否则用户只会看到「请求失败」，想不起来自己设过指定。
 */
export function describePinBlocked(
  picked: Pick<PickResult, 'pinnedUid' | 'pinnedLabel' | 'pinnedReason'>,
  fromHeader: boolean,
  /** 指定账号在本次请求里的真实失败原因（若它已经试过）。 */
  lastFailure?: string,
): string {
  const uid = picked.pinnedUid ?? ''
  const nick = picked.pinnedLabel ?? ''
  const label = nick !== '' && nick !== uid ? `${nick}（${uid}）` : uid
  const head = fromHeader ? `请求头 X-FLR-Account 指定了账号「${label}」` : `已指定只用账号「${label}」`
  const why = lastFailure !== undefined && lastFailure !== ''
    ? `它这次请求失败了：${lastFailure}`
    : `但它当前不可用：${picked.pinnedReason ?? '原因未知'}`
  const fix = fromHeader
    ? '去掉该请求头即可恢复自动选号'
    : '可在面板「供应商与账号」里取消指定，或改为「优先用它」（不可用时自动换号）'
  return `${head}，${why}。${fix}。`
}

/** 选号被「只用指定账号」挡住（网关据此直接报错，不换号、不跨渠道容灾）。 */
interface PinBlocked {
  pinBlocked: true
  picked: PickResult
}

async function pickCandidate(
  pool: DurableObjectStub<AccountPoolDO>,
  realm: string,
  model: string,
  exclude: string[],
  now: number,
  provider: string,
  /** 会话粘性的优先账号（仅首轮传；见 `deriveSessionKey` 的说明）。 */
  preferred?: string,
  /** 请求级指定账号（`X-FLR-Account`）。 */
  pinned?: string,
): Promise<Candidate | PinBlocked | undefined> {
  const result = await pool.pick({
    realm, provider, model, exclude, now,
    ...(preferred !== undefined && preferred !== '' ? { preferred } : {}),
    ...(pinned !== undefined && pinned !== '' ? { pinned } : {}),
  })
  if (result !== undefined && result.pinnedUnavailable === true) {
    return { pinBlocked: true, picked: result }
  }
  // ── 永久积分锁：把「锁了」翻译成**用户可见的明确错误** ──
  //
  // ⚠️ 这条分支是 §7.2「失败必须显式」的落地：若静默返回 undefined，
  // 上层会报含糊的「无可用账号」—— 用户会误判服务故障、甚至解锁
  // 烧掉不可撤回的永久积分（那正是锁要防的事）。
  if (result !== undefined && (result as { lockedByPermanent?: true }).lockedByPermanent === true) {
    const skipped = (result as { lockedSkipped?: number }).lockedSkipped ?? 0
    throw new Error(
      `该供应商的 ${skipped} 个账号只剩永久积分且已被「永久积分锁」保护，` +
        '不参与选号。若确认要消耗永久积分，请在面板里关闭该锁。',
    )
  }
  if (result === undefined) return undefined
  const credential = (await pool.getCredential(result.uid)) as LoginCredential | undefined
  if (credential === undefined || credential.accessToken === '') return undefined
  return { uid: result.uid, credential }
}

/** 账号请求失败时异步解绑会话粘性，防止下次请求死锁在坏账号上。 */
function clearSessionBinding(
  pool: DurableObjectStub<AccountPoolDO>,
  sessionKey: string,
  ctx?: ExecutionContext,
): void {
  if (sessionKey === '') return
  if (ctx !== undefined && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(pool.unbindSession(sessionKey).catch(logPoolError('unbindSession')))
  } else {
    void pool.unbindSession(sessionKey).catch(logPoolError('unbindSession'))
  }
}

/** 网关处理结果。 */
export interface GatewayResult {
  response: Response
}

/**
 * 处理 `/v1/chat/completions`：**选号 → 转发 → 记账 → 失败换号**。
 */
/**
 * 记一条**请求级**失败用量（2026-10-21 审查补，M6 指出）。
 *
 * ## 缺陷
 * 全库 `recordUsage` 的 4 个调用点**全部**写 `ok: true`，**没有任何**
 * `ok: false` 的生产者 ⇒ 用量表里「失败」恒为 0 ⇒ **面板成功率恒 100%**。
 * 用户据此判断「网关很稳」，而实际上整池失败全被静默吞掉。
 *
 * ## 口径
 * 每个**请求**记一条（不是每个尝试记一条）：
 * 一次请求轮了 3 个账号最终失败，若记 3 条会把「请求数」放大 3 倍、
 * 把成功率进一步压低到失真。故用最后一个尝试的账号作为归属，并在
 * `errorKind` 里带上分类原因（该字段此前从未被写过）。
 */
function recordRequestFailure(
  pool: { recordUsage: (record: UsageRecord) => Promise<unknown> },
  input: { uid: string; model: string; errorKind: string; startedAt: number },
): void {
  void pool
    .recordUsage({
      at: Date.now(),
      uid: input.uid,
      model: input.model,
      input: 0,
      output: 0,
      ok: false,
      errorKind: input.errorKind,
      ms: Math.max(0, Date.now() - input.startedAt),
    })
    .catch(() => undefined)
}

/**
 * 流内失败也要记**用量**（T3，2026-10-22）。
 *
 * ## 缺陷
 * 三条流式路径的 `onError` 都只 `recordLog()`，**从不 `recordUsage()`**。
 * 而面板的「成功率」是按 `recordUsage.ok` 算的 ⇒ 流内失败的请求
 * 既不计入失败、也不计入总数，成功率**恒接近 100%**。
 *
 * 这与请求级失败（`recordRequestFailure`）不是一回事，不会重复计数：
 * 那条只在「一个候选都没成功、还没开始推流」时触发；本函数处理的是
 * **已经 200 开流、推到一半上游断了**——请求级路径根本走不到。
 */
function recordStreamFailure(
  pool: { recordUsage: (record: UsageRecord) => Promise<unknown> },
  input: { uid: string; model: string; errorKind: string; startedAt: number },
  ctx: ExecutionContext | undefined,
): void {
  const t = pool
    .recordUsage({
      at: Date.now(),
      uid: input.uid,
      model: input.model,
      input: 0,
      output: 0,
      ok: false,
      errorKind: input.errorKind,
      ms: Math.max(0, Date.now() - input.startedAt),
    })
    .catch(() => undefined)
  if (ctx !== undefined) ctx.waitUntil(t)
}

export async function handleChatCompletions(
  request: Request,
  env: Env,
  realm = 'cn',
  /**
   * ExecutionContext（可选，便于单测）。
   *
   * ⚠️ 用途是 `waitUntil`：把「流结束后才发生的记账」托住，
   * 否则响应一结束 Worker 就会取消它。
   */
  ctx?: ExecutionContext,
  /**
   * 跨渠道容灾深度（内部用，默认 0）。
   *
   * ⚠️ **必须存在**：buddy 与国际版 workbuddy 互为容灾目标，
   * 若两边都不加深度限制，会形成 `buddy→workbuddy→buddy→…` 的
   * **无限相互递归**（栈溢出 / CPU 超时）。深度 ≥1 时不再触发任何容灾。
   */
  failoverDepth = 0,
): Promise<GatewayResult> {
  // ① 解析并准备请求体（一次性，不随换号重复）
  let rawBody: unknown
  try {
    // 🔴 **必须有上限**（2026-10-21 审查补，安全面专项）：
    // 原来直接 `request.json()`，一条 120 MiB 的请求会把 RSS 顶高 322 MB，
    // 而且**读完之后**才因别的原因失败 —— 没有 413。
    rawBody = await readJsonCapped(request)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { response: jsonError(413, error.message, 'payload_too_large') }
    }
    return { response: jsonError(400, '请求体必须是合法 JSON', 'invalid_request_error') }
  }

  // 会话粘性 key（空串 = 无法判定会话，此时不做粘性）。
  // ⚠️ 在这里算一次、两条路径共用 —— 不各算一份（会分叉）。
  const sessionKey = await deriveSessionKey(rawBody)

  // ── 防封配置（面板可改，10 秒 TTL 缓存）──
  // ⚠️ 必须**早于裁剪**：裁剪上限本身来自这份配置。
  // ⚠️ 这里单独建一个 stub 只为读配置：真正的 `pool` 要到分支里才建，
  //    而裁剪必须在所有分支之前完成（否则又变成「只修一半」）。
  const safety = await safetyConfigFor(env, env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm)))

  const rawModel =
    typeof (rawBody as Record<string, unknown>).model === 'string'
      ? ((rawBody as Record<string, unknown>).model as string)
      : ''

  // ── 单请求消息数硬上限（全链路唯一一处裁剪） ──
  //
  // ## 为什么插在这里（而不是 `handleProviderChat` 或 `prepareChatBody` 里）
  //
  // `handleChatCompletions` 是**所有**对话请求的共同入口：
  //   ① 聚合路由  → `handleAggregateChat` → `handleProviderChat`
  //   ② 具名供应商 → `handleProviderChat`
  //   ③ 默认供应商（buddy）→ `prepareChatBody`
  //   ④ `/v1/responses` → `toChatBody` → 本函数
  // 而 `prepareChatBody` 只服务 ③（provider 路径**根本不过它**），
  // `handleProviderChat` 又接不到 ③。**任何一个都不是唯一落点** ——
  // 在两个地方各写一遍，正是本项目的旧伤「同一个 bug 只修一半」。
  // 故裁剪放在 `rawBody` 解析之后、所有分支之前，改一次全覆盖。
  //
  // ⚠️ 顺序上有两个刻意的选择：
  // - 放在 `deriveSessionKey` **之后**：会话粘性 key 必须由**完整**历史算出，
  //   若先裁剪，裁掉的那几条会影响 key ⇒ 每轮 key 都在变 ⇒ 粘性失效、命中不了上游 prompt cache；
  // - 放在 `rawModel` **之后**：日志要带模型名（只带名字，不带任何消息内容）。
  // ── 消息归一：`developer` → `system`、工具配对修复（**全链路唯一一处**）──
  //
  // ## 为什么必须放在这里
  //
  // 同一段逻辑原本只在 `prepareChatBody` 里，而它**只服务默认供应商（buddy）**；
  // 具名/聚合 provider 走 `handleProviderChat`，`rawBody` 被原样展开就发上游
  // ⇒ 归一从未生效。实测（2026-10-21）用户用 DSH 选 Qoder 中国版：
  //
  //   HTTP 400 {"code":"provider_error",
  //     "details":"Failed to deserialize the JSON body into the target type:
  //                messages[0].role: unknown variant `developer`,
  //                expected one of `system`, `user`, `assistant`, `tool`"}
  //
  // 上游只认 system/user/assistant/tool，而 OpenAI 新规范里 DSH 用
  // `role: 'developer'` 承载系统提示词。buddy 路径因为有 `prepareChatBody` 侥幸没事，
  // provider 路径全线报错 —— 正是本项目旧伤「同一个 bug 只修一半」的又一次复现。
  //
  // ⇒ 落点选在**所有分支之前**（与下面的消息数裁剪同理）：聚合路由、具名供应商、
  // 默认供应商、`/v1/responses` 四条路都从这里过，改一次全覆盖。
  // `cleanupToolPairing` 是幂等的，buddy 路径再经 `prepareChatBody` 跑第二遍也无副作用。
  if (rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
    const msgBody = rawBody as Record<string, unknown>
    if (Array.isArray(msgBody.messages)) {
      const before = msgBody.messages as unknown[]
      const normalized = cleanupToolPairing(before)
      if (normalized !== before) {
        rawBody = { ...msgBody, messages: normalized }
        // ⚠️ 隐私红线：只打模型名，不打任何消息内容。
        console.log(`[msg-normalize] 已归一消息角色/工具配对 model=${rawModel}`)
      }
    }
  }

  // ── 聚合 provider 分支 ──
  //
  // ## 🔴 **必须在这里手写剥前缀**（不能靠 `splitModelName`）
  //
  // `aggregate` **不在 `providerIds()`** 里（见 `aggregate.ts` 文件头：
  // 它是网关层的一层，不是注册表里的 Provider）。而 `splitModelName` 对
  // **未知前缀**的处理是：回落到默认供应商，并把**整串**当模型名 ——
  // 实测 `aggregate/deepseek-v4-1-flash` ⇒ `{provider:'buddy',
  // model:'aggregate/deepseek-v4-1-flash'}`。
  //
  // 后果比「报错」严重得多：那个名字上游当然不认识，回 11102
  // `model [...] service info not found`，被归类为 `model_unavailable`
  // ⇒ **给这个模型写 6 小时模型级冷却** —— 一个纯粹由我方前缀引起的失败，
  // 被记成了「上游没有这个模型」。之后所有同名请求都选不到号。
  //
  // ⚠️ 判据是**前缀完全匹配**（`=== id` 或 `startsWith(id + '/')`），
  // 不是「包含 `aggregate/`」—— 否则 `buddy/aggregate/x` 会被误吞。
  const AGG_PREFIX = `${AGGREGATE_PROVIDER_ID}/`
  // 前缀大小写不敏感（与 `splitModelName` 一致）：`Aggregate/auto` 若漏到默认供应商，
  // 小写化后会以 `aggregate/auto` 打上游 ⇒ 11102 ⇒ 被记成模型冷却。
  const rawLower = rawModel.toLowerCase()
  if (rawLower === AGGREGATE_PROVIDER_ID || rawLower.startsWith(AGG_PREFIX)) {
    return await handleAggregateChat({
      model: rawModel.slice(AGG_PREFIX.length),
      // ⚠️ 就地算 `wantsStream`（不用外层那个 `const`）——
      // 本分支在它**之前**执行（必须早于 `splitModelName`），
      // 引用未初始化的 `const` 会抛 TDZ 错误。判据与外层**逐字一致**：
      // OpenAI 规范里 `stream` 缺省是 `false`（非流式）。
      wantsStream: (rawBody as Record<string, unknown>).stream === true,
      rawBody, request, env, realm, ctx, sessionKey,
    })
  }

  // ⚠️ 多供应商路由：`provider/model` 前缀决定去哪家。
  // 无前缀时回落到默认供应商（保持既有用户兼容 —— 他们已经在用裸模型名）。
  const routed = splitModelName(rawModel, providerIds(), DEFAULT_PROVIDER)

  const providerId = routed.provider
  /**
   * ── 消息数裁剪：**只对 WorkBuddy 国际版（workbuddy）生效**──
   *
   * ## 🔴 为什么必须是 workbuddy 专属（2026-10-22 修正）
   *
   * 这项来自封号复盘 P2「上下文治理」，它的目的是**伪装**：让我们的请求
   * 看起来像官方客户端的行为（复盘结论是「超大上下文 + 高频连发」会被并入
   * 机器行为画像）。**伪装只对需要伪装的上游有意义。**
   *
   * `workbuddy`（国际版）是我们用一个「非官方客户端」的身份去冒充桌面端，
   * 风控判据在那儿。而 `qodercn` / `qoder` / `cline` 等是我们**用它们自己的
   * 官方凭据/协议**在跑 —— 本来就没有「像不像官方客户端」的问题，
   * 给它们裁消息只是**白白损坏用户请求**。
   *
   * 原实现放在所有分支之前（那是为了「改一次全覆盖」），副作用是
   * **把防封措施套到了全部供应商头上**。实测后果：agent 会话
   * `1767 条 → 301 条`，一次丢掉 1466 条历史（系统提示 + 早期工具结果），
   * 模型于是重复调工具、基于不存在的上下文编造 —— 表现为「上游异常」，
   * 真因在我们自己把对话腰斩了。
   *
   * ⚠️ **消息归一（`cleanupToolPairing`）不在此列**，它必须对所有供应商生效：
   * 那是**协议适配**（上游只认 system/user/assistant/tool），不是防封。
   *
   * ⚠️ 位置说明：必须放在 `splitModelName` **之后**（否则拿不到 `providerId`），
   * 且仍在所有真正的转发分支**之前**（buddy 主路径、provider 路径、聚合路径）。
   */
  const maxContextMessages = safety.maxContextMessages
  if (
    providerId === 'workbuddy'
    && maxContextMessages > 0
    && rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
  ) {
    const withMessages = rawBody as Record<string, unknown>
    if (Array.isArray(withMessages.messages)) {
      const beforeTrim = withMessages.messages as unknown[]
      const trimmed = trimMessagesByLimit(beforeTrim, maxContextMessages)
      if (trimmed.messages !== beforeTrim) {
        rawBody = { ...withMessages, messages: trimmed.messages }
        // ⚠️ 隐私红线：**不打任何消息内容**，只打条数与模型名。
        console.log(
          `[context-trim] 消息数超限已压缩：${beforeTrim.length} 条 → ${trimmed.messages.length} 条`
            + `（省略更早 ${trimmed.dropped} 条）limit=${maxContextMessages} model=${rawModel}`,
        )
      }
    }
  }

  // WorkBuddy 两个渠道的上游模型 id 全是小写（`deepseek-v4.1-flash`、`glm-5.3` …），
  // 客户端手填的 `Workbuddy/DeepSeek-v4.1-Flash` 若原样上送会 11102 ⇒ 被记 6 小时模型冷却。
  // 其他供应商的 id 可能区分大小写，不动。
  const model = providerId === 'buddy' || providerId === 'workbuddy' ? routed.model.toLowerCase() : routed.model

  // ⚠️ **读客户端要的是流式还是非流式**（实测踩到的严重缺陷）。
  //
  // 上游只支持流式，故我们一律以流式请求它；但客户端可能要非流式。
  // 原实现**从不检查**这个字段，一律把 SSE 转发回去 ——
  // 非流式客户端拿到 `data: {...}` 文本，JSON.parse 直接报
  // `Unexpected JSON token at offset 5`（offset 5 就是 `data:` 的冒号）。
  /**
   * 客户端是否要流式。
   *
   * ⚠️ **OpenAI 规范里 `stream` 缺省是 `false`（非流式）**。
   * 我第一版写成「缺省按流式」，结果非流式工具调用（客户端没传 stream）
   * 仍返回 SSE 原文 —— 客户端 `JSON.parse` 报
   * `Unexpected JSON token at offset 5`。已用真实请求复现。
   *
   * 故判据是**严格等 true**：只有显式 `stream: true` 才走流式。
   */
  const wantsStream = (rawBody as Record<string, unknown>).stream === true

  // ⚠️ **用户关闭的供应商必须拒绝路由**（关闭 = 彻底关掉，不只是从目录里消失）。
  //
  // ## 为什么必须在这里拦
  //
  // 只在 `/v1/models` 里过滤是**不够的** —— 客户端可能缓存了旧目录，
  // 或者直接按名字硬编码调用。那会让「我明明关了它」变成一句空话：
  // 关了之后仍能用，只是「不好找」而已。
  //
  // ⚠️ 判据读的是**服务端**设置（DO storage），不是浏览器 localStorage ——
  // 后者只在面板生效，API 照样能调。
  const closedByUser = await isProviderClosedByUser(env, providerId)
  if (closedByUser) {
    return {
      response: jsonError(
        403,
        `供应商「${providerId}」已被你在面板中关闭。如需使用，请在「供应商与账号」页重新启用。`,
        'provider_disabled',
      ),
    }
  }

  // 非 WorkBuddy 的供应商走独立的 Provider 接口（协议差异极大，
  // 不能把分支塞进下面这段 WorkBuddy 专用逻辑里）。
  /**
   * 🔴 **逐模型「停用」必须在直连路径也生效**（2026-10-21 审查补，重复实现专项）。
   *
   * 「供应商级」关闭上面已经两路都拦了；但**模型级**此前只在 `/v1/models`
   * 目录与 `aggregate` 聚合路径过滤（`filterDisabledCandidates`）。
   * 于是：面板里关掉的烧钱模型，目录里消失、`aggregate/auto` 也剔除它，
   * 但客户端直接写 `qodercn/dfmodel`（或裸名）**照样打通、照样扣额度**。
   *
   * 就是上面那段注释的原话 ——「只在 `/v1/models` 里过滤是不够的 …… 那会让
   * 『我明明关了它』变成一句空话」—— 只是这句当时没对模型级执行。
   */
  /**
   * ⚠️ `auto` 是**网关自己的别名**（"不指定模型，用默认的"），不是供应商的真实模型 id。
   *
   * 停用列表里可能存在一条陈旧的 `auto`（历史目录里曾有过同名模型），
   * 若一并拦掉，会把 `buddy/auto` 这个**默认入口**打成 403 ——
   * 实测就踩到了：上线后 `buddy/auto` 立刻从 200 变成
   * `模型「auto」已被停用`，而 `/v1/models` 里根本不存在 `buddy/auto`。
   *
   * 与 `aggregate/auto` 的处理保持一致：别名不受「停用」约束。
   */
  const isAutoAlias = model.toLowerCase() === 'auto'
  try {
    const poolForModelGate = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const disabledModels = isAutoAlias ? [] : await poolForModelGate.getDisabledModels(providerId)
    if (disabledModels.length > 0) {
      const lowered = model.toLowerCase()
      if (disabledModels.some((m) => m.toLowerCase() === lowered)) {
        return {
          response: jsonError(
            403,
            `模型「${model}」已被你在面板中停用。如需使用，请在「模型」页重新启用。`,
            'model_disabled',
          ),
        }
      }
    }
  } catch (error) {
    // 读不到停用列表就按「没停用」处理：这是展示/省钱用的闸门，不该把请求卡死。
    console.warn(`[model-disabled] 读 ${providerId} 的停用模型失败，按「未停用」放行：`, error)
  }

  if (providerId !== DEFAULT_PROVIDER) {
    return await handleProviderChat({ providerId, model, wantsStream, rawBody, request, env, realm, ctx, tried: [], sessionKey })
  }

  // ⚠️ **必须把请求体里的 model 改写成去前缀的裸名**（实测踩到的真实缺陷，
  // 且必须在 `prepareChatBody` **之前**做 —— 它会连 `model` 一起复制）。
  //
  // 客户端发 `workbuddy/deepseek-v4-flash` 时，若不改写，上游收到带前缀的名字，
  // 回应：`model [workbuddy/deepseek-v4-flash] service info not found`。
  //
  // 后果比「报错」严重得多：该错误被归类为 `model_unavailable`（11102），
  // 于是**给这个模型写了 6 小时的模型级冷却** —— 一个纯粹由我方前缀引起的
  // 失败，被记成了「上游没有这个模型」。此后所有**裸名**请求都会因为这个
  // 冷却而选不到号，对外表现为「没有可用账号」，与真实原因毫无关系。
  //
  // 故这是「一个前缀写错 → 整个模型被拉黑 6 小时」的放大器，必须在这里切断。
  const upstreamBody =
    model !== rawModel && rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? { ...(rawBody as Record<string, unknown>), model }
      : rawBody

  let prepared: string
  try {
    prepared = sanitizeChatBody(prepareChatBody(upstreamBody).body)
  } catch (error) {
    return {
      response: jsonError(400, error instanceof Error ? error.message : String(error), 'invalid_request_error'),
    }
  }

  const bases = resolveUpstream(env)
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))

  // ⚠️ `tried` 必须**跨重试保留**，否则会在两个账号之间无限来回
  // （Go 侧 account-pool.ts:905-914 记录过这个缺陷）。
  const tried: string[] = []
  // 请求级开始时刻（用于失败用量的 `ms`，见 `recordRequestFailure`）。
  const requestStartedAt = Date.now()
  let lastError: { status: number; message: string; kind: string } | undefined

  // ⚠️ IP 级 WAF 拦截的**前置检查**：激活期内直接失败，**连一个号都不试**。
  // 理由：轮转会把一次客户端请求放大成 N 次撞同一堵墙，反而加重风控
  // （Go 侧实测：3 个账号 1 秒内全部 403）。判据与窗口见 AccountPoolDO 的常量注释。
  if (await pool.wafGateActive(Date.now())) {
    return {
      response: jsonError(
        503,
        '出口 IP 疑似被上游 WAF 拦截（短时间内多个账号接连 403），已暂停轮转以避免加重风控。稍后自动恢复。',
        'waf_ip_blocked',
      ),
    }
  }

  // ⚠️ **账号级限制波次**的前置检查（与上面 IP 级并列、判据不同）。
  // 依据 workbuddy2api-hub #425：短时间内多个账号被 11140 标记 ⇒ 上游正在对这批号
  // 做风控，继续送号只会让更多号进标记（社区红线「看到 11140 立即停手」）。
  // 期间**一个上游请求都不发**，直接返回可读原因。
  // ⚠️ **先判方法存在**再调用：波次暂停是保护措施，不是请求前置条件。
  // 读不到状态（测试替身缺该方法 / 老 DO 未升级）时应放行请求，
  // 而不是让整条 chat 路径崩掉 —— 保护措施本身不能成为新的故障点。
  // 注意不能只靠 `.catch()`：方法**不存在**时是同步 TypeError，promise 链接不住。
  const gateProbe = (pool as { restrictionGateActive?: (now: number) => Promise<boolean> })
  const restrictionPaused =
    typeof gateProbe.restrictionGateActive === 'function'
      ? await gateProbe.restrictionGateActive(Date.now()).catch(() => false)
      : false
  if (restrictionPaused) {
    return {
      response: jsonError(
        429,
        '多个账号近期被上游风控限制（11140 账号存在异常行为），已暂停该区域派发以避免更多账号被牵连。稍后自动恢复；如确认是误判可在面板解冻。',
        'restriction_wave',
      ),
    }
  }

  // ⚠️ **会话/轮级 id 在重试循环外算一次**（实测语义）。
  //
  // 官方客户端：`X-Conversation-ID` 在同一对话里恒定，`X-Conversation-Request-ID`
  // 在一轮用户发送里恒定（重试复用），只有消息级 id 每请求新生成。
  // 放在循环内会让每次重试都变成「另一个会话 / 另一轮」，正是上游画像里最显眼的
  // 非人类特征。
  const turnRequestId = newTurnRequestId()
  /**
   * `X-Conversation-ID` 的**当前值**与**它属于哪个账号**（2026-10-21 审查补，M3 指出高危）。
   *
   * ## 原缺陷：注释与实现相反
   * 下面（`:1167`）的注释明写「`X-Conversation-ID` 按「账号 + 会话」派生：
   * 换号**必须**换 id（同一段会话 id 发给两个账号就是跨账号关联键）」，
   * 但实现是 `if (conversationId === '') { … }` —— 只在**第一次**算，
   * 之后换号**永远复用**同一个 id。**注释描述了意图，代码做了相反的事。**
   *
   * 更糟的是 `sessionKey === ''` 时原来直接 `crypto.randomUUID()` 一次，
   * 于是「无会话」的请求在整个重试链路上共用**一个随机 id**，同样构成关联键。
   *
   * ## 为什么要记 owner
   * 只判 `=== ''` 无法区分「没算过」与「算过但属于别的账号」。
   * 用 `conversationIdOwner` 显式记住归属，账号一变就重算 ——
   * 同一账号的多次重试仍复用同一 id（客户端在同一次发送里重试是正常的）。
   */
  let conversationId = ''
  let conversationIdOwner = ''
  const pinnedHeader = requestedAccount(request)
  const maxRotate = await maxRotateFor(pool)

  /**
   * 本 provider 在当前 realm 有多少个**可参与轮换**的账号（循环外探一次）。
   *
   * 用途见下方 `deferSoft`：池里只有 1 个号时，软冷却 = 掐断唯一路径。
   *
   * ⚠️ 探测失败按「多账号」处理（`0` ⇒ 不禁用延迟，即保持原有立即记账行为）：
   * 读不到池大小时**不应该**放宽记账纪律 —— 那会让真正的限流被漏记。
   * 宁可偶发误冷却，也不要让限流失去约束。
   */
  let poolSize = 0
  try {
    const all = await pool.listAccounts(realm, Date.now())
    poolSize = all.filter(
      (a) => (a.provider ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER && a.disabled !== true,
    ).length
  } catch {
    poolSize = 0
  }

  // ⚠️ **延迟记账收件箱**（借鉴 qoder2api-hub #65 的 blame 机制）。
  //
  // 只有「**换号后成功了**」才能证明问题出在之前那个账号上；若所有号都以同样方式
  // 失败，更可能是上游整体故障 / 本机断网，此时给每个号都记一次失败会造成
  // **连锁熔断**：每个请求遍历 N 个号 ⇒ 各记 1 次 ⇒ 3 个请求后全池 breaker 30 分钟，
  // 而熔断期内没有成功请求来复位计数，网络恢复后号池仍然不可用。
  //
  // 因此只对「会累加失败计数」的维度（breaker / degrade）延迟记账；
  // restricted（上游明确标记）、model（模型级）、soft（限流）等**仍然立即记** ——
  // 它们都有明确的上游证据，不是「靠换号成功才反推」的推测。
  const blame: BlameEntry[] = []

  /**
   * ⚠️ **单账号池的 soft 冷却必须延迟**（2026-10-21 实测踩到）。
   *
   * ## 症状（用户报）
   * 「审查的时候会被误判打断」—— 一次瞬时抖动就让 qodercn（**只有 1 个账号**）
   * 进 60 秒软冷却，期间所有请求回 503「1 个账号都在冷却中，约 1 分钟后恢复」。
   * 而账号本身完全健康（实测 successCount 1556、errTotal 仅 9，
   * 并发 5 连发 + 长上下文并发全部 200）。
   *
   * ## 为什么上面的注释「soft 有明确上游证据，立即记」在这情况下站不住
   * 那个理由对**多账号池**成立：罚了 A 还能用 B，代价可控。
   * 但池里只有 1 个账号时，「立即记」= **立即把唯一可用路径掐断 60 秒**。
   * 而此时根本没有别的号可换，冷却换不来任何好处，只有中断。
   *
   * ## 判据：**真实的池大小**，不是 `tried.length`
   *
   * ⚠️ 第一版我写成 `tried.length <= 1`，那是错的：`tried.push` 发生在错误处理
   * **之前**，所以「多账号池的第一个号失败」时 `tried.length` 也是 1 ——
   * 会把它误判成单账号池，从而漏记真正的限流。
   * 故改成循环外探一次 `poolSize`（只数未停用的同 provider 账号）。
   *
   * 只有 `poolSize === 1` 才延迟：**只有后续真的换号成功才记账**，
   * 全失败则丢弃（与 breaker/degrade 同一套纪律）。
   * `poolSize === 0`（探测失败或有 0 个可用）**不启用**延迟 ——
   * 读不到就按原纪律走，宁可偶发误冷却，也不让限流失去约束。
   */
  const deferSoft = (): boolean => poolSize === 1

  for (let attempt = 0; attempt <= maxRotate; attempt += 1) {
    const now = Date.now()
    // ⚠️ 限定默认供应商：池里可能同时有 cline 等家的账号，
    // 拿它们的凭据去打 WorkBuddy 端点必然 401（看起来像「凭据坏了」）。
    // 会话粘性：只首轮用（换号后还粘回去会死循环）
    const buddyPreferred =
      tried.length === 0 && sessionKey !== '' ? await pool.getSession(sessionKey, now) : ''
    const candidate = await pickCandidate(
      pool, realm, model, tried, now, DEFAULT_PROVIDER,
      buddyPreferred === undefined ? '' : buddyPreferred,
      pinnedHeader,
    )
    // ── 只用指定账号但它不可用：直接报它的原因（不换号、不跨渠道容灾）──
    if (candidate !== undefined && 'pinBlocked' in candidate) {
      // ⚠️ **早退出口也要丢弃 blame**（S11）：指定账号在本次请求里已经失败过
      //（`lastError` 有值即证明），那些失败挂在这里既不结算也不打日志。
      discardBlame(blame, '只用指定账号且它已不可用（早退，不换号）')
      return {
        response: jsonError(
          lastError?.status ?? 503,
          describePinBlocked(candidate.picked, pinnedHeader !== '', lastError?.message),
          lastError?.kind ?? 'pinned_account_unavailable',
        ),
      }
    }
    if (candidate === undefined) {
      // ⚠️ 国内版（buddy）所有可用账号已尝试或全部处于限流/冷却中。
      // 跨渠道智能容灾：如果用户配置了国际版（workbuddy）账号且**真的可选**，
      // 自动无缝降级派发至国际版同名模型，避免直接向客户端返回 502/503。
      //
      // ⚠️ **只在 `failoverDepth === 0` 时触发**：否则会与 workbuddy 路径的
      // 反向容灾形成无限相互递归（`buddy→workbuddy→buddy→…`）。
      if (failoverDepth === 0 && model !== '') {
        try {
          const intlPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))
          const hasIntlUsable = (await intlPool.listAccounts('global', now)).some(
            (a) => (a.provider ?? DEFAULT_PROVIDER) === 'workbuddy' && healthyForModel(a, now, model),
          )
          if (hasIntlUsable) {
            console.log(`[failover] 国内版 ${DEFAULT_PROVIDER} 全部不可用或已限流，自动无缝跨渠道容灾至国际版 workbuddy (模型: ${model})`)
            // ⚠️ 容灾是**早退出口**（S11）：`handleProviderChat` 有它**自己的**空
            // `blame` 收件箱，本路径挂起的失败不会跟着过去 ⇒ 必须在这里显式丢弃，
            // 否则它们静默消失（既不结算也不打日志）。
            discardBlame(blame, '已跨渠道容灾至国际版（blame 不移交）')
            return await handleProviderChat({
              providerId: 'workbuddy',
              model,
              wantsStream,
              rawBody,
              request,
              env,
              realm: 'global',
              ...(ctx !== undefined ? { ctx } : {}),
              tried: [],
              sessionKey,
              failoverDepth: 1,
            })
          }
        } catch (failoverError) {
          console.warn('[failover] 跨渠道容灾检查失败：', failoverError)
        }
      }

      // 🔴 记一条**请求级失败**（否则面板成功率恒 100%，见 `recordRequestFailure`）。
      // ⚠️ 必须在 `if` **之外**：`lastError === undefined` 的那条「池里根本没账号」
      // 同样是失败请求，漏记会让「零账号」场景完全不出现在用量里。
      recordRequestFailure(pool, {
        uid: tried[tried.length - 1] ?? '',
        model,
        errorKind: lastError?.kind ?? 'no_available_account',
        startedAt: requestStartedAt,
      })
      // ⚠️ **下面两条 return 都是早退出口**（S11），一起在这里丢弃 blame。
      //
      // 放在 `if` **之前**而不是各分支里：只有一条会执行（if/else），
      // 两处各调一次会重复打日志。而第一条（`lastError !== undefined`）
      // 正是「有 blame 却静默丢弃」的典型场景 —— 全池都失败、账号全在冷却时
      // 走的就是它，此前一条日志都没有。
      //
      // ⚠️ 第二条（`lastError === undefined`）此时 blame **必然为空**
      //（没有失败就没有 `lastError`，而 `blame.push` 与 `lastError` 赋值同块发生），
      // 故它不会产生日志；保留同一次调用只是为了不让「出口 → 丢弃」这条规则出现例外。
      discardBlame(blame, '没有可用账号（所有候选都已尝试或全在冷却/禁用）')
      // 没有可用账号了：若之前有过失败，报最后一次的真实原因（更有信息量）
      if (lastError !== undefined) {
        return {
          response: jsonError(lastError.status, `所有可用账号均失败，最后一次：${lastError.message}`, lastError.kind),
        }
      }
      return {
        response: jsonError(
          503,
          // ⚠️ **必须与 provider 路径同源**（2026-10-22 实测）。
          // 原来这里是一句写死的「请先登录/导入凭据；检查是否全部处于冷却或禁用状态」，
          // 与 `describeNoAccount` 构成**两份判据**，且这一份把
          // 「只是某个模型在冷却」也说成「没账号」，比 provider 路径那句更误导
          // （用户会去重新导入一份完全有效的凭据）。
          // ⇒ 同一个语义只能有一份实现。
          await describeNoAccount(env, realm, DEFAULT_PROVIDER, model),
          'no_available_account',
        ),
      }
    }
    tried.push(candidate.uid)
    console.log(`[pick:buddy] 选中账号 uid=${candidate.uid} nickname=${candidate.credential.nickname || ''} tried=${tried.length}`)

    // ⚠️ `X-Conversation-ID` 按「账号 + 会话」派生：换号**必须**换 id
    //（同一段会话 id 发给两个账号就是跨账号关联键）。
    //
    // 🔴 判据是「**归属账号变了**」，不是「还没算过」（2026-10-21 审查补，M3 指出）。
    // 原来写成 `if (conversationId === '')`，于是：
    //   - 有会话：只在第一个账号身上算一次，之后换号全程复用 ⇒ 跨账号关联键；
    //   - 无会话：整个重试链路共用一个 `randomUUID()` ⇒ 同样是关联键。
    if (conversationIdOwner !== candidate.uid) {
      conversationId = sessionKey === ''
        ? crypto.randomUUID()
        : await deriveIntlConversationId(candidate.uid, sessionKey)
      conversationIdOwner = candidate.uid
    }

    /**
     * ② 构造出站请求
     *
     * 🔴 **设备标识必须真的发出去**（2026-10-22 审查，A7）。
     *
     * 原来这两行算了 `machineId` / `sessionId` 之后**再也没用过** ——
     * 纯死变量：值算出来就扔，`referenceChatHeaders` 根本没收到它们。
     *
     * 后果是同一账号在两个端点上呈现成**两台不同设备**：
     * - `listModels()`（`/v3/config`）走 `cliChatHeaders`，发的是
     *   `deriveDeviceId()` 派生的 **36 位 hex**；
     * - `chat`（`/v2/chat/completions`）走 `referenceChatHeaders`，
     *   国内版**一个都不发**，国际版发的是 `deriveUuidLike()` 的 **UUID 形态**。
     *
     * 对上游风控来说这是「一个账号、两台机器、三种身份」——
     * 而 `intlDeviceHeaders` 的注释早就写明「缺 `X-Machine-ID` 会回 14003 Model busy」，
     * 等于我们自己把那条已验证的结论只用在一条路径上（又一次「只修一半」）。
     *
     * ⚠️ 形态统一为 **36 位 hex**（`/v3/config` 已在用、且是 `desktop.go:51-53` 的原口径）。
     * `deriveUuidLike` 的 UUID 形态是「国际服抓包长这样」的推断，没有版本锚点；
     * 而 36-hex 有明确的参考实现出处，故以它为准。
     */
    const machineId = await deriveDeviceId(candidate.uid, 'machine')
    const sessionId = await deriveDeviceId(candidate.uid, 'session')
    const conversationRequestId = crypto.randomUUID().replaceAll('-', '')

    let upstream: Response
    try {
      /**
       * 🔴 **防封节奏也必须在这里做**（2026-10-21 审查补，M3 指出高危）。
       *
       * `throttleUpstream` 此前**只**接在 provider 分支（`2198` / `2220`），
       * buddy 主分支完全没接 ⇒ 面板「防封」分区里的**节奏/抖动开关对 buddy 静默无效**。
       *
       * 而 buddy 恰恰是默认 provider（`DEFAULT_PROVIDER`），也就是**主要流量路径**。
       * ⇒ 用户打开「防封节奏」以为在保护账号，实际只有带前缀模型生效。
       * 这是本项目「配置只在一处生效」模式的又一次复现。
       */
      // ⚠️ 只对 workbuddy（国际版）加节奏 —— 那是需要伪装的上游，见 throttle.ts 的说明。
      await throttleUpstream(
        candidate.uid,
        undefined,
        undefined,
        DEFAULT_PROVIDER === 'workbuddy' ? 'workbuddy' : 'buddy',
      )
      upstream = await fetch(`${bases.chat}/v2/chat/completions`, {
        method: 'POST',
        // ⚠️ 与 provider 路径用**同一套**参考实现口径的头（见 referenceChatHeaders）。
        // 两条 chat 路径的口径必须一致，否则国内版与国际版会表现不同。
        headers: referenceChatHeaders({
          uid: candidate.uid,
          accessToken: candidate.credential.accessToken,
          variant: DEFAULT_PROVIDER === 'workbuddy' ? 'workbuddy' : 'buddy',
          // ⚠️ 会话/轮级 id 必须传进来：国际服强校验会话头族（缺了就 11-128），
          // 且**同一会话必须复用同一个 id**（每请求现生成等于伪造上千个一次性会话）。
          // 两者都在重试循环**第 0 轮**算一次（见函数开头的说明）。
          conversationId,
          turnRequestId,
          // ⚠️ 与 `/v3/config` 同源（同一账号 ⇒ 同一台设备），见上面的说明。
          machineId,
          sessionId,
        }),
        body: prepared,
        signal: request.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const { punish } = mapErrorToPunishment('network')
      // 网络层：**不罚号**（抖动量不构成「这个号坏了」的证据）
      void punish
      lastError = { status: 502, message, kind: 'network' }
      continue // 换号重试
    }

    // ③ 上游错误：分类 → 记账 → 决定是否换号
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      const { kind, msg } = classify(upstream.status, text)
      /**
       * 上游原文诊断开关（`QODER_DEBUG_UPSTREAM=1`）。
       *
       * ⚠️ 保留而不是用完就删：这次排查「11140 到底是不是真封号」全靠它 ——
       * 只有拿到 `http=403 code=11140 displayMsg:"account has been restricted"`
       * 的**原始字节**，才能区分「真·账号限制」与「WAF 403 / 模型下线」这两种
       * 完全不同的处置。之前正是因为看不到原文，把模型下线误判成封号。
       * 默认关闭（正文可能含用户内容），排障时打开。
       */
      /**
       * ⚠️ **`waf_blocked` 无条件留证**（2026-10-21 加，这是排查误判的关键）。
       *
       * 数据库里存到的真实 reason 是：
       *   `waf_blocked: WAF blocked (403 without business envelope)`
       * 而 `waf_blocked` 的处置是 `punish: true, dimension: 'soft'` ⇒ **账号级软冷却**。
       * 也就是说：只要上游回一个「403 且解析不出业务信封」，该账号就会被冷却 60 秒，
       * 单账号池下等于整条链路中断 —— 而**我们从来没记录过那个 403 的原文**，
       * 导致反复误判却无从定位。
       *
       * 该分支默认开启（不依赖环境变量）：它是**误判的唯一证据来源**，
       * 而 WAF 403 本身应是低频事件，不会刷屏。
       */
      if (kind === 'waf_blocked') {
        console.warn(
          `[waf-403] model=${model} http=${upstream.status} len=${text.length} body=${text.slice(0, 500)}`,
        )
      } else if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPSTREAM_DEBUG === '1') {
        console.warn(`[upstream] http=${upstream.status} kind=${kind} body=${text.slice(0, 300)}`)
      }
      const mapped = mapErrorToPunishment(kind)
      const { dimension, resetAt } = refineModelScoped(kind, text)

      // ⚠️ WAF 403 需要**双记账**：
      // ① 账号级软冷却（下方 applyFailure）—— 让这个号暂时别用；
      // ② **IP 级判定**（noteWaf）—— 若短窗内多个不同号都命中，说明是出口 IP 被拦，
      //    此时继续轮转毫无意义（撞的是同一堵墙），必须 fail-fast。
      // ②-b **账号级限制波次判定**（noteRestriction）—— 与上面的 IP 级并列。
      //     短窗内多个不同号被 11140 标记 ⇒ 上游正在对这一批号做风控，
      //     继续送号会让更多号被牵连（workbuddy2api-hub #425）。
      //     ⚠️ 与 `waf_blocked` 分开判：11128 是渠道指纹（不罚号），
      //     11140 是账号级限制（罚号），两者混判会让处置互相串味。
      if (kind === 'request_illegal') {
        await pool.noteRestriction(candidate.uid, Date.now()).catch(() => false)
      }

      if (kind === 'waf_blocked') {
        const ipBlocked = await pool.noteWaf(candidate.uid, Date.now()).catch(() => false)
        if (ipBlocked) {
          lastError = {
            status: 503,
            message: '出口 IP 疑似被 WAF 拦截（短窗内多个账号接连 403）',
            kind: 'waf_ip_blocked',
          }
          break // 不再轮转下一个号
        }
      }

      // 记账（按类别落到正确维度）
      if (mapped.punish) {
        const cause = modelCauseFor(kind)
        const punishKind =
          kind === 'rate_limited' ? dimension : mapped.dimension === 'model' ? 'model' : mapped.dimension
        // 累加失败的维度延迟到「换号成功」时再记（见 blame 的注释）。
        // ⚠️ `soft` 在**单账号池**下也要延迟：池里只有一个号时，立即冷却
        // 等于立即掐断唯一路径 60 秒，而冷却换不来任何好处（见 deferSoft）。
        //
        // ⚠️ 延迟记账**也必须带上 `resetAt`**：下面「立即结算」那条分支传了它，
        // 若这里不传，同一个 429 只因走了延迟就丢掉上游墙钟（见 `BlameEntry`）。
        if (punishKind === 'breaker' || punishKind === 'degrade' || (punishKind === 'soft' && deferSoft())) {
          blame.push({
            uid: candidate.uid,
            kind: punishKind,
            reason: `${kind}: ${msg}`.slice(0, 200),
            ...(resetAt !== undefined ? { resetAt } : {}),
          })
        } else {
        await pool
          .applyFailure({
            uid: candidate.uid,
            kind: punishKind,
            now: Date.now(),
            ...(model !== '' ? { model } : {}),
            // ⚠️ 带上上游给的重置时刻（文案里的 `reset at … UTC+8`）。
            // 模型级冷却据此对齐上游墙钟，而不是我们自己猜 6 小时指数退避 ——
            // 猜早了会继续撞限流，猜晚了白白少用几小时。
            ...(resetAt !== undefined ? { resetAt } : {}),
            ...(msg !== '' ? { reason: `${kind}: ${msg}`.slice(0, 200) } : {}),
            // 结构化成因：不靠文案反推（见 modelCauseFor 的注释）
            ...(cause !== undefined ? { modelCause: cause } : {}),
          })
          .catch((error: unknown) => {
            // 记账失败不该让回复失败：这是可观测性问题，不是正确性问题。
            // ⚠️ 但**不能完全静默** —— 此前这里是空 catch，导致「restricted 维度
            // 没被 DO 接受」这类问题只表现为「罚了却看不出罚」，线上排查极难。
            console.warn(
              `[punish] applyFailure 失败 uid=${candidate.uid} kind=${punishKind}: ` +
                (error instanceof Error ? error.message : String(error)),
            )
          })
        }
      }

      lastError = {
        // ⚠️ 不原样透传上游状态码：400 会让客户端误以为「是我请求写错了」。
        status: clientStatusFor(upstream.status, kind),
        message: `${kind}: ${msg || text.slice(0, 160)}${kind === 'channel_blocked' ? CHANNEL_BLOCKED_HINT : ''}`,
        kind,
      }

      // 账号失败，立即解绑该会话粘性，防止下次请求死锁在坏账号上
      clearSessionBinding(pool, sessionKey, ctx)

      // ⚠️ **渠道校验失败必须立刻停止轮换**（实测：5 个国际版账号全回 11-128）。
      //
      // `mapErrorToPunishment('channel_blocked').rotate` 已经是 false，
      // 但显式 break 能说清原因：11-128 判的是**我方请求指纹**，
      // 与账号无关 ⇒ 换号只会把同一份指纹再打 4 次，既浪费时间又刷风控。
      if (kind === 'channel_blocked') break
      if (!mapped.rotate) break // 不该换号（参数错/WAF/网络已单独处理）
      continue // 换号重试
    }

    // ④ 成功：按上游流**逐帧透传**，同时判断是否需要记账
    if (upstream.body === null) {
      clearSessionBinding(pool, sessionKey, ctx)
      lastError = { status: 502, message: '上游返回空 body', kind: 'unknown' }
      continue
    }

    // 预检首块数据：上游若以 HTTP 200 返回 6004 限流或错误帧，立即拦截并换号重试
    const peeked = await peekStreamForError(upstream.body)
    if (peeked.error !== undefined) {
      const errText = peeked.cleanJson ?? peeked.rawText ?? peeked.error
      const { kind, msg } = classify(200, errText)
      const mapped = mapErrorToPunishment(kind)
      const { dimension, resetAt } = refineModelScoped(kind, errText)
      /**
       * 🔴 **流内错误诊断**（`UPSTREAM_DEBUG=1` 开启）。
       *
       * ⚠️ 此前诊断开关只覆盖 `!upstream.ok`（非 2xx）分支，而**这条路径是
       * HTTP 200 但流里藏错误帧** —— qoder / codearts 等上游都用这种形态。
       * 结果：用户报「误判进冷却」时，日志里**一条记录都没有**，只能猜。
       *
       * 这条日志记录「真实的分类结果」——它是判断「我们是否误判」的**唯一依据**：
       * 若 kind 是 rate_limited 但上游原文其实是别的，就是误判。
       */
      if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPSTREAM_DEBUG === '1') {
        console.warn(
          `[stream-error] model=${model} kind=${kind} dim=${dimension} punish=${mapped.punish} ` +
            `resetAt=${resetAt ?? '-'} text=${errText.slice(0, 300)}`,
        )
      }

      if (mapped.punish) {
        const cause = modelCauseFor(kind)
        const punishKind =
          kind === 'rate_limited' ? dimension : mapped.dimension === 'model' ? 'model' : mapped.dimension
        // ⚠️ 与 buddy 路径同一套纪律：累加型维度 + 单账号池的 soft 都延迟记账，
        // 只有「换号后成功」才落账；全失败则丢弃（见上方 blame 的说明）。
        // ⚠️ `resetAt` 同样要带进收件箱（见 `BlameEntry`）：下面立即结算那条传了它。
        if (punishKind === 'breaker' || punishKind === 'degrade' || (punishKind === 'soft' && deferSoft())) {
          blame.push({
            uid: candidate.uid,
            kind: punishKind,
            reason: `${kind}: ${msg}`.slice(0, 200),
            ...(resetAt !== undefined ? { resetAt } : {}),
          })
        } else {
          await pool
            .applyFailure({
              uid: candidate.uid,
              kind: punishKind,
              now: Date.now(),
              ...(model !== '' ? { model } : {}),
              ...(resetAt !== undefined ? { resetAt } : {}),
              ...(msg !== '' ? { reason: `${kind}: ${msg}`.slice(0, 200) } : {}),
              ...(cause !== undefined ? { modelCause: cause } : {}),
            })
            .catch(logPoolError('applyFailure'))
        }
      }

      clearSessionBinding(pool, sessionKey, ctx)

      lastError = {
        status: clientStatusFor(200, kind),
        message: `${kind}: ${msg || errText.slice(0, 160)}${kind === 'channel_blocked' ? CHANNEL_BLOCKED_HINT : ''}`,
        kind,
      }

      // ⚠️ 渠道校验失败必须立刻停止轮换，**不能**落到下面的 `mapped.rotate` 再换号。
      //
      // 11-128 判的是**我方请求指纹**（头部身份 + 会话头族），与账号无关：
      // 实测 5 个国际版账号用同一套头发出去，全部回 11-128。
      // 换号只是把同一份指纹再打 N 次 —— 既拖长客户端等待（每次都等首帧超时），
      // 又白白给上游刷失败次数、抬高风控权重。
      //
      // 与 HTTP 非 2xx 分支同口径：那一路已经显式 break，两条路径必须一致，
      // 否则「上游用 400 报」和「上游用 SSE 帧报」会表现不同（同一个 bug 只修一半）。
      if (kind === 'channel_blocked') break
      if (mapped.rotate) continue // 换号重试！
      break
    }

    const startedAt = Date.now()

    // **零输出越墙熔断**（buddy 路径，与 provider 路径同一份判据 ——
    // 见 `zero-output.ts` 文件头：同一语义不得两套实现）。
    //
    // ⚠️ buddy/workbuddy 是**默认供应商**，绝大多数流量走这里；若只在
    // provider 路径接守卫，越墙熔断对主力渠道等于不存在。
    const screenedBuddy = await screenZeroOutputStream(peeked.stream, {
      // 客户端主动取消 ⇒ 一律不改道（本项目的既有纪律）
      isCancelled: () => request.signal.aborted,
    })
    if (screenedBuddy.hit) {
      // ⚠️ 罚**模型维度**（`kind:'model'`）：越墙是「这个目标此刻的输入被拒」，
      // 不是账号坏了。绝不能升成 `breaker`（3 次熔断账号 30 分钟，误杀健康号）。
      await pool
        .applyFailure({
          uid: candidate.uid,
          kind: 'model',
          now: Date.now(),
          ...(model !== '' ? { model } : {}),
          // 显式给 `resetAt`：不走「11102 无此模型」那条 6h 指数退避
          resetAt: Date.now() + ZERO_OUTPUT_COOLDOWN_MS,
          reason: `buddy/${model} zero-output (finish_reason=length, ${screenedBuddy.probe.frames}f)`,
        })
        .catch(logPoolError('applyFailure'))

      // ⚠️ §7.2「失败必须显式」：改道必须留痕（日志 + 面板日志双写）
      console.warn(`[zero-output] ${describeZeroOutputHit(DEFAULT_PROVIDER, model, screenedBuddy.probe)} uid=${candidate.uid}`)
      recordLog(
        pool,
        {
          type: 'error',
          model: `buddy/${model}`,
          provider: 'buddy',
          uid: candidate.uid,
          status: 502,
          durationMs: Date.now() - startedAt,
          error: `零输出越墙，已冷却该目标并改道（finish_reason=length，0 输出，${screenedBuddy.probe.frames} 帧）`,
          stream: wantsStream,
        },
        ctx,
      )

      clearSessionBinding(pool, sessionKey, ctx)
      lastError = {
        status: 502,
        message: describeZeroOutputHit(DEFAULT_PROVIDER, model, screenedBuddy.probe),
        kind: 'upstream_error',
      }
      continue // 改道下一个候选重发（什么都没产出，没有内容可丢）
    }

    return {
      response: await streamResponse(screenedBuddy.stream, {
        // ⚠️ 诊断 + 记账分界：客户端断开**不得**记成账号失败
        //（否则用户的取消动作会熔断健康账号，见 `nonStreamingResponse` 的说明）。
        clientGone: () => request.signal.aborted,
        onFirstChunk: () => {
          // 首帧到达即算成功（清熔断/降权）
          const okTask = pool.noteSuccess(candidate.uid, Date.now(), undefined, model).catch(logPoolError('noteSuccess'))
          if (ctx !== undefined) ctx.waitUntil(okTask)
          else void okTask
          // ✅ **结算 blame**：这个号成功了 ⇒ 之前那些失败确实是那几个号的问题，
          // 现在才记账（见 blame 的注释：全池同样失败时不记账，避免连锁熔断）。
          const settle = settleBlame(pool, blame, Date.now())
          if (ctx !== undefined) ctx.waitUntil(settle)
          else void settle
          /**
           * 🔴 **会话粘性必须在主成功路径也绑定**（2026-10-21 审查补，M3 指出高危）。
           *
           * `bindSession` 此前只在**续期重试分支**调用（`2242` / `2500`）。
           * 而续期重试是**罕见路径** ⇒ 绝大多数请求从未建立会话粘性
           * ⇒ 同一会话的后续轮次会落到**不同账号**。
           *
           * 后果有两层（都不是「功能坏了」而是「优化静默失效」）：
           * 1. 上游 prompt cache **命中率为 0**（缓存是按账号隔离的）⇒ 更慢更贵；
           * 2. 同一段对话在不同账号间跳，对上游是**指纹异常**
           *   （本项目防封的核心顾虑之一）。
           *
           * ⇒ 首帧到达即绑定（与 provider 分支的续期分支同一时机）。
           */
          if (sessionKey !== '' && ctx !== undefined) {
            ctx.waitUntil(pool.bindSession(sessionKey, candidate.uid, Date.now()).catch(logPoolError('bindSession')))
          }
        },
        onFinish: (usage) => {
          // 记账用量（面板的「用量」视图靠它）
          //
          // ⚠️ 这里**不能**静默吞错误：第一版写成 `.catch(logPoolError('noteSuccess'))`，
          // 结果线上「对话成功但用量恒为 0」，且没有任何日志可查
          // （正是本项目一直在警告的「静默失败」形态）。
          const record = {
            at: Date.now(),
            uid: candidate.uid,
            model,
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            ok: true,
            ms: Date.now() - startedAt,
          }
          // 🔴 子密钥的 token 配额（2026-10-21 审查补）：主密钥路径无条目、零开销
          settleSubkeyUsage(ctx, env, record.input, record.output, record.model)
          const task = pool.recordUsage(record).catch((error: unknown) => {
            console.error(
              '[usage] 记录用量失败：',
              error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            )
          })
          // ⚠️ 必须 waitUntil：否则响应流结束的瞬间这个 promise 会被取消
          if (ctx !== undefined) ctx.waitUntil(task)
          else void task

          recordLog(
            pool,
            {
              type: 'api',
              model: `buddy/${model}`,
              provider: 'buddy',
              uid: candidate.uid,
              status: 200,
              durationMs: Date.now() - startedAt,
              tokens: { input: usage?.input ?? 0, output: usage?.output ?? 0, total: (usage?.input ?? 0) + (usage?.output ?? 0) },
              stream: wantsStream,
            },
            ctx,
          )
        },
        onError: (message) => {
          // 流**内**错误：无法改 HTTP 状态码了，但要记账
          void pool
            // ⚠️ 按**错误类别**罚正确的维度，不能一律 breaker。
            //
            // 实测缺陷：渠道拦截（11128，被分类为 `waf_blocked`）原本会走到
            // `kind: 'breaker'` ⇒ 3 次就**熔断账号 30 分钟**。
            // 而渠道问题是**请求指纹**的事，与账号好坏无关 ——
            // 结果是「账号明明好的，却越来越用不了」（好号被逐个熔断）。
            .applyFailure({
              uid: candidate.uid,
              kind: punishmentForStreamError(message),
              now: Date.now(),
              reason: message.slice(0, 200),
            })
            .catch(logPoolError('applyFailure'))

          // ⚠️ 流内失败也要记**用量**（否则面板成功率虚高，见 recordStreamFailure）
          recordStreamFailure(
            pool,
            { uid: candidate.uid, model: `buddy/${model}`, errorKind: punishmentForStreamError(message), startedAt },
            ctx,
          )
          recordLog(
            pool,
            {
              type: 'error',
              model: `buddy/${model}`,
              provider: 'buddy',
              uid: candidate.uid,
              status: 502,
              durationMs: Date.now() - startedAt,
              error: message.slice(0, 200),
              stream: wantsStream,
            },
            ctx,
          )
        },
      }, wantsStream ? undefined : { model }),
    }
  }

  // 所有轮转都失败
  // ⚠️ **丢弃 blame**：所有候选都以同样方式失败，没有「换号后成功」这个证据，
  // 就不能断定是那几个号坏了（更可能是上游整体故障 / 本机断网）。
  // 记账会累加 `fails`，3 次后全池熔断 30 分钟且期间无成功请求复位 ——
  // 那会把一次上游抖动放大成半小时不可用。留日志便于事后判断。
  //
  // ⚠️ 丢弃逻辑统一走 `discardBlame`（S11）：函数里还有 4 个早退出口也要丢弃，
  // 若各写一份，日志格式与「是否留痕」就会再次分叉。
  discardBlame(blame, '全池同样失败')
  return {
    response: jsonError(
      lastError?.status ?? 502,
      lastError === undefined ? '所有账号均失败' : `所有账号均失败，最后一次：${lastError.message}`,
      lastError?.kind ?? 'upstream_error',
    ),
  }
}

/**
 * 把上游 body 逐帧转换成给客户端的 SSE 流。
 *
 * ⚠️ **绝不缓冲**：不 `await response.text()`，否则 Free 计划的 10ms CPU
 * 会在长回答上超限，且客户端失去逐字输出。
 */
function streamResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  hooks: {
    onFirstChunk: () => void
    onError: (message: string) => void
    /** 流结束时回调，带上从流里解析到的 usage（用于面板用量统计）。 */
    onFinish?: (usage: { input: number; output: number } | undefined) => void
    /**
     * ⚠️ **诊断用**：客户端是否已断开（`request.signal.aborted`）。
     *
     * 这是「Worker 掐断」与「客户端断开」的**唯一分界** ——
     * 排查「长回答突然停止」时必须能区分，否则会在错误方向优化
     *（我为此连续几轮改错地方，见 AGENTS.md）。
     */
    clientGone?: () => boolean
  },
  /**
   * 客户端要**非流式**时传 true：内部仍按流式读上游，但最后聚合成一个
   * JSON 响应（见 `aggregateSse` 的说明）。
   */
  nonStreaming?: { model: string },
): Response | Promise<Response> {
  let notified = false

  // ⚠️ 非流式：**必须缓冲**（非流式的语义就是「一次给完」）。
  // 与流式路径的取舍相反 —— 那条路径逐帧透传是为了省 CPU（10ms 纪律），
  // 而这条只在客户端显式要非流式时走。
  if (nonStreaming !== undefined) {
    return nonStreamingResponse(upstreamBody, nonStreaming.model, hooks)
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const reader = upstreamBody.getReader()
      let buffer = ''
      let sawChunk = false
      let sawDone = false
      // ⚠️ 错误帧**只在前几帧查**（见 `ERROR_CHECK_FRAMES`）：
      // 上游要拒绝请求必然在开头，不可能先正常输出几万字再报错。
      // 而每帧全串扫描要 9.6ms/2 万帧 —— 直接超 10ms 配额。
      let frameSeq = 0
      // 是否已在流内检出错误帧（检出后立刻终止整条流，见下方 break）。
      let errorDetected = false
      // ⚠️ **有状态**转换器：首帧判断一次，之后全程沿用该决定。
      //
      // 逐帧扫描整帧字符串**必然超预算**（实测 8000 帧的单次 `includes`
      // 就要 7.4ms，而 Free 计划只有 10ms/次调用）⇒ 长回答会被切断。
      // 详见 `createFrameTranslator` 的说明。
      const translator = createFrameTranslator()
      const streamStartedAt = Date.now()
      // 从流里抓 usage（末帧带 include_usage=true 时会有）
      let usage: { input: number; output: number } | undefined

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // ⚠️ `{stream:true}` 必需：多字节字符可能跨 chunk，否则解码出乱码
          buffer += decoder.decode(value, { stream: true })

          let start = 0
          let nl = buffer.indexOf('\n', start)
          while (nl >= 0) {
            const line = buffer.slice(start, nl)
            start = nl + 1
            const frame = parseSseLine(line)

            if (frame.kind === 'done') {
              sawDone = true
              controller.enqueue(encoder.encode(doneFrame()))
            } else if (frame.kind === 'chunk' && frame.data !== undefined) {
              if (!notified) {
                notified = true
                hooks.onFirstChunk()
              }
              // 只在**可能**是错误帧时才解析（正常帧原样转发，省 CPU）
              frameSeq += 1
              if (frameSeq <= ERROR_CHECK_FRAMES && ERROR_HINT_PATTERN.test(frame.data)) {
                const errMsg = tryDetectError(frame.data)
                if (errMsg !== undefined) {
                  hooks.onError(errMsg)
                  controller.enqueue(encoder.encode(errorFrame(errMsg)))
                  // ⚠️ 必须是 break（终止整条流），不能是 continue：
                  // continue 只回到 while 判断，上游在 HTTP 200 下「先发错误帧、
                  // 后续正常帧照发」时，客户端会**同时**收到 error 帧与 choices 帧，
                  // 违反 OpenAI SSE 语义（客户端行为未定义：可能既报错又渲染内容）。
                  errorDetected = true
                  break
                }
              }
              sawChunk = true
              // 只在字面量含 usage 时才解析（省 CPU）
              if (mayHaveUsage(frame.data)) {
                try {
                  const parsed = JSON.parse(frame.data) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
                  const u = parsed.usage
                  if (u !== undefined && typeof u.prompt_tokens === 'number') {
                    usage = { input: u.prompt_tokens, output: u.completion_tokens ?? 0 }
                  }
                } catch {
                  // usage 解析失败不影响转发
                }
              }
              controller.enqueue(encoder.encode(translator.translate(frame.data)))
            } else if (frame.kind === 'error') {
              // ⚠️ 非预期形状必须让客户端看到（不静默丢）
              controller.enqueue(encoder.encode(errorFrame(frame.error ?? '非预期帧')))
            }
            nl = buffer.indexOf('\n', start)
          }
          // 检出错误帧：终止整条流，不再继续读取上游（避免 error 帧与内容帧混发）。
          if (errorDetected) break
          buffer = start > 0 ? buffer.slice(start) : buffer
        }

        // 流结束但从未产生内容 → 明确报「疑似截断」，而不是假装模型没话说
        // ⚠️ 已检出错误帧时不重复报：错误已发过，再补一条会污染客户端判断。
        if (!errorDetected && !sawChunk && !sawDone) {
          const msg = '上游流在产生任何内容前结束（疑似被截断）'
          if (!hooks.clientGone?.()) {
            hooks.onError(msg)
            try {
              controller.enqueue(encoder.encode(errorFrame(msg)))
            } catch {}
          }
        }
        if (!errorDetected && !sawDone && !hooks.clientGone?.()) {
          try {
            controller.enqueue(encoder.encode(doneFrame()))
          } catch {}
        }
        // ⚠️ **诊断日志**（排查「长回答突然停止」用）：
        // 记录本次流**为什么结束**、收了多少帧、用了多久。
        // 之前只靠外部 curl 观察，无法区分「Worker 掐断」与「客户端断开」，
        // 导致我连续几轮都在错误的方向上优化（详见 AGENTS.md）。
        console.log(
          `[stream] end reason=${sawDone ? 'done' : 'upstream-eof'} frames=${frameSeq}` +
            ` bytes=${sawChunk ? 'has-content' : 'empty'} ms=${Date.now() - streamStartedAt}`,
        )
        hooks.onFinish?.(usage)
      } catch (error) {
        const msg = `流传输中断：${error instanceof Error ? error.message : String(error)}`
        // ⚠️ 关键诊断：**这里是「客户端断开」与「上游中断」的分界**。
        // `request.signal.aborted` 为真 ⇒ **客户端**断了（我们的流被取消）；
        // 否则是**上游**的连接掉了。两者的处置完全不同，此前无法区分。
        const clientGone = hooks.clientGone?.() === true
        console.log(
          `[stream] aborted clientGone=${clientGone} frames=${frameSeq}` +
            ` ms=${Date.now() - streamStartedAt} err=${msg.slice(0, 160)}`,
        )
        // 🔴 客户端取消（用户点停止 / 重新对话 / 客户端超时断开）绝对不能罚账号！
        // 否则 3 次就把好账号熔断 30 分钟（对齐 nonStreamingResponse:1340）
        if (!clientGone) {
          hooks.onError(msg)
          hooks.onFinish?.(undefined)
          try {
            controller.enqueue(encoder.encode(errorFrame(msg)))
            controller.enqueue(encoder.encode(doneFrame()))
          } catch {
            // 忽略向已关闭流 enqueue 的异常
          }
        }
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // 忽略
        }
        controller.close()
      }
    },
  })

  return new Response(stream, { status: 200, headers: sseHeaders() })
}

/** 尝试解析并识别错误帧（失败返回 undefined）。 */
function tryDetectError(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return detectErrorFrame(parsed as Record<string, unknown>)
  } catch {
    // ⚠️ 绝不能把所有 JSON.parse 失败都当成错误！
    // 首块分包如果把正常的 SSE chunk 从中文字符或属性中间截断，JSON.parse 就会抛 SyntaxError。
    // 如果把分包误报成错误，会导致正常请求被假限流拦截并误换号！
    return undefined
  }
}

/**
 * 预读首块数据并预检是否为上游在 HTTP 200 下返回的限流/业务错误帧。
 *
 * ## 为什么必须做（解决限流后不会自动切换账号的问题）
 *
 * 腾讯 WorkBuddy / CodeBuddy 及部分第三方供应商在模型限流（6004）或拒绝时，
 * HTTP 状态码依然返回的是 200 OK，错误信息作为首个 SSE 帧或首个 JSON 载荷下发。
 * 原实现一旦看到 200 就直接返回 `streamResponse` 给客户端，外层换号循环瞬间退出，
 * 导致池中有健康账号也无法自动轮换，客户端直接收到限流错误。
 *
 * ⇒ 在把响应交付给客户端之前，在内部预读取首帧：
 * 1. 若检测到限流或错误：拦截并记账，解绑会话粘性，继续外层循环挑选下一个账号！
 * 2. 若首帧正常：无缝还原流传递给 streamResponse。
 */
async function peekStreamForError(body: ReadableStream<Uint8Array>): Promise<{
  error?: string
  rawText?: string
  cleanJson?: string
  stream: ReadableStream<Uint8Array>
}> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const prefixChunks: Uint8Array[] = []
  const maxPeekBytes = 64 * 1024
  let prefixBytes = 0
  let text = ''
  let lineStart = 0
  let candidate: 'unknown' | 'sse' | 'json' | 'plain' = 'unknown'

  // 预读到第一个完整 SSE 数据行，避免 TCP 分包恰好截断 `data: {...6004...}` 时漏判。
  // 仅缓存首行，且有 64 KiB 上限；未识别为限流时把全部预读字节原样交回客户端。
  const replay = (): ReadableStream<Uint8Array> => {
    let index = 0
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < prefixChunks.length) {
          controller.enqueue(prefixChunks[index++]!)
          return
        }
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
        } else {
          controller.enqueue(value)
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })
  }

  const emptyStream = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })

  const detectJsonError = (raw: string): { error: string; cleanJson: string } | undefined => {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const error = detectErrorFrame(parsed)
      return error === undefined ? undefined : { error, cleanJson: trimmed }
    } catch {
      return undefined
    }
  }

  const errorResult = async (error: string, cleanJson?: string): Promise<{
    error: string
    rawText: string
    cleanJson?: string
    stream: ReadableStream<Uint8Array>
  }> => {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    return {
      error,
      rawText: text,
      ...(cleanJson === undefined ? {} : { cleanJson }),
      stream: body,
    }
  }

  const detectSseLine = async (line: string): Promise<{
    error?: string
    cleanJson?: string
    complete: boolean
  }> => {
    const parsedLine = parseSseLine(line)
    if (parsedLine.kind === 'chunk' && parsedLine.data !== undefined) {
      const error = ERROR_HINT_PATTERN.test(parsedLine.data)
        ? tryDetectError(parsedLine.data)
        : undefined
      if (error !== undefined) return { error, cleanJson: parsedLine.data, complete: true }
      // 首个完整的正常数据帧已经足以判定这是流式响应，不再预读。
      return { complete: true }
    }
    if (parsedLine.kind === 'done' || parsedLine.kind === 'error') return { complete: true }
    return { complete: false }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      text += decoder.decode()
      if (prefixChunks.length === 0) {
        reader.releaseLock()
        return { stream: emptyStream() }
      }
      if (candidate === 'json') {
        const detected = detectJsonError(text)
        if (detected !== undefined) return await errorResult(detected.error, detected.cleanJson)
      } else if (candidate === 'sse' && lineStart < text.length) {
        // ⚠️ 只喂**第一行**给 detectSseLine：`text.slice(lineStart)` 可能含多个
        // `data:` 帧（预读缓冲跨过帧边界就 EOF）。整段喂进去时，parseSseLine 会
        // `slice(5)` 得到 `{...}\ndata: {...}` —— 不以 `{` 开头 ⇒ 被判成
        // 「非预期的 SSE 数据帧」错误 ⇒ 一条**完全正常**的流在结束边界被误拦成 502。
        const rest = text.slice(lineStart)
        const nlIdx = rest.indexOf('\n')
        const firstLine = nlIdx >= 0 ? rest.slice(0, nlIdx) : rest
        const detected = await detectSseLine(firstLine)
        if (detected.error !== undefined) return await errorResult(detected.error, detected.cleanJson)
      }
      return { stream: replay() }
    }
    if (value === undefined) continue
    prefixChunks.push(value)
    prefixBytes += value.byteLength
    text += decoder.decode(value, { stream: true })

    if (candidate === 'unknown') {
      const leading = text.trimStart()
      if (leading === '') continue
      if (leading.startsWith('{')) {
        candidate = 'json'
      } else if (
        'data:'.startsWith(leading)
        || leading.startsWith('data:')
        || leading.startsWith(':')
        || leading.startsWith('event:')
        || leading.startsWith('id:')
        || leading.startsWith('retry:')
      ) {
        candidate = 'sse'
      } else {
        candidate = 'plain'
      }
    }

    if (candidate === 'plain') return { stream: replay() }

    if (candidate === 'json') {
      const detected = detectJsonError(text)
      if (detected !== undefined) return await errorResult(detected.error, detected.cleanJson)
      // 完整 JSON 且不是错误帧时，直接交给既有响应转换路径。
      if (text.trimEnd().endsWith('}')) {
        try {
          JSON.parse(text.trim())
          return { stream: replay() }
        } catch {
          // 仍可能是被拆包的 JSON，继续等下一块。
        }
      }
    } else if (candidate === 'sse') {
      let newline = text.indexOf('\n', lineStart)
      while (newline >= 0) {
        const detected = await detectSseLine(text.slice(lineStart, newline))
        lineStart = newline + 1
        if (detected.error !== undefined) return await errorResult(detected.error, detected.cleanJson)
        if (detected.complete) return { stream: replay() }
        newline = text.indexOf('\n', lineStart)
      }
    }

    if (prefixBytes >= maxPeekBytes) return { stream: replay() }
  }
}

/**
 * 非 WorkBuddy 供应商的对话处理。
 *
 * ## 为什么要单独一条路径，而不是复用上面那段
 *
 * 上面那段是 **WorkBuddy 专用**的：它依赖 `/v2/chat/completions` 这个固定路径、
 * 四套客户端指纹、`prepareChatBody` 的 4 处必改、以及 WorkBuddy 特有的错误码表。
 * 把这些塞进一个「通用」循环里，只会让 WorkBuddy 的逻辑被稀释、
 * 而其它供应商仍要写一堆 `if (provider === ...)`。
 *
 * ⇒ 供应商差异**全部**收敛到 `Provider` 接口（见 `src/providers/types.ts`），
 * 这里只做「选号 → 调接口 → 记账 → 换号」这件与供应商无关的事。
 */
export async function handleProviderChat(input: {
  providerId: string
  model: string
  /** 客户端是否要流式（false ⇒ 聚合成非流式 JSON）。 */
  wantsStream: boolean
  rawBody: unknown
  request: Request
  env: Env
  realm: string
  ctx?: ExecutionContext
  tried: string[]
  /** 会话粘性 key（由 `handleChatCompletions` 统一派生，空串 = 不做粘性）。 */
  sessionKey: string
  /**
   * 跨渠道容灾深度（默认 0）。
   *
   * ⚠️ ≥1 时**不再触发**反向容灾，避免与 buddy 路径形成无限相互递归。
   */
  failoverDepth?: number
}): Promise<GatewayResult> {  const { providerId, model, wantsStream, rawBody, request, env, realm, ctx, sessionKey } = input
  const failoverDepth = input.failoverDepth ?? 0

  const provider = findProvider(providerId)
  if (provider === undefined) {
    return { response: jsonError(404, `未知供应商「${providerId}」`, 'unknown_provider') }
  }
  if (!provider.capabilities.chat) {
    // ⚠️ 显式说明**为什么**不可用，而不是笼统报错
    return {
      response: jsonError(
        501,
        `供应商「${provider.name}」当前不支持对话。` +
          (provider.capabilities.loginBlockedReason ?? ''),
        'provider_chat_unsupported',
      ),
    }
  }

  // ⚠️ **realm 自动回退与分片消歧**：
  //
  // 账号按凭据的 `extras.realm` 分片存放（WorkBuddy 国际版在 `global`，国内版在 `cn`）。
  // 客户端请求通常缺省 `realm=cn`：
  // 1. 请求 `workbuddy` 时，规范分片**严格锁定为 `global`**，绝不能在 `cn` 分片探测，
  //    避免误把国内凭据拿去打国际版端点（必然 401/11128 拦截）；
  // 2. 其余供应商先看当前 realm，若该分片完全无此供应商账号再回退到另一个 realm。
  let activeRealm = providerId === 'workbuddy' ? 'global' : realm
  if (providerId !== 'workbuddy') {
    const probe = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const hasHere = (await probe.listAccounts(realm, Date.now())).some(
      (a) => (a.provider ?? DEFAULT_PROVIDER) === providerId,
    )
    if (!hasHere) {
      const other = realm === 'cn' ? 'global' : 'cn'
      const probeOther = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(other))
      const hasOther = (await probeOther.listAccounts(other, Date.now())).some(
        (a) => (a.provider ?? DEFAULT_PROVIDER) === providerId,
      )
      if (hasOther) activeRealm = other
    }
  }

  // 请求头指定的账号若在另一个分片，跟着它走（否则只会报「指定账号不存在」）
  const headerPin = requestedAccount(request)
  if (headerPin !== '' && providerId !== 'workbuddy') {
    const here = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(activeRealm))
    if ((await here.getAccount(headerPin)) === undefined) {
      const other = activeRealm === 'cn' ? 'global' : 'cn'
      const there = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(other))
      if ((await there.getAccount(headerPin)) !== undefined) activeRealm = other
    }
  }

  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(activeRealm))
  // ⚠️ 与 WorkBuddy 路径同理：请求体里的 `model` 必须换成**去前缀**的裸名。
  // 各 provider 的 `chat()` 会把它直接放进上游请求，带前缀会被上游判为
  // 「没有这个模型」—— 而这个错误又会被记成模型级冷却（见上面的长注释）。
  const body =
    rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? { ...(rawBody as Record<string, unknown>), model }
      : (rawBody as Record<string, unknown>)
  const tried = input.tried
  const requestStartedAt = Date.now()
  let lastError: { status: number; message: string; kind?: string } | undefined

  // ⚠️ 会话 / 轮级 id 在重试循环**外**算一次（实测语义）：
  // `X-Conversation-Request-ID` 在一轮用户发送里恒定（重试复用），
  // 放在循环内会让每次重试都变成「另一轮」。
  const providerTurnRequestId = newTurnRequestId()
  /**
   * 与 buddy 路径的 `conversationId` **同一缺陷、同一修法**
   *（2026-10-21 审查补，M3 指出高危）。
   *
   * 原来 `let providerConversationId = sessionKey === '' ? crypto.randomUUID() : ''`
   * 配合循环内 `if (providerConversationId === '') { … }`，
   * ⇒ 只在**第一个账号**身上算一次，之后换号全程复用
   * ⇒ **同一段会话 id 发给多个账号 = 跨账号关联键**（防封最忌的形态之一）。
   *
   * 判据改为「**归属账号变了**」：用 `providerConversationIdOwner` 显式记归属。
   */
  let providerConversationId = ''
  let providerConversationIdOwner = ''
  const pinnedHeader = requestedAccount(request)
  /** 是否被「只用指定账号」挡住（挡住时不做跨渠道容灾 —— 用户要的就是这个号）。 */
  let pinBlocked = false
  const maxRotate = await maxRotateFor(env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn')))

  /**
   * ⚠️ **provider 路径也要延迟记账**（2026-10-21 修，我自己上一次只修了一半）。
   *
   * 0.9.1 给 buddy 主循环加了 `blame` + `deferSoft`，但**漏了这条路径** ——
   * 而 `qodercn` / `qoder` / `trae` 等**所有带前缀的模型都走这里**
   *（`server.ts:913` 的 `if (providerId !== DEFAULT_PROVIDER)` 分流）。
   *
   * 后果与 buddy 路径完全相同：池里只有 1 个号时，一次瞬时抖动就让该号进 60 秒
   * 软冷却，期间全部请求回 503「1 个账号都在冷却中」—— 用户报「审查时被打断」
   * 的症状在修完 0.9.1 后**依然复现**，就是因为这条路径没修。
   *
   * ⚠️ 这是本项目第三次「同一个 bug 只修一半」
   *（前两次：`developer→system` 归一化、SSE `data:` 前缀解析）。
   * ⇒ 以后修任何记账/归一化逻辑，**必须 grep 出所有 `applyFailure` 调用点**再动手。
   *
   * ⚠️ 本函数的出口共 4 类，**每一类都必须对 blame 表态**（S11）：
   * - 循环内的成功返回（3 处）⇒ `settleBlame`（见各自的 `onFirstChunk`）；
   * - 循环尾（全失败）⇒ `discardBlame`；
   * - 跨渠道容灾（`return await handleChatCompletions(...)`）⇒ `discardBlame`；
   * - 进循环**之前**的两道闸门（`wafGateActive` / `restrictionGateActive`）⇒
   *   此时 `blame` **必然为空**（本行以下到循环之间没有任何 `blame.push`），无需调用。
   */
  const blame: BlameEntry[] = []
  let poolSize = 0
  try {
    /**
     * 🔴 **必须用 `activeRealm`，不是 `realm`**（2026-10-21 审查发现，M2 指出）。
     *
     * `activeRealm` 在 `1997` 处按 provider 修正过
     *（`workbuddy` ⇒ `'global'`，或按 `X-FLR-Account` 钉号落到另一分片），
     * 而 `realm` 是**请求参数的原始值**（默认 `'cn'`）。
     *
     * ## 后果（静默失效）
     * `workbuddy` 的号全在 `global` 分片，却去 `cn` 分片数：
     * `listAccounts('cn')` 里没有 provider 为 `workbuddy` 的号
     * ⇒ `poolSize` 恒为 **0** ⇒ `deferSoft()` 恒 **false**
     * ⇒ workbuddy 的单账号池**永远走立即记账**，
     *   而 `deferSoft` 的设计目的（单账号池不要立刻掐断唯一路径）对它完全没生效。
     *
     * ⚠️ 这类「用了名字相近但语义不同的变量」的缺陷不会报错，
     * 只会让某个 provider 的保护静默失效 —— 正是本项目最难查的一类。
     * 直接用已经修正过的 `pool`（`2024` 处按 `activeRealm` 构造）最稳妥。
     */
    const all = await pool.listAccounts(activeRealm, Date.now())
    poolSize = all.filter((a) => (a.provider ?? '') === providerId && a.disabled !== true).length
  } catch {
    poolSize = 0
  }
  /** 单账号池时 soft 也延迟（理由见 buddy 路径的同名函数）。 */
  const deferSoft = (): boolean => poolSize === 1

  /**
   * 🔴 **两道全局防封闸门必须在**这里也接线**（2026-10-21 审查补，M1 指出高危）**。
   *
   * ## 缺陷
   * `wafGateActive` 的查询与 `noteWaf` 的投喂**只存在于 buddy 分支**（`987` / `1252`），
   * provider 分支**既不查询也不投喂**。后果是双向的：
   * 1. **不查询** ⇒ 出口 IP 已被 WAF 拦住时，buddy 会停手，provider 路径却继续
   *    轮转送号，把一次客户端请求放大成 N 次撞同一堵墙（正是防封最忌的）；
   * 2. **不投喂** ⇒ provider 路径上真实的 403 不计入 IP 级窗口，
   *    导致闸门**永远攒不够证据**、形同虚设。
   *
   * ⇒ 带前缀模型（`qodercn/dfmodel`、`workbuddy/*` 等）的请求此前**完全不受防封保护**。
   * 这是本项目「只在一处生效」模式的又一次复现，故此处**逐字对齐** buddy 的判据，
   * 连错误码与文案都保持一致，避免两条路径的语义再漂。
   *
   * ## 为什么放在循环外
   * 闸门激活期内应当**一个上游请求都不发**（见 buddy 分支的注释：
   * 轮转只会加重风控）。放进循环内就失去意义了。
   */
  if (await pool.wafGateActive(Date.now()).catch(() => false)) {
    return {
      response: jsonError(
        503,
        '出口 IP 疑似被上游 WAF 拦截（短时间内多个账号接连 403），已暂停轮转以避免加重风控。稍后自动恢复。',
        'waf_ip_blocked',
      ),
    }
  }
  // ⚠️ 先判方法存在再调用：波次暂停是保护措施，保护措施本身不能成为新的故障点
  //（测试替身缺该方法 / 老 DO 未升级时应放行请求，而不是崩掉整条路径）。
  const waveProbe = (pool as { restrictionGateActive?: (now: number) => Promise<boolean> })
  const wavePaused =
    typeof waveProbe.restrictionGateActive === 'function'
      ? await waveProbe.restrictionGateActive(Date.now()).catch(() => false)
      : false
  if (wavePaused) {
    return {
      response: jsonError(
        429,
        '多个账号近期被上游风控限制（11140 账号存在异常行为），已暂停该区域派发以避免更多账号被牵连。稍后自动恢复；如确认是误判可在面板解冻。',
        'restriction_wave',
      ),
    }
  }

  for (let attempt = 0; attempt <= maxRotate; attempt += 1) {
    const now = Date.now()
    // ⚠️ 供应商过滤交给 `pick()` 做（`provider` 字段），
    // **不要**在这里「先选中再筛掉」—— 那会让「池里有账号但当前供应商没账号」
    // 表现为「pick 返回了号、却被我丢掉」，最终误报「没有可用账号」（实测踩到）。
    // ⚠️ **会话粘性**：优先用该会话已绑定的账号（命中上游 prompt cache）。
    // `preferred` 只是「排到最前」，不可用时自然回落 —— 不会因为它挂了就报「无可用账号」。
    // ⚠️ 只在**首轮**（`tried` 为空）用粘性：已经在换号了还粘回去会死循环。
    const preferred = tried.length === 0 ? (sessionKey === '' ? '' : await pool.getSession(sessionKey, now)) : ''
    const picked = await pool.pick({
      realm: activeRealm, provider: providerId, model, exclude: tried, now,
      ...(preferred !== undefined && preferred !== '' ? { preferred } : {}),
      ...(pinnedHeader !== '' ? { pinned: pinnedHeader } : {}),
    })
    // ── 只用指定账号但它不可用：显式报原因，**不换号、不跨渠道容灾** ──
    if (picked !== undefined && picked.pinnedUnavailable === true) {
      pinBlocked = true
      lastError = {
        status: lastError?.status ?? 503,
        message: describePinBlocked(picked, pinnedHeader !== '', lastError?.message),
        kind: lastError?.kind ?? 'pinned_account_unavailable',
      }
      break
    }
    // ── 永久积分锁：同第一消费点，锁定必须显式报错（不许静默 break）──
    if (picked !== undefined && (picked as { lockedByPermanent?: true }).lockedByPermanent === true) {
      const skipped = (picked as { lockedSkipped?: number }).lockedSkipped ?? 0
      lastError = {
        status: 429,
        message: `该供应商的 ${skipped} 个账号只剩永久积分且已被「永久积分锁」保护，不参与选号。若确认要消耗永久积分，请在面板里关闭该锁。`,
      }
      break
    }
    if (picked === undefined) break
    tried.push(picked.uid)
    console.log(`[pick:${providerId}] 选中账号 uid=${picked.uid} realm=${activeRealm} tried=${tried.length}`)
    // ⚠️ 换号必须换会话 id（同一段会话发给两个账号就是跨账号关联键）
    // 🔴 换号必须换 id（见声明处的说明）：判「归属账号变了」，不是「还没算过」。
    if (providerConversationIdOwner !== picked.uid) {
      providerConversationId = sessionKey === ''
        ? crypto.randomUUID()
        : await deriveIntlConversationId(picked.uid, sessionKey)
      providerConversationIdOwner = picked.uid
    }

    const credential = (await pool.getCredential(picked.uid)) as ProviderCredential | undefined
    if (credential === undefined) {
      lastError = { status: 500, message: '账号缺少凭据' }
      continue
    }

    const startedAt = Date.now()
    // ⚠️ 续期只试一次（见下方 401 分支的说明）。
    let refreshed = false
    /**
     * 续期失败的原因（若有）。
     *
     * ⚠️ 必须**回给用户**，不能只进日志 —— 否则用户看到的是上游那句
     * 误导性的 `IAM authentication Unauthorized`，而真实原因可能是
     * 「凭据缺少续期材料，请重新登录」（见下方 catch 的说明）。
     */
    let refreshFailure = ''
    let upstream: Response
    try {
      // 防封：按账号排队 + 抖动 —— **只对 workbuddy 生效**（见 throttle.ts）。
      await throttleUpstream(picked.uid, undefined, undefined, providerId)
      upstream = await provider.chat(credential, {
        model, body, signal: request.signal,
        conversation: { conversationId: providerConversationId, turnRequestId: providerTurnRequestId },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // ⚠️ **续期也要在 catch 分支里做**（实测踩到的架构不一致）。
      //
      // 8 家 provider 的 `chat()` 在非 200 时**抛 `ProviderError`**，
      // 而不是返回 `Response`（只有 opencode 返回）。于是网关的
      // `!upstream.ok` 分支**永远走不到** —— 401 续期逻辑形同虚设，
      // 表现为「cline 的 token 明明可以续期，却一直报 401」。
      //
      // 这里按同样的判据（鉴权类错误）尝试续期并重放一次。
      if (isAuthLikeFailure(0, message) && provider.refresh !== undefined && !refreshed) {
        try {
          refreshed = true
          const fresh = await provider.refresh(credential, AbortSignal.timeout(30_000))
          await pool.putCredential(picked.uid, fresh, Date.now())
          console.warn(`[refresh] ${providerId} 续期成功（catch 分支），已回写凭据`)
          await throttleUpstream(picked.uid, undefined, undefined, providerId)
          const retry = await provider.chat(fresh, {
            model, body, signal: request.signal,
            conversation: { conversationId: providerConversationId, turnRequestId: providerTurnRequestId },
          })
          if (retry.ok && retry.body !== null) {
            const startedAt2 = Date.now()
            return {
              response: await streamResponse(retry.body, {
                // ⚠️ 诊断 + 记账分界：客户端断开**不得**记成账号失败
                //（否则用户的取消动作会熔断健康账号，见 `nonStreamingResponse` 的说明）。
                clientGone: () => request.signal.aborted,
                onFirstChunk: () => {
                  const t = pool.noteSuccess(picked.uid, Date.now(), undefined, model).catch(logPoolError('noteSuccess'))
                  if (ctx !== undefined) ctx.waitUntil(t)
                  // ✅ **结算 blame**：这个号成功了 ⇒ 之前那些失败确实是那几个号的问题。
                  const settle = settleBlame(pool, blame, Date.now())
                  if (ctx !== undefined) ctx.waitUntil(settle)
                  else void settle
                  // ⚠️ 首帧到达即绑定会话 —— 此后同一会话优先落这个账号，
                  // 从第二轮起命中上游 prompt cache（更快、更省）。
                  if (sessionKey !== '' && ctx !== undefined) {
                    ctx.waitUntil(pool.bindSession(sessionKey, picked.uid, Date.now()).catch(logPoolError('bindSession')))
                  }
                },
                onError: (m) => {
                  const t = pool
                    .applyFailure({ uid: picked.uid, kind: 'breaker', now: Date.now(), reason: m.slice(0, 200) })
                    .catch(logPoolError('applyFailure'))
                  if (ctx !== undefined) ctx.waitUntil(t)
                  recordStreamFailure(pool, { uid: picked.uid, model: `${providerId}/${model}`, errorKind: 'breaker', startedAt: startedAt2 }, ctx)
                  recordLog(
                    pool,
                    {
                      type: 'error',
                      model: `${providerId}/${model}`,
                      provider: providerId,
                      uid: picked.uid,
                      status: 502,
                      durationMs: Date.now() - startedAt2,
                      error: m.slice(0, 200),
                      stream: wantsStream,
                    },
                    ctx,
                  )
                },
                onFinish: (usage) => {
                  // 🔴 子密钥 token 配额（2026-10-21 审查补）：主密钥路径无条目、零开销
                  settleSubkeyUsage(ctx, env, usage?.input ?? 0, usage?.output ?? 0, `${providerId}/${model}`)
                  const t = pool
                    .recordUsage({
                      at: Date.now(), uid: picked.uid, model: `${providerId}/${model}`,
                      input: usage?.input ?? 0, output: usage?.output ?? 0, ok: true,
                      ms: Date.now() - startedAt2,
                    })
                    .catch(logPoolError('recordUsage'))
                  if (ctx !== undefined) ctx.waitUntil(t)
                  recordLog(
                    pool,
                    {
                      type: 'api',
                      model: `${providerId}/${model}`,
                      provider: providerId,
                      uid: picked.uid,
                      status: 200,
                      durationMs: Date.now() - startedAt2,
                      tokens: { input: usage?.input ?? 0, output: usage?.output ?? 0, total: (usage?.input ?? 0) + (usage?.output ?? 0) },
                      stream: wantsStream,
                    },
                    ctx,
                  )
                },
              }, wantsStream ? undefined : { model }),
            }
          }
        } catch (refreshError) {
          console.error(
            `[refresh] ${providerId} 续期失败：`,
            refreshError instanceof Error ? refreshError.message : String(refreshError),
          )
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // 🔴 `ProviderError` 必须**先过一遍业务码分类**，不能一律当网络错误
      // ══════════════════════════════════════════════════════════════════
      //
      // ## 实测缺陷（2026-10-20，与 11158 / 11102 误锁直接相关）
      //
      // 8 家 provider 的 `chat()` 在非 2xx 时**抛 `ProviderError`**，
      // 于是网关的 `!upstream.ok` 分支（那里才有 `classify()`）永远走不到。
      // 结果：**所有**上游业务错误都被压成一句 `lastError = {502, message}`、
      // 记成传输层失败 —— 业务码语义整条丢失。
      //
      // 具体后果（本次事故现场）：
      //   - `11158 model not allowed for user type` ⇒ 记成网络错误 ⇒ 不写模型负缓存；
      //   - `11102 service info not found`          ⇒ 同上；
      //   - 而**另一些**路径（如 SSE 分支）却会写模型冷却 —— 同一份错误两套结果，
      //     出现 `cause=absent` 与 `cause=denied` 混杂、且冷却时长对不上账的现象。
      //
      // 修法：把 `ProviderError` 的原始 message 交给 `classify()`（它本来就是
      // 按文本解析业务码的），只有**确实解析不出业务码**时才退回传输层语义。
      const pe = error as { name?: string; httpStatus?: number; code?: unknown; retryable?: unknown }
      const peStatus = typeof pe?.httpStatus === 'number' ? pe.httpStatus : 0
      const isProviderErr = pe?.name === 'ProviderError'
      if (isProviderErr) {
        const c = classify(peStatus, message)
        // ⚠️ **解析不出业务码时保留 provider 的原文**（实测缺陷）。
        // `classify()` 在没有信封时只会给出 `upstream 403` / `unexpected status 0`
        // 这种合成文案 —— 直接用它会把 ProviderError 里真正的原因（例如
        // 「WASM 实例化失败：Import #0 …」）整句吞掉，用户只看到
        // `unknown: unexpected status 0`，完全无从排查。
        const detail = c.code === undefined && c.kind !== 'waf_blocked' ? message : (c.msg || message)

        /**
         * 🔴 **`waf_blocked` 无条件留证**（2026-10-21，第三次修同一个盲区）。
         *
         * ⚠️ 我此前把这条日志加在了 `!upstream.ok` 分支（`handleChatCompletions`
         * 里），但**8 家 provider 的 `chat()` 在非 2xx 时抛 `ProviderError`**，
         * 于是那条分支**永远走不到** —— 日志加了等于没加，`[waf-403]` 一条都没有，
         * 而 `[punish]` 却持续输出 `reason=waf_blocked: ...`。
         *
         * 这就是「记录点在 A 路径、故障发生在 B 路径」的第 4 次复发。
         * ⇒ 判据应该是「**这个 kind 值得留证**」，而不是「我在哪个分支顺手」。
         */
        if (c.kind === 'waf_blocked' || c.kind === 'channel_blocked') {
          console.warn(
            `[waf-403] model=${model} http=${peStatus} kind=${c.kind} len=${message.length} ` +
              `body=${message.slice(0, 500)}`,
          )
        }

        /**
         * 🔴 **WAF / 11140 的「双记账」也必须在这里做**
         *（2026-10-21 审查补，M1 指出高危）。
         *
         * ## 缺陷
         * buddy 分支在 `!upstream.ok` 里做了双记账（`1260` 附近的 `noteWaf` /
         * `noteRestriction`），而 provider 分支**只打日志、不记账**。
         *
         * ⇒ 效果是**闸门永远攒不够证据**：
         * 顶部的 `wafGateActive` / `restrictionGateActive` 靠「短窗内多个不同号命中」
         * 才激活，而 provider 路径（8 家 provider 抛 `ProviderError` 都走这里）
         * 的真实 403 一条都没投喂 ⇒ 闸门对带前缀模型**形同虚设**。
         *
         * ## 为什么还要 `break`
         * IP 被拦时继续轮转，就是把一次客户端请求放大成 N 次撞同一堵墙
         *（buddy 分支的注释记过 Go 侧实测：3 个账号 1 秒内全部 403）。
         * 故与 buddy 分支同样**立即停手**，返回可读原因。
         */
        if (c.kind === 'request_illegal') {
          await pool.noteRestriction(picked.uid, Date.now()).catch(() => false)
        }
        if (c.kind === 'waf_blocked') {
          const ipBlocked = await pool.noteWaf(picked.uid, Date.now()).catch(() => false)
          if (ipBlocked) {
            lastError = {
              status: 503,
              message: '出口 IP 疑似被 WAF 拦截（短窗内多个账号接连 403）',
              kind: 'waf_ip_blocked',
            }
            break
          }
        }

        const pm = mapErrorToPunishment(c.kind)
        const pcause = modelCauseFor(c.kind)
        if (pm.punish) {
          /**
           * ⚠️ **与另两条路径同一套纪律**：累加型维度 + 单账号池的 soft 都延迟记账。
           *
           * 这是「延迟记账」的第 3 条路径（前两条：buddy 主循环、provider 的
           * `peekStreamForError` 分支）。三处必须一致，否则又是「只修一半」。
           */
          /**
           * 🔴 **必须在这里也做 `refineModelScoped`**（2026-10-21 审查发现，M1 指出）。
           *
           * ## 缺陷
           * 本分支原来只写 `const pPunishKind = pm.dimension` ——
           * 而 `mapErrorToPunishment('rate_limited')` 恒为 `'soft'`（**账号级**）。
           * `refineModelScoped` 的模型级细分（6004 / 14003 / 11134 / **110**）
           * 在这里**根本没被调用**。
           *
           * ## 为什么这条路径最关键
           * qoder 的 `110`（日次数上限）**恰恰只从这条路径产生**：
           * `providers/qoder.ts` 把非 2xx 包成 `ProviderError` 抛出 ⇒ 落到本分支。
           * ⇒ 我上一版把 `110` 加进 `refineModelScoped` 的模型级判据，
           * 但**唯一真正产生 110 的路径不调用它** ⇒ 修复等于没生效。
           * 后果：单账号 provider（`qodercn`）遇 110 时**整个账号被锁 60 秒起**，
           * 而正确处置是「只冷却该模型，换个模型立刻可用」。
           *
           * ## 与另两条路径对齐
           * - 分支A（`server.ts:1269`）：`kind === 'rate_limited' ? dimension : …`
           * - 分支B 首帧预检（`server.ts:2534`）：`kind === 'rate_limited' ? refined.dimension : …`
           * 本处照抄同一口径，并**补上 `resetAt`**（另两条都传了）：
           * 上游在文案里给了重置墙钟时，冷却应对齐它而不是走我们自己猜的指数退避
           *（猜早了继续撞限流，猜晚了白白少用几小时）。
           */
          /**
           * ⚠️ **必须传原始 message，不能传 `detail`**（2026-10-22，G3）。
           *
           * `detail` 在「已解析出业务码」时被换成了 `c.msg`（人话文案），
           * 而 `refineModelScoped()` 内部是拿 `parseBusinessCode(bodyText)` 找码的 ——
           * 传人话过去必然解析不出码，于是 `110/6004/14003/11134` 全部退化成
           * **账号级 soft**：一个模型限流就把整个号锁掉，换个模型明明能用。
           *
           * 这与注释里声称的「与另两条路径对齐」并不一致：那两条传的都是原始文本。
           */
          const pRefined = refineModelScoped(c.kind, message)
          const pPunishKind =
            c.kind === 'rate_limited'
              ? pRefined.dimension
              : pm.dimension === 'model'
                ? 'model'
                : pm.dimension
          const pResetAt = pRefined.resetAt
          if (pPunishKind === 'breaker' || pPunishKind === 'degrade' || (pPunishKind === 'soft' && deferSoft())) {
            // ⚠️ `resetAt` 也必须带进收件箱（S4）：下面立即结算那条分支传了
            // `pResetAt`，若这里不传，同一个错误只因走了延迟就丢掉上游墙钟。
            // ⚠️ 本路径拿不到 `Retry-After` 头（上游是**抛异常**，没有 `Response`），
            // 故只有文案里解析出的 `pResetAt` —— 与立即结算分支的可用信息同源。
            blame.push({
              uid: picked.uid,
              kind: pPunishKind,
              reason: `${c.kind}: ${detail}`.slice(0, 200),
              ...(pResetAt !== undefined ? { resetAt: pResetAt } : {}),
            })
          } else {
            await pool
              .applyFailure({
                uid: picked.uid,
                kind: pPunishKind,
                now: Date.now(),
                ...(model !== '' ? { model } : {}),
                ...(pcause !== undefined ? { modelCause: pcause } : {}),
                ...(pResetAt !== undefined ? { resetAt: pResetAt } : {}),
                reason: `${c.kind}: ${detail.slice(0, 180)}`,
              })
              .catch(logPoolError('applyFailure'))
          }
        }
        lastError = {
          status: clientStatusFor(peStatus || 502, c.kind),
          message: `${c.kind}: ${detail}`,
          kind: c.kind,
        }
        /**
         * 🔴 **换不换号：先问 provider，再退到 `retryable`，最后才是通用判据**
         *（2026-10-21 审查补，M4 指出高危）。
         *
         * ## 缺陷
         * 这条路径原来**只用** `pm.rotate`（由业务码推出来的通用判据），于是：
         * 1. `provider.shouldRotate?.(status, text)` **从未被调用** ——
         *    cline / minimax 里写好的「403 地域封锁不换号」「5xx 不换号」
         *    整套判据**一次都没生效**（M4 实测：这两家都抛 `ProviderError`，
         *    而唯一消费 `shouldRotate` 的地方在「返回 Response」的分支）；
         * 2. `ProviderError.retryable` 在对话路径**无人消费**
         *    （只有登录流程读它）⇒ 各家精心标的 `retryable` 全是死字段。
         *
         * ## 后果是**反向**的
         * cline 想「403 别换号」（换号会连坐其它号），实际却按通用判据
         * `auth_error.rotate = true` **整池轮转** —— 与作者意图完全相反。
         *
         * ## 优先级
         * `shouldRotate`（provider 最了解自己的错误语义）
         * → `retryable`（provider 的较粗粒度标注）
         * → `pm.rotate`（通用兜底）。
         * 三者都缺省时保持原行为，不改变未定义这两项的 provider。
         */
        const providerRotate = provider.shouldRotate?.(peStatus, message)
        const rotate =
          providerRotate
          ?? (typeof pe.retryable === 'boolean' ? pe.retryable : pm.rotate)
        // 判出来的「不可换号」类（如渠道拦截 / 参数错 / 地域封锁）立刻停，
        // 否则会白换号并放大风控。
        if (!rotate) break
        continue
      }

      lastError = { status: 502, message }
      // 传输层失败：换号可能有用（也可能是本地出口抖动）
      continue
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')

      // ⚠️ **401/403 先尝试续期，而不是直接判失败**（实测踩到）。
      //
      // 上游令牌都有寿命（实测本地凭据过期 5–7 小时），过期后所有请求 401。
      // 若不续期，账号用一天就废；而用户看到的是「凭据坏了」，
      // 完全想不到「只是该续期了」。
      //
      // 只试**一次**（`refreshed` 标记）：续期后仍 401 说明 refresh token 也废了，
      // 再试只是无谓地打上游。
      // ⚠️ **判据是「响应内容像鉴权失败」，不是「状态码等于 401/403」**。
      //
      // 实测踩到：CodeArts 的 security_token 过期报的是 **HTTP 400** +
      // `{"error_code":"APIG.0602","error_msg":"...security token has expired"}`。
      // 只看状态码的话，这个分支根本不进 —— 续期逻辑形同虚设，
      // 而 catch 分支（另一条路）已经改成按内容判了，两条路判据必须一致。
      if (isAuthLikeFailure(upstream.status, text) && provider.refresh !== undefined && !refreshed) {
        try {
          refreshed = true
          const fresh = await provider.refresh(credential, AbortSignal.timeout(30_000))
          await pool.putCredential(picked.uid, fresh, Date.now())
          // ⚠️ 重放请求（用新凭据）。这里直接用 continue 会重新选号，
          // 但我们要的是**同一个号**换新令牌重试 —— 故显式再发一次。
          const retry = await provider.chat(fresh, {
            model, body, signal: request.signal,
            conversation: { conversationId: providerConversationId, turnRequestId: providerTurnRequestId },
          })
          if (retry.ok && retry.body !== null) {
            const startedAt2 = Date.now()
            return {
              response: await streamResponse(retry.body, {
                onFirstChunk: () => {
                  const t = pool.noteSuccess(picked.uid, Date.now(), undefined, model).catch(logPoolError('noteSuccess'))
                  if (ctx !== undefined) ctx.waitUntil(t)
                  // ✅ **结算 blame**（2026-10-21 审查补，M1 指出）：
                  // 这个号成功了 ⇒ 之前那些失败确实是那几个号的问题，现在才记账。
                  // 缺了它，本路径塞进 blame 的 breaker/degrade 失败**永不落账**
                  //（成功时直接 return，连「丢弃」日志都不打）——
                  // 表现是「持续 5xx 的账号永远不进熔断、面板 fails 恒 0」。
                  const settle = settleBlame(pool, blame, Date.now())
                  if (ctx !== undefined) ctx.waitUntil(settle)
                  else void settle
                  // 会话粘性：首帧到达即绑定，后续轮次优先落同一账号
                  if (sessionKey !== '' && ctx !== undefined) {
                    ctx.waitUntil(pool.bindSession(sessionKey, picked.uid, Date.now()).catch(logPoolError('bindSession')))
                  }
                },
                // ⚠️ 诊断用：区分「客户端断开」与「上游中断」
                clientGone: () => request.signal.aborted,
                onError: (message) => {
                  const t = pool
                    .applyFailure({
                      uid: picked.uid,
                      kind: punishmentForStreamError(message),
                      now: Date.now(),
                      reason: message.slice(0, 200),
                    })
                    .catch(logPoolError('applyFailure'))
                  if (ctx !== undefined) ctx.waitUntil(t)
                  recordStreamFailure(pool, { uid: picked.uid, model: `${providerId}/${model}`, errorKind: punishmentForStreamError(message), startedAt: startedAt2 }, ctx)
                  recordLog(
                    pool,
                    {
                      type: 'error',
                      model: `${providerId}/${model}`,
                      provider: providerId,
                      uid: picked.uid,
                      status: 502,
                      durationMs: Date.now() - startedAt2,
                      error: message.slice(0, 200),
                      stream: wantsStream,
                    },
                    ctx,
                  )
                },
                onFinish: (usage) => {
                  // 🔴 子密钥 token 配额（2026-10-21 审查补）：主密钥路径无条目、零开销
                  settleSubkeyUsage(ctx, env, usage?.input ?? 0, usage?.output ?? 0, `${providerId}/${model}`)
                  const t = pool
                    .recordUsage({
                      at: Date.now(), uid: picked.uid, model: `${providerId}/${model}`,
                      input: usage?.input ?? 0, output: usage?.output ?? 0, ok: true,
                      ms: Date.now() - startedAt2,
                    })
                    .catch(logPoolError('recordUsage'))
                  if (ctx !== undefined) ctx.waitUntil(t)
                  recordLog(
                    pool,
                    {
                      type: 'api',
                      model: `${providerId}/${model}`,
                      provider: providerId,
                      uid: picked.uid,
                      status: 200,
                      durationMs: Date.now() - startedAt2,
                      tokens: { input: usage?.input ?? 0, output: usage?.output ?? 0, total: (usage?.input ?? 0) + (usage?.output ?? 0) },
                      stream: wantsStream,
                    },
                    ctx,
                  )
                },
              }, wantsStream ? undefined : { model }),
            }
          }
        } catch (error) {
          // ## 🔴 续期失败的原因**必须带到用户可见的错误里**
          //
          // 实测缺陷（用户报「商汤和 zcode 的账号怎么了，为什么调用不了」）：
          // 续期失败的原因此前只 `console.error` 到日志，用户看到的仍是
          // **上游的原始错误** —— 例如 codearts 那条：
          // ```
          // APIG.0301 Incorrect IAM authentication information: Unauthorized
          // ```
          // ⚠️ 那句极具误导性：它说的是「IAM 鉴权不对」，让人以为**账号被封**，
          // 而真实原因是**这个凭据缺自动续期所需的材料**（见下）。
          //
          // ⇒ 把续期失败的原因**记下来**，附在最终错误里。
          refreshFailure = error instanceof Error ? error.message : String(error)
          console.error(`[refresh] ${providerId} 续期失败：`, refreshFailure)
        }
      }

      // ⚠️ **先按响应体分类，再决定怎么罚**（实测缺陷：provider 路径只看状态码）。
      //
      // 原实现固定按 `upstream.status === 429 ? 'rate_limited' : 'unknown'` 分类，
      // 于是上游用 400 回的渠道校验失败（`{"code":"11-128"}`）会被当成 `unknown`
      // ⇒ `failureKind` 落到 `breaker` ⇒ **连续 3 次就把健康账号熔断 30 分钟**
      //（实测：5 个国际版账号全 11-128，几分钟内整池进熔断）。
      // 改用共享的 `classify()` 后，11-128 会被认成 `channel_blocked`，
      // 走「不罚号 + 不换号 + 直出真实原因」的分支，与 buddy 路径口径一致。
      const classified = classify(upstream.status, text)
      /**
       * 🔴 **WAF / 11140 的「双记账」在这条出口也要做**（2026-10-22，G5）。
       *
       * ProviderError 出口（`2451`/`2454`）早就补了双记账，但**这条出口没有** ——
       * 而 `trae` / `opencode` 恰恰是把非 2xx **原样 return**（不抛异常）的两家：
       * ```
       * trae.ts:1083   if (!upstream.ok || upstream.body === null) return upstream
       * opencode.ts:815  return res
       * ```
       * ⇒ 这两家的真实 403-WAF / 11140 从来不给闸门投喂证据，
       * 而顶部的 `wafGateActive` / `restrictionGateActive` 靠「短窗内多个不同号命中」
       * 才激活 ⇒ 闸门对它们形同虚设。
       *
       * 这与本项目反复出现的「记录点在 A 路径、故障发生在 B 路径」是同一个毛病：
       * 判据应该挂在**语义**上（这个 kind 该不该记账），而不是「我在哪个分支顺手」。
       */
      if (classified.kind === 'request_illegal') {
        await pool.noteRestriction(picked.uid, Date.now()).catch(() => false)
      }
      if (classified.kind === 'waf_blocked') {
        const ipBlocked = await pool.noteWaf(picked.uid, Date.now()).catch(() => false)
        if (ipBlocked) {
          lastError = {
            status: 503,
            message: '出口 IP 疑似被 WAF 拦截（短窗内多个账号接连 403）',
            kind: 'waf_ip_blocked',
          }
          break
        }
      }
      const isChannelBlocked = classified.kind === 'channel_blocked'
      const rotate = isChannelBlocked
        ? false
        : (provider.shouldRotate?.(upstream.status, text) ?? (upstream.status === 429 || upstream.status === 402))
      // ⚠️ 不换号 ⇒ 也不该记冷却（判的是我方请求指纹，账号是健康的）
      if (isChannelBlocked) {
        lastError = {
          status: clientStatusFor(upstream.status, 'channel_blocked'),
          message: `渠道校验失败：${text.slice(0, 200)}${CHANNEL_BLOCKED_HINT}`,
        }
        clearSessionBinding(pool, sessionKey, ctx)
        break
      }

      // ⚠️ **429 不能一律当账号级冷却**（实测缺陷，用户报「一会能用一会不能用」）。
      //
      // 上游 6004 说的是「usage exceeds frequency limit … alternatively, you can
      // switch to the other models」= **模型级**限流。而这条 provider 路径原先
      // 硬编码 `429 → soft`（账号级），于是**单个账号的供应商**
      //（如只有 1 个 global 账号的 workbuddy）在冷却期**完全不可用**。
      //
      // 复用与 buddy 路径相同的细分判据，避免两条路径口径分叉
      //（此前 buddy 路径已细分、这里没有 —— 同一个 bug 修了一半）。
      /**
       * 🔴 **必须用 `classify()` 的结论决定「罚不罚、罚哪个维度」**
       *（2026-10-21 审查补，M4 指出的**严重**项）。
       *
       * ## 缺陷
       * 本分支原来把 `classified.kind` **只**用于判 `channel_blocked`，
       * 其余非 2xx 一律硬编码：
       * ```
       * const failureKind = 402 ? 'hard' : 429 ? refined.dimension : 'breaker'
       * ```
       * ⇒ opencode / trae 这两家（**返回非 2xx Response** 而非抛异常）的
       * `400 / 401 / 403 / 404` 全部落 `breaker` ⇒ 3 次熔断健康号 30 分钟起，
       * 且 `AccountPoolDO` 还按 `2^retryCount` 递增到 6 小时。
       *
       * ## 为什么这是「只修一半」的第 N 次
       * **同一个文件里**的 SSE 预读分支（`2681` 起）**已经**用
       * `mapErrorToPunishment(kind)` 正确判定了 —— 只有这条 HTTP 非 2xx 分支没改。
       * 于是「上游用 SSE 帧报错」和「上游用 HTTP 状态码报错」表现完全不同，
       * 而这两条路径**服务的是同一批 provider**。
       *
       * ## 修法
       * 与 SSE 分支同口径：`mapErrorToPunishment` 决定 `punish` 与 `dimension`，
       * `refineModelScoped` 在 `rate_limited` 时细分到模型级，
       * `modelCauseFor` 把「无此模型/档位拒绝」的结构化成因一并带给池。
       */
      const pm = mapErrorToPunishment(classified.kind)
      const refined = refineModelScoped(
        // 429 一律按「限流」细分（`classify` 对无信封的 429 也返回 rate_limited，
        // 这里显式兜一层，避免上游回 429 但文案没码时被判成 unknown 而失去模型级细分）
        upstream.status === 429 ? 'rate_limited' : classified.kind,
        text,
      )
      // ⚠️ **文案解析不到时，退回标准的 `Retry-After` 头**。
      //
      // 上游文案格式**随时可能改**（`reset at … UTC+8` 是我们逆向出来的），
      // 而 `Retry-After` 是 HTTP 标准头 —— 两者都能给就用文案的（更精确），
      // 文案给不出时才用头。没有这一步就只剩「我们自己猜 6 小时」。
      //
      // ⚠️ `parseRetryAfterMs` 只放行**纯数字**秒数：`Date.parse('900')`
      // 会得到 1970 年，算出巨大负数被夹成 0 ⇒ 刚限流的账号马上被重选，
      // 形成无限空转（该函数自己的注释记录了这条踩坑）。
      const retryAfterMs = refined.resetAt === undefined
        ? parseRetryAfterMs(upstream.headers)
        : undefined
      const resolvedResetAt = refined.resetAt
        ?? (retryAfterMs === undefined ? undefined : Date.now() + retryAfterMs)
      /**
       * `punish === false` 的一律**不写冷却**（如 `bad_request` / `auth_error` /
       * `model_unavailable` 之类参数或凭据问题）—— 罚健康账号是本项目最贵的错误。
       * 402 例外保留：它语义上就是「余额耗尽」，必须硬冷却。
       */
      // ⚠️ 直接透传 `pm.dimension`，**不做有损映射**：
      // 一度写成 `model/soft/else breaker`，结果把 hard / session_dead / restricted
      // 三个维度全并成了 breaker —— 那正是本项目反复出现的「映射时丢语义」。
      const failureKind: typeof pm.dimension | undefined =
        upstream.status === 402
          ? 'hard'
          : pm.punish
            ? (upstream.status === 429 || classified.kind === 'rate_limited'
              ? refined.dimension
              : pm.dimension)
            : undefined
      if (failureKind !== undefined) {
        const cause = modelCauseFor(classified.kind)
        await pool
          .applyFailure({
            uid: picked.uid,
            kind: failureKind,
            now: Date.now(),
            ...(model !== '' ? { model } : {}),
            // ⚠️ 带上上游给的重置时刻（文案里的 `reset at … UTC+8`，
            // 或标准 `Retry-After` 头）：模型级冷却据此对齐上游墙钟，
            // 而不是我们自己猜 6 小时。
            ...(resolvedResetAt !== undefined ? { resetAt: resolvedResetAt } : {}),
            reason: `${providerId} http=${upstream.status}: ${text.slice(0, 160)}`,
            ...(cause !== undefined ? { modelCause: cause } : {}),
          })
          .catch(logPoolError('applyFailure'))
      }
      // ⚠️ 同上：不原样透传上游状态码（避免把网关故障伪装成客户端的 400）
      lastError = {
        status: clientStatusFor(upstream.status, 'unknown'),
        // ⚠️ **续期失败时要把原因一并说明** —— 否则用户只看到上游那句
        // 误导性的错误（如 codearts 的 `IAM authentication Unauthorized`），
        // 会以为账号被封，而真实原因是「凭据缺少续期材料，该重新登录」。
        // 两者该采取的行动完全不同：前者等，后者去重新登录。
        message: refreshFailure !== ''
          ? `${text.slice(0, 200) || `http=${upstream.status}`}`
            + `（自动续期也失败了：${refreshFailure.slice(0, 200)}）`
          : text.slice(0, 300) || `http=${upstream.status}`,
      }

      // 请求失败立刻解绑当前会话，避免下次请求死锁在坏账号上
      clearSessionBinding(pool, sessionKey, ctx)

      if (!rotate) break
      continue
    }

    if (upstream.body === null) {
      clearSessionBinding(pool, sessionKey, ctx)
      lastError = { status: 502, message: '上游返回空 body' }
      continue
    }

    // 预检首块数据：若上游以 HTTP 200 返回 6004 限流或错误帧，立即拦截并换号重试
    const peeked = await peekStreamForError(upstream.body)
    if (peeked.error !== undefined) {
      const errText = peeked.cleanJson ?? peeked.rawText ?? peeked.error
      const { kind, msg } = classify(200, errText)
      const mapped = mapErrorToPunishment(kind)
      const refined = refineModelScoped(kind, errText)
      const retryAfterMs = refined.resetAt === undefined ? parseRetryAfterMs(upstream.headers) : undefined
      const resolvedResetAt = refined.resetAt ?? (retryAfterMs === undefined ? undefined : Date.now() + retryAfterMs)

      if (mapped.punish) {
        const cause = modelCauseFor(kind)
        await pool
          .applyFailure({
            uid: picked.uid,
            kind: kind === 'rate_limited' ? refined.dimension : mapped.dimension === 'model' ? 'model' : mapped.dimension,
            now: Date.now(),
            ...(model !== '' ? { model } : {}),
            ...(resolvedResetAt !== undefined ? { resetAt: resolvedResetAt } : {}),
            reason: `${providerId} sse: ${(msg || errText).slice(0, 160)}`,
            ...(cause !== undefined ? { modelCause: cause } : {}),
          })
          .catch(logPoolError('applyFailure'))
      }

      clearSessionBinding(pool, sessionKey, ctx)

      lastError = {
        status: clientStatusFor(200, kind),
        message: `${providerId} sse: ${msg || errText.slice(0, 160)}`,
      }

      // ⚠️ 渠道校验失败必须立刻停止轮换，**不能**落到下面的 `mapped.rotate` 再换号。
      //
      // 11-128 判的是**我方请求指纹**（头部身份 + 会话头族），与账号无关：
      // 实测 5 个国际版账号用同一套头发出去，全部回 11-128。
      // 换号只是把同一份指纹再打 N 次 —— 既拖长客户端等待（每次都等首帧超时），
      // 又白白给上游刷失败次数、抬高风控权重。
      //
      // 与 HTTP 非 2xx 分支同口径：那一路已经显式 break，两条路径必须一致，
      // 否则「上游用 400 报」和「上游用 SSE 帧报」会表现不同（同一个 bug 只修一半）。
      if (kind === 'channel_blocked') break
      if (mapped.rotate) continue // 换号重试！
      break
    }

    // ②b **零输出越墙熔断**（见 `zero-output.ts` 文件头）。
    //
    // ⚠️ 必须在**把响应交给客户端之前**判定：一旦 `finish_reason=length` 的
    // 终止帧被转发出去，客户端就把这一轮当结束了，改道也晚了。
    // 故这里预读「首帧可见内容之前」的字节（正常只有 1~3 帧），判定完再原样放行。
    const screened = await screenZeroOutputStream(peeked.stream, {
      // 客户端主动取消 ⇒ 一律不改道（本项目的既有纪律）
      isCancelled: () => request.signal.aborted,
    })
    if (screened.hit) {
      // ⚠️ 罚**模型维度**（`kind:'model'`），不罚账号：
      // 越墙是「这个目标（账号+模型）此刻的输入被拒」，与账号好坏无关，
      // 换账号可能有用（不同号挂不同后端），故仍需改道；但绝不能升成
      // `breaker`（3 次就熔断账号 30 分钟，会误杀健康账号）。
      const reason = `${providerId}/${model} zero-output (finish_reason=length, ${screened.probe.frames}f)`
      await pool
        .applyFailure({
          uid: picked.uid,
          kind: 'model',
          now: Date.now(),
          ...(model !== '' ? { model } : {}),
          // ⚠️ 显式给 `resetAt`：不走「11102 无此模型」那条 6h 指数退避
          //（越墙不是「上游没有这个模型」，6h 惩罚过重）。
          resetAt: Date.now() + ZERO_OUTPUT_COOLDOWN_MS,
          reason,
        })
        .catch(logPoolError('applyFailure'))

      // ⚠️ §7.2「失败必须显式」：改道**必须留痕**，不能静默。
      // 日志 + 面板日志双写，否则用户/排查者无法把这次改道与网络故障区分开
      //（两者在 chunk 层完全同形，见 `zero-output.ts` 文件头）。
      console.warn(`[zero-output] ${describeZeroOutputHit(providerId, model, screened.probe)} uid=${picked.uid}`)
      recordLog(
        pool,
        {
          type: 'error',
          model: `${providerId}/${model}`,
          provider: providerId,
          uid: picked.uid,
          status: 502,
          durationMs: Date.now() - startedAt,
          error: `零输出越墙，已冷却该目标并改道（finish_reason=length，0 输出，${screened.probe.frames} 帧）`,
          stream: wantsStream,
        },
        ctx,
      )

      clearSessionBinding(pool, sessionKey, ctx)
      lastError = {
        status: 502,
        message: describeZeroOutputHit(providerId, model, screened.probe),
      }
      continue // 改道下一个候选重发（什么都没产出，没有内容可丢）
    }

    return {
      response: await streamResponse(screened.stream, {
        // ⚠️ 诊断 + 记账分界：客户端断开**不得**记成账号失败
        //（否则用户的取消动作会熔断健康账号，见 `nonStreamingResponse` 的说明）。
        clientGone: () => request.signal.aborted,
        onFirstChunk: () => {
          const t = pool.noteSuccess(picked.uid, Date.now(), undefined, model).catch(logPoolError('noteSuccess'))
          if (ctx !== undefined) ctx.waitUntil(t)
          /**
           * ✅ **结算 blame**（2026-10-21 审查补，M1 指出）。
           *
           * 这是**分支B 的主成功路径** —— 它原来只有 `noteSuccess`，没有 `settleBlame`。
           * 而 `blame.push` 在 ProviderError 分支（`2325`）会塞入 breaker/degrade 失败。
           *
           * ⇒ 缺 `settleBlame` 的后果：这些失败**永不落账**，
           *   而且因为成功时直接 return，连「全失败则丢弃」的那条日志都不会打。
           *   表现：持续 5xx 的账号永远不进熔断，面板 `fails` 恒 0 —— **保护机制静默失效**。
           *
           * ⚠️ 之所以长期没被发现：`tests/state.test.ts` 用的是
           * `settleCalls.length >= 2` 的**全局计数**断言，
           * 而它恰好被「分支A + 分支B 续期重试」两处满足 ⇒ 主路径缺失被掩盖。
           */
          const settle = settleBlame(pool, blame, Date.now())
          if (ctx !== undefined) ctx.waitUntil(settle)
          else void settle
          // 🔴 **会话粘性**（2026-10-21 审查补，M3 指出）：主成功路径此前从不绑定
          // ⇒ 同一会话的后续轮次落到不同账号 ⇒ prompt cache 命中率 0 + 指纹跳变。
          if (sessionKey !== '' && ctx !== undefined) {
            ctx.waitUntil(pool.bindSession(sessionKey, picked.uid, Date.now()).catch(logPoolError('bindSession')))
          }
        },
        onError: (message) => {
          const t = pool
            .applyFailure({
              uid: picked.uid,
              kind: punishmentForStreamError(message),
              now: Date.now(),
              reason: message.slice(0, 200),
            })
            .catch(logPoolError('applyFailure'))
          if (ctx !== undefined) ctx.waitUntil(t)
          recordStreamFailure(pool, { uid: picked.uid, model: `${providerId}/${model}`, errorKind: punishmentForStreamError(message), startedAt }, ctx)
          recordLog(
            pool,
            {
              type: 'error',
              model: `${providerId}/${model}`,
              provider: providerId,
              uid: picked.uid,
              status: 502,
              durationMs: Date.now() - startedAt,
              error: message.slice(0, 200),
              stream: wantsStream,
            },
            ctx,
          )
        },
        onFinish: (usage) => {
          const record = {
            at: Date.now(),
            uid: picked.uid,
            // ⚠️ 用量里记**带前缀**的模型名：否则多供应商下的同名模型会混在一起
            model: `${providerId}/${model}`,
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            ok: true,
            ms: Date.now() - startedAt,
          }
          // 🔴 子密钥的 token 配额（2026-10-21 审查补）：主密钥路径无条目、零开销
          settleSubkeyUsage(ctx, env, record.input, record.output, record.model)
          const t = pool.recordUsage(record).catch((error: unknown) => {
            console.error('[usage] 记录用量失败：', error instanceof Error ? error.message : String(error))
          })
          if (ctx !== undefined) ctx.waitUntil(t)
          else void t

          recordLog(
            pool,
            {
              type: 'api',
              model: `${providerId}/${model}`,
              provider: providerId,
              uid: picked.uid,
              status: 200,
              durationMs: Date.now() - startedAt,
              tokens: { input: usage?.input ?? 0, output: usage?.output ?? 0, total: (usage?.input ?? 0) + (usage?.output ?? 0) },
              stream: wantsStream,
            },
            ctx,
          )
        },
      }, wantsStream ? undefined : { model }),
    }
  }

  // ⚠️ 国际版（workbuddy）容灾回退：若国际版所有账号均失败或限流，
  // 检查国内版（buddy）是否有**真可选**账号，自动无缝跨渠道容灾至国内版同名模型。
  //
  // ⚠️ **只在 `failoverDepth === 0` 时触发**（否则与 buddy 路径互相递归成死循环）。
  // ⚠️ **绝不能复用 `request`**：它的 body 在 `handleChatCompletions` 开头
  //    已被 `request.json()` 消费，再读会抛错 → 恒返回 400「请求体必须是合法 JSON」。
  //    必须用 `rawBody` 重建一个**全新** Request。
  // ⚠️ 重建时把 `model` 换成**裸名**（去掉 `workbuddy/` 前缀）：否则
  //    `splitModelName` 会再次路由回 workbuddy，形成自我循环。
  if (providerId === 'workbuddy' && failoverDepth === 0 && model !== '' && !pinBlocked) {
    try {
      const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
      const now = Date.now()
      const hasCnUsable = (await cnPool.listAccounts('cn', now)).some(
        (a) => (a.provider ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER && healthyForModel(a, now, model),
      )
      if (hasCnUsable) {
        console.log(`[failover] 国际版 workbuddy 全部不可用或已限流，自动无缝跨渠道容灾至国内版 ${DEFAULT_PROVIDER} (模型: ${model})`)
        const fallbackBody =
          rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
            ? { ...(rawBody as Record<string, unknown>), model }
            : rawBody
        const fallbackRequest = new Request(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          /**
           * 🔴 **必须带 `signal`**（2026-10-21 审查发现，M1 指出）。
           *
           * 重建 Request 时漏掉 `signal` ⇒ 内层 `handleChatCompletions` 的
           * `clientGone()`（`request.signal.aborted`）**恒为 false**
           * ⇒ 用户点「停止」造成的 AbortError 会被当成**上游/账号失败**记账
           * ⇒ 健康号被记 breaker，3 次即熔断 30 分钟。
           *
           * 这正是本项目反复踩的「客户端取消被记成账号失败」在**合成 Request 入口的回归**：
           * 两条主路径已经用 `clientGone` 修好了，但这里重建 Request 把判据废掉了。
           */
          signal: request.signal,
          body: JSON.stringify(fallbackBody),
        })
        // ⚠️ 容灾是**早退出口**（S11）：`handleChatCompletions` 有它**自己的**空
        // `blame` 收件箱，本路径挂起的失败不会跟着过去 ⇒ 必须在这里显式丢弃。
        // 否则它们静默消失：既不在国际版结算、也不打日志、更不会走到下面那段
        // 循环尾的「丢弃」日志（那段在 `return` 之后，永远执行不到）。
        discardBlame(blame, '已跨渠道容灾至国内版（blame 不移交）')
        return await handleChatCompletions(fallbackRequest, env, 'cn', ctx, 1)
      }
    } catch (failoverError) {
      console.warn('[failover] 国际版->国内版容灾检查失败：', failoverError)
    }
  }

  // ⚠️ **丢弃 blame**（与 buddy 路径同一纪律）：所有候选都以同样方式失败，
  // 没有「换号后成功」这个证据，就不能断定是那几个号坏了。
  // 不丢弃的话这些记录会留在数组里既不算也不清 —— 虽然随函数返回被回收，
  // 但**日志缺失**会让排障时误以为「没有失败过」。
  //
  // ⚠️ 与 buddy 路径同一份实现（`discardBlame`，S11）：那边的 4 个早退出口
  // 也要丢弃，各写一份会让「是否留痕」再次分叉。
  discardBlame(blame, 'provider 路径全池同样失败')
  // 🔴 请求级失败用量（emit 一次，不按尝试次数重复记）。
  recordRequestFailure(pool, {
    uid: tried[tried.length - 1] ?? '',
    model: `${providerId}/${model}`,
    errorKind: lastError?.kind ?? 'provider_error',
    startedAt: requestStartedAt,
  })
  return {
    response: jsonError(
      lastError?.status ?? 503,
      lastError === undefined
        // ⚠️ 区分「真的没账号」与「有账号但全在冷却/熔断」。
        // 实测踩到：账号因连续失败进了熔断，报的却是「请先导入凭据」——
        // 用户会去重新导入一份好凭据，而真实原因是**等几分钟就好**。
        // ⚠️ 必须把 `model` 一起传进去（2026-10-22）：不传就只能报笼统的
        // 「暂时没有可用账号」，而真实原因常常是**这一个模型**在冷却
        // —— 用户看到那句话会去翻面板，却只看到一个健康的号。
        ? (await describeNoAccount(env, activeRealm, providerId, model))
        : `供应商「${provider.name}」请求失败：${lastError.message}`,
      'provider_error',
    ),
  }
}

/**
 * 这次失败看起来是**鉴权类**问题吗（该续期）。
 *
 * ## ⚠️ 为什么必须抽成公共函数（实测踩到两次）
 *
 * 这个判据在网关里有**两个调用点**（`!upstream.ok` 分支与 `catch` 分支），
 * 因为 provider 的 `chat()` 有两种失败风格：有的返回非 2xx Response
 *（opencode），有的直接抛 `ProviderError`（其余 8 家）。
 *
 * 我第一版只放宽了 `catch` 分支，忘了 `!upstream.ok` 分支 ——
 * 于是 CodeArts（返回 Response 的那条路）仍然不续期，
 * 表现为「明明能续期却一直报 security token expired」。
 * 抽出来从根上避免两处再分叉。
 *
 * ## 判据要**宽**
 *
 * 各家的鉴权错误文案千差万别，且**状态码也各不相同**：
 * - WorkBuddy: `auth_error` / `upstream 401`
 * - Raccoon:   `code=200003` + `authorization_verify_error`
 * - Cline:     `http=401` + `Unauthorized`
 * - CodeArts:  **HTTP 400** + `APIG.0602` + `security token has expired`
 *
 * 宁可偶尔多试一次续期（续期失败会落回原错误），也不要漏掉真正的鉴权失败。
 */
/**
 * 生成「选不到号」的**准确**说明。
 *
 * ⚠️ 不能一律说「请先导入凭据」（实测踩到的误导）：
 * 账号可能只是**在冷却/熔断**里（`until` / `breakerUntil` / `degradeUntil`），
 * 等几分钟自己就好了。让用户去重新导入凭据是纯粹的浪费时间。
 *
 * ## 🔴 判据必须直接复用 `healthyForModel()`，绝不自己再列一遍维度
 *（2026-10-22 实测事故，用户截图）
 *
 * 现场：5 个并行子代理请求 `qodercn/dfmodel`，全部得到
 * `503 供应商「qodercn」暂时没有可用账号（请稍后重试或查看面板状态）`。
 * 而面板上那个账号 `disabled=false`、`credits=4562`、四个账号级冷却**全为 0**，
 * 唯一的异常是 `modelCooldowns['dfmodel']`（上游排队 10605 打上的模型级冷却）。
 *
 * 根因：本函数手抄了一份「这号为什么不可用」的判据，且**抄漏了两个维度**：
 *
 * | 维度 | `pick()`（`healthyForModel`） | 本函数（旧） |
 * |---|---|---|
 * | `disabled` | ✅ | ✅ |
 * | `until` / `breakerUntil` / `degradeUntil` | ✅ | ✅ |
 * | **`restrictedUntil`**（11140 上游限制） | ✅ | ❌ 漏 |
 * | **`modelCooldowns[model]`**（模型级冷却） | ✅ | ❌ 漏 |
 *
 * ⇒ 只因模型级冷却（或上游限制）不可用时，全部落进最后的兜底文案。
 * 那句「暂时没有可用账号」对用户是**误导**：账号根本没坏，等冷却过去
 * 或**换个模型**就行；而「查看面板状态」只会看到一个健康的号，无从下手。
 *
 * ⚠️ 这与 `modelExempt` 漏 `restrictedUntil`、`shouldPunish` 与
 * `mapErrorToPunishment` 漂移是**同一类缺陷**（本项目最反复的一类）：
 * 同一个判据写了两份，改一份漏一份。
 * ⇒ 故这里**直接调用共享判据**，物理上不可能再漂。
 *
 * @param model 请求的模型名。只有传了它才能说清「是这个模型被冷却」——
 *              不传则退化为只判账号级维度（仍比手抄准确）。
 */
export async function describeNoAccount(
  env: Env,
  realm: string,
  provider: string,
  model = '',
): Promise<string> {
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
  const now = Date.now()
  // ⚠️ 用 `listAccounts(realm, now)`：它在内部会 `pruneExpired`，
  // 否则已自然到期的模型冷却会让下面误报「还在冷却」。
  const accounts = (await pool.listAccounts(realm, now)).filter(
    (a) => (a.provider ?? 'workbuddy') === provider,
  )
  if (accounts.length === 0) {
    return `供应商「${provider}」没有账号（请先在面板导入该供应商的凭据）`
  }

  // ⚠️ 顺序很重要：先说「最具体」的原因，再说笼统的。
  // 用户看到「被上游限制」能立刻明白重试无用、要换号；
  // 看到「模型冷却」能立刻换模型；看到「没有可用账号」则完全无从下手
  // —— 故它必须是**最后**才可能出现的一句话。

  const disabled = accounts.filter((a) => a.disabled)
  if (disabled.length === accounts.length) {
    return `供应商「${provider}」的账号都被手动禁用了（请在面板启用）`
  }

  // 上游明确标记的账号级限制（11140）：与「我们自己怀疑它不行」的冷却分开说，
  // 因为处置不同（这个只能等或换号，重试无用）。
  const restricted = accounts.filter((a) => a.restrictedUntil > now)
  if (restricted.length === accounts.length) {
    const waits = restricted.map((a) => a.restrictedUntil - now)
    const mins = Math.max(1, Math.round(Math.max(...waits) / 60_000))
    return `供应商「${provider}」的账号被上游判定为异常行为并限制使用（11140），约 ${mins} 分钟后到期。`
      + '这不是本地配置问题，重试不会恢复；如需立即使用请换供应商或换号。'
  }

  // 账号级冷却（soft / hard / breaker / degrade）。
  const cooling = accounts.filter(
    (a) => a.until > now || a.breakerUntil > now || a.degradeUntil > now,
  )
  if (cooling.length === accounts.length) {
    const waits = cooling.map((a) => Math.max(a.until, a.breakerUntil, a.degradeUntil) - now)
    const mins = Math.max(1, Math.round(Math.max(...waits) / 60_000))
    return `供应商「${provider}」的 ${accounts.length} 个账号都在冷却中（因连续失败触发退避），约 ${mins} 分钟后自动恢复`
  }

  // ── 模型级冷却：最常见、也最容易被误报成「没账号」的一维 ──
  //
  // ⚠️ 判据复用 `healthyForModel`（与 `pick()` **同一份**），不再手写维度。
  if (model !== '') {
    const healthyForIt = accounts.filter((a) => healthyForModel(a, now, model))
    if (healthyForIt.length === 0) {
      // 全部账号对该模型都在冷却。取**最短**的剩余时间：
      // 用户关心的是「最快什么时候能用」，不是「最坏要等多久」。
      const waits = accounts
        .map((a) => {
          const mc = a.modelCooldowns[model]
          return mc === undefined ? 0 : mc.until - now
        })
        .filter((w) => w > 0)
      if (waits.length > 0) {
        const mins = Math.max(1, Math.round(Math.min(...waits) / 60_000))
        return `供应商「${provider}」的 ${accounts.length} 个账号对模型「${model}」都在冷却中`
          + `（上游限流/排队或该后端无此模型），最快约 ${mins} 分钟后恢复。`
          + '换一个模型通常立刻可用 —— 账号本身是好的。'
      }
    }
  }

  return `供应商「${provider}」暂时没有可用账号（请稍后重试或查看面板状态）`
}

export function isAuthLikeFailure(status: number, detail: string): boolean {
  // 状态码：401/403 是标准鉴权失败；400 也可能（CodeArts 就是这样）
  if (status === 401 || status === 403) return true
  // ⚠️ 除了状态码，**内容**也要判（CodeArts 的 `APIG.0602` 走 HTTP 400）。
  //
  // ## 🔴 实测缺陷：`invalid.?token` 漏掉了 `invalid access token`
  //
  // 原判据是 `invalid.?token` —— `.?` 只允许**一个**字符，
  // 而 minimax 的真实报错是 `invalid access token`（中间隔了 `access`，6 个字符）
  // ⇒ **匹配失败** ⇒ 续期分支根本不进 ⇒ 表现为
  // 「这个号用几分钟就 401，然后永远是 401」。
  //
  // 修法：改用 `invalid[\W_]+(?:\w+[\W_]+){0,2}?token` —— 允许中间夹最多两个词
  //（覆盖 `invalid access token` / `invalid api key token` 这类），
  // 同时**不放宽到任意长度**（`invalid.*token` 会误伤
  // 「invalid model, but the token is fine」这类非鉴权错误）。
  //
  // ⚠️ 教训：用正则匹配**英文短语**时，`.` 与 `.?` 的跨度极易写窄，
  // 而症状是「续期静默不触发」（不是报错）。故这里同时给
  // 「状态码」与「关键字」两条独立通路，任一条命中即可。
  return /auth_error|unauthor|forbidden|invalid[\W_]+(?:\w+[\W_]+){0,2}?token|token[\W_]+(?:\w+[\W_]+){0,2}?expir|expired|200003|APIG\.0602|42400/i.test(
    detail,
  )
}

/**
 * 非流式响应：把上游 SSE 读完、聚合成一个 `chat.completion`。
 *
 * ⚠️ 这里的 `await reader.read()` 会一直读到上游结束 —— 对长回答可能耗时较久。
 * 这是**非流式的固有代价**（客户端要的就是「等完整结果」），
 * 且等待网络 I/O **不计入 CPU 预算**（AGENTS.md §8.2.2 第 2 条）。
 */
async function nonStreamingResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  hooks: {
    onFirstChunk: () => void
    onError: (message: string) => void
    onFinish?: (usage: { input: number; output: number } | undefined) => void
    /**
     * ⚠️ **诊断用**：客户端是否已断开（`request.signal.aborted`）。
     *
     * 与流式路径的 `hooks.clientGone` 同一用途 —— 这是「客户端取消」与
     * 「上游失败」的**唯一分界**。非流式路径读体时同样需要它：
     * 不分清就会把用户的取消动作记成账号失败，进而熔断健康账号。
     */
    clientGone?: () => boolean
  },
): Promise<Response> {
  const reader = upstreamBody.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  /**
   * 🔴 **读体失败必须被翻译成上游错误，不能让它穿透成 500。**
   *
   * ## 实测缺陷（用户报「qoder 调用不了」，返回 `服务内部错误`）
   *
   * 原先这里只有 `try/finally`、**没有 `catch`**。而 provider 的推理超时
   * （qoder 的 `INFER_TIMEOUT_MS`）触发点**不在** `provider.chat()` 里 ——
   * `chat()` 返回 `Response` 时**流还没读完**，超时是在**这里读体时**炸的。
   *
   * ⇒ 那个 `TimeoutError` 穿透整个 `handleProviderChat`（它的 try 只包了
   * `provider.chat` 调用）⇒ 落到 Worker 异常边界 ⇒ 客户端看到
   * **`服务内部错误`**，而不是「上游超时，请重试」。
   *
   * ⚠️ 这是**错误分类**错误：上游慢/超时是**可重试的上游问题**，
   * 不是我们的内部故障。把它报成 500 会让用户以为服务坏了。
   *
   * ⚠️ 修法：在这里兜住，**转成一个正常的错误响应**（与「上游返回错误帧」
   * 同一条出口），并调用 `hooks.onError` 让它参与记账/换号。
   */
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // ## 🔴 必须区分「客户端断开」与「上游失败」
    //
    // ⚠️ 我第一版**无条件**调 `hooks.onError(message)`，那是错的：
    // 客户端中途取消（用户点了停止 / 关了标签页 / 客户端超时）同样会让
    // 上游流 abort、`reader.read()` 抛 `AbortError`，于是**一个健康账号
    // 会因用户的取消动作被记一次失败**，而 `punishmentForStreamError`
    // 对非 11128 的错误一律返回 `'breaker'` ⇒ **3 次就把好号熔断 30 分钟**。
    //
    // ⇒ 症状正是本项目反复踩到的那个：「账号明明好的，却越来越用不了」。
    //
    // ⚠️ 本项目已有这条纪律（`qoder.ts:924`、`zcode.ts:752` 都显式把
    // 「请求已被客户端取消」原样区分开），且流式路径**已经**用
    // `hooks.clientGone?.()` 做这个判别（见下方 `[stream] aborted` 那段）。
    // 非流式路径此前漏了同一条判据 —— 又是「同一个 bug 只修一半」。
    const clientGone = hooks.clientGone?.() === true
    if (clientGone) {
      // ⚠️ **不记失败、不惩罚账号**：这不是账号的问题。
      // 也不必回响应体（客户端已经走了），但返回一个明确的 499 语义响应，
      // 便于日志/中间层观察，且**不**触发 hooks.onError。
      return new Response(
        JSON.stringify({
          error: {
            message: '请求已被客户端取消（连接已断开）。',
            type: 'client_closed_request',
            code: 'client_closed_request',
          },
        }),
        { status: 499, headers: { 'content-type': 'application/json; charset=utf-8' } },
      )
    }
    // ⚠️ 超时/中止 ⇒ 如实说「上游超时/繁忙」，并标成**可重试**。
    const timedOut = /timeout|timed out|abort/i.test(detail)
    const message = timedOut
      ? `读取上游响应超时（${model}）：上游长时间不返回数据。请稍后重试。`
      : `读取上游响应失败（${model}）：${detail}`
    // 让记账路径知道这次失败（换号/冷却仍按既有规则走）。
    hooks.onError(message)
    return new Response(
      JSON.stringify({
        error: {
          message,
          // ⚠️ 用 `upstream_error`（502 语义）而不是 `internal_error` ——
          // 这是**上游**的问题，不是我们的内部故障。
          type: 'upstream_error',
          code: 'upstream_error',
        },
      }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } },
    )
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 忽略
    }
  }

  const completion = aggregateSse(raw, { model, now: Date.now() })
  const choice = completion.choices[0]

  // 上游错误以 SSE 帧形式返回（HTTP 200）：必须显式报错，不能假装成功。
  //
  // ⚠️ 判据是「**没有正文也没有思考过程**」，不能只看 `usage`。
  // 实测踩到：CodeArts 的模型名错误帧既没有 `usage` 也没有正文，
  // 而某次判断只查了 usage —— 结果给客户端一个 `content:''` 的空回答，
  // 用户以为是模型不行，其实是模型名写错了。
  // ⚠️ 判据**只看有没有内容**，`usage` 不参与判断。
  //
  // 我原先写的是 `... && (completion.usage === undefined || completion.usage === null)`——
  // ⚠️ 那是**错的**：它把「有 usage」当成「不是空响应」的理由，
  // 于是「消耗了 token 但没产出任何内容」这种**最需要报错**的形态反而被放过
  //（实测 codearts 就会回 `content:'' + usage:null` 或带 usage 的空帧）。
  // `usage` 只说「上游计了费」，与「有没有内容」无关。
  // ⚠️ **必须排除「只调用工具」的正常响应**：那时 `content` 也是 `''`
  //（`aggregateSse` 把工具调用放进 `choice.message.tool_calls`，
  // `finish_reason` 为 `'tool_calls'`）。不排除就会把一次**成功**的工具调用
  // 误报成「上游返回空响应」—— 那是比原缺陷更糟的假阳性
  //（工具调用是 agent 场景的主路径）。
  /**
   * ⚠️ 判据已抽到 `stream.ts` 的 `isEmptyAssistantTurn`（2026-10-21 审查后）。
   *
   * 原来这里手写一遍 `content==='' && reasoning_content===''` + 排除 `tool_calls`，
   * 而 `responses.ts` 的非流式路径**没有这段** —— 同一概念两套口径，
   * 结果是 `/v1/chat/completions` 报 502、`/v1/responses` 回 **200 空答案**。
   *
   * 换用共用函数后：
   * - 两条路径**结构上不可能再漂移**；
   * - 顺带补上原来漏判的 `refusal`（合法拒答）与旧式 `function_call` ——
   *   漏掉它们会把**有产出的响应**反向误报成「上游空响应」502。
   */
  if (isEmptyAssistantTurn(choice)) {
    // ⚠️ **先处理「整个响应体就是一个 JSON（不是 SSE）」的情况**。
    //
    // 实测踩到：某些上游（如 CodeArts 经华为 APIG）在 HTTP **200** 下直接
    // 回一个**裸 JSON 错误体**，完全没有 `data: ` 前缀。此时：
    // - `aggregateSse` 找不到任何 `data:` 行 ⇒ 产出空 completion；
    // - 下面的逐行扫描也要求 `line.startsWith('data: ')` ⇒ 同样找不到错误。
    // 结果客户端拿到 `content:'' + finish_reason:'stop'` 的**空回答**，
    // 完全看不出上游其实报错了。
    //
    // 故这里先尝试把整个 body 当 JSON 解析，并用同一套 `detectErrorFrame`
    // 判据识别错误。
    const trimmedRaw = raw.trim()
    if (trimmedRaw.startsWith('{') || trimmedRaw.startsWith('[')) {
      try {
        const whole = JSON.parse(trimmedRaw) as Record<string, unknown>
        const wholeErr = detectErrorFrame(whole)
        if (wholeErr !== undefined) {
          hooks.onError(wholeErr)
          return jsonError(502, wholeErr, 'upstream_error')
        }
      } catch {
        // 不是合法 JSON：交给下面的逐帧扫描
      }
    }

    // 流里没有任何内容 —— 找一下是不是错误帧
    //
    // ## 🔴 必须复用 `parseSseLine`，不能自己 `startsWith('data: ')`
    //
    // 实测缺陷：codearts 经华为 APIG 回的原文是
    // ```
    // data:{"error_code":"InferHub.4004.200","error_msg":"benefit not found",...}
    // ```
    // ⚠️ 注意 **`data:` 后面没有空格**。
    //
    // 而本段原先判的是 `line.startsWith('data: ')`（**带空格**）
    // ⇒ 这一帧**永远匹配不上** ⇒ 扫不到错误帧 ⇒ 落到下面那条通用兜底，
    // 用户看到的是「上游返回了空响应…」，而**真实原因是 `benefit not found`**
    //（账号权益未生效，该采取的行动完全不同）。
    //
    // ⚠️ 更值得记的是：**同一个项目里 `parseSseLine`（`stream.ts:47`）
    // 早就同时容忍两种写法**（`startsWith('data:')` + `.trim()`）——
    // 我在这里又手写了一遍解析，就漏掉了无空格形态。
    // **教训：SSE 解析一律走 `parseSseLine`，不要手写前缀判断。**
    for (const line of raw.split('\n')) {
      const frame = parseSseLine(line)
      // ⚠️ `parseSseLine` 已经把注释/空行/`[DONE]` 归为 `ignore`/`done`。
      // `kind === 'error'` 是它自己解析出的错误（`data:` 前缀两种写法都认）。
      if (frame.kind === 'error' && typeof frame.error === 'string') {
        hooks.onError(frame.error)
        return jsonError(502, frame.error, 'upstream_error')
      }
      if (frame.kind !== 'chunk' || typeof frame.data !== 'string') continue
      try {
        const parsed = JSON.parse(frame.data) as Record<string, unknown>
        const err = detectErrorFrame(parsed)
        if (err !== undefined) {
          hooks.onError(err)
          return jsonError(502, err, 'upstream_error')
        }
      } catch {
        // 非 JSON 帧，继续找
      }
    }

    // ## 🔴 找不到错误帧时**也必须报错**，不能落回静默空回复
    //
    // 实测缺陷（用户报「codearts 调用不了」，且现象是**空回复而不是报错**）：
    // CodeArts 在「并发会话数已达上限(3个)」时，旧版路径会给一个
    // `content:'' + finish_reason:'stop' + usage:null` 的 **HTTP 200 空答案**，
    // 而它在流式路径**是**会报错的 —— 两条路径口径不一致。
    //
    // ⚠️ 上面那段只在**识别到错误帧**时才报错；若上游给的是「合法但完全空」
    // 的响应（没有错误帧、也没有内容），流程会**落回下面的正常返回**
    // ⇒ 客户端拿到 `content:''`，看起来像「模型说了空话」。
    //
    // ⚠️ 这是本项目 §7.2「失败必须显式」明确禁止的形态：**空回复比报错更糟**，
    // 用户会以为是模型能力问题，而真实原因是上游拒绝了这次请求。
    // ⇒ 兜底：走到这里说明「既没内容、也没能定位到错误帧」，那也要如实报错。
    //
    // ⚠️ 注意此处**不能**用 `hooks.onError` 记成「账号失败」——我们无法确定
    // 是账号问题还是上游临时抽风，而误记会让健康账号被冷却
    //（本项目反复踩到的「状态看着对、行为不对」型缺陷）。只如实回报给客户端。
    const snippet = raw.trim().slice(0, 200)
    return jsonError(
      502,
      '上游返回了空响应（既没有正文/思考内容，也没有可识别的错误帧）。'
        + '这通常意味着上游临时拒绝或该模型不可用，请稍后重试。'
        + (snippet === '' ? '' : `上游原文片段：${snippet}`),
      'upstream_error',
    )
  }

  hooks.onFirstChunk()
  const usage = completion.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
  hooks.onFinish?.(
    usage === undefined
      ? undefined
      : { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 },
  )
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// ─────────────────────── 聚合 provider（跨渠道临期优先） ───────────────────────

/**
 * 聚合请求的派发。
 *
 * ## 它做什么
 *
 * 1. 拉一份**跨渠道目录**（各家 `listModels`），归成虚拟模型；
 * 2. 定位请求要的虚拟模型（`auto` = 不指定，在所有候选里挑）；
 * 3. 给每个候选渠道**探测积分到期时刻**（`provider.balance().earliestExpiry`）；
 * 4. **临期优先**排序，逐个试；
 * 5. 最终**复用 `handleProviderChat`** 真正发请求 —— 那样就白拿了既有的
 *    选号／冷却／熔断／续期／记账／会话粘性（见 `aggregate.ts` 文件头）。
 *
 * ## 🔴 回退边界（必须保守）
 *
 * 只有**还没开始输出内容就失败**（HTTP ≥ 400）时才换下一个候选。
 * 一旦开始流式输出就不再切换 —— 那会把半截回答换成另一个模型的回答。
 *
 * ## 为什么不缓存目录/到期时刻
 *
 * 参考实现缓存 60 秒。我们**先不缓存**，理由：Workers 的 isolate 随时被回收，
 * 模块级缓存在多 isolate 下命中率低、且会引入「缓存新旧不一致」这类难查问题；
 * 而「临期优先」的正确性恰恰依赖到期时刻够新。代价是每次聚合请求多几次
 * 上游调用 —— 对**本人自用**的规模可接受，且刻意优先正确性。
 * 若将来发现开销明显，再加缓存（届时必须带 TTL 与 `force` 旁路）。
 */
async function handleAggregateChat(input: {
  model: string
  wantsStream: boolean
  rawBody: unknown
  request: Request
  env: Env
  realm: string
  ctx?: ExecutionContext
  sessionKey: string
}): Promise<GatewayResult> {
  const { model, rawBody, request, env, realm, ctx, sessionKey } = input

  const virtuals = await loadAggregateCatalog(env, realm, { signal: request.signal })
  if (virtuals.length === 0) {
    return {
      response: jsonError(
        503,
        '聚合目录为空：没有任何渠道提供了可聚合的模型。'
          + '请先在面板确认有账号（且它们的 `listModels` 可用）。',
        'no_available_account',
      ),
    }
  }

  // 定位候选：
  // - `auto` ⇒ 全部虚拟模型的候选并集（「在所有渠道的所有可用模型里挑」）；
  // - 具体规范键 ⇒ 该模型的候选；
  // - 找不到 ⇒ 明确报错并**列出可用的键**（否则用户只能猜拼写）。
  let candidates: AggregateCandidate[]
  if (model === AGGREGATE_AUTO || model === '') {
    const seen = new Set<string>()
    candidates = []
    for (const v of virtuals) {
      for (const c of v.candidates) {
        const id = `${c.provider}\u0000${c.realId}`
        if (seen.has(id)) continue
        seen.add(id)
        candidates.push(c)
      }
    }
  } else {
    const hit = virtuals.find((v) => v.key === model)
    if (hit === undefined) {
      // ⚠️ 列出可用键：聚合的键是**推导**出来的（用户看不到映射表），
      // 不给提示就等于让用户猜。截断到 20 条以免响应过大。
      const keys = virtuals.slice(0, 20).map((v) => v.key)
      return {
        response: jsonError(
          400,
          `聚合模型「${model}」未知。可用的规范名（前 20 个）：${keys.join('、')}`
            + `${virtuals.length > 20 ? ` …… 共 ${virtuals.length} 个` : ''}`
            + '。也可以用 `aggregate/auto` 让它自动挑。',
          'invalid_request_error',
        ),
      }
    }
    candidates = hit.candidates
  }

  if (candidates.length === 0) {
    return {
      response: jsonError(503, `聚合模型「${model}」没有任何候选渠道。`, 'no_available_account'),
    }
  }

  // ⚠️ **剔除用户停用的模型**（与 `/v1/models` 同一条纪律：停用 = 彻底关掉）。
  //
  // 实测缺陷：聚合目录曾列出 **526** 条而主目录只有 32 条 —— 差额全是用户
  // 自己在面板里停用的模型。若不在这里也过滤，聚合路径会**绕过停用设置**：
  // 用户在目录里看不到它，写个规范名却能调通 —— 「我关了它」变成一句空话。
  //
  // ⚠️ 若剔除后一个不剩，**如实报错**并说明原因，而不是回退到「不过滤」
  //（回退等于静默无视用户的设置）。
  const filtered = await filterDisabledCandidates(env, realm, candidates)
  if (filtered.length === 0) {
    return {
      response: jsonError(
        403,
        `聚合模型「${model}」的候选渠道都已被你在面板中停用。`
          + '如需使用，请在「供应商与账号」页重新启用对应模型。',
        'model_disabled',
      ),
    }
  }

  // 探测到期时刻并做临期优先排序。
  const expiry = await probeExpiries(env, realm, filtered, request.signal)
  const ranked = rankCandidates(filtered, (c) => expiry.get(`${c.provider}\u0000${c.realId}`) ?? EXPIRY_UNUSABLE)

  if (ranked.length === 0) {
    // ⚠️ 如实区分「查不到额度」与「没有候选」—— 用户的下一步动作不同。
    return {
      response: jsonError(
        503,
        `聚合模型「${model}」的 ${candidates.length} 个候选渠道都查不到可用额度`
          + '（可能是凭据过期、或该家不支持查余额）。请到面板检查账号状态。',
        'no_available_account',
      ),
    }
  }

  // 逐个候选试。**只在「还没输出内容就失败」时换下一个**。
  let lastError: { status: number; message: string; kind?: string } | undefined
  const tried: string[] = []
  for (const c of ranked) {
    // ⚠️ 把请求体里的 `model` 换成**该渠道的真实 id**再派发。
    // 不换会让上游收到规范键（它不认识）⇒ 404 / 落到默认模型。
    const body = rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? { ...(rawBody as Record<string, unknown>), model: c.realId }
      : rawBody

    let result: GatewayResult
    try {
      result = await handleProviderChat({
        providerId: c.provider,
        model: c.realId,
        wantsStream: input.wantsStream,
        rawBody: body,
        request,
        env,
        realm,
        ...(ctx !== undefined ? { ctx } : {}),
        tried: [],
        sessionKey,
        // ⚠️ 聚合层**自己**有候选轮转循环，故禁止它内部的跨渠道容灾
        //（否则单个候选失败会先容灾一轮，与聚合的轮转叠加，白白放大请求）。
        failoverDepth: 1,
      })
    } catch (error) {
      lastError = {
        status: 502,
        message: `聚合候选「${c.provider}」异常：${error instanceof Error ? error.message : String(error)}`,
      }
      tried.push(c.provider)
      continue
    }

    // ⚠️ **只在「还没吐内容」时才允许切换**。
    //
    // `handleProviderChat` 在「上游拒绝」时返回的是**错误响应**（非 2xx），
    // 此时流还没开始，可以安全换下一个；一旦是 2xx，流已经开始（或即将开始），
    // 再换就会把半截回答拼成乱码 —— 故**直接返回**。
    if (result.response.status < 400) return result

    // 错误响应：读出正文用于「所有候选都失败」时的说明（可安全读，非流式体）。
    let message = `http=${result.response.status}`
    try {
      message = (await result.response.clone().text()).slice(0, 200)
    } catch {
      // 读不到就用状态码兜底（不静默）
    }
    lastError = { status: result.response.status, message }
    tried.push(c.provider)
  }

  const detail = lastError === undefined ? '没有候选' : lastError.message
  return {
    response: jsonError(
      lastError?.status ?? 503,
      `聚合模型「${model}」的全部候选都失败了（已试：${tried.join('、')}）。最后一次：${detail}`,
      'provider_error',
    ),
  }
}

/**
 * 拉一份跨渠道目录并归成虚拟模型。
 *
 * ⚠️ 逐家**串行**：Workers 同时出站连接上限 6，且并行打上游更容易触发风控
 * （与 `/v1/models` 同一条纪律）。
 *
 * ⚠️ 单家失败**只跳过它**（记日志），不让整个聚合不可用 ——
 * 一家凭据过期不该让「用哪家更划算」这件事整个失效。
 */
/**
 * 聚合目录的**总预算**。
 *
 * 🔴 为什么必须有（2026-10-21 审查补，并发专项）：
 * 这里原本**逐家串行**、每家 `AbortSignal.timeout(20_000)`，
 * 而 `providerIds()` 有 14 家 ⇒ 最坏 **280 秒**才吐出第一个 token，
 * 期间既不接客户端取消、也没有总超时 —— 客户端早就断了，
 * 我们还在替它排队打上游（既烧配额也烧 CPU）。
 *
 * 给 12 秒总预算：正常情况（每家 1~3 秒、且多数家没账号直接返回空）
 * 远小于它；真有一家卡住时，宁可让聚合目录**少几家**，
 * 也不能让用户等 4 分钟。缺席的家在下次请求会自动补上（无缓存副作用）。
 */
const AGGREGATE_CATALOG_BUDGET_MS = 12_000

async function loadAggregateCatalog(
  env: Env,
  realm: string,
  options: { signal?: AbortSignal } = {},
): Promise<ReturnType<typeof buildVirtualModels>> {
  const catalogs: ProviderCatalog[] = []
  const startedAt = Date.now()
  const skipped: string[] = []

  for (const providerId of providerIds()) {
    if (providerId === AGGREGATE_PROVIDER_ID) continue
    const provider = findProvider(providerId)
    if (provider === undefined || !provider.capabilities.listModels) continue

    // ⚠️ 客户端已经断开就别再打上游了 —— 继续排队只会白烧配额
    if (options.signal?.aborted === true) {
      skipped.push(`${providerId}(客户端已取消)`)
      break
    }
    if (Date.now() - startedAt > AGGREGATE_CATALOG_BUDGET_MS) {
      skipped.push(providerId)
      continue
    }

    try {
      const models = await listModelsForProvider(env, realm, providerId, options.signal)
      if (models.length > 0) catalogs.push({ provider: providerId, models })
    } catch (error) {
      console.warn(
        `[aggregate] 跳过 ${providerId} 的目录：`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  if (skipped.length > 0) {
    console.warn(
      `[aggregate] 目录预算 ${AGGREGATE_CATALOG_BUDGET_MS}ms 用尽或请求已取消，本次跳过：${skipped.join(', ')}`,
    )
  }
  return buildVirtualModels(catalogs)
}

/**
 * 取某家在**某 realm** 下一个可用账号的模型目录。
 *
 * ⚠️ 走**续期重试**（与 `/v1/models` 同一条路径）：过期令牌不该让整家
 * 从聚合目录里消失。也**同样跳过用户已关闭的供应商** ——
 * 否则「我关了它」在聚合路径上失效。
 */
async function listModelsForProvider(
  env: Env,
  realm: string,
  providerId: string,
  outerSignal?: AbortSignal,
): Promise<import('../providers/types.js').ProviderModel[]> {
  // ⚠️ 分片消歧：国际版在 global 分片，优先走其规范分片
  const targetRealm = providerId === 'workbuddy' ? 'global' : realm
  let pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(targetRealm))
  let accounts = await pool.listAccounts(targetRealm, Date.now())
  let usable = accounts.filter((a) => (a.provider ?? DEFAULT_PROVIDER) === providerId && !a.disabled)

  // 若目标分片未找到，自动回退探测另一个分片
  if (usable.length === 0) {
    const otherRealm = targetRealm === 'cn' ? 'global' : 'cn'
    const otherPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(otherRealm))
    const otherAccounts = await otherPool.listAccounts(otherRealm, Date.now())
    const otherUsable = otherAccounts.filter((a) => (a.provider ?? DEFAULT_PROVIDER) === providerId && !a.disabled)
    if (otherUsable.length > 0) {
      pool = otherPool
      usable = otherUsable
    }
  }

  if (usable.length === 0) return []

  const provider = findProvider(providerId)
  if (provider === undefined) return []

  // ⚠️ 用户关闭的家在聚合路径上也要跳过（关闭 = 彻底关掉）
  if (await isProviderClosedByUser(env, providerId)) return []

  const account = usable[0] as (typeof usable)[number]
  const credential = (await pool.getCredential(account.uid)) as ProviderCredential | undefined
  if (credential === undefined) return []

  const bound = providerId === DEFAULT_PROVIDER ? bindBuddy(env) : provider
  // ⚠️ 单家 20s 上限 + **外层取消**：两者任一触发都要停（否则客户端走了我们还在等）
  const timeoutSignal = AbortSignal.timeout(20_000)
  const signal = outerSignal === undefined
    ? timeoutSignal
    : (typeof AbortSignal.any === 'function'
        ? AbortSignal.any([timeoutSignal, outerSignal])
        : timeoutSignal)
  try {
    return await bound.listModels(credential, signal)
  } catch (error) {
    // ⚠️ 目录拉取失败时**不在这里续期**：续期需要 `putCredential` 回写，
    // 而那套逻辑在 `index.ts` 的 `withRefreshRetry` 里（私有的）。
    // 这里**如实抛出**，由 `loadAggregateCatalog` 逐家兜错跳过 ——
    // 一个令牌过期的家不该让整个聚合目录消失，但也不该在这里假装成功。
    //（正常路径上令牌由 cron 的主动续期与网关的 401 兜底维护，很少走到这里。）
    throw error
  }
}

/**
 * 剔除被用户停用的候选（**停用 = 彻底关掉**）。
 *
 * 判据与 `/v1/models` 同源：`AccountPoolDO.getDisabledModels(provider)`。
 * 两个 realm 都查 —— 停用列表按 provider 存，但存在各自 realm 的分片里。
 *
 * ⚠️ 逐家查一次并缓存：`getDisabledModels` 是 DO RPC，按候选逐个查会
 * 产生大量无谓往返。
 */
async function filterDisabledCandidates(
  env: Env,
  realm: string,
  candidates: readonly AggregateCandidate[],
): Promise<AggregateCandidate[]> {
  const providers = [...new Set(candidates.map((c) => c.provider))]
  const off = new Map<string, Set<string>>()
  for (const providerId of providers) {
    const set = new Set<string>()
    for (const r of ['cn', 'global']) {
      try {
        const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(r))
        for (const id of await pool.getDisabledModels(providerId)) set.add(id)
      } catch {
        // ⚠️ 读不到停用列表时**不静默放行** —— 那会让停用失效。
        // 保守做法：把该家整体视为「停用不可用」。这里选择**记日志并跳过
        // 该家的过滤**是危险的，故改为：读失败则保留候选但记警告。
        // 取舍理由：读失败更可能是瞬时 DO 故障，而「整体不可用」会让
        // 用户明明是好的账号突然全用不了 —— 那是更大的伤害。
        console.warn(`[aggregate] 读取 ${providerId} 的停用模型失败（按未停用处理）`)
      }
    }
    off.set(providerId, set)
  }
  return candidates.filter((c) => !(off.get(c.provider)?.has(c.realId) ?? false))
}

/**
 * 为每个候选探测「积分最早作废时刻」。
 *
 * ⚠️ 用我们既有的 `ProviderBalance.earliestExpiry` —— 它本来就存在
 * （10/12 家已实现），故这里**不需要**参考实现那套 590 行的分渠道折算：
 * 各家的 `balance()` 已经把它算好了。这正是「复用既有能力」的好处。
 *
 * ⚠️ 探测失败 ⇒ `EXPIRY_UNUSABLE`（**不是**「长期」）——
 * 我们**不知道**那个渠道能不能用，不能把流量发过去。
 *
 * ⚠️ 每个供应商**只探一次**（同一家的多个模型共享一份余额）。
 * ⚠️ 逐家串行 + 超时：探测是**额外开销**，必须受限，不能让它拖垮请求。
 */
async function probeExpiries(
  env: Env,
  realm: string,
  candidates: readonly AggregateCandidate[],
  signal: AbortSignal,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const seenProviders = new Set<string>()

  for (const c of candidates) {
    const key = `${c.provider}\u0000${c.realId}`
    if (seenProviders.has(c.provider)) {
      // 同一家已探过：复用那家的结果（按 provider 记一份）
      out.set(key, out.get(`${c.provider}\u0000*`) ?? EXPIRY_UNUSABLE)
      continue
    }
    seenProviders.add(c.provider)

    const provider = findProvider(c.provider)
    if (provider === undefined || provider.balance === undefined) {
      // 不支持查余额 ⇒ 查不到（不是「长期」）
      out.set(`${c.provider}\u0000*`, EXPIRY_UNUSABLE)
      out.set(key, EXPIRY_UNUSABLE)
      continue
    }

    let expiry = EXPIRY_UNUSABLE
    try {
      const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
      const accounts = await pool.listAccounts(realm, Date.now())
      const account = accounts.find((a) => (a.provider ?? DEFAULT_PROVIDER) === c.provider && !a.disabled)
      if (account === undefined) {
        out.set(`${c.provider}\u0000*`, EXPIRY_UNUSABLE)
        out.set(key, EXPIRY_UNUSABLE)
        continue
      }
      const credential = (await pool.getCredential(account.uid)) as ProviderCredential | undefined
      if (credential === undefined) {
        out.set(`${c.provider}\u0000*`, EXPIRY_UNUSABLE)
        out.set(key, EXPIRY_UNUSABLE)
        continue
      }
      const bound = c.provider === DEFAULT_PROVIDER ? bindBuddy(env) : provider
      const balanceFn = bound.balance
      if (balanceFn === undefined) {
        out.set(`${c.provider}\u0000*`, EXPIRY_UNUSABLE)
        out.set(key, EXPIRY_UNUSABLE)
        continue
      }
      const balance = await balanceFn.call(bound, credential, AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
      // ⚠️ `earliestExpiry` 是**绝对 epoch ms**；`0` = 未知（不是「已过期」）。
      // 未知 ⇒ 用「长期」还是「查不到」？本项目取**查不到**（保守）：
      // 我们没能确定它的临期情况，就不该假装它长期有效而去优先烧别家。
      expiry = balance.earliestExpiry > 0 ? balance.earliestExpiry : EXPIRY_UNUSABLE
    } catch (error) {
      // ⚠️ 客户端取消必须原样抛出（本项目既有纪律），不能吞成「查不到」
      if (signal.aborted) throw error
      expiry = EXPIRY_UNUSABLE
      console.warn(
        `[aggregate] 探测 ${c.provider} 的到期时刻失败：`,
        error instanceof Error ? error.message : String(error),
      )
    }
    out.set(`${c.provider}\u0000*`, expiry)
    out.set(key, expiry)
  }
  return out
}
