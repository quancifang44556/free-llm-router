/**
 * 会话 ID 稳定派生（**纯函数**，不碰网络、不碰存储）。
 *
 * ## ⚠️ 为什么必须稳定，而不是每请求现生成
 *
 * 上游国际服（`www.workbuddy.ai`）从 2026-10-20 起强校验**会话头族**：
 * 缺 `X-Conversation-ID` 等 5 个头直接 400 `11-128 request illegal`。
 * 补齐之后，`X-Conversation-ID` 的**取值语义**同样影响画像：
 *
 * - 官方客户端在同一个对话里**复用同一个** `X-Conversation-ID`，
 *   每轮用户发送复用同一个 `X-Conversation-Request-ID`；
 * - 网关如果每个请求现生成一个，等于把一次多轮对话拆成上千个「一次性会话」，
 *   是反作弊眼里最明显的非人类形态。
 *
 * ⇒ 按「账号 + 会话键」稳定派生：同一账号的同一会话多轮复用同一个 id，
 * 不同账号 / 不同会话互不相同。
 *
 * ## ⚠️ 为什么不能拿同一个 id 发给多个账号
 *
 * 那才是真正的关联键 —— 同一段会话 id 出现在两个账号的请求里，
 * 上游立刻能把两个号串起来。故派生的种子**必须包含 uid**。
 */

/** 32 位 hex（请求级 / 消息级 id，实测形态）。 */
function randomHex32(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * 把 16 个字节的十六进制串**就地**改写成 UUIDv4 形状（8-4-4-4-12）。
 *
 * ## ⚠️ 为什么不用 `h[6] = '4'` 那种写法（踩过的坑）
 *
 * 直觉上「版本位就是第 7 个字节，把它改成 `'4'`」—— 但那样**丢掉了原来的高半字节**，
 * 于是该字节从 2 个字符变成 1 个字符，整串少一位，产出一个 31 位 hex 的「假 UUID」，
 * 而且**不会报错**。本机实测多次复现（`...4338...` → `...438...`）。
 *
 * 正确做法是**字符串切片替换**：写进 2 个字符，长度天然守恒。
 * 这类「看上去等价、实际少一位」的 bug 正是最容易被指纹识别盯上的地方。
 */
function shapeAsUuidV4(hex32: string): string {
  if (hex32.length !== 32) throw new Error(`UUID 源长度异常：${hex32.length}`)
  // 版本位：第 7 个字节（索引 12..14）置为 `4x` —— 保留低 4 位随机性
  let out = `${hex32.slice(0, 12)}4${hex32.slice(13, 14)}${hex32.slice(14)}`
  // 变体位：第 9 个字节（索引 18..20）高 2 位置 `10`（即第三段首字符为 8/9/a/b）
  const variant = (Number.parseInt(out.slice(18, 20), 16) & 0x3f) | 0x80
  out = `${out.slice(0, 18)}${variant.toString(16).padStart(2, '0')}${out.slice(20)}`
  if (out.length !== 32) throw new Error(`UUID 长度异常：${out.length}`)
  return [out.slice(0, 8), out.slice(8, 12), out.slice(12, 16), out.slice(16, 20), out.slice(20)].join('-')
}

/**
 * 由「账号 + 会话键」稳定派生一个**带连字符的 UUID**（`X-Conversation-ID`）。
 *
 * @param uid 账号 uid（作为派生种子，保证跨账号不撞）
 * @param sessionKey 会话键（空串表示无法判定会话，此时退回随机，**不伪造稳定值**）
 */
export async function deriveIntlConversationId(uid: string, sessionKey: string): Promise<string> {
  if (sessionKey === '') return crypto.randomUUID()
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`conv:${uid}:${sessionKey}`),
  )
  // ⚠️ 用 `Array.from` 取字节数组再逐字节格式化 —— 不要用「数组元素就地改写」的写法
  let hex = ''
  for (const b of Array.from(new Uint8Array(digest)).slice(0, 16)) {
    hex += b.toString(16).padStart(2, '0')
  }
  return shapeAsUuidV4(hex)
}

/**
 * 一轮用户发送的 `X-Conversation-Request-ID`。
 *
 * 官方语义：在「一次 user send」开始时生成，这一轮里所有请求（含重试）复用它；
 * 只有消息级 id（`X-Request-ID` / `X-Conversation-Message-ID`）是每请求新生成。
 * 故必须由调用方在重试循环**外**生成一次再传进来，不能放在头构造函数里现生成。
 */
export function newTurnRequestId(): string {
  return randomHex32()
}

/** 供单测直接验证 UUID 改写逻辑（不导出到公共接口之外）。 */
export const __test = { shapeAsUuidV4 }
