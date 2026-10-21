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
