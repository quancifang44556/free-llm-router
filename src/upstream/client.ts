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
export function shouldRotate(kind: ErrorKind): boolean {
  switch (kind) {
    case 'rate_limited':
    case 'model_unavailable':
    // 11158 档位不支持 ⇒ 换到别的档位账号可能可用
    case 'model_denied':
    case 'credit_exhausted':
    case 'server':
    case 'auth_error':
    case 'session_dead':
    case 'waf_blocked':
      return true
    // ⚠️ `request_illegal`（11140）**不换号** —— 与 `mapErrorToPunishment` 同一口径。
    // 依据 workbuddy2api-hub #422/#425：11140 是**设备/出口维度**的账号标记，
    // 换号不改变被盯上的设备，只会把更多无辜账号送进同一个标记
    // （社区实测：一个请求遍历整池，7 个号一次任务全被封）。
    // 下一次**独立**请求自然会落到别的号，不需要在同一请求里硬换。
    // ⚠️ 参数类错误**不换号**：换号重试会重放同样的非法请求，放大风控。
    case 'context_exceeded':
    case 'image_invalid':
    case 'bad_request':
    // ⚠️ 11140 是**账号级封禁**（上游原文 `Your account has been restricted`），
    // 换号有用 —— 见 `clientStatusFor` 上方注释里抓到的完整响应体。
    // 只有 11128（渠道指纹）才是「换号无用」。
    case 'channel_blocked':
    // 11140 与 11128 一样不换号，但理由不同：
    // 11128 换的是「请求指纹」不成立，11140 换的是「设备」不成立。
    case 'request_illegal':
    case 'network':
    case 'not_found':
    case 'already_done':
    case 'unsupported':
    case 'unknown':
      return false
  }
}

/** 该错误类别是否应当「罚账号」（改变持久化惩罚状态）。 */
export function shouldPunish(kind: ErrorKind): boolean {
  switch (kind) {
    case 'rate_limited':
    case 'model_unavailable':
    case 'model_denied':
    case 'credit_exhausted':
    case 'waf_blocked':
    case 'session_dead':
    case 'request_illegal':
    case 'server':
    // ⚠️ 渠道拦截：**软冷却**（短退避），不是熔断 —— 它不说明账号坏了。
    case 'channel_blocked':
      return true
    case 'network':
    case 'auth_error':
    case 'not_found':
    case 'context_exceeded':
    case 'image_invalid':
    case 'bad_request':
    case 'already_done':
    case 'unsupported':
    case 'unknown':
      return false
  }
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

  const text = await response.text()
  const raw = text.slice(0, 4096)
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
