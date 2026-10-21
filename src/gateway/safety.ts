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
function envFallback(env: Env): SafetyConfig {
  const burn = resolveBurnRate(env)
  return {
    sessionTrace: true,
    maxContextMessages: resolveMaxContextMessages(env),
    burnRateWindowMs: burn.windowMs,
    burnRateThresholdPct: burn.thresholdPct,
    rateLimitQps: 0,
    rateJitterMs: 0,
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
