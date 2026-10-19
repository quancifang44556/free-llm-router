/**
 * 自定义 API Key：**面向外部调用方的子密钥**。
 *
 * ## 为什么需要它（与 `API_KEY` 的关系）
 *
 * `API_KEY`（Worker secret）是**管理员主密钥**：能登录面板、能增删账号、
 * 能清空日志 —— 权限是全量的。把它发给第三方应用或做分发给不同客户端，
 * 等于把管理权限一起交出去。
 *
 * 这里的自定义 Key 是**受限子密钥**：只能调 `/v1/*`（对话、模型列表），
 * 且可以逐把限制「用多少 / 从哪来 / 用哪些模型」。管理员随时可禁用或删除。
 *
 * ## 两个安全纪律
 *
 * 1. **明文永不落库** —— 只在「创建 / 重置」的响应里出现一次（用户自己保存）。
 *    库里存的是 SHA-256 哈希。这样即使 DO 存储被读出，也拿不到可用的 Key。
 * 2. **哈希要恒定时间比较** —— 但因为我们用「哈希后查表」，查表本身不泄漏
 *    （键是哈希，且哈希是单向的），故这里不需要额外做恒定时间比较；
 *    真要防的是**时序侧信道**，而查表命中/不命中的差异已经由表结构抹平。
 *
 * ⚠️ 刻意**不**复用 `CREDENTIAL_KEY` 做加密（可逆）：子密钥需要的是
 * 「验签」而不是「取回明文」—— 可逆存储只会凭空扩大泄漏面。
 */

/** 一把子密钥的配额与范围限制。 */
export interface ApiKeyLimits {
  /** 窗口内允许的最大**请求数**。`0` = 不限。 */
  maxRequests: number
  /** 窗口内允许的最大 **token 数**（输入 + 输出）。`0` = 不限。 */
  maxTokens: number
  /**
   * 配额统计窗口（小时）。
   *
   * - `24`（默认）= 每天重置；
   * - `0` = **不重置**（累计总量，适合「一次性试用额度」）。
   *
   * ⚠️ 用「滚动窗口」而不是「自然日」：自然日会让用户在 23:59 用完之后
   * 00:01 立刻又满血 —— 对限额场景没意义。滚动窗口是「从窗口起点起 24 小时」。
   */
  windowHours: number
  /**
   * 允许调用的模型（空数组 = **全部**）。
   *
   * 元素可以是完整 id（`buddy/glm-5.3-flash`），
   * 也可以是**裸模型名**（`glm-5.3-flash`）—— 后者跨供应商都算匹配。
   */
  models: string[]
  /**
   * 允许的来源 IP（空数组 = **全部**）。支持精确 IP 与 CIDR
   *（`1.2.3.4`、`10.0.0.0/8`、`2001:db8::/32`）。
   */
  allowedIps: string[]
  /** 过期时刻（epoch ms）。`0` = 永不过期。 */
  expiresAt: number
}

/** 一把子密钥的完整记录（**不含明文**）。 */
export interface ApiKeyRecord {
  /** 稳定 id（面板内部用，也用于「重置」定位）。 */
  id: string
  /** 用户起的名字（便于辨认用途）。 */
  name: string
  /** SHA-256(明文) 的 base64url。**明文不落库。** */
  hash: string
  /**
   * 展示用前缀（`sk-abc…`）。
   *
   * ⚠️ 必须可辨认但**不可复原**：这里只留前 6 位随机字符，
   * 足够用户在自己的列表里对上号，而不足以被爆破。
   */
  prefix: string
  createdAt: number
  lastUsedAt: number
  enabled: boolean
  limits: ApiKeyLimits
}

/** 一把子密钥的**用量计数**（与记录分开存，因为它是每请求都会写的热数据）。 */
export interface ApiKeyUsage {
  /** 当前窗口起点（epoch ms）。`0` 表示从未统计过。 */
  windowStart: number
  /** 窗口内请求数。 */
  requests: number
  /** 窗口内输入 token。 */
  inputTokens: number
  /** 窗口内输出 token。 */
  outputTokens: number
  /** 窗口内被**拒绝**的次数（配额/IP/模型），便于用户排查。 */
  rejected: number
  /** 最后一次使用的时刻。 */
  lastAt: number
  /** 最后一次使用的来源 IP。 */
  lastIp: string
  /** 最后一次使用的模型。 */
  lastModel: string
}

/** 默认窗口（小时）：24 = 每天。 */
export const DEFAULT_WINDOW_HOURS = 24

/** 空用量。 */
export function emptyApiKeyUsage(): ApiKeyUsage {
  return {
    windowStart: 0, requests: 0, inputTokens: 0, outputTokens: 0,
    rejected: 0, lastAt: 0, lastIp: '', lastModel: '',
  }
}

/** 默认限制（全不限、24 小时窗口）。 */
export function defaultApiKeyLimits(): ApiKeyLimits {
  return {
    maxRequests: 0, maxTokens: 0, windowHours: DEFAULT_WINDOW_HOURS,
    models: [], allowedIps: [], expiresAt: 0,
  }
}

/**
 * 生成一把新密钥的明文。
 *
 * 格式：`sk-` + 40 个 `[A-Za-z0-9]` 字符（约 238 bit 熵）。
 *
 * ⚠️ 刻意避开容易混淆的字符？**没有** —— 那样会降低每字符熵，且用户
 * 通常是复制粘贴而不是手抄。这里优先保证熵与「格式像常见的 sk- 密钥」。
 *
 * ⚠️ 必须用 `crypto.getRandomValues`（CSPRNG），不能用 `Math.random()`：
 * 后者在 Workers 上虽然是 xorshift 级实现，但**不是**密码学安全的 ——
 * 密钥可被预测等于没有密钥。
 */
export function generateApiKey(): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const LEN = 40
  const bytes = new Uint8Array(LEN)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < LEN; i += 1) {
    // ⚠️ 取模会引入极轻微偏置（256 % 62 ≠ 0），但 256/62 ≈ 4.13，
    // 偏置量级 ~10^-2 —— 对 238 bit 熵的密钥来说完全可忽略。
    // 若要做到零偏置需用拒绝采样，这里不值当（会引入循环与不定的耗时形状）。
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length]
  }
  return `sk-${out}`
}

/** 展示用前缀：`sk-` + 前 6 位。 */
export function keyPrefix(plaintext: string): string {
  return plaintext.slice(0, 9)
}

/** 计算密钥哈希（SHA-256 → base64url）。 */
export async function hashApiKey(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext))
  const bytes = new Uint8Array(digest)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** 生成一个用于内部定位的稳定 id。 */
export function newApiKeyId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 把任意输入规范化成合法的 `ApiKeyLimits`（缺字段补默认、错误类型丢弃）。 */
export function normalizeApiKeyLimits(raw: unknown): ApiKeyLimits {
  const d = defaultApiKeyLimits()
  if (raw === null || typeof raw !== 'object') return d
  const o = raw as Record<string, unknown>
  const num = (v: unknown, fallback: number): number => {
    // ⚠️ 显式排除负数与 NaN —— 负上限会让**所有**请求被拒（看似「密钥坏了」）
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
  }
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
  return {
    maxRequests: num(o.maxRequests, d.maxRequests),
    maxTokens: num(o.maxTokens, d.maxTokens),
    // ⚠️ 窗口为 0 是**合法**值（= 不重置），不能用 `|| 默认` 把它吃掉
    windowHours: num(o.windowHours, d.windowHours),
    models: strList(o.models),
    allowedIps: strList(o.allowedIps),
    expiresAt: num(o.expiresAt, d.expiresAt),
  }
}

/** 规范化一条记录（读库时用；字段缺失/损坏时回落到安全默认）。 */
export function normalizeApiKeyRecord(raw: unknown): ApiKeyRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.hash !== 'string' || o.id === '' || o.hash === '') return undefined
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name !== '' ? o.name : '（未命名）',
    hash: o.hash,
    prefix: typeof o.prefix === 'string' ? o.prefix : '',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    lastUsedAt: typeof o.lastUsedAt === 'number' ? o.lastUsedAt : 0,
    // ⚠️ 缺失 `enabled` 时按**启用**处理（新建的密钥就该能用）；
    // 显式 `false` 才是禁用。
    enabled: o.enabled !== false,
    limits: normalizeApiKeyLimits(o.limits),
  }
}

// ─────────────────────────── IP / CIDR 匹配 ───────────────────────────

/**
 * 把 IPv4 解析成 32 位无符号整数。非法返回 `undefined`。
 *
 * ## ⚠️ 为什么显式拒绝前导零（`01.2.3.4`）
 *
 * 前导零在 IPv4 里**歧义**：一些实现（inet_aton、部分语言的解析器）
 * 把它当**八进制**理解，于是 `010.1.1.1` 会被当成 `8.1.1.1`。
 * 一个 IP 白名单若允许这种写法，就会出现「我以为写了 010 这个网段，
 * 实际放行的是 8 网段」—— 静默的安全偏差。故直接判非法。
 */
function parseIpv4(value: string): number | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  let out = 0
  for (const p of parts) {
    // ⚠️ 必须拒绝 `01`、`+1`、` 1` 这类：
    //   · `01` 有八进制歧义（见上）；
    //   · `Number('')` 是 0，宽松解析会让 `1.2.3.` 变成 `1.2.3.0`。
    // 故只接受「0」本身或「1-9 开头且不超 3 位」。
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return undefined
    const n = Number(p)
    if (n > 255) return undefined
    out = (out << 8) | n
  }
  return out >>> 0
}

/** 把 IPv6 解析成 16 字节数组。非法返回 `undefined`。 */
function parseIpv6(value: string): Uint8Array | undefined {
  // 只支持标准写法（含 `::` 压缩）。不支持嵌入 IPv4 的 `::ffff:1.2.3.4` 之外的怪写法，
  // 那种会在这里被判非法 —— 宁可拒绝也不要误判成「匹配」。
  const zone = value.indexOf('%')
  const v = zone >= 0 ? value.slice(0, zone) : value
  const halves = v.split('::')
  if (halves.length > 2) return undefined
  const head = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':')
  const tailRaw = halves.length === 2 ? (halves[1] ?? '') : undefined
  const tail = tailRaw === undefined || tailRaw === '' ? [] : tailRaw.split(':')
  const bad = (xs: string[]): boolean => xs.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))
  if (bad(head) || bad(tail)) return undefined
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 && head.length !== 8) return undefined
  if (fill < 0) return undefined
  const groups = [...head, ...Array.from({ length: fill }, () => '0'), ...tail]
  if (groups.length !== 8) return undefined
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i += 1) {
    const n = parseInt(groups[i] ?? '0', 16)
    out[i * 2] = (n >> 8) & 0xff
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

/** 判断字符串是否是可解析的 IP。 */
export function isIpLiteral(value: string): boolean {
  return parseIpv4(value) !== undefined || parseIpv6(value) !== undefined
}

/**
 * 判断 `ip` 是否落在 `rule` 里。
 *
 * `rule` 可以是：
 * - 精确 IP：`1.2.3.4` / `2001:db8::1`
 * - CIDR：`10.0.0.0/8` / `2001:db8::/32`
 *
 * ⚠️ 协议族必须一致：IPv4 的 ip 不会匹配 IPv6 的规则（反之亦然）。
 * 跨族匹配是最常见的 CIDR 实现缺陷来源。
 */
export function ipMatchesRule(ip: string, rule: string): boolean {
  const slash = rule.indexOf('/')
  const base = slash >= 0 ? rule.slice(0, slash) : rule
  const bitsRaw = slash >= 0 ? Number(rule.slice(slash + 1)) : undefined

  const ip4 = parseIpv4(ip)
  const base4 = parseIpv4(base)
  if (ip4 !== undefined && base4 !== undefined) {
    const bits = bitsRaw === undefined ? 32 : bitsRaw
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
    if (bits === 0) return true
    // ⚠️ JS 的 `<<` 在 32 位处会回绕（`1 << 32` === 1），故 bits===32 必须单独走全等。
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
    return ((ip4 & mask) >>> 0) === ((base4 & mask) >>> 0)
  }

  const ip6 = parseIpv6(ip)
  const base6 = parseIpv6(base)
  if (ip6 !== undefined && base6 !== undefined) {
    const bits = bitsRaw === undefined ? 128 : bitsRaw
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false
    let remaining = bits
    for (let i = 0; i < 16 && remaining > 0; i += 1) {
      const take = Math.min(8, remaining)
      const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff
      const a = ip6[i] ?? 0
      const b = base6[i] ?? 0
      if ((a & mask) !== (b & mask)) return false
      remaining -= take
    }
    return true
  }

  return false
}

/**
 * 判断来源 IP 是否被允许。
 *
 * ⚠️ **空规则列表 = 允许全部**（这是「不限」的语义，与「全禁」相反）。
 * 把空列表当成「全禁」会让新建的密钥一开始就用不了 —— 那是很糟的默认值。
 */
export function ipAllowed(ip: string, rules: string[]): boolean {
  if (rules.length === 0) return true
  if (ip === '') return false
  return rules.some((r) => ipMatchesRule(ip, r))
}

/**
 * 判断模型是否被允许。
 *
 * 规则里可以写完整 id（`buddy/glm-5.3-flash`）或裸名（`glm-5.3-flash`）；
 * 后者对**任何**供应商的同名模型都算匹配（便于「这个模型允许用」的直觉）。
 */
export function modelAllowed(model: string, rules: string[]): boolean {
  if (rules.length === 0) return true
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
  return rules.some((r) => r === model || r === bare)
}

/** 配额判定结果。 */
export type QuotaVerdict =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'disabled' | 'ip' | 'model' | 'requests' | 'tokens'; message: string }

/** 用量是否已超窗口 → 需要重置。 */
export function isWindowExpired(usage: ApiKeyUsage, limits: ApiKeyLimits, now: number): boolean {
  // ⚠️ `windowHours === 0` = **永不重置**（累计额度）。这是合法配置，
  // 不能用 `if (!windowHours) return ...` 之类的 falsy 判断吃掉它。
  if (limits.windowHours <= 0) return usage.windowStart === 0
  if (usage.windowStart === 0) return false
  return now - usage.windowStart >= limits.windowHours * 60 * 60 * 1000
}

/** 把用量归零并开一个新窗口。 */
export function resetUsageWindow(usage: ApiKeyUsage, now: number): ApiKeyUsage {
  return {
    ...emptyApiKeyUsage(),
    windowStart: now,
    // 保留「最后一次使用」的观察值：它是诊断信息，不该因为换窗口就丢失
    lastAt: usage.lastAt,
    lastIp: usage.lastIp,
    lastModel: usage.lastModel,
  }
}

/**
 * 用量配额判定（**纯函数**，便于单测）。
 *
 * @param usage - 应当是**已经按窗口重置过**的计数。
 */
export function checkQuota(
  record: ApiKeyRecord,
  usage: ApiKeyUsage,
  ip: string,
  model: string,
  now: number,
): QuotaVerdict {
  const { limits } = record
  if (!record.enabled) return { ok: false, reason: 'disabled', message: '这把 API Key 已被停用' }
  if (limits.expiresAt > 0 && now >= limits.expiresAt) {
    return { ok: false, reason: 'expired', message: '这把 API Key 已过期' }
  }
  if (!ipAllowed(ip, limits.allowedIps)) {
    return { ok: false, reason: 'ip', message: `来源 IP ${ip || '(未知)'} 不在允许列表内` }
  }
  // ⚠️ 模型判定只在**调用方传了模型**时做：`/v1/models` 没有 model 参数，
  // 传空串时不该被模型白名单拒掉（那会让用户「连列表都拉不到」）。
  if (model !== '' && !modelAllowed(model, limits.models)) {
    return { ok: false, reason: 'model', message: `模型 ${model} 不在允许列表内` }
  }
  if (limits.maxRequests > 0 && usage.requests >= limits.maxRequests) {
    return { ok: false, reason: 'requests', message: `已达请求数上限（${limits.maxRequests}）` }
  }
  if (limits.maxTokens > 0 && usage.inputTokens + usage.outputTokens >= limits.maxTokens) {
    return { ok: false, reason: 'tokens', message: `已达 token 上限（${limits.maxTokens}）` }
  }
  return { ok: true }
}

/** 面板展示用的视图对象（**绝不含 hash**）。 */
export interface ApiKeyView {
  id: string
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number
  enabled: boolean
  limits: ApiKeyLimits
  usage: ApiKeyUsage
  /** 窗口起点的可读时间（面板直接显示，避免前端各算一份）。 */
  windowStartAt: number
}

/** 把记录 + 用量合成面板视图（**剥掉 hash**）。 */
export function toApiKeyView(record: ApiKeyRecord, usage: ApiKeyUsage): ApiKeyView {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    enabled: record.enabled,
    limits: record.limits,
    usage,
    windowStartAt: usage.windowStart,
  }
}
