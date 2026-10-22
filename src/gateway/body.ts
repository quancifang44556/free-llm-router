/**
 * 请求体大小上限（2026-10-21 审查补，安全面专项）。
 *
 * ## 缺陷
 * 全链路**没有任何请求体上限**：`await request.json()` 会把整个 body 缓冲进内存。
 * 实测一条 120 MiB 的请求 RSS 涨 **+322 MB**（约 2.7× 放大），
 * 且**读完之后**才因「无可用账号」失败 —— 没有 413，攻击者已经赢了。
 *
 * 更糟的是注释里写着「网关自己也有体积上限保护」——**那个保护不存在**。
 *
 * ## 为什么必须两道
 * 1. `content-length` 是**廉价预检**（能挡掉绝大多数）；
 * 2. 但它可被省略（`Transfer-Encoding: chunked`）或伪造，所以真正的防线是
 *    边读边计数、超限立刻 `reader.cancel()` —— 不把超量字节搬进内存。
 */

/** 默认上限：**8 MiB**。长上下文对话远小于此（1M token 的纯文本约 4 MB）。 */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024

/** `/admin/import` 单独放宽（要一次性导入多个账号的 auths/*.json）。 */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number, readonly observed: number) {
    super(`请求体过大：已超过 ${Math.round(limit / 1024 / 1024)} MiB 上限`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * 读 JSON，但**有硬上限**。
 *
 * ⚠️ 与 `request.json()` 的差别不是风格问题：后者会把整个 body 读进内存后才解析，
 * 前者在累计字节超过 `limit` 的**那一刻**就停止并断开上游流。
 */
export async function readJsonCapped(
  request: Request,
  limit: number = MAX_REQUEST_BYTES,
): Promise<unknown> {
  // ① 廉价预检：声明了就照声明拒（挡住绝大多数）
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    throw new BodyTooLargeError(limit, declared)
  }
  if (request.body === null) return undefined

  // ② 真正的防线：边读边计数
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > limit) {
        // ⚠️ 必须 cancel：否则底层 socket 会把剩余字节继续推进来
        await reader.cancel().catch(() => undefined)
        throw new BodyTooLargeError(limit, total)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }

  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  return JSON.parse(new TextDecoder().decode(buf)) as unknown
}

/**
 * 读文本但**只保留前 `limit` 字节**（多余部分直接丢弃，不驻留内存）。
 *
 * 🔴 用于**上游错误响应体**（2026-10-21 审查补，并发专项）：
 * 原来是 `const text = await response.text()` 然后再 `text.slice(0, 4096)` ——
 * 注释写的是「截断到 4KB」，实际**先把整包读进内存**再截。
 * 上游/WAF/强制门户回一个几 MB 的 HTML 时，单次错误就能把几 MB 搬进内存。
 */
export async function readTextCapped(response: Response, limit: number = 4096): Promise<string> {
  const { text } = await readTextCappedEx(response, limit)
  return text
}

/**
 * 同 {@link readTextCapped}，但**告诉你是否被截断**。
 *
 * 🔴 **为什么必须有这个返回值**（2026-10-22 事故复盘）。
 *
 * 我在并发专项里把上游响应改成「只读前 4 KiB」，本意是防止 WAF 回几 MB 的
 * HTML 时整包进内存。但我把这个上限用在了 `callUpstream()` —— 那是**所有
 * JSON 业务接口**（签到、余额、任务、补偿）的公共出口。
 *
 * 后果：余额接口对一个有 21 个积分包的账号返回约 15 KB，
 * 被截到 4 KiB ⇒ `JSON.parse` 失败 ⇒ `parseEnvelope` 返回 `undefined`
 * ⇒ `fetchBalance` 拿到空数组 ⇒ **total = 0**
 * ⇒ `updateBalance` 把真实积分（1976）**覆盖成 0**。
 *
 * 用户看到的就是「积分全变 0 了」，而日志写的是「余额刷新完成：成功 8 / 失败 0」——
 * 因为「解析失败」被当成了「成功且为 0」。
 *
 * ⇒ 截断必须**可知**：调用方要么给足预算，要么把「截断」当成错误，绝不当成空数据。
 */
export async function readTextCappedEx(
  response: Response,
  limit: number = 4096,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const room = limit - total
      if (room <= 0) {
        truncated = true
        break
      }
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room))
        total += room
        truncated = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    // ⚠️ 必须 cancel：否则底层 socket 会把剩余字节继续推进来
    await reader.cancel().catch(() => undefined)
    reader.releaseLock?.()
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  return { text: new TextDecoder().decode(buf), truncated }
}
