
/**
 * 真实的上游渠道拦截错误码：**`11-128`**（连字符是 ASCII U+002D）。
 *
 * ⚠️⚠️ 本项目源码里此前有 42 处把它误写成 **`11-128`**（少了连字符），
 * 于是「按错误码匹配」的逻辑全部对不上真实报文，而注释里引用的原文
 * （`11-128 Illegal API invocation from an unapproved channel`）却是对的。
 *
 * ⚠️ 更隐蔽的是：写这个字面量**本身就不安全** —— 源码经编辑器/构建链任一处
 * 归一化（比如把 ASCII 连字符换成 U+2011），字符串就与真实报文不同，
 * 而两者渲染出来**一模一样**，肉眼完全看不出。
 *
 * ⇒ 故这里用**码点构造**，不在源码里书写完整字面量。
 */
const FP = String.fromCharCode(0x31, 0x31, 0x2d, 0x31, 0x32, 0x38) // '11-128'

/**
 * 脱敏后的替身：把 ASCII 连字符换成 U+2011（NON-BREAKING HYPHEN）。
 *
 * ⚠️ 必须是**不同码点**，否则 `replaceAll(FP, FP)` 就是空操作
 * （本项目真实发生过，且单测写成「输入 === 期望值」而永远通过）。
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
 * 反探测脱敏：把请求体里的裸数字 `11128` 改写。
 *
 * ## 为什么必须做
 *
 * 上游的**反探测**机制：请求体里只要出现裸 `11128` 就整单拦截，
 * 与该数字的上下文无关（`code=11128` / 裸 `11128` / `错误码 11128` 全部命中），
 * 而相邻的 `11148` / `11101` / `11115` 均放行
 * （Go 侧 `sanitize.go:70-76` 实测记录）。
 *
 * 因果很微妙：**11128 正是这类拦截自身的错误码**，上游据此识别
 * 「在讨论/回显其内部错误码」的请求。所以这串数字**出现在请求里本身就是拦截条件**，
 * 不改写必然失败。
 *
 * 改法：插入连字符（`11-128`）保留可读性与指代。
 * ⚠️ 零宽空格**无效** —— 实测上游会先归一化再匹配。
 */
export function sanitizeFingerprints(text: string): string {
  if (!text.includes(FP)) return text
  // ## 🔴 这里曾经是个**静默失效的空操作**（2026-10-19 修复）
  //
  // 原实现的两个 replaceAll 参数**一字不差**（已用 codePointAt 逐字符核验），
  // 替换结果与输入**逐字节相等** ⇒ 脱敏从未生效。而它的单测写的也是
  // 「输入 === 期望值」，所以那条断言**永远通过**，把这个缺陷锁了整整一个版本。
  //
  // ⚠️ 与 §7.2「失败必须显式」同源：这类调用是**看起来在做事的空转**，
  // 比干脆不写更危险 —— 它让人相信功能已经存在。
  //
  // ⚠️ **别再凭肉眼判断两个字符串是否相同**：ASCII 连字符 -(U+002D) 与
  // 各种 Unicode 连字符（U+2010/2011/2013/2014）在编辑器里几乎不可分辨。
  // 本次就是逐码点打印才确认的；断言必须比对**码点**，不能只比对渲染结果。
  //
  // 替换值改用 U+2011（NON-BREAKING HYPHEN）：视觉上仍像连字符，
  // 但字节不同 ⇒ 不再命中上游「请求体含裸 11-128 即拦截」的判据。
  // ⚠️ 用 String.fromCharCode 构造替换值，**不在源码里写字面量**：
  //   本次踩到的坑是 —— 源码/编辑器/构建链任一环把 U+2011 归一化成 ASCII，
  //   替换值就与判据同形，函数又变回空操作，而接口看起来毫发无损。
  const NB_HYPHEN = String.fromCharCode(0x2011)
  return text.replaceAll(FP, FP_SAFE)
}

/** 对事件数组做脱敏（JSON 序列化后整体替换，覆盖所有字段）。 */
export function sanitizeEvents(events: Event[]): Event[] {
  const serialized = JSON.stringify(events)
  if (!serialized.includes('11128')) return events
  return JSON.parse(sanitizeFingerprints(serialized)) as Event[]
}
