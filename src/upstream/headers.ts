/**
 * 四套客户端指纹头族（**纯函数**，不碰网络、不碰存储）。
 *
 * ## 为什么这个模块必须是纯函数
 *
 * AGENTS.md §5 的分层纪律：Go 侧这些是纯 map 构造，最适合用单测锁死形状。
 * 上游改判据时**只改这一部分**，执行逻辑不动。
 *
 * ## 四套指纹的由来（AGENTS.md §6.1）
 *
 * 任务计分都走 `POST /v2/report`，但**不同任务认不同客户端指纹**：
 *
 * | 指纹 | Base | 判别性字段 |
 * |---|---|---|
 * | CLI | `www.codebuddy.cn` | `agentName:"default"`, `agentType:"conversation"`, `mode:"craft"` |
 * | 桌面 | `copilot.tencent.com` | `ideName/ideType:"WorkBuddy"`, `extName:"workbuddy-desktop"` |
 * | Web | `www.workbuddy.cn` | `x-client-platform: web`, `pageURL`/`elementId` |
 * | mp | `www.codebuddy.cn` | `ideType:"WorkBuddy_MP"`, `platform:"mini_program"` |
 */

/**
 * 客户端版本号（写进 UA 与 `X-IDE-Version`）。
 *
 * ## ⚠️ 为什么从 `5.5.4` 改成 `5.5.6`（实测依据）
 *
 * 原值 5.5.4 是照抄 Go 侧 `headers.go:61-67` 的**默认值**，而那个默认值是**旧的**：
 *
 * 1. AGENTS.md §6.1 记录的**桌面端实测 UA** 是 `WorkBuddy/5.5.6`；
 * 2. 本仓库自己的 `realtime.ts:222` 在**同一个端点**
 *    （`/v2/chat/completions`）上写的是 `'X-IDE-Version': '5.5.6'`
 *    —— 同一个仓库里两个版本号本身就是不一致。
 *
 * ⚠️ 版本号是上游判定**渠道是否被认可**的输入之一（`11128
 * "Illegal API invocation from an unapproved channel"`）。
 * 旧版本可能被划入「不认可的渠道」，而这与账号本身是否有效**无关**。
 *
 * ⚠️ 这里**不编造**更新的版本号：只对齐到**本仓库内已有依据**的那个值
 * （桌面端实测 + realtime 一致）。若上游继续升版，应重新实测后再改。
 */
export const CLIENT_VERSION = '5.5.6'
export const CLI_VERSION = '2.137.1'
/** 桌面端实测 UA（`desktop.go:43`）。 */
export const DESKTOP_VERSION = '5.5.6'
export const DESKTOP_CLI_VERSION = '2.137.1'

/** CN CLI 三段式 UA（`headers.go:61-67`）。 */
export function cliUserAgent(): string {
  return `WorkBuddy/${CLIENT_VERSION} WorkBuddy/${CLIENT_VERSION} CLI/${CLI_VERSION}`
}

/**
 * **国际版**（workbuddy.ai）的三段式 UA。
 *
 * ## 🔴 与国内版的差别只在中间那段：`WorkBuddy AI`
 *
 * ```
 * 国内版: WorkBuddy/5.5.2 WorkBuddy/5.5.2    CLI/5.5.2
 * 国际版: WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2
 *                         ^^^^^^^^^^^ 多了 " AI"
 * ```
 *
 * ⚠️ 这不是装饰：**上游据此判定「渠道是否被认可」**，用错形态会回
 * `11128 Illegal API invocation from an unapproved channel`
 *（而 `displayMsg` 把它**伪装成「安全策略拦截」**，极易误判成账号被封）。
 *
 * 依据：参考实现 `src/product.ts:70` 的 `WORKBUDDY_UA_INTL`
 *（`deepseek-harness-codearts`）。
 */
export function cliUserAgentIntl(): string {
  // ⚠️ **三段都用国际版自己的版本号 5.5.2**（与 `X-IDE-Version` 一致）。
  //
  // 参考实现逐字是 `WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2`
  //（`product.ts:70`），三段**同值**。
  // 我一度写成 `WorkBuddy/5.5.6 … CLI/2.137.1`（混了国内版段），
  // 那与 `X-IDE-Version: 5.5.2` **自相矛盾** —— 同一请求里两个版本号，
  // 正是「渠道指纹」最容易露馅的地方。
  return `WorkBuddy/${CLIENT_VERSION_INTL} WorkBuddy AI/${CLIENT_VERSION_INTL} CLI/${CLIENT_VERSION_INTL}`
}

/**
 * **国内版**（CodeBuddy，`copilot.tencent.com`）的 UA。
 *
 * ## 🔴 与国际版是**完全不同的格式**（实测缺陷：我一度把国际版的值套到国内版）
 *
 * ```
 * 国内版: CodeBuddyIDE/1.106.1
 * 国际版: WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2
 * ```
 *
 * ⚠️ 国内版**不是**三段式、也**不含 `WorkBuddy`** —— 它是 IDE 客户端的形态。
 * 依据：参考实现 `src/product.ts:309` / `src/buddy.ts:89` 的
 * `userAgent: 'CodeBuddyIDE/1.106.1'`。
 *
 * ⚠️ 三个归属头（`X-IDE-Name` / `X-IDE-Type` / `X-Product`）在国内版也要发
 * **`CodeBuddy`**（`product.ts:311` 的 `attributionName`），不是 `WorkBuddy`。
 * 发错会让后台「使用端」归因错误（参考实现对此有专门注释：
 * 早年误发 `SaaS` 导致后台归因不到产品）。
 */
export const CODEBUDDY_USER_AGENT = 'CodeBuddyIDE/1.106.1'

/** 国内版的客户端版本号（`X-IDE-Version`）。 */
export const CODEBUDDY_CLIENT_VERSION = '1.106.1'

/**
 * 国际版的客户端版本号。
 *
 * ⚠️ 参考实现国际版用 **5.5.2**（`src/product.ts:484`），而国内版 CodeBuddy 用
 * `clientVersion: '1.106.1'` / `cliVersion: '2.137.1'`。
 * 我们此前对两个变体都用同一组国内版版本号 —— 那也是渠道指纹不匹配的来源之一。
 */
export const CLIENT_VERSION_INTL = '5.5.2'

/**
 * 国际服**桌面端** 5.8.4 的 UA（2026-10-16 抓包 + 2026-10-20 本机实测 200）。
 *
 * ## ⚠️ 中段是小写 `workbuddy-ai`，不再是旧的 `WorkBuddy AI`
 *
 * 旧值 `WorkBuddy/… WorkBuddy AI/…` 是 v0.1.1 时代照抄参考实现的形态，**已失效**：
 * 上游 2026-10-20 起把国际服的渠道指纹判据换成了桌面端 5.8.4 的那一套，
 * 用旧 UA 一律回 `11-128 request illegal`。UA 是这套判据的输入之一，
 * 与账号是否有效无关（5 个账号用同一套头全部 11-128 已证实），
 * 故这里逐字对齐抓包，连大小写都不能改。
 */
export const INTL_DESKTOP_UA = 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0'
/** 国际服桌面端版本号，必须与 `INTL_DESKTOP_UA` 自洽（同一请求里两个版本号就是露馅点）。 */
export const INTL_DESKTOP_VERSION = '5.8.4'

/**
 * 国际服的**会话头族**（5 个）。
 *
 * ## ⚠️ 为什么这 5 个缺一不可
 *
 * 上游 2026-10-20 起给国际服加了会话头族强校验。实测单变量对照：
 * 只补前 3 个仍 11-128（甚至退化成 429/14003），补到第 5 个才 200。
 * 它属于**渠道指纹**的一部分，缺任意一个都判「不是官方客户端发的」。
 *
 * Base 与 chat 端点不同：`X-Conversation-ID` 在这里也要发，
 * 而 `cliChatHeaders` 那套（国内口径）是「空则不发」——那是国内服的规矩，别混用。
 *
 * @param input 空值一律现生成：宁可退化也不缺头，缺头的代价是整条请求被拒。
 */
export function intlConversationHeaders(input: {
  /** 会话 ID：同一会话恒定（上游据此把多轮归到一条会话）。 */
  conversationId?: string
  /** 轮级 ID：一次用户发送内恒定（重试复用，否则上游看到的是新的一轮）。 */
  turnRequestId?: string
}): HeaderMap {
  const conversationId =
    input.conversationId !== undefined && input.conversationId !== ''
      ? input.conversationId
      : crypto.randomUUID()
  const turnRequestId =
    input.turnRequestId !== undefined && input.turnRequestId !== '' ? input.turnRequestId : randomHex32()
  // 消息级 ID 必须**每请求新生成**：它与轮级 ID 相等就等于承认「同一个请求重发了」
  const messageId = randomHex32()
  return {
    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': turnRequestId,
    'X-Root-Request-ID': turnRequestId,
    'X-Conversation-Message-ID': messageId,
    // ⚠️ 与消息级 ID 同值（抓包实测如此），上游会交叉校验这两行的对应关系
    'X-Request-ID': messageId,
  }
}

/**
 * ⚠️ **会话链路 ID**（b3 追踪头）—— 补上「链式请求」这一机器特征。
 *
 * ## 为什么需要（同类项目封禁复盘的真实结论）
 *
 * 官方 IDE 的请求是**链式**的：同一个对话里 multi-turn 请求共享同一条链路，
 * 且每请求都带 b3 追踪头；而第三方反代发的是**孤立请求**（既无会话 id、也无 trace），
 * 这本身就是可识别的机器特征。上游 2026-10-20 起加的渠道校验（`11‑128`）
 * 判的是「头部身份 + **会话头族**」，故补齐链路能直接缓解。
 *
 * ## 各字段的语义（与抓包口径一致）
 *
 * | 头 | 稳定性 | 形态 |
 * |---|---|---|
 * | `X-Conversation-ID` | 同一客户端会话内**稳定** | 带连字符 UUID（见 `intlConversationHeaders`） |
 * | `X-Conversation-Request-ID` | 每请求新生成（重试由调用方复用） | 32 位 hex |
 * | `X-Conversation-Message-ID` | 每请求**必然**新生成 | 32 位 hex |
 * | `X-B3-TraceId` | 同一会话内**稳定**（一条链路 = 一个 trace） | 32 位 hex |
 * | `X-B3-SpanId` | 每请求新生成 | 16 位 hex |
 * | `X-B3-Sampled` | 恒 `1`（官方客户端全量采样） | — |
 *
 * ## ⚠️ trace id 为什么跟着**会话**而不是每请求随机
 *
 * b3 的语义里 trace 代表**一条调用链**，span 代表链上的一次调用。
 * 官方 IDE 的多轮对话天然是「一条 trace、多个 span」；若我们每请求换 trace，
 * 就退回成「一堆互不相干的单 span 请求」，正是复盘里指出的那个特征。
 * ⇒ `deriveTraceId32(conversationId)`：同会话恒定、跨会话/跨账号互不相同
 * （会话 id 本身已按「账号+会话」派生，故这里不需要再掺 uid）。
 *
 * ⚠️ 会话 id 无法判定时（客户端没给 `user` / `conversation_id`）**退化为每请求随机**，
 * 且绝不从消息内容推断 —— 本项目纪律：宁可「不粘」也不能「错误地粘」。
 */
/**
 * 会话链**运行时开关**（面板「防封」分区控制，见 `SafetyConfig.sessionTrace`）。
 *
 * ## ⚠️ 为什么是模块级变量而不是参数
 *
 * 组装头的调用点有三处（`models.ts` 列目录、`buddy.ts` 发对话、内部委派），
 * 而后者在 provider 内部、拿不到网关层的配置。要一路透传就得改
 * `Provider.chat` 的签名 —— 为一个**全局唯一**的开关改一层接口不划算。
 *
 * ## ⚠️ 并发安全
 *
 * 该配置是**全局单值**（整个服务一个值），不存在「不同请求要不同值」的情况，
 * 故模块级变量不会读串。若将来要按账号区分配置，必须改成参数透传。
 */
let sessionTraceEnabled = true

/** 设置会话链开关（由网关按面板配置刷新）。 */
export function setSessionTraceEnabled(enabled: boolean): void {
  sessionTraceEnabled = enabled
}

/** 当前开关状态（供测试断言）。 */
export function isSessionTraceEnabled(): boolean {
  return sessionTraceEnabled
}

export function sessionTraceHeaders(input: {
  /** 客户端显式会话标识派生出的会话 id（空/缺省 ⇒ 每请求随机）。 */
  conversationId?: string
  /** 轮级 id：重试须复用（调用方在重试循环外算一次），缺省则现生成。 */
  turnRequestId?: string
} = {}, includeB3 = true): HeaderMap {
  // ⚠️⚠️ 这里**千万不能**整段 return {}。
  //
  // `intlConversationHeaders` 那 5 个会话头是 v0.1.2 为修「11‑128 渠道拦截
  // 被误判成限流」而加的**必需头**：缺任一个上游直接回 11‑128，请求根本发不出去。
  // 我第一版把开关写成「关掉 ⇒ 一个头都不发」，等于把这个开关做成了
  // 「一键封掉国际服」—— 比不做开关更糟。
  //
  // 所以开关只作用在**本轮新增的 b3 三件套**上（那是可选的行为化特征，
  // 没有它服务照常工作）；会话头族**恒发**。
  // ⚠️ 会话头族复用 `intlConversationHeaders`，**不另写一份**：
  // 两处各写一遍必然分叉（本项目已多次踩过「同一概念两套判据」）。
  // 它返回的 5 个头一条都不能少（缺任一个上游就回 11‑128）。
  const conversation = intlConversationHeaders({
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.turnRequestId === undefined ? {} : { turnRequestId: input.turnRequestId }),
  })
  const conversationId = conversation['X-Conversation-ID'] ?? ''
  return {
    ...conversation,
    // b3 受两道闸门控制：
    // ① `includeB3`（调用方按变体决定）—— ⚠️ **国内版必须传 false**，
    //    否则上游判「两套 trace 并存」回 `11-128 request illegal`；
    // ② 面板开关 `sessionTraceEnabled`。
    ...(sessionTraceEnabled && includeB3 ? b3TraceHeaders({ conversationId }) : {}),
  }
}

/**
 * b3 追踪头三件套（`X-B3-TraceId` 32 hex / `X-B3-SpanId` 16 hex / `X-B3-Sampled: 1`）。
 *
 * ⚠️ 头名用 `X-B3-TraceId` 这种 Zipkin 规范写法，与本文件其余头的风格一致
 *（HTTP 头名大小写不敏感，且 HTTP/2 会统一小写，故不影响上游解析）。
 */
export function b3TraceHeaders(input: { conversationId?: string } = {}): HeaderMap {
  const conversationId = input.conversationId ?? ''
  return {
    // 会话可判定 ⇒ 稳定（一条链路）；不可判定 ⇒ 随机（仍必须存在，缺头代价更大）
    'X-B3-TraceId': conversationId === '' ? randomHex32() : deriveTraceId32(conversationId),
    'X-B3-SpanId': randomHex16(),
    'X-B3-Sampled': '1',
  }
}

/**
 * 由种子**稳定派生** 32 位 hex（b3 trace id 形态，同步、无依赖）。
 *
 * ⚠️ 与 `deriveDeviceId`（`crypto.subtle`，异步）刻意不同：头构造函数必须同步，
 * 故用四路 FNV-1a 32 位混合拼出 128 位。它只需要「同种子同值、异种子不撞」，
 * 不需要密码学强度（trace id 不含任何秘密）。
 */
export function deriveTraceId32(seed: string, salt = 'trace'): string {
  return `${fnv1a32Hex(`${salt}:${seed}#0`)}${fnv1a32Hex(`${salt}:${seed}#1`)}${fnv1a32Hex(
    `${salt}:${seed}#2`,
  )}${fnv1a32Hex(`${salt}:${seed}#3`)}`
}

/**
 * FNV-1a 32 位 → 8 位 hex（含两轮搅动）。
 *
 * ⚠️ 搅动必须写成 `h = (h ^ (h >>> 15)) >>> 0`：复合赋值 `h ^= h >>> 15`
 * 会把「右移结果」**赋回** h（等价于 `h = h >>> 15`），高位全丢、尾部变短。
 */
function fnv1a32Hex(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  h = (h ^ (h >>> 15)) >>> 0
  h = Math.imul(h, 0x2545f491) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/**
 * 国际服的**设备头**（2 个）：`X-Machine-ID` + `X-Session-ID`。
 *
 * ## ⚠️ 为什么必须补（2026-10-20 二次实测）
 *
 * 会话头族补齐后，国际服又会按**设备维度**限流：实测同时用 3 个账号各发一条，
 * 首条拿 200、后两条 429 `14003 Model busy`；串行重试时同一账号反复 14003。
 * 而官方客户端一定带 `X-Machine-ID`（OS 硬件 UUID，每台设备恒定）。
 *
 * 网关是一个长驻进程同时冒充多台设备 —— 若在进程维度取一次，所有账号共用同一个
 * machineId，那就是把整池账号关联到同一台机器上（比不发更糟）。故**按账号稳定派生**：
 * 同一账号恒定、账号之间互不相同，等价于「每个账号一台虚拟设备」。
 *
 * 形态按抓包：`machineId` / `sessionId` 都是**带连字符的 UUID**。
 * 用户若传了真实设备标识就用用户的（更贴近真实客户端），否则派生。
 *
 * ⚠️ 这里**不做** SHA-256（`crypto.subtle` 是异步的，构造函数必须是同步的）；
 * 派生用同步的 FNV-1a 32 位四路混合，足以保证「同账号稳定 + 跨账号不撞」。
 */
export function intlDeviceHeaders(input: {
  uid: string
  /** 真实设备标识（可选）：来自凭据里的 machineId / deviceId，有则优先用。 */
  machineId?: string
  sessionId?: string
}): HeaderMap {
  const uid = input.uid
  return {
    'X-Machine-ID': input.machineId !== undefined && input.machineId !== ''
      ? input.machineId
      : deriveUuidLike(`machine:${uid}`),
    'X-Session-ID': input.sessionId !== undefined && input.sessionId !== ''
      ? input.sessionId
      : deriveUuidLike(`session:${uid}`),
  }
}

/**
 * 由任意种子稳定派生一个**带连字符的 UUIDv4 形状**字符串（同步、无依赖）。
 *
 * 用于设备标识：同一账号每次得到同一个值，不同账号得到不同的值。
 * 四段 FNV-1a 用不同盐跑，避免「不同种子撞在同一段前缀」。
 */
export function deriveUuidLike(seed: string, salt = ''): string {
  /** FNV-1a 32 位 → 8 位 hex（分段用不同后缀，避免各段高度相关）。 */
  const chunk = (suffix: string): string => fnv1a32Hex(`${salt}${seed}#${suffix}`)
  // ⚠️ 每个字段必须**精确按段宽**取字符（8-4-4-4-12）。
  // 曾写过「把某个数组元素改成 `'4'`」的版本 —— 那会丢掉该字节的高半字节，
  // 整串少一位，产出一个**不报错**的「假 UUID」。这里用纯字符串切片，长度天然守恒。
  const hex = `${chunk('a')}${chunk('b')}${chunk('c')}${chunk('d')}`.slice(0, 32)
  const versioned = `${hex.slice(0, 12)}4${hex.slice(13)}`
  const variant = (Number.parseInt(versioned.slice(16, 18), 16) & 0x3f) | 0x80
  const v = `${versioned.slice(0, 16)}${variant.toString(16).padStart(2, '0')}${versioned.slice(18)}`
  return [v.slice(0, 8), v.slice(8, 12), v.slice(12, 16), v.slice(16, 20), v.slice(20)].join('-')
}

/** 桌面端 UA（`desktop.go:43`）。 */
export function desktopUserAgent(): string {
  return `WorkBuddy/${DESKTOP_VERSION} WorkBuddy/${DESKTOP_VERSION} CLI/${DESKTOP_CLI_VERSION}`
}

/** billing 域的单段 UA（`headers.go:88`）。 */
export function billingUserAgent(): string {
  return `WorkBuddy/${CLIENT_VERSION}`
}

/** Web 域的 Chrome UA（Go 侧 web 事件用）。 */
export function webUserAgent(): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`
}

/**
 * 由 uid **稳定派生**一个 36 位 hex 设备标识。
 *
 * `deriveID(uid, salt) = sha256(salt + ":" + uid)` 取前 18 字节 → 36 hex
 * （`desktop.go:51-53`）。**同账号恒同值** —— 模拟固定设备，避免每次请求
 * 都像一台新机器（那本身就是风控信号）。
 *
 * @param salt `machine` / `session` / `webmachine` 等，不同用途用不同 salt。
 */
export async function deriveDeviceId(uid: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${uid}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  // 取前 18 字节 → 36 个 hex 字符
  const bytes = new Uint8Array(digest).subarray(0, 18)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** mp 指纹的 machineId 是**硬编码常量**（Go 侧 `school.go:113-116`）。 */
export const MP_MACHINE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234'

/** 外观/主题任务用的固定资源键（Go 侧实测 `theme-tkmw7j`）。 */
export const APPEARANCE_THEME_KEY = 'theme-tkmw7j'

/** 请求头集合（普通对象，便于单测断言与 JSON 序列化）。 */
export type HeaderMap = Record<string, string>

/**
 * CN CLI 通用头（`internal/upstream/headers.go:147-172` 的 `CommonHeaders`）。
 *
 * ⚠️ `X-CodeBuddy-Request: 1` 是**官方客户端风控闸门头，所有 API 请求必带**
 * （Go 侧记为 D1）。少了它上游可能判定为非官方客户端。
 */
export function cliCommonHeaders(input: {
  uid: string
  machineId: string
  sessionId: string
  /**
   * 该请求属于哪个变体（默认国内版 buddy）。
   *
   * ⚠️ **必须按变体切换**（实测缺陷）：国际版端点
   *（`www.workbuddy.ai`）与国内版（`copilot.tencent.com`）**要求不同的渠道指纹**。
   * 用国内版指纹打国际版端点会回
   * `11128 unapproved channel`（伪装成「安全策略拦截」）。
   *
   * ## 参考实现的对照（`deepseek-harness-codearts/src/product.ts`）
   *
   * | 项 | 国内版 CodeBuddy | 国际版 WorkBuddy |
   * |---|---|---|
   * | `apiDomain`/`X-Domain` | `copilot.tencent.com` | `www.workbuddy.ai` |
   * | `productCode`/`X-Product-Code` | `codebuddy` | `workbuddy` |
   * | UA 中段 | `WorkBuddy` | **`WorkBuddy AI`** |
   * | `clientVersion` | `1.106.1` | `5.5.2` |
   */
  variant?: 'buddy' | 'workbuddy'
}): HeaderMap {
  const intl = input.variant === 'workbuddy'
  // ⚠️ `X-Domain` 必须与**实际请求的端点**一致，否则身份与目的地址自相矛盾 ——
  // 参考实现对此有明确注释（`buddy-adapter.ts:1958-1966`）。
  const domain = intl ? 'www.workbuddy.ai' : 'copilot.tencent.com'
  const webOrigin = intl ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: webOrigin,
    Referer: `${webOrigin}/`,
    // ⚠️ UA 按变体切换（中段 `WorkBuddy AI` 只在国际版出现）
    'User-Agent': intl ? cliUserAgentIntl() : cliUserAgent(),
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN',
    'X-Machine-ID': input.machineId,
    'X-Session-ID': input.sessionId,
    // ⚠️ 以下三个头**原先完全缺失**（实测缺陷），而参考实现必发：
    // 它们共同构成「渠道归属」指纹。
    'X-Domain': domain,
    'X-Product-Code': intl ? 'workbuddy' : 'codebuddy',
  }
}

/**
 * **参考实现口径**的 chat 出站头（`deepseek-harness-codearts`）。
 *
 * ## ⚠️ 为什么需要它与 `cliChatHeaders` 并存（实测对比的结论）
 *
 * 用户报「在 DSH 用参考插件几乎没失败过，而你这里问题一堆」。
 * 逐行对比后发现**两套头的差异很大**：
 *
 * | 头 | 参考实现（不失败） | 我们原先（11128） |
 * |---|---|---|
 * | `Accept` | **`text/event-stream`** | `application/json, text/event-stream` |
 * | `X-Domain` | ✅ `www.workbuddy.ai` | ❌ 缺失 |
 * | `X-Product-Code` | ✅ `workbuddy` | ❌ 缺失 |
 * | `Origin`/`Referer` | ❌ **不发** | ✅ 发（国内域名） |
 * | `X-Requested-With` / `X-CodeBuddy-Request` | ❌ 不发 | ✅ 发 |
 * | `X-Machine-ID` / `X-Session-ID` | ❌ 不发 | ✅ 发 |
 * | `X-Conversation-Request-ID` 等 4 个 | ❌ 不发 | ✅ 发 |
 *
 * 参考实现只发 **11 个**头（`buddy-adapter.ts:1950-1982`）。
 * 我们那批多余的头来自 **Go 侧的实现**（`internal/upstream/headers.go`），
 * 而那套口径在国际版端点上**不被认可** ⇒ `11128 unapproved channel`。
 *
 * ⇒ 这里按**参考实现逐字对齐**：只发它发的那些。
 *
 * ## ⚠️ 国际服分支已于 2026-10-20 换成「桌面端 5.8.4 + 会话头族」
 *
 * 上表的 11 个头仍能打**国内服**，但上游给国际服换了判据：只发这 11 个一律回
 * `11-128 request illegal`（5 个账号同款结果 ⇒ 判的是请求头，不是账号）。
 * 单变量实测：补上场会话头族即 200；只改 UA 或只改 `X-IDE-Version` 都还是 400。
 * 故国际服分支按抓包逐字发 5.8.4 桌面端身份，并附 `intlConversationHeaders()`。
 * 国内服分支**一个字都不动**——它的现行口径实测仍然 200。
 *
 * @param input 与 `cliChatHeaders` 相同的输入（保留形参以便将来切换）
 */
export function referenceChatHeaders(input: {
  uid: string
  accessToken: string
  variant?: 'buddy' | 'workbuddy'
  /** 国际服会话 ID（同一会话恒定）。拿不到就省略，函数内部兜底生成。 */
  conversationId?: string
  /** 真实设备标识（凭据里带的 machineId / deviceId），有则优先于派生的稳定值。 */
  machineId?: string
  /** 真实会话标识（凭据里带的 sessionId）。 */
  sessionId?: string
  /** 国际服轮级 ID（重试须复用，否则上游视作新的一轮）。拿不到就省略。 */
  turnRequestId?: string
}): HeaderMap {
  if (input.variant === 'workbuddy') return intlReferenceChatHeaders(input)

  const headers: HeaderMap = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    // ⚠️ 与端点一致（参考实现 `buddy-adapter.ts:1969`）
    'X-Domain': 'copilot.tencent.com',
    'X-Product-Code': 'codebuddy',
    'X-Agent-Purpose': 'conversation',
    // ⚠️ **归属名按变体切换**：国内版是 `CodeBuddy`，国际版是 `WorkBuddy`
    //（参考实现 `product.ts:311` 的 `attributionName`）。
    // 发错会让后台「使用端」归因错误。
    'X-IDE-Name': 'CodeBuddy',
    'X-IDE-Type': 'CodeBuddy',
    'X-IDE-Version': CODEBUDDY_CLIENT_VERSION,
    'X-Product': 'CodeBuddy',
    // ⚠️ UA 是**完全不同的格式**（不是同一个模板换段）：
    // 国内版 `CodeBuddyIDE/1.106.1`，国际版 `WorkBuddy/… workbuddy-ai/…`。
    'User-Agent': CODEBUDDY_USER_AGENT,
  }
  if (input.accessToken !== '') headers.Authorization = `Bearer ${input.accessToken}`
  return headers
}

/**
 * 国际服参考口径的 chat 头（桌面端 5.8.4 身份 + 会话头族）。
 *
 * 单独抽出来只是为了让 `referenceChatHeaders` 的两个变体各自可读；
 * **判据依据见 `referenceChatHeaders` 上方那段实测记录**，这里不再重复。
 */
function intlReferenceChatHeaders(input: {
  uid: string
  accessToken: string
  conversationId?: string
  turnRequestId?: string
  machineId?: string
  sessionId?: string
}): HeaderMap {
  // ⚠️ 官方值就是 `SaaS`（部署类型），不是产品名 `WorkBuddy` ——
  // 与 `X-IDE-Name` 分工不同，发成 `WorkBuddy` 会被判身份不自洽。
  const headers: HeaderMap = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': INTL_DESKTOP_VERSION,
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'X-Domain': 'www.workbuddy.ai',
    'User-Agent': INTL_DESKTOP_UA,
    // ⚠️ 设备头（2026-10-20 二次实测：只补会话头族仍会被按设备维度 429 14003）
    ...intlDeviceHeaders({
      uid: input.uid,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    }),
    // 会话头族 + **仅国际版**追加 b3 链路头。
    //
    // ⚠️⚠️ **国内版发 b3 会让 WorkBuddy 全线 `11-128 request illegal`**
    //（2026-10-21 实测：三个国内版账号逐一熔断，用户报「WB 号好像都被封了」）。
    //
    // 定位过程：把 `sessionTrace` 开关关掉后，同一个请求立刻 200 并正常出字；
    // 打开就 `request_illegal: request illegal`。这是**唯一变量**，故根因确定。
    //
    // 原因：国内版指纹是 **CLI 口径**（`cliChatHeaders` 已自带 `X-Trace-ID`），
    // 而 b3 是**另一套 trace 体系**。两套并存 ⇒ 上游看到自相矛盾的链路标识，
    // 判为非法调用。参考实现的对照表也写着「我们多发了一批头，
    // 在国际版端点上不被认可」—— b3 正好又犯了一次同样的错。
    //
    // 正确切分：**国际版**（workbuddy）要 b3（渠道要求链路可串联）；
    // **国内版**（buddy）不要，它只认自己那套 CLI 头。
    ...sessionTraceHeaders(
      {
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.turnRequestId === undefined ? {} : { turnRequestId: input.turnRequestId }),
      },
      // 国际版**要** b3：渠道要求链路可串联，且它的指纹是桌面口径，
      // 与 b3 不冲突（国内版才冲突，见 `referenceChatHeaders` 主分支的说明）。
      true,
    ),
  }
  if (input.accessToken !== '') {
    headers.Authorization = `Bearer ${input.accessToken}`
    // ⚠️ 抓包里的 `X-User-Id` 是**裸 uid**，不带 `workbuddy:` 前缀 ——
    // 账号池里存的是带前缀的形态，直接透传会让「用户」与「令牌」对不上。
    const uid = input.uid.replace(/^workbuddy:/, '')
    if (uid !== '') headers['X-User-Id'] = uid
  }
  return headers
}

/** chat 出站头：在 common 之上加鉴权与会话头族（`headers.go:198-268`）。 */
export function cliChatHeaders(input: {
  uid: string
  machineId: string
  sessionId: string
  accessToken: string
  /** `X-Conversation-Request-ID`：轮级聚合主键，**必发**。 */
  conversationRequestId: string
  /** `X-Conversation-ID`：入站透传值，空则不发（不伪造）。 */
  conversationId?: string
  /** 变体（见 `cliCommonHeaders` 的说明）。默认国内版。 */
  variant?: 'buddy' | 'workbuddy'
}): HeaderMap {
  const headers: HeaderMap = {
    ...cliCommonHeaders(input),
    // ⚠️ **必须精确是 `text/event-stream`**（实测缺陷）。
    //
    // 我们此前发的是 `application/json, text/event-stream`（多一个 json 偏好），
    // 而参考实现逐字发 `text/event-stream`（`buddy-adapter.ts:1954`）。
    //
    // ⚠️ 上游会把它当作**渠道指纹**的一部分 —— 对不上就回
    // `11128 Illegal API invocation from an unapproved channel`
    //（伪装成「安全策略拦截」）。这类「多一个字符就不认」的判据在本项目里
    // 出现过多次（如 UA 中段的 ` AI`），故**逐字对齐参考实现**。
    Accept: 'text/event-stream',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': input.variant === 'workbuddy' ? CLIENT_VERSION_INTL : CLIENT_VERSION,
    // ⚠️ `X-Product` 发的是**产品归属名**，不是部署类型 `SaaS`。
    // Go 侧 `product.ts:113-118` 记录过：早年误发 `SaaS` 导致后台归因不到产品。
    'X-Product': 'WorkBuddy',
    // 轮级聚合主键 + 消息级 id
    'X-Conversation-Request-ID': input.conversationRequestId,
    'X-Conversation-Message-ID': randomHex32(),
    'X-Root-Request-ID': input.conversationRequestId,
    'X-Trace-ID': input.conversationRequestId,
  }

  if (input.accessToken !== '') {
    headers.Authorization = `Bearer ${input.accessToken}`
    headers['X-User-Id'] = input.uid
  } else {
    // 缺省字段用 X-No-* 约定（与官方 CLI 一致）
    headers['X-No-Authorization'] = '1'
    headers['X-No-User-Id'] = '1'
  }

  // ⚠️ 只有非空才发：空串会让上游误判为「显式要求空会话」
  if (input.conversationId !== undefined && input.conversationId !== '') {
    headers['X-Conversation-ID'] = input.conversationId
  }

  // ⚠️ 国际服还要补齐会话头族：上面的 4 个是**国内口径**，上游给国际服另加了一条校验，
  // 缺 `X-Request-ID` 等头会回 `11-128 request illegal`（逐头累加实测：补到最后一个才 200）。
  // 这一步**不改国内分支的任何值**，只在国际服上覆盖/补齐同名头。
  if (input.variant === 'workbuddy') {
    Object.assign(
      headers,
      sessionTraceHeaders({
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        turnRequestId: input.conversationRequestId,
      }),
    )
  }

  return headers
}

/**
 * billing 域头（`headers.go:375-400`）—— 签到/余额/CLI 活跃上报用。
 *
 * ⚠️ 与 chat 头的差异：**没有 `X-IDE-*` 归因头**，UA 是单段式。
 * Go 侧记录过「billing 单段 UA 形态」是并发修复的一部分。
 */
export function billingHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  const headers: HeaderMap = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
    'User-Agent': billingUserAgent(),
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN',
    'X-Domain': 'www.codebuddy.cn',
    'X-Product': 'SaaS',
  }
  if (input.accessToken !== '') {
    headers.Authorization = `Bearer ${input.accessToken}`
    headers['X-User-Id'] = input.uid
  }
  return headers
}

/**
 * 桌面指纹头（`desktop.go`，用于 `RichMeow_Chat` / 模板 / 画布 / 专家类任务）。
 *
 * ⚠️ 关键差异：`X-Product: SaaS`（**不是** WorkBuddy）。桌面端上报认这个值。
 */
export function desktopHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://copilot.tencent.com',
    Referer: 'https://copilot.tencent.com/',
    'User-Agent': desktopUserAgent(),
    'X-CodeBuddy-Request': '1',
    'X-Domain': 'copilot.tencent.com',
    'X-Product': 'SaaS',
    'X-User-Id': input.uid,
    'X-No-Enterprise-Id': '1',
    ...(input.accessToken === '' ? {} : { Authorization: `Bearer ${input.accessToken}` }),
  }
}

/**
 * Web 指纹头（`desktop.go:266-294`，用于任务领奖与 `Library_read`）。
 *
 * ⚠️ `x-client-platform: web` 是**领奖权威路径的必需头**
 * （`internal/upstream/tasks.go:228-254`）。
 */
export function webHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'x-client-platform': 'web',
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/',
    'User-Agent': webUserAgent(),
    'X-User-Id': input.uid,
    ...(input.accessToken === '' ? {} : { Authorization: `Bearer ${input.accessToken}` }),
  }
}

/**
 * mp 小程序指纹头（`school.go:62-79`，用于 `Sequential_Tasks_*` 与 `school_season`）。
 *
 * ⚠️ 这些任务**只在 mp 口径下下发**，默认列表不可见。
 */
export function mpHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
    'X-Client-Platform': 'mp-weixin',
    'X-Platform': 'wechatmp',
    'X-Client-Product': 'workbuddy-mp',
    'X-User-Id': input.uid,
    ...(input.accessToken === '' ? {} : { Authorization: `Bearer ${input.accessToken}` }),
  }
}

/** 生成 32 位 hex（消息级 ID / b3 trace id）。 */
export function randomHex32(): string {
  return randomHex(16)
}

/** 生成 16 位 hex（b3 span id）。 */
export function randomHex16(): string {
  return randomHex(8)
}

/** 生成 `byteLength * 2` 位 hex。 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

