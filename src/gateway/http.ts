/**
 * HTTP 响应助手（OpenAI 兼容形状）。
 *
 * 单独一个文件是为了避免**循环 import**：`server.ts` 需要 `jsonError`，
 * 而 `models.ts` 也需要它 —— 若放在 `server.ts` 里就会形成环。
 */

/** JSON 响应。 */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** JSON 错误响应（OpenAI 兼容形状：`{error:{message,type,code}}`）。 */
export function jsonError(status: number, message: string, code: string): Response {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 解析标准 `Retry-After` 头 → 毫秒。
 *
 * ## 为什么放在共享层而不是某个 provider 里
 *
 * 它是 **HTTP 标准头**，与任何供应商无关。原先它只存在于 `opencode.ts`，
 * 而**别处也需要**（网关的模型级冷却要据此对齐上游墙钟）。
 * 放在 provider 里会逼着网关去 import 一个供应商模块 —— 层次颠倒。
 *
 * ## ⚠️ 只放行**纯数字**秒数
 *
 * `Date.parse('900')` 会得到 1970 年的时刻，算出巨大负数，
 * 再被 `Math.max(0, …)` 夹成 0 ⇒ 刚被限流的账号**马上又被选中**，
 * 形成无限空转。故先判纯数字，再退回 `Date` 解析（HTTP-date 形式）。
 */
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after')
  if (raw === undefined || raw === null || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}
