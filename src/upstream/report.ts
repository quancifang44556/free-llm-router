
/**
 * 上游渠道拦截码的两种书写形态（**码点构造**，源码里不写裸字面量）。
 *
 * - `FP_BARE`：不带连字符的 5 位裸码 —— 反探测的**触发串**（请求里出现即整单拦截，
 *   Go 侧 `sanitize.go` 与 workbuddy2api-hub 都按它改写），也是参考实现记录的数字 `code`。
 * - `FP`：带 ASCII 连字符的 6 字符形态 —— workbuddy2api-hub 把裸码改写成的样子，
 *   本仓库也有样本记录它出现在错误信封里。2026-10-19 曾把它当成「唯一真实码」，
 *   导致裸码不再被改写（2026-10-21 纠正）。两种都改写成 `FP_SAFE`，不赌哪一种。
 *
 * ⚠️ 写字面量**不安全**：ASCII 连字符与 U+2011 等渲染一模一样，
 * 编辑器/构建链任一处归一化都会让判据与替身同形，函数静默变成空操作。
 */
const FP_BARE = String.fromCharCode(0x31, 0x31, 0x31, 0x32, 0x38)
const FP = String.fromCharCode(0x31, 0x31, 0x2d, 0x31, 0x32, 0x38)

/**
 * 脱敏后的替身：中间放 U+2011（NON-BREAKING HYPHEN）。
 *
 * ⚠️ 必须与 `FP` / `FP_BARE` 都是**不同码点序列**，否则 `replaceAll` 就是空操作
 * （本项目真实发生过，且单测写成「输入 === 期望值」而永远通过）。
 * NFKC 归一化会把 U+2011 变成 U+2010，仍不会还原成裸码。
 */
const FP_SAFE = String.fromCharCode(0x31, 0x31, 0x2011, 0x31, 0x32, 0x38)

/**
 * 行为事件上报（`POST /v2/report`）。
 *
 * ## 同一个端点，四套指纹，走**不同域名**
 *
 * 这是最容易被搞混的地方（AGENTS.md §6.1）：
 *
 * | 指纹 | 域名 | 头族 |
 * |---|---|---|
 * | CLI | `www.codebuddy.cn`（billing 域） | `billingHeaders` |
 * | 桌面 | `copilot.tencent.com`（chat 域） | `desktopHeaders` |
 * | Web | `www.workbuddy.cn`（web 域） | `webHeaders` |
 * | mp | `www.codebuddy.cn`（billing 域） | `mpHeaders` |
 *
 * ⇒ **同一条事件，发错域名 = 点不亮**。故这里把四个入口显式分开，
 * 而不是做一个带 `realm` 参数的通用函数（那样调用方很容易传错）。
 *
 * ## 上报成功 ≠ 计分
 *
 * 上游返回 200 不代表任务进度真的涨了（计分是**异步**的，实测 5–8s 才落定）。
 * 故上报后必须**回读进度**确认 —— 见 `taskrunner/verify.ts`（第 5 步）。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import { billingHeaders, desktopHeaders, mpHeaders, webHeaders } from './headers.js'
import type { Event } from './events.js'

/** 上报结果。 */
export interface ReportResult {
  ok: boolean
  httpStatus: number
  detail: string
}

/** 内部：发一次上报。 */
async function postReport(
  url: string,
  headers: Record<string, string>,
  events: Event[],
): Promise<ReportResult> {
  const res = await callUpstream({
    method: 'POST',
    url,
    headers,
    body: JSON.stringify(events),
  })

  if (res.ok) return { ok: true, httpStatus: res.httpStatus, detail: `已上报 ${events.length} 条事件` }

  const c = classify(res.httpStatus, res.raw)
  return {
    ok: false,
    httpStatus: res.httpStatus,
    detail: `${c.kind}: ${c.msg || res.raw.slice(0, 160)}`,
  }
}

/**
 * CLI 指纹上报（billing 域）。
 *
 * 用于 `chat_5`（对话活跃）与 `first_buddy` 的前置解锁。
 * 每条事件前应有 ≥1s 间隔（Go 侧 `reportGap = 1050ms`），由调用方在步骤间控节奏。
 */
export async function reportCli(
  ctx: { uid: string; accessToken: string },
  env: Env,
  events: Event[],
): Promise<ReportResult> {
  if (events.length === 0) return { ok: true, httpStatus: 0, detail: '无事件' }
  const bases = resolveUpstream(env)
  return await postReport(
    `${bases.billing}/v2/report`,
    billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    events,
  )
}

/**
 * 桌面指纹上报（chat 域）。
 *
 * ⚠️ 桌面事件的公共指纹由 `events.desktopFingerprint()` 注入到**每条**事件 ——
 * 服务端按 `machineId`/`extName` 判定是否来自桌面端。
 */
export async function reportDesktop(
  ctx: { uid: string; accessToken: string },
  env: Env,
  events: Event[],
): Promise<ReportResult> {
  if (events.length === 0) return { ok: true, httpStatus: 0, detail: '无事件' }
  const bases = resolveUpstream(env)
  return await postReport(
    `${bases.chat}/v2/report`,
    desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    events,
  )
}

/** Web 指纹上报（web 域）。用于 `Library_read` 等 web 端任务。 */
export async function reportWeb(
  ctx: { uid: string; accessToken: string },
  env: Env,
  events: Event[],
): Promise<ReportResult> {
  if (events.length === 0) return { ok: true, httpStatus: 0, detail: '无事件' }
  const bases = resolveUpstream(env)
  return await postReport(
    `${bases.web}/v2/report`,
    webHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    events,
  )
}

/** mp 指纹上报（billing 域，带 mp 头）。用于 `Sequential_Tasks_*` 与 `school_season`。 */
export async function reportMp(
  ctx: { uid: string; accessToken: string },
  env: Env,
  events: Event[],
): Promise<ReportResult> {
  if (events.length === 0) return { ok: true, httpStatus: 0, detail: '无事件' }
  const bases = resolveUpstream(env)
  return await postReport(
    `${bases.billing}/v2/report`,
    { ...mpHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }), 'X-Client-Platform': 'mp-weixin' },
    events,
  )
}

/**
 * 把公共指纹注入到每条事件（业务字段优先）。
 *
 * ⚠️ 顺序很重要：业务字段**覆盖**指纹字段。这样调用方可以显式对齐设备标识
 * （如 mp 任务覆盖 `machineId`），而不用改指纹函数。
 */
export function withFingerprint(events: Event[], fingerprint: Event): Event[] {
  return events.map((ev) => ({ ...fingerprint, ...ev }))
}

/**
 * 反探测脱敏：把文本里的渠道拦截码（裸 5 位与带连字符两种形态）改写。
 *
 * ## 为什么必须做
 *
 * 上游的**反探测**机制：请求体里只要出现裸 5 位拦截码就整单拦截，
 * 与上下文无关（`code=` / 裸码 / `错误码 ` 前缀全部命中），
 * 而相邻的 `11148` / `11101` / `11115` 均放行（Go 侧 `sanitize.go:70-76` 实测记录）。
 * 这个码**既表示拦截、又是拦截条件**，不改写必然失败。
 *
 * 改法：中间插 U+2011，保留可读性与指代。
 * ⚠️ 零宽空格**无效** —— 实测上游会先归一化再匹配。
 *
 * ## 🔴 历史上的两次静默失效
 *
 * 1. 2026-10-19 之前：`replaceAll` 的两个参数一字不差，单测又写成「输入 === 期望值」。
 * 2. 2026-10-19 的「修复」把判据换成了带连字符形态，裸码反而不再改写（2026-10-21 纠正）。
 *
 * ⚠️ **别凭肉眼判断两个字符串是否相同**，断言必须比对码点。
 */
export function sanitizeFingerprints(text: string): string {
  if (!text.includes(FP_BARE) && !text.includes(FP)) return text
  return text.replaceAll(FP_BARE, FP_SAFE).replaceAll(FP, FP_SAFE)
}

/** 递归改写结构里的**字符串值**（数字、布尔原样保留）。 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeFingerprints(value)
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[sanitizeFingerprints(k)] = sanitizeValue(v)
    return out
  }
  return value
}

/**
 * 对事件数组做脱敏：只改**字符串值**。
 *
 * ⚠️ 不能像以前那样在 `JSON.stringify` 结果上整串替换：毫秒时间戳等数字可能碰巧含这 5 位，
 * 整串替换会把数字改成非法 JSON，`JSON.parse` 直接抛错，整次上报失败。
 */
export function sanitizeEvents(events: Event[]): Event[] {
  const serialized = JSON.stringify(events)
  if (!serialized.includes(FP_BARE) && !serialized.includes(FP)) return events
  return sanitizeValue(events) as Event[]
}
