/**
 * 防封配置的**网关侧**入口：带 TTL 缓存地从账号池读 {@link SafetyConfig}，
 * 并把其中的「全局开关」推给下游（头族 / 限速器）。
 *
 * ## 为什么要缓存
 *
 * 每个对话请求都要用它（裁剪上限、限速参数）。直接每次 `pool.getSafetyConfig()`
 * 就多一次 DO 往返 —— 而这是**全局配置**，10 秒的陈旧完全可接受。
 * 与 `maxRotateFor` 的缓存同一思路（那里缓存的是 `maxRetries`）。
 *
 * ## 为什么在这里做「副作用」
 *
 * `setSessionTraceEnabled` / `configureThrottle` 改的是模块级全局值。
 * 放在**唯一**的读取入口做推送，可以保证「面板改了 → 下一次读配置 → 开关立刻跟上」，
 * 不会出现某个调用点忘了同步的状态。
 */
import type { Env } from '../env.js'
import { resolveBurnRate, resolveMaxContextMessages } from '../env.js'
import type { AccountPoolDO, SafetyConfig } from '../pool/AccountPoolDO.js'
import { setSessionTraceEnabled } from '../upstream/headers.js'
import { configureThrottle } from './throttle.js'

/** 缓存时长：配置是全局量，10 秒陈旧无感；面板上点一下最迟 10 秒后生效。 */
export const SAFETY_TTL_MS = 10_000

let cached: { at: number; value: SafetyConfig } | undefined

/** 清空缓存（面板写入后调用，让改动**立刻**生效而不是等 TTL）。 */
export function resetSafetyConfigCache(): void {
  cached = undefined
}

/**
 * 读不到 DO 配置时的兜底：**回落到环境变量**。
 *
 * ⚠️ 为什么要回落而不是用硬编码常量：老部署靠环境变量配了
 * `MAX_CONTEXT_MESSAGES` / `BURN_RATE_*`，升级后若 DO 里还没有值，
 * 直接换成代码默认会把人家配好的东西**悄悄改回默认**。
 */
/**
 * 单账号 QPS 上限（`RATE_LIMIT_QPS`，默认 **0 = 不限速**）。
 *
 * ## 为什么需要它（防封的「节奏」层）
 *
 * 真人操作有停顿，脚本是连发。上游把「高频连发」并入机器行为画像。
 * `throttle.ts` 实现了按 uid 的限速 + 抖动，但**此前没有任何开启途径**：
 * `rateLimitQps` 硬编码 0、无环境变量、面板也没有对应端点 ——
 * 等于模块写好了却永远关着。
 *
 * ## 为什么沿用「环境变量回落」而不是加硬编码常量
 *
 * 与 `MAX_CONTEXT_MESSAGES` / `BURN_RATE_*` 同一口径：老部署用环境变量配过，
 * 升级后若 DO 里没值就直接用代码默认，会把人配好的东西**悄悄改回默认**。
 * 补上回落，部署方一个环境变量就能开，不必等面板端点。
 *
 * ⚠️ **默认保持 0（关闭）**：限速会改变现有用户的实际吞吐，
 * 该由部署方决定何时启用，不能升级后自动生效。
 *
 * ⚠️ 本项目跑在 **Node 单容器**（非 Workers），所以 `throttle.ts` 里
 * 「多 isolate 各一份状态」的已知限制在这里**不成立** —— 限速是精确的。
 */
export function resolveRateLimitQps(env: Env): number {
  const raw = (env as { RATE_LIMIT_QPS?: string }).RATE_LIMIT_QPS
  if (raw === undefined || raw.trim() === '') return 0
  const n = Number(raw)
  // 非法值回落 0（=关闭）。限速配置写错时宁可放行，也不要卡住全部请求。
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 限速之外的随机抖动上限（`RATE_JITTER_MS`，默认 0）。
 *
 * 固定间隔本身也是一种"机器特征"：每 1000ms 一次，比随机间隔更像脚本。
 * 抖动让节奏接近人类。只有 `RATE_LIMIT_QPS > 0` 时才有意义。
 */
export function resolveRateJitterMs(env: Env): number {
  const raw = (env as { RATE_JITTER_MS?: string }).RATE_JITTER_MS
  if (raw === undefined || raw.trim() === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function envFallback(env: Env): SafetyConfig {
  const burn = resolveBurnRate(env)
  return {
    sessionTrace: true,
    maxContextMessages: resolveMaxContextMessages(env),
    burnRateWindowMs: burn.windowMs,
    burnRateThresholdPct: burn.thresholdPct,
    rateLimitQps: resolveRateLimitQps(env),
    rateJitterMs: resolveRateJitterMs(env),
  }
}

/**
 * 取防封配置（TTL 缓存）。
 *
 * ⚠️ 读失败**绝不影响请求本身**：回落环境变量。配置链路挂了不该让网关 500。
 */
export async function safetyConfigFor(
  env: Env,
  pool: DurableObjectStub<AccountPoolDO>,
  now = Date.now(),
): Promise<SafetyConfig> {
  if (cached !== undefined && now - cached.at < SAFETY_TTL_MS) return cached.value
  let value: SafetyConfig
  try {
    value = await pool.getSafetyConfig()
  } catch {
    value = envFallback(env)
  }
  cached = { at: now, value }
  // 推给下游：会话链开关与限速参数都是模块级全局值。
  setSessionTraceEnabled(value.sessionTrace)
  configureThrottle({ qps: value.rateLimitQps, jitterMs: value.rateJitterMs })
  return value
}
