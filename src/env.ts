/**
 * Bindings、环境解析与「不写 `parseInt(x) || 默认值`」的硬纪律。
 *
 * ## 为什么这个文件单独存在
 *
 * AGENTS.md §6.8 记录了本项目最贵的同型缺陷：`parseInt(x) || 默认值`。
 * `0` 是**合法**配置值却是 falsy，用 `||` 会被静默换成默认值 —— 开关「关不掉」。
 * `deepseek-harness-codearts` 里至少三处记录过它（`openai-gateway/config.ts:12-14`、
 * `auto-checkin.ts:188-190`、`buddy-balance-rank.ts:87-89`）。
 *
 * 故本文件是**唯一的**环境读取入口，所有解析都走下面这几个函数，
 * 不允许在业务代码里直接读 `env`。
 */

import type { AccountPoolDO } from './pool/AccountPoolDO.js'
import type { TaskRunnerDO } from './taskrunner/TaskRunnerDO.js'
import {
  DEFAULT_BURN_RATE_THRESHOLD_PCT,
  DEFAULT_BURN_RATE_WINDOW_MS,
  type BurnRateConfig,
} from './pool/burn-rate.js'

/** Worker 的 bindings 与 vars。 */
export interface Env {
  /** 账号池（每 realm 一个实例）。 */
  ACCOUNT_POOL: DurableObjectNamespace<AccountPoolDO>
  /** 任务执行器（每账号一个实例）。 */
  TASK_RUNNER: DurableObjectNamespace<TaskRunnerDO>

  /** 管理 API 与 OpenAI 兼容端口的共享密钥（用 `wrangler secret put` 设置）。 */
  API_KEY?: string
  /** 凭据加密密钥（32 字节 base64url）。**不设置则拒绝存凭据**，不静默明文落盘。 */
  CREDENTIAL_KEY?: string

  /** 上游域名（见 AGENTS.md §6.2，三个 base 不可混用）。 */
  UPSTREAM_CHAT_BASE?: string
  UPSTREAM_BILLING_BASE?: string
  UPSTREAM_WEB_BASE?: string

  /** 国际版每日活跃打卡用的模型（默认 `deepseek-v4.1-flash`，见 `upstream/webagent.ts`）。 */
  WORKBUDDY_DAILY_CHAT_MODEL?: string

  /**
   * 单请求消息数硬上限（默认 `0` = 不截断，见 `DEFAULT_MAX_CONTEXT_MESSAGES`）。
   *
   * ⚠️ `0` 或负数 = **不限制**（显式放开，见 `parseMaxContextMessages` 的说明）。
   */
  /**
   * 对外的公网地址（如 `https://router.example.com`），**用于拼 OAuth 回调地址**。
   *
   * 🔴 为什么必须有它（2026-10-21 审查补，安全面专项）：
   * 回调地址原先由 `url.origin` 拼出，而 `origin` 来自请求头 `Host` +
   * `x-forwarded-proto` —— **两者都是客户端可控的**。
   * 一旦有人拿着管理密钥调 `POST /admin/providers/login/start` 并伪造 Host，
   * 回调就会被指到攻击者域；用户完成授权后，上游把 `?secret=<换取凭据的能力凭证>`
   * 送到那里 —— 直接拿到可换 accessToken 的 secret。
   *
   * 未设置时仍回落到 `url.origin`（保持单机可用），但会**打一条 warn**。
   */
  PUBLIC_URL?: string

  MAX_CONTEXT_MESSAGES?: string

  /**
   * 消耗速率熔断的**观察窗口**（ms，默认 `3600000` = **1 小时**，与整点采样间隔一致）。
   *
   * ⚠️ `0` 或负数 = **关闭**该检测（见 `resolveBurnRate`）。
   */
  BURN_RATE_WINDOW_MS?: string

  /**
   * 消耗速率熔断的**阈值**（百分比，默认 `20` = 窗口内烧掉起点余额的 20%）。
   *
   * ⚠️ `0` 或负数 = **关闭**该检测（见 `resolveBurnRate`）。
   */
  BURN_RATE_THRESHOLD_PCT?: string
}

/** CN 域默认上游（与 Go 侧 `internal/upstream/client.go:693-695` 一致）。 */
export const DEFAULT_UPSTREAM = {
  chat: 'https://copilot.tencent.com',
  billing: 'https://www.codebuddy.cn',
  web: 'https://www.workbuddy.cn',
} as const

/**
 * 显式假值集合。
 *
 * ⚠️ 判据是「**归一化后的字符串是否在集合里**」，而不是 `!value` / `Number(x) || d`。
 * 这样 `'0'`、`'false'`、`'off'`、`'no'` 都能真正关掉开关，且未设置时取默认。
 */
const FALSY = new Set(['0', 'false', 'off', 'no'])

/**
 * 解析一个「默认开」的开关。
 * 未设置 / 空串 → `fallback`；显式假值 → `false`；其余 → `true`。
 */
export function parseEnabled(raw: string | undefined, fallback = true): boolean {
  if (raw === undefined) return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === '') return fallback
  return !FALSY.has(normalized)
}

/**
 * 解析整数。
 *
 * ⚠️ 刻意**不接受** `parseInt` 的宽松语义（`'12abc'` → 12）。要求整个字符串
 * 就是整数，否则视为非法并返回 `undefined` —— 让调用方显式决定回退策略，
 * 而不是吞掉配置错误。
 */
export function parseInteger(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  // 手写整数校验：拒绝 '12abc'、'1.5'、'0x10'、' 12 '（已 trim 故后者可行）
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined
  const value = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

/** 读取非空字符串；空串视为未设置。 */
export function parseString(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  return trimmed === '' ? fallback : trimmed
}

/** 上游域名集合。 */
export interface UpstreamBases {
  chat: string
  billing: string
  web: string
}

/**
 * 单请求消息数硬上限的默认值。
 *
 * 依据：workbuddy2api 的封禁复盘（doc/incident-postmortem-and-hardening-checklist.md，
 * P2「上下文治理」：`--optimize-context` 默认开启 + 单请求消息数硬上限，原文建议 ≤100）。
 * 三次封禁前最后一次成功请求分别是 **2552 / 428→434 / 987~993 条消息**，
 * 上游风控把「超大上下文 + 高频连发」并入机器行为画像。
 *
 * ⚠️ 我们取 **300 而不是 100**，是权衡后的决定，不是抄漏：
 * - 300 仍**低于三次封禁样本中的最小值 434**，仍在同一量级的防线内；
 * - 取 100 会把 700+ 条的正常长会话砍成 100 条（实测日志：719 → 101，
 *   一次丢掉 619 条历史），对 agent 场景是实打实的质量损失；
 * - 复盘把根因写成**多因素叠加**（无设备指纹 / 会话链缺失 / 429 热重试 / 高频），
 *   本项目其余几项（b3 链、会话 ID 链、429 熔断、限速、消耗熔断）均已具备，
 *   消息数只是其中一道，不必单独拉到最紧。
 * 要恢复复盘的保守值就设 `MAX_CONTEXT_MESSAGES=100`；要完全关掉就设 `0`。
 *
 * ## 🔴 2026-10-22：默认值改为 `0`（不截断）
 *
 * ### 为什么推翻上面那个 300
 *
 * 上面那段依据是**封号复盘**得出的，但它把两件事混成了一件事：
 * 「大上下文」与「请求形态不完整」。复盘样本里那三次封禁前的请求
 * 既超大、**又缺设备指纹/会话链**（本项目当时确实缺，见 A7）。
 *
 * 实测反证：同一账号用**官方客户端 50 并发**完全正常 —— 而官方客户端同样发大上下文。
 * 说明「大」本身不是判据，**形态不完整才是**。而我们的形态补齐了
 * （设备指纹、会话链、b3 分流、防封节奏），继续按 300 砍就变成了纯粹的自我伤害：
 * 实测日志里 agent 会话 `1767 条 → 301 条`，**一次丢掉 1466 条历史**
 * —— 丢的是系统提示与早期工具上下文，上游看到的是被腰斩的对话。
 *
 * ### 为什么「不截断」比「截断」更安全
 *
 * 截断是**静默改写用户请求**：调用方以为发的是完整对话，实际被换成了别的。
 * 对 agent 场景这不只是质量损失 —— 丢掉 tool 定义与早期结果后，模型会重复调工具、
 * 甚至基于不存在的上下文编造，**表现为「上游限流/异常」，真因在我们自己**。
 * 而放开截断后，超大请求最多是被上游按正常规则拒绝（有明确的 4xx 与原因），
 * 可定位、可解释。
 *
 * ### 风险（如实记）
 *
 * 默认不截断 ⇒ 一个病态的 20 万条请求会被原样转发，占用内存与上行带宽。
 * 需要收紧时显式设 `MAX_CONTEXT_MESSAGES`（如 `5000`）；
 * 复盘的极保守值 `100` 仍然可用。
 */
export const DEFAULT_MAX_CONTEXT_MESSAGES = 0

/** 上限的整数取值范围。刻意允许负数（负数 = 显式不限制），故下界不是 0。 */
const MAX_CONTEXT_MESSAGES_RANGE = 1_000_000

/**
 * 解析 `MAX_CONTEXT_MESSAGES`。
 *
 * ## ⚠️ 这里**绝对**不能写 `parseInt(x) || 100`
 *
 * 本项目最贵的同型缺陷（AGENTS.md §6.8）：`0` 是**合法**配置值却是 falsy，
 * 用 `||` 会被静默换成默认值 —— 用户写了 `MAX_CONTEXT_MESSAGES=0` 想关掉裁剪，
 * 结果照旧按 100 裁，而且**没有任何报错**。故判据只看解析结果是否为 `undefined`。
 *
 * ## 返回值的三种情形
 *
 * | 输入 | 返回 | 理由 |
 * |---|---|---|
 * | 未设置 / 空串 / 非法（`'abc'`、`'12abc'`、超范围） | `0`（= `DEFAULT_MAX_CONTEXT_MESSAGES`，不截断） | 默认值已于 2026-10-22 改为 0，理由见 `DEFAULT_MAX_CONTEXT_MESSAGES` 的说明（截断是静默改写请求，比不截断更危险） |
 * | `0` 或负数 | `0`（= 不限制） | 显式放开，必须真的生效 |
 * | 正整数 | 该值 | |
 */
export function parseMaxContextMessages(raw: string | undefined): number {
  const value = parseInteger(raw, -MAX_CONTEXT_MESSAGES_RANGE, MAX_CONTEXT_MESSAGES_RANGE)
  if (value === undefined) return DEFAULT_MAX_CONTEXT_MESSAGES
  return value > 0 ? value : 0
}

/** 从 `Env` 读 `MAX_CONTEXT_MESSAGES`（业务代码只走这个入口，不直接读 `env`）。 */
export function resolveMaxContextMessages(env: Env): number {
  return parseMaxContextMessages(env.MAX_CONTEXT_MESSAGES)
}

/** 观察窗口的整数取值范围（ms）。上界 24h：再长就不再是「近期爆发」的语义了。 */
const BURN_RATE_WINDOW_RANGE = 24 * 60 * 60 * 1000

/**
 * 阈值的整数取值范围（百分比）。
 * ⚠️ 刻意允许负数（负数 = 显式关闭）与 >100（= 事实上永不触发），故下界不是 0。
 */
const BURN_RATE_PCT_RANGE = 1_000

/**
 * 解析 `BURN_RATE_WINDOW_MS`。
 *
 * ## ⚠️ 这里**绝对**不能写 `parseInt(x) || 300000`
 *
 * AGENTS.md §6.8 的同型缺陷：`0` 是**合法**配置值却是 falsy，用 `||` 会被静默
 * 换成默认值 —— 用户写了 `BURN_RATE_WINDOW_MS=0` 想关掉检测，结果照旧每 1 小时
 * 判一次，而且**没有任何报错**。故判据只看解析结果是否为 `undefined`。
 *
 * | 输入 | 返回 | 理由 |
 * |---|---|---|
 * | 未设置 / 空串 / 非法（`'abc'`、`'5m'`） | `DEFAULT_BURN_RATE_WINDOW_MS`（**1 小时**） | 失败方向取**收紧**：检测保持开启 |
 * | `0` 或负数 | `0`（= 关闭） | 显式关闭必须真的生效 |
 * | 正整数 | 该值 | |
 */
export function parseBurnRateWindowMs(raw: string | undefined): number {
  const value = parseInteger(raw, -BURN_RATE_WINDOW_RANGE, BURN_RATE_WINDOW_RANGE)
  if (value === undefined) return DEFAULT_BURN_RATE_WINDOW_MS
  return value > 0 ? value : 0
}

/** 解析 `BURN_RATE_THRESHOLD_PCT`（语义与取值表完全同 {@link parseBurnRateWindowMs}）。 */
export function parseBurnRateThresholdPct(raw: string | undefined): number {
  const value = parseInteger(raw, -BURN_RATE_PCT_RANGE, BURN_RATE_PCT_RANGE)
  if (value === undefined) return DEFAULT_BURN_RATE_THRESHOLD_PCT
  return value > 0 ? value : 0
}

/**
 * 从 `Env` 读消耗速率熔断配置（业务代码只走这个入口，不直接读 `env`）。
 *
 * 两个旋钮**任一**为 0/负数即整体关闭，并归一成 `{windowMs: 0, thresholdPct: 0}` ——
 * 让「是否启用」只有一个判据，调用方不必记住两处特例。
 */
export function resolveBurnRate(env: Env): BurnRateConfig {
  const windowMs = parseBurnRateWindowMs(env.BURN_RATE_WINDOW_MS)
  const thresholdPct = parseBurnRateThresholdPct(env.BURN_RATE_THRESHOLD_PCT)
  if (windowMs <= 0 || thresholdPct <= 0) return { windowMs: 0, thresholdPct: 0 }
  return { windowMs, thresholdPct }
}

export function resolveUpstream(env: Env): UpstreamBases {
  return {
    chat: parseString(env.UPSTREAM_CHAT_BASE, DEFAULT_UPSTREAM.chat),
    billing: parseString(env.UPSTREAM_BILLING_BASE, DEFAULT_UPSTREAM.billing),
    web: parseString(env.UPSTREAM_WEB_BASE, DEFAULT_UPSTREAM.web),
  }
}
