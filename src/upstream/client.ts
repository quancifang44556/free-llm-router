/**
 * 上游 HTTP 客户端与**错误分类**（决定「换号」还是「罚号」）。
 *
 * ## 这个模块为什么关键
 *
 * Go 侧有 13 种 `ErrKind`、12 层判定优先级（`internal/upstream/client.go:489-596`）。
 * 分类错误的后果是不对称的：
 * - 把「临时限流」当「账号死亡」→ **误杀健康账号**（Go 侧真实事故：
 *   13 个 disabled 号 refresh 全部成功，全是历史误判的受害者）；
 * - 把「账号死亡」当「临时限流」→ 反复打无效号，放大风控。
 *
 * ## 两条必须守住的判据（来自实测）
 *
 * 1. **WAF 判据只看 `403 + 无业务信封`**（`client.go:337-340`）。
 *    实测 APISIX 对「缺凭据」回的是 **401**，web 域甚至回 **302** ——
 *    把 401/302 也当 WAF 会产生**假警报**（本项目出口验证探针就踩过这个坑）。
 * 2. **12153 单次不算死亡**：连续 3 次才禁用（`state.go:27-40`）。
 */

import { readTextCapped } from '../gateway/body.js'
import type { HeaderMap } from './headers.js'

/** 上游业务信封（所有端点统一形态）。 */
export interface Envelope<T = unknown> {
  code: number
  msg: string
  data?: T
}

/**
 * 错误类别。
 *
 * ⚠️ 命名与 Go 的 `ErrKind` 有意保持可对照（便于查 Go 侧注释），
 * 但只保留第一版需要的子集（AGENTS.md §3.2 的范围裁剪）。
 */
export type ErrorKind =
  | 'network' // 网络层失败（连接重置/DNS/TLS）—— 可重试，不罚号
  | 'server' // 上游 5xx —— 可重试，喂熔断
  | 'rate_limited' // 429 / 6004 —— 换号 + 冷却；6004 是**模型级**
  | 'model_unavailable' // 11102：该后端无此模型 —— (账号,模型) 负缓存
  /**
   * **账号等级不支持该模型**（业务码 `11158`，`is not allowed for user type [...]`）。
   *
   * ⚠️ 与 `model_unavailable`(11102) 的区别（2026-10-20 实测捕获原文）：
   * - `11102` `service info not found` ⇒ **后端没有该模型**；
   * - `11158` `not allowed for user type [personal_free_user]` ⇒ **模型存在，档位不配用**。
   *
   * 两者都要做 (账号,模型) 负缓存，但证据强度不同（见 AccountPoolDO 的冷却阶梯）。
   */
  | 'model_denied'
  | 'credit_exhausted' // 402 / 14018 —— 硬冷却至次日 04:00
  | 'waf_blocked' // HTTP 403 且无业务信封 —— **可能是 IP 级**（会触发 IP 级判定）
  /**
   * **渠道指纹**被上游拒绝（业务码 `11128`，`unapproved channel`）。
   *
   * ⚠️ 与 `waf_blocked` 的**关键区别**（实测缺陷：我一度把两者混为一类）：
   * - `waf_blocked` 是 **HTTP 403 + 无业务信封** —— 典型的 WAF 拦截形态，
   *   有可能是**出口 IP 级**（多个账号会同时命中）⇒ 需要 IP 级判定；
   * - `channel_blocked` 是**正常的业务码响应**（`{"code":11128,...}`），
   *   只说明**这个请求的指纹**不被认可 —— **与出口 IP、与账号都无关**。
   *
   * ⇒ 混为一类会导致：每个账号的 11128 都被记成「IP 级 403 命中」，
   * 很快凑够阈值 ⇒ **误报「出口 IP 被 WAF 拦截」并全局停服**。
   *（`WAF_IP_THRESHOLD = 2`，而用户有 3 个账号，极易触发。）
   */
  | 'channel_blocked'
  | 'request_illegal' // 11140 —— 强信号，直接禁用账号
  | 'session_dead' // 12153 —— **连续 3 次**才禁用
  | 'context_exceeded' // 11115 —— 不罚号、不轮转
  | 'image_invalid' // 11135 —— 不罚号、不轮转
  /**
   * 请求**参数/协议形状**被上游拒绝（11101 / 11129 / 11133 / 11148 / 11150 / 11155）。
   *
   * 同一份请求换到任何账号都会被同样拒绝 ⇒ **不罚号、不换号**，如实回 400。
   * ⚠️ 上游有时用 5xx 包这些码；若落进 `server` 会喂熔断，把好账号逐个熔断掉
   *（workbuddy2api-hub 把它们列为 model-scoped，不计入账号故障）。
   */
  | 'bad_request'
  | 'auth_error' // 401 —— 续期凭据后重试
  | 'not_found' // 404 —— 路径不存在（可能需换 fallback 路径）
  | 'already_done' // 幂等命中（如签到 10001）—— 视为成功
  | 'unsupported' // 能力不支持（如 workbuddy 无签到）—— 跳过，不算失败
  | 'unknown'

/** 上游错误。`detail` 保留**原文片段**，便于定位（AGENTS.md §7.2 禁止静默失败）。 */
export class UpstreamError extends Error {
  readonly kind: ErrorKind
  readonly httpStatus: number
  readonly code: number | undefined
  readonly detail: string

  constructor(input: {
    kind: ErrorKind
    httpStatus: number
    code?: number
    message: string
    detail: string
  }) {
    super(input.message)
    this.name = 'UpstreamError'
    this.kind = input.kind
    this.httpStatus = input.httpStatus
    this.code = input.code
    this.detail = input.detail
  }
}

/**
 * 渠道校验失败的**字符串形态**（`"11-128"`）的归一化业务码。
 *
 * ⚠️ 参考实现（workbuddy2api-hub 回归用例、dsh-tencent-channel-fix）记录的是**数字**码
 *（已在 `CODE_KIND` 里直接登记）；本仓库 2026-10-20 的样本记录为带连字符的字符串。
 * 两种都认，不赌哪种。
 * JS 里没有「非数字但可比较」的码，故字符串形态归一成一个**不可能与真实业务码冲突**的负值。
 *
 * ⚠️ 取值必须是**字面量负数**：写成 `-11-128` 会被 JS 求值成算术表达式 `-11 - 128`（= `-139`），
 * 而 `-139` 是「看起来像业务码」的普通负值，日后极易与真码撞车且难以肉眼发现。
 * 现用 `-108128`（把连字符两侧原样拼接）——上游业务码全为正整数，负值永不冲突。
 */
export const CHANNEL_BLOCKED_CODE = -108128

/** 已知业务码 → 错误类别。数值来自 Go 侧实测。 */
const CODE_KIND: Record<number, ErrorKind> = {
  6004: 'rate_limited',
  11102: 'model_unavailable',
  14003: 'rate_limited',
  14018: 'credit_exhausted',
  /**
   * 🔴 **`10605` = 上游排队/容量不足**（2026-10-21 审查补，M3 指出）。
   *
   * ## 为什么必须登记（而不是让它落到 5xx 的 `server`）
   * `qoder.ts` 排队耗尽时抛 `ProviderError{httpStatus: 503}`（那次改写的目的是
   * 躲开「403 无信封 ⇒ 误判 WAF ⇒ 罚号」，见该处注释）。
   * 但**503 会落进 `classify` 的 5xx 分支 ⇒ `server` ⇒ `dimension: 'breaker'`**
   * ⇒ 3 次就把一个**完全健康**的号熔断 30 分钟起（指数翻倍）。
   *
   * 也就是说那次改写**把「罚 60 秒」换成了「熔断 30 分钟」**——
   * 修掉一个误判、造出一个更重的。这正是本项目「只修一半」的典型形态。
   *
   * ## 为什么归 `rate_limited`
   * 排队 = 上游暂时挤，语义上最接近「限流」；处置是
   * **换号 + 软冷却**，不再是熔断。且 `refineModelScoped` 也认 10605（模型级），
   * 于是最常见的形态是「只冷却这个模型，换个模型立刻可用」。
   */
  10605: 'rate_limited',
  /**
   * **qoder 业务码 `110`（`Billing daily count exceeded`）** —— 2026-10-21 实测定性。
   *
   * ## 它**不是**额度耗尽（这点我一开始搞错了）
   * 用户是专业版会员，明确说「不可能用尽」。实测 `/admin/accounts/balance`
   * 直连上游拿到 **`credits: 4565`（充足）**。上游原文的关键词是
   * **`count`（次数）**，不是 credits（额度）⇒ 这是**日调用次数**上限。
   *
   * ## 一次代价高昂的错误映射（必须记住）
   * 我最初把它映射成 `credit_exhausted`，而它的处置是 `dimension: 'hard'`
   * ⇒ **硬冷却到次日 04:00** ⇒ 账号被锁 **619 分钟（10.3 小时）**，
   * 而账号完全健康、额度充足。**把语义未明的码映射到最重的处置，代价远大于收益。**
   *
   * ## 为什么现在映射成 `rate_limited`
   * - 语义对：日次数上限就是一种限流；
   * - **代价小**：`rate_limited` → `dimension: 'soft'`（60 秒，非 10 小时）；
   * - **单账号池下不产生持久冷却**：`deferSoft()` 在 `poolSize === 1` 时把 soft
   *   压进 `blame` 延迟记账，全失败则**丢弃**（不记账）⇒ 账号不会被锁；
   * - 文案诚实：错误里显示 `rate_limited:` 而非 `auth_error:`，
   *   客户端不会再误报「API 密钥无效」。
   *
   * ⚠️ 若将来确认 110 是**账号级**日上限（而非模型级），应改成 `dimension: 'model'`
   * 并携带 `resetAt`（次日 00:00），让它只冷却该模型而不是账号。
   */
  110: 'rate_limited',
  14017: 'rate_limited',
  11158: 'model_denied',
  11140: 'request_illegal',
  12153: 'session_dead',
  11115: 'context_exceeded',
  11135: 'image_invalid',
  // ── 请求形状类（与账号无关，见 `bad_request` 的说明） ──
  11101: 'bad_request', // 参数反序列化失败（如 stop 传了字符串、arguments 传了对象）
  11129: 'bad_request', // 工具 schema 不合法
  11133: 'bad_request', // tool_call 名字为空等
  11148: 'bad_request', // tool_call 配对/顺序断裂
  11150: 'bad_request', // reasoning_effort 该模型不支持
  11155: 'bad_request', // 思考模式下缺上一轮 reasoning_content
  // 11134「模型供应方暂不可用」：模型级繁忙，与 6004/14003 同档（见 `refineModelScoped`）
  11134: 'rate_limited',
  // ⚠️ **11128 不是 `request_illegal`**（实测缺陷，用户报「账号是好的但就是用不了」）。
  //
  // 上游原文：`Illegal API invocation from an unapproved channel` /
  // `The request was blocked by security policy.`
  //
  // 关键区别：
  // - `11140`（真正的 request_illegal）是**这个账号发了非法请求** ⇒ 该罚账号；
  // - `11128` 是**请求的渠道指纹不被认可** ⇒ 与账号无关，罚账号是错的。
  //
  // ⚠️ 而且 11128 还是上游**反探测机制自身的错误码**（AGENTS.md §6.6）：
  // 请求体里出现裸 `11128` 就会触发它。也就是说这个码**既表示拦截、又是拦截条件**。
  //
  // ⚠️ 归类为 **`channel_blocked`（不是 `waf_blocked`）**：
  // 两者都要「软冷却 + 不换号」，但 `waf_blocked` 还会触发**IP 级判定**
  //（`noteWaf`）—— 而 11128 与出口 IP **无关**，用它触发 IP 判定会**误报全局封锁**。
  // 这正是「有的软件能用、有的不能」的原因：凑够 2 个账号就整体停服 60 秒。
  [CHANNEL_BLOCKED_CODE]: 'channel_blocked',
  // ⚠️ **数字形态**（`{"code":<5 位数字>,"msg":"Illegal API invocation…"}`）：
  // workbuddy2api-hub 的回归用例与 dsh-tencent-channel-fix 都记录为这种写法。
  // 2026-10-19 只登记了字符串形态，数字码因此落到 `unknown` ⇒ provider 路径按 `breaker`
  // 记账，连续 3 次就把健康账号熔断 30 分钟 ——「官方客户端能用、经网关不能用」的又一来源。
  // 用数字分隔符书写，源码里不出现裸 5 位串（见 `report.ts` 文件头）。
  [11_128]: 'channel_blocked',
  // 幂等命中：签到已领（视为成功）
  10001: 'already_done',
  1001: 'already_done',
  14051: 'already_done',
}

/** 判定响应体是否为「业务信封」形态。支持纯 JSON 与 SSE（带 data: 前缀）形态。 */
export function parseEnvelope(text: string): Envelope | undefined {
  let trimmed = text.trim()
  // 支持 SSE 单帧或多行帧（提取 data: 后面的内容）
  if (trimmed.startsWith('data:')) {
    trimmed = trimmed.slice(5).trim()
  } else if (!trimmed.startsWith('{') && trimmed.includes('data:')) {
    const lines = trimmed.split('\n')
    for (const line of lines) {
      const l = line.trim()
      if (l.startsWith('data:')) {
        const candidate = l.slice(5).trim()
        if (candidate.startsWith('{')) {
          trimmed = candidate
          break
        }
      }
    }
  }

  // ⚠️ 报文可能**不是纯 JSON**：provider 层会把上游原文包进一句中文
  //   `供应商「WorkBuddy」请求失败：{"code":11158,...}`
  // 且内层引号可能**已被转义**（`{\"code\":11158}`）。
  // `ProviderError` 分支正是拿这种 message 再喂给本函数的（见 server.ts），
  // 所以这里必须能从任意位置取出 JSON，并容忍转义引号。
  //
  // 实现刻意保持**单遍、无正则回溯**：用栈式扫描找配对 `}`，
  // 不依赖「整串是合法 JSON」这个过强前提。
  if (!trimmed.startsWith('{')) {
    if (trimmed.includes('\\"')) trimmed = trimmed.replace(/\\"/g, '"')
    const from = trimmed.indexOf('{')
    if (from < 0) return undefined
    let depth = 0
    let inStr = false
    let esc = false
    let to = -1
    for (let i = from; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') {
        inStr = true
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          to = i
          break
        }
      }
    }
    if (to < 0) return undefined
    trimmed = trimmed.slice(from, to + 1)
  }
  try {
    const value = JSON.parse(trimmed) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const obj = value as Record<string, unknown>

    /**
     * 🔴 **【实测缺陷】qoder 的「外层信封包内层业务码」形态**（2026-10-21）。
     *
     * qoder 加密端点在**鉴权失败时也回 HTTP 200**，错误装在第一帧：
     * ```
     * data:{"headers":{…},"body":"{\"code\":\"105\",\"message\":\"Login expired\"}",
     *       "statusCodeValue":403,…}
     * ```
     * 特征：**顶层没有 `code`，业务码藏在 `body` 字符串里**，真实状态码在 `statusCodeValue`。
     *
     * 旧实现只认顶层 `code` ⇒ 这个信封被判为「不是信封」⇒
     * `isWafBlocked(403, …)` 命中 ⇒ **`waf_blocked` ⇒ 罚账号 + 软冷却 60 秒**。
     * 而它其实是 `105 Login expired`（**登录过期**），正确处置是**触发续期**，
     * 完全不该罚号 —— 单账号池下这等于整条链路中断 60 秒。
     *
     * 这一层不负责 unwrap（provider 的 `asError` 已经做了），只负责**认出**：
     * 只要有 `body` 字符串里含业务码，就把内层码当信封码返回。
     */
    if (obj.code === undefined && typeof obj.body === 'string' && obj.body.trim() !== '') {
      const inner = parseEnvelope(obj.body)
      if (inner !== undefined) return inner
    }

    /**
     * 🔴 **双层嵌套：`{"error":{"data":{"code":14018,...}}}`**（2026-10-21 实测缺陷）。
     *
     * ## 真实故障
     * workbuddy 的「额度耗尽」回的是：
     * ```
     * HTTP 429  {"error":{"data":{"code":14018,
     *            "msg":"Credits exhausted. Please visit the link below to purchase add-on packs"}}}
     * ```
     * 顶层**没有 `code`**，业务码在 `error.data.code` 里（比上面那个 `body` 形态又深一层）。
     *
     * ## 后果（比「少一条日志」严重）
     * `parseEnvelope` 返回 `undefined` ⇒ `classify(429, …)` 拿不到业务码
     * ⇒ 落到「429 ⇒ `rate_limited`」⇒ **`soft`（60 秒）**
     * 而 `CODE_KIND[14018] = 'credit_exhausted'` ⇒ 本该 **`hard`（冷却到次日 04:00）**。
     *
     * ⇒ 一个**真的没额度**的号每 60 秒被重新选中一次，反复打上游、反复失败，
     *   而面板上它看起来「只是被限流」，用户完全看不出「这个号没钱了」。
     *   实测日志：`[punish] uid=workbudd kind=soft reason=workbuddy http=429: {...14018...}`
     *
     * ## 兼容形态
     * 两种都要认（都不带顶层 `code`）：
     * - `{"error":{"code":X,…}}` —— 标准 OpenAI 风格
     * - `{"error":{"data":{"code":X,…}}}` —— workbuddy 实测风格
     *
     * ⚠️ 只有拿到**有限数字码**才返回信封：否则 `{"error":{"message":"…"}}`
     * 这类「只有消息没有码」的响应会被误判成「有信封」，
     * 进而让 `isWafBlocked` 放过真正的 WAF 拦截页。
     */
    if (obj.code === undefined && obj.error !== null && typeof obj.error === 'object') {
      const outer = obj.error as Record<string, unknown>
      const deep = outer.data !== null && typeof outer.data === 'object'
        ? (outer.data as Record<string, unknown>)
        : undefined
      const carrier = outer.code !== undefined ? outer : deep
      if (carrier !== undefined) {
        const rawInner = carrier.code
        const innerCode =
          typeof rawInner === 'number'
            ? rawInner
            : typeof rawInner === 'string' && rawInner.trim() !== ''
              ? Number(rawInner)
              : Number.NaN
        if (Number.isFinite(innerCode)) {
          const pickMsg = (o: Record<string, unknown>): string =>
            typeof o.msg === 'string' ? o.msg : typeof o.message === 'string' ? o.message : ''
          return {
            code: innerCode,
            msg: pickMsg(carrier) || pickMsg(outer),
            data: carrier.data,
          }
        }
      }
    }

    const raw = obj.code
    // ⚠️ 上游有两种码形态：数字（`6004`）与**带连字符的字符串**（`"11-128"`）。
    // 后者是渠道校验失败的真实形态，`Number("11-128")` = NaN，
    // 原实现直接 `return undefined` ⇒ 整条响应被当成「无信封的裸 400/429」，
    // 分类与错误文案全部丢失（实测：网关只回一个含糊的 400）。
    // 这里把 `NN-NNN` 归一成一个稳定的负值，让 `classify` 能认出来。
    // ⚠️ 不能放宽成「任何字符串码都归一」：只有 `数字-数字` 形态才是 11-128 这一类；
    // 其他字符串（如 `"6004"`）仍交给下面按数字解析，否则会把可识别的码误判成渠道拦截。
    // ⚠️ 连字符可能是**非 ASCII 的 U+2011**：`11‑128` 的真实字节是
    // `31 31 E2 80 91 31 32 38` —— 中间那个不是 `-`，而是 U+2011（非断连字符）。
    // 旧正则 `/^\d+-\d+$/` 只认 ASCII `-`，于是这个码**始终匹配不上**，
    // `parseEnvelope` 返回 undefined，整条信封被丢弃、最终落回 `server`。
    if (typeof raw === 'string' && /^\d+[\u2010-\u2015\u2212\uFF0D-]\d+$/.test(raw.trim())) {
      return {
        code: CHANNEL_BLOCKED_CODE,
        msg: typeof obj.msg === 'string' && obj.msg !== '' ? obj.msg : raw.trim(),
        data: obj.data,
      }
    }
    const code =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : Number.NaN
    if (!Number.isFinite(code)) return undefined
    return {
      code,
      msg: typeof obj.msg === 'string' ? obj.msg : '',
      data: obj.data,
    }
  } catch {
    return undefined
  }
}

/**
 * WAF 判据：**HTTP 403 且响应体无业务信封**。
 *
 * ⚠️ 逐字照抄 Go 的 `IsWafBlocked`（`client.go:337-340`）。
 * 两个最容易被误加的判据：
 * - **401 不是 WAF**（实测 APISIX 对缺 Authorization 就是 401）；
 * - **302 不是 WAF**（web 域 `/console/account` 对未授权回 302 跳登录）。
 * 把它们当 WAF 会让「凭据过期」看起来像「IP 被封」，排查方向完全错。
 */
export function isWafBlocked(httpStatus: number, bodyText: string): boolean {
  if (httpStatus !== 403) return false
  if (parseEnvelope(bodyText) !== undefined) return false
  /**
   * 🔴 **2026-10-21 加固：我们自己的中文错误文案绝不能被判成 WAF。**
   *
   * ## 真实故障（`[waf-403]` 日志抓到的原文）
   * ```
   * body=Qoder 服务繁忙：排队等待已超过 45 秒（已尝试 4 次，实际等待 32 秒）。
   *      请稍后重试 —— 这是上游排队，不是账号或配置问题。
   * ```
   * 这段话**是 `qoder.ts` 自己生成的**（`ProviderError` 的 message），
   * 而该 ProviderError 沿用了上游 10605 排队响应带的 **HTTP 403**。
   * 于是 `403 + 非信封` ⇒ `waf_blocked` ⇒ **罚健康账号 + 冷却 60 秒**。
   *
   * ⇒ 判据必须加一条：**含中日韩字符的文本不可能是 WAF 返回**。
   * WAF（APISIX / EdgeOne）返回的是英文/HTML 拦截页，绝不会是中文业务文案。
   * 我们所有 `ProviderError` 的 message 都是中文，加上这条即可整类排除。
   *
   * ⚠️ 为什么不是"按 ProviderError 判断"：`classify()` 只收 `(status, bodyText)`，
   * 拿不到错误来源。语言判据是在这个签名约束下最可靠的区分手段。
   */
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(bodyText)) return false
  return true
}

/**
 * 分类一次响应。
 *
 * 判定顺序即语义（Go 侧 12 层优先级的精简版，保留了顺序敏感的部分）：
 * 1. WAF（403 无信封）—— 必须**最先**判，否则会被通用 4xx 分支吃掉；
 * 2. 5xx → `server`；
 * 3. 信封里的业务码 → 对应类别；
 * 4. 401/403（有信封或非 403）→ `auth_error`；
 * 5. 404 → `not_found`；
 * 6. 其余 → 按状态码粗分。
 */
export function classify(httpStatus: number, bodyText: string): { kind: ErrorKind; code?: number; msg: string } {
  // ── 1. WAF：必须最先判 ──
  if (isWafBlocked(httpStatus, bodyText)) {
    return { kind: 'waf_blocked', msg: 'WAF blocked (403 without business envelope)' }
  }

  const envelope = parseEnvelope(bodyText)

  // ── 2. 5xx ──
  //
  // ⚠️ **已知业务码优先于 5xx 状态码**（2026-10-20 实测捕获的真实缺陷）。
  //
  // 上游在网关侧出错时用 **502 包裹业务信封**，例如：
  //   HTTP 502 + {"code":11158,"msg":"model [x] is not allowed for user type [...]"}
  // 旧实现把 5xx 判在业务码之前 ⇒ 这类被一律成 `server`（账号级，喂熔断），
  // 连续几次就把好账号熔断掉 —— 「账号是好的却用不了」的第二条来源。
  //
  // 判据要**足够窄**：只有信封里的 code 属于已知业务码时才越过 5xx，
  // 否则真网关故障（HTML/无信封/未知码）仍必须落 `server`。
  if (httpStatus >= 500) {
    const known = envelope !== undefined ? CODE_KIND[envelope.code] : undefined
    if (known !== undefined && envelope !== undefined) {
      return { kind: known, code: envelope.code, msg: envelope.msg }
    }
    return { kind: 'server', code: envelope?.code, msg: envelope?.msg ?? `upstream ${httpStatus}` }
  }

  // ── 3. 业务码（有信封时优先按码判） ──
  if (envelope !== undefined) {
    const mapped = CODE_KIND[envelope.code]
    if (mapped !== undefined) {
      return { kind: mapped, code: envelope.code, msg: envelope.msg }
    }
    // ── 3b. 码已归一但仍落在表外的兜底 ──
    //
    // ⚠️ 字符串形态的 `{"code":"11-128"}` 已在 `parseEnvelope` 里归一成 `CHANNEL_BLOCKED_CODE`，
    // 走上面的 `CODE_KIND` 查表，**不需要**再嗅原始文本。我曾在此处按 `"11-128"` 正则兜底，
    // 结果同一个码有两条判据（一条查表、一条正则），改一处漏一处；现已删除，保持单一来源。
    if (envelope.code === 0) {
      return { kind: 'unknown', code: 0, msg: envelope.msg }
    }
    // 有信封但码未知：按 HTTP 状态兜底（0 码以外的业务错误）
    if (httpStatus === 401 || httpStatus === 403) {
      return { kind: 'auth_error', code: envelope.code, msg: envelope.msg }
    }
    if (httpStatus === 429) {
      return { kind: 'rate_limited', code: envelope.code, msg: envelope.msg }
    }
    return { kind: 'unknown', code: envelope.code, msg: envelope.msg }
  }

  // ── 4. 无信封：按状态码 ──
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: 'auth_error', msg: `upstream ${httpStatus}` }
  }
  if (httpStatus === 404) {
    return { kind: 'not_found', msg: 'upstream 404' }
  }
  if (httpStatus === 429) {
    return { kind: 'rate_limited', msg: 'upstream 429' }
  }
  if (httpStatus === 402) {
    return { kind: 'credit_exhausted', msg: 'upstream 402' }
  }
  if (httpStatus >= 400) {
    return { kind: 'unknown', msg: `upstream ${httpStatus}` }
  }

  return { kind: 'unknown', msg: `unexpected status ${httpStatus}` }
}

/** 该错误类别是否「值得换号重试」。 */
/**
 * 该错误类别是否值得**换号重试**。
 *
 * 🔴 **唯一判据是 `mapErrorToPunishment()`**（2026-10-21 审查补，重复实现专项）。
 *
 * 这里原来是一份**手写的 switch**，与 `gateway/server.ts` 里的
 * `mapErrorToPunishment()` 平行维护 —— 然后已经漂了：
 * `shouldPunish('channel_blocked')` 返回 `true`（罚账号），
 * 而活路径的 `mapErrorToPunishment('channel_blocked').punish` 是 `false`
 *（渠道指纹被拒**不罚号**，罚了会误伤健康账号并误报「IP 被拦」）。
 *
 * 死代码不影响运行，但它是一份**看起来权威的相反结论**：
 * 下次有人按它「修」一处分支，就会把已修好的缺陷重新引回来。
 * ⇒ 改为委托，物理上不可能再漂。
 */
export function shouldRotate(kind: ErrorKind): boolean {
  return mapErrorToPunishment(kind).rotate
}

/**
 * `11140`（账号被限制）默认**不换号**，与 workbuddy2api-hub #422/#425 口径一致。
 *
 * 设 `RESTRICTED_ROTATE_MAX` 为正数可恢复旧行为（同一请求内换号继续），仅供排查 ——
 * 旧行为会把池子里的号逐个拖进上游的**设备级**限制（社区实测 7 号一次任务全封），
 * 生产环境**不要**开。
 */
function restrictRotateAllowed(): boolean {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'RESTRICTED_ROTATE_MAX'
  ]
  if (raw === undefined || raw.trim() === '') return false
  const n = Number(raw)
  return Number.isFinite(n) && n > 0
}

export function mapErrorToPunishment(kind: ErrorKind): {
  punish: boolean
  dimension: 'soft' | 'hard' | 'breaker' | 'degrade' | 'session_dead' | 'model' | 'restricted'
  /** 该错误是否值得**换号重试**。 */
  rotate: boolean
} {
  switch (kind) {
    // 限流：可能是账号级（14017）或模型级（6004）—— 调用方用错误码进一步区分
    case 'rate_limited':
      return { punish: true, dimension: 'soft', rotate: true }
    // 该后端无此模型：模型级负缓存，换号**可能**有用（不同号挂不同后端）
    case 'model_unavailable':
      return { punish: true, dimension: 'model', rotate: true }
    // 11158「模型存在但账号档位不支持」：也是模型维度负缓存。
    // 换号**有意义**——不同账号档位不同（付费号能用免费号用不了的模型）。
    // ⚠️ 与 `model_unavailable` 分开成一类，是为了让冷却策略拿到不同的证据强度：
    // 档位拒绝属于确定性拒绝，而 11102 的文案极易由「模型名前缀拼错」触发。
    case 'model_denied':
      return { punish: true, dimension: 'model', rotate: true }
    // 余额耗尽：硬冷却到次日 04:00，换号有用
    case 'credit_exhausted':
      return { punish: true, dimension: 'hard', rotate: true }
    // WAF（HTTP 403 无信封）：账号级软冷却；但可能是 IP 级（详见 AGENTS.md §2.6），换号无用
    case 'waf_blocked':
      return { punish: true, dimension: 'soft', rotate: false }
    // ⚠️ 渠道指纹被拒（业务码 11128）：**不罚账号、不换号、不触发 IP 判定**。
    //
    // ## 为什么连软冷却都不该做（实测缺陷，用户报两处 503）
    //
    // `11128 "unapproved channel"` 说的是**这个请求的渠道指纹**不被认可。
    // 它有两种可能来源：
    //   A. 我们的指纹本身有问题（版本 / 头部不对）⇒ **所有账号都会命中**，
    //      罚任何一个账号都毫无意义（换个号还是同样指纹）；
    //   B. 上游对某个账号的风控升级 ⇒ 那才该罚该账号。
    //
    // ⚠️ A 是最可能的情形，而旧实现（把它当 `waf_blocked` / `request_illegal`）
    // 会**惩罚本来健康的账号**，制造两个假故障：
    //   ① 账号逐个进软冷却 ⇒ 客户端看到「1 个账号都在冷却中，约 30 分钟后恢复」；
    //   ② 每次命中都被记成「IP 级 403」⇒ 凑够 `WAF_IP_THRESHOLD = 2`
    //      就**误报「出口 IP 被 WAF 拦截」并全局停服**
    //      （用户报「两个都是正常的，但显示 IP 被拦」）。
    //
    // ⇒ 正确处置：**如实把错误返回给客户端**，同时**不再轮转**
    //（换号无用，只会把同样的渠道判定打给更多账号）。
    // 这也解释了用户说的「有的软件能用、有的不能」——
    // 差别在**请求指纹**，不在账号。
    case 'channel_blocked':
      return { punish: false, dimension: 'soft', rotate: false }
    // 请求非法（上游 11140）：**账号级封禁，换号有用**。
    //
    // ⚠️⚠️ 这里此前判 `rotate: false`，理由是「换号无用（同样的非法请求）」——
    // 但那是把 11140 与 11128 混为一谈。2026-10-21 抓到上游原文，两者语义完全不同：
    //
    //   code 11140 / HTTP 403 →
    //     {"msg":"request illegal",
    //      "displayMsg":{"zh":"账号存在异常行为，已被限制使用",
    //                    "en":"Your account has been restricted due to unusual activity"},
    //      "displayTips":{"zh":"系统检测到该账号存在异常使用行为，如需申诉请提交反馈"}}
    //
    // 上游说的是 **this account has been restricted** —— 罚的是**这一个账号**，
    // 与请求内容、与其它账号都无关。`rotate: false` 的后果是：
    // 一个被封的号会把整个 provider 拖死（每次都只撞它，好号永远轮不到），
    // 实测就出现过「三个 WB 号里只有 z 被封，另两个完好却全线不可用」。
    //
    // ⇒ 罚该号（breaker），但**绝不换号继续打**。
    //
    // ⚠️⚠️ **2026-10-21 修正**：此前这里判 `rotate: true`，依据是「罚的是单号、
    // 所以换号有用」。换号**确实能绕过**这个坏号，但那正是上游风控要抓的行为：
    //
    //   workbuddy2api-hub #422/#425 实测 —— 在 11140 上「冷却该号后立刻换下一个号
    //   继续同一请求」，一个请求最多遍历整个池子，**用户 7 个号在一次任务里全被封**。
    //   社区复盘（Zhengyuuuui/workbuddy2api 事件复盘）的红线原文是：
    //   「看到 11140 立即停手，解封前严禁换号继续打同一设备 —— 设备指纹会连坐」。
    //
    // 机制：11140 是**设备/出口维度**的账号标记（同一台"设备"上的其它号会被连带
    // 判定），所以「换号」不改变被盯上的设备，只会把更多无辜账号送进同一个标记里。
    // 本项目实测的「三个 WB 号里只有 z 被封、另两个完好」是**封禁前**的状态；
    // 一旦开始轮转，完好的号也会被逐个拖进去（这正是连坐）。
    //
    // ⇒ 正确处置：罚该号 + **不换号**，把限制原因如实交给客户端。
    //    下一次**独立**请求自然会落到别的号（上游已给它记上 `restrictedUntil`，
    //    见 AccountPoolDO 的持久化），不需要在同一个请求里硬换。
    //    要把旧行为调回来的运维口子见 `RESTRICTED_ROTATE_MAX`。
    case 'request_illegal':
      return { punish: true, dimension: 'restricted', rotate: restrictRotateAllowed() }
    // session 死亡：连续 3 次才禁用；换号有用
    case 'session_dead':
      return { punish: true, dimension: 'session_dead', rotate: true }
    // 5xx：喂熔断；换号有用
    case 'server':
      return { punish: true, dimension: 'breaker', rotate: true }
    // 鉴权失败：续期凭据后重试，**不罚号**（换号可能有用）
    case 'auth_error':
      return { punish: false, dimension: 'soft', rotate: true }
    // 参数类：**不换号**（换号会重放同样的非法请求，放大风控）
    case 'context_exceeded':
    case 'image_invalid':
    case 'bad_request':
      return { punish: false, dimension: 'soft', rotate: false }
    // 网络层：抖动量，不构成「这个号坏了」的证据；也不该立刻换号（可能是本地出口抖动）
    case 'network':
      return { punish: false, dimension: 'soft', rotate: false }
    case 'not_found':
    case 'already_done':
    case 'unsupported':
    case 'unknown':
      return { punish: false, dimension: 'soft', rotate: false }
  }
}

/** 该错误类别是否应当「罚账号」（改变持久化惩罚状态）。语义同 {@link shouldRotate}。 */
export function shouldPunish(kind: ErrorKind): boolean {
  return mapErrorToPunishment(kind).punish
}

/** 一次上游调用的选项。 */
export interface RequestOptions {
  method: 'GET' | 'POST'
  url: string
  headers: HeaderMap
  body?: string
  /** 超时（毫秒）。默认 30s。 */
  timeoutMs?: number
  /** 外部取消信号（如客户端断开）。 */
  signal?: AbortSignal
}

/** 一次上游调用的结果。 */
export interface UpstreamResponse<T = unknown> {
  ok: boolean
  httpStatus: number
  envelope: Envelope<T> | undefined
  /** 原始响应体（截断到 4KB，仅用于错误诊断）。 */
  raw: string
}

/**
 * 发一次上游请求并解信封。
 *
 * ⚠️ **不 throw**：把分类结果交回调用方，由它决定换号/罚号（Go 侧同口径）。
 * 只有网络层错误会 throw（因为那时没有 HTTP 语义可分类）——
 * 但也包装成 `UpstreamError` 便于统一处理。
 *
 * ⚠️ **响应体大小限制**：`raw` 截断到 4KB。上游错误页可能很大，
 * 全量读入会浪费 10ms CPU 预算且对诊断无益。
 */
export async function callUpstream<T = unknown>(options: RequestOptions): Promise<UpstreamResponse<T>> {
  const timeoutMs = options.timeoutMs ?? 30_000

  // 组合外部信号与超时（AbortSignal.any 在 Workers 可用）
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal])

  let response: Response
  try {
    response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal,
      redirect: 'manual',
    })
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new UpstreamError({
      kind: 'network',
      httpStatus: 0,
      message: `上游请求失败：${message}`,
      detail: message,
    })
  }

  // ⚠️ 只读前 4 KiB：注释说的「截断到 4KB」原先只是**读完之后**才 slice，
  // 上游回一个几 MB 的错误页时会整包进内存（并发专项实测）。
  const text = await readTextCapped(response, 4096)
  const raw = text
  const envelope = parseEnvelope(text) as Envelope<T> | undefined

  // 网络层「成功但业务失败」也走信封：code !== 0 视为 not ok
  const ok = response.status >= 200 && response.status < 300 && (envelope === undefined || envelope.code === 0)

  return { ok, httpStatus: response.status, envelope, raw }
}

/**
 * 发一次请求，**业务失败直接抛 `UpstreamError`**。
 *
 * 便利包装，用于那些「失败就该中断当前步骤」的调用点。
 * 需要按类别分支处理时用 {@link callUpstream} 裸接口。
 */
export async function mustUpstream<T = unknown>(options: RequestOptions): Promise<Envelope<T>> {
  const res = await callUpstream<T>(options)
  if (res.ok && res.envelope !== undefined) {
    return res.envelope
  }

  const { kind, code, msg } = classify(res.httpStatus, res.raw)
  throw new UpstreamError({
    kind,
    httpStatus: res.httpStatus,
    code,
    message: `上游错误（${kind}）：${msg || res.raw.slice(0, 200)}`,
    detail: res.raw,
  })
}
