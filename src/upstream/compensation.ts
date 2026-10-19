/**
 * CodeBuddy / WorkBuddy **限时补偿积分**的状态查询与领取。
 *
 * ## 这是什么（用户视角）
 *
 * 「套餐与积分」页上那个**「立即领取」**按钮 —— 腾讯偶尔发一次限时补偿
 * （例如服务抖动后补 500 积分），过期即作废。
 *
 * ## 端点来源（逆向 + 真实报文双证据）
 *
 * 取自参考实现 `deepseek-harness-codearts/src/buddy-compensation.ts`，
 * 那里的端点来自 `www.codebuddy.cn` 的前端 bundle 原文：
 *
 * ```js
 * bp = async () => await cn.post("/billing/meter/compensation-status")
 * vp = async () => await cn.post("/billing/meter/claim-compensation")
 * ```
 *
 * ⚠️ 路径**没有 `/v2` 前缀**（对比签到是 `/v2/billing/meter/daily-checkin`）——
 * 这是另一个产品面，别按 v2 抄。
 *
 * ## 鉴权只需 Bearer
 *
 * ⚠️ `Authorization: Bearer <access_token>` 即可，**不需要浏览器 cookie** ——
 * 参考实现用 Node `fetch`（无任何浏览器上下文）实测 200。
 * 这是本功能能脱离「网页点按钮」实现自动化的前提。
 *
 * ## 真实响应形状（决定了本模块最容易写错的地方）
 *
 * 状态查询（要求 `data`）：
 * ```json
 * {"code":0,"msg":"OK","requestId":"…","data":{
 *    "claimed": false, "active": true,
 *    "credit_num": 500, "validity_period": 1,
 *    "end_time": "2026-10-22 23:59:59"}}
 * ```
 *
 * 领取（**成功时没有 `data`**）：
 * ```json
 * {"code":0,"msg":"OK","requestId":"…"}
 * ```
 *
 * ⚠️⚠️ 参考实现为此踩过一次坑并留下了记录：本机 5 个账号批量领取，
 * 5/5 都返回「无 data」形态，面板按「缺 data ⇒ 形态不认识」判成
 * **「5 个账号领取失败」**；而随后用同一批 token 查 status，
 * 5/5 都是 `claimed:true, credit_num:500` —— **积分其实早已到账**。
 *
 * ⇒ 写操作的成败**只看 `code === 0`**；缺 `data` 不等于失败。
 *   但**仍要求有 `code`**：没有业务码的响应无法与「网关回了个 JSON 错误体」
 *   区分，宁可报 `shape` 也不要把未知形态当成功（一次性写操作尤其不能猜）。
 *
 * ## ⚠️ 刻意**不**接进自动任务/自动签到
 *
 * 这是一次性的**限时**活动（`end_time` 到期即作废），不是每日可领的能力。
 * 本项目对「一次性 / 有代价动作」的纪律是**默认不自动执行**
 * （同 `Expert_Philanthropy` 需真实捐款那类）。
 *
 * ⇒ 本模块只提供：
 *   ① 状态查询（供面板如实展示「有 N 积分待领 / 已领取 / 活动已结束」）；
 *   ② 一次**显式**领取（由用户在面板点按钮触发）。
 *   **不**在 cron、不自动签到链路里调用 `claimCompensation`。
 *
 * @module src/upstream/compensation.ts
 */

import { callUpstream } from './client.js'
import { billingHeaders } from './headers.js'
import { resolveUpstream, type Env } from '../env.js'

/** 状态查询路径。⚠️ 无 `/v2` 前缀。 */
export const COMPENSATION_STATUS_PATH = '/billing/meter/compensation-status'
/** 领取路径。⚠️ 无 `/v2` 前缀。 */
export const COMPENSATION_CLAIM_PATH = '/billing/meter/claim-compensation'

/** 补偿状态（面板据此渲染，字段一对一映射上游原始值）。 */
export interface CompensationStatus {
  /** 是否**已经领过**（幂等键）。 */
  claimed: boolean
  /** 活动是否**仍有效**（false 表示已过期/未开始/无此活动）。 */
  active: boolean
  /** 可领/已领的积分数。 */
  creditNum: number
  /** 有效期天数（上游 `validity_period`，用于展示「积分 N 天内有效」）。 */
  validityPeriod: number
  /** 活动截止时刻原文（上游 `end_time`，形如 `2026-10-22 23:59:59`）。 */
  endTime: string
}

/** 领取结果。 */
export interface CompensationClaimResult {
  /** 是否本次真的领到（幂等命中时为 false）。 */
  claimed: boolean
  /** 幂等命中（此前已领过，上游通常回业务码而非成功）。 */
  alreadyClaimed: boolean
  /** 上游 `msg` 原文（排障唯一线索）。 */
  message: string
}

/** 内部：把上游字段安全读成 number。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 内部：把上游字段安全读成 string。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 查询补偿状态。
 *
 * @returns 解析成功时返回状态；**上游无此活动 / 形态不认识**时返回 `undefined`
 *          （调用方应如实展示为「当前没有可领取的补偿」，而不是报错 ——
 *           活动结束后这个端点对所有人恒返回 `active:false`，
 *           那是正常业务语义，不是故障）。
 */
export async function fetchCompensationStatus(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<CompensationStatus | undefined> {
  const bases = resolveUpstream(env)
  // ⚠️ 走 `web` base（`www.workbuddy.cn`）：这个端点属于**用户中心**产品面，
  // 参考实现明确记录了「三个 host 实测都能通，但刻意走 webBase」——
  // 因为网页端发这个请求的站就是它（前端 bundle 托管在 assets.workbuddy.cn）。
  // 把用户中心类请求打到推理站（copilot）没有依据，哪天收窄路由就会静默失效。
  const res = await callUpstream<Record<string, unknown>>({
    method: 'POST',
    url: `${bases.web}${COMPENSATION_STATUS_PATH}`,
    headers: billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    body: '{}',
  })
  if (!res.ok) return undefined

  // ⚠️ 状态查询**要求 `data`**：返回值就是 data 里的字段，
  // 缺 data 说明接口形态变了 —— 此时返回 undefined 让上层如实说「查不到」，
  // 而不是编一个「没有补偿」的假结论。
  const data = res.envelope?.data
  if (data === undefined || data === null || typeof data !== 'object') return undefined

  return {
    claimed: data.claimed === true,
    active: data.active === true,
    creditNum: num(data.credit_num),
    validityPeriod: num(data.validity_period),
    endTime: str(data.end_time),
  }
}

/**
 * 领取补偿积分。
 *
 * ⚠️⚠️ 这是**一次性写操作**，调用前应先用 {@link fetchCompensationStatus}
 * 确认 `active && !claimed` —— 否则白打上游，且用户会以为「点了没反应」。
 *
 * ⚠️ 成败判据**只看 `code === 0`**（成功时上游**不回 `data`**，
 * 见模块头那段实测记录）。
 *
 * 幂等：已领过时上游通常回业务码（非 0）而不是 code 0，
 * 故这里把它映射成 `{claimed:false, alreadyClaimed:true}` —— **不算失败**。
 */
export async function claimCompensation(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<CompensationClaimResult> {
  const bases = resolveUpstream(env)
  const res = await callUpstream<Record<string, unknown>>({
    method: 'POST',
    url: `${bases.web}${COMPENSATION_CLAIM_PATH}`,
    headers: billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    body: '{}',
  })

  const code = res.envelope?.code
  const message = res.envelope?.msg ?? ''

  // ⚠️ 判据只看业务码 —— **不要**因为缺 `data` 就判失败（那是本模块最大的坑）。
  if (res.ok && code === 0) {
    return { claimed: true, alreadyClaimed: false, message }
  }

  // 已领过：上游用业务码拒绝，语义上是幂等命中而非失败。
  // ⚠️ 这里刻意**不**按具体码号匹配（参考实现也没记录确切码值）：
  // 以「httpStatus 正常 + 文案含已领/重复」为判据，避免猜一个码号猜错。
  const looksAlready = /已领取|already|重复|repeated/i.test(message)
  if (looksAlready) {
    return { claimed: false, alreadyClaimed: true, message }
  }

  // 其余一律如实抛出 —— §7.2「失败必须显式」，一次性写操作绝不静默。
  throw new Error(
    message !== ''
      ? `领取补偿失败：${message}`
      : `领取补偿失败：上游返回 code=${String(code)} http=${res.httpStatus}`,
  )
}
