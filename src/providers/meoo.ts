/**
 * Meoo（秒悟 - 阿里巴巴/阿里云旗下 AI 平台）供应商适配器。
 *
 * ## 协议速览（基于 @aliyun-meoo/cli@0.5.5 逆向与实测）
 *
 * | 用途 | 端点 | 认证方式与请求头 |
 * |---|---|---|
 * | 对话推理 | `POST https://api.meoo.host/meoo-ai/compatible-mode/v1/chat/completions` | `Authorization: Bearer <key>`, `X-Meoo-Client: cli` (OpenAI 兼容) |
 * | 余额积分 | `GET https://meoo.com/open/v1/cli-compat/account/points` | `Authorization: Bearer <token_or_key>`, `X-Meoo-Client: cli` |
 * | 每日签到 | `GET https://meoo.com/api/mc/entitlement/init` | `Authorization: Bearer <token_or_key>`, `X-Meoo-Client: cli` (每日送 2000 积分) |
 * | OAuth 续期 | `POST https://meoo.com/oauth/token` | `grant_type=refresh_token`, `client_id=meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh` |
 *
 * ## 凭据形态
 *
 * 1. API Key：以 `sk-` 开头或任意字符串，或带有 `apiKey` / `MEOO_PROJECT_API_KEY` 的 JSON 对象。
 * 2. OAuth 令牌：由官方 CLI 登录后存入 `~/.meoo/credentials.json`，含 `accessToken`、`refreshToken`、`scope: 'cli.compat'` 等。
 *
 * ## 纪律与限制
 *
 * 1. **登录不可在 Workers 完成**：官方 CLI 走标准 OAuth 授权码模式并在本机启动 HTTP 服务器
 *    监听 `http://127.0.0.1:<port>/oauth/callback`。Workers 环境无本地 TCP socket 监听能力，
 *    故 `capabilities.login = false`，并提供清晰的 `loginBlockedReason` 引导用户导入凭据。
 * 2. **零 node: 模块导入**：本文件纯使用 Web 标准 API（`fetch`、`Response`、WebCrypto），
 *    确保既能在 Cloudflare Workers 边缘运行，也能在 Node.js 单测环境中 100% 跑通。
 */

import {
  ProviderError,
  type ChatRequest,
  type CheckinResult,
  type Provider,
  type ProviderBalance,
  type ProviderCredential,
  type ProviderModel,
} from './types.js'

// ─────────────────────────── 协议常量 ───────────────────────────

export const MEOO_PROVIDER_ID = 'meoo'
export const MEOO_PROVIDER_NAME = 'Meoo (秒悟)'

/** 平台主站与 API 基址。 */
export const MEOO_API_BASE = 'https://meoo.com'

/** 推理网关主机。 */
export const MEOO_AI_HOST = 'https://api.meoo.host'

/** AI 推理端点（OpenAI 兼容）。 */
export const MEOO_CHAT_COMPLETIONS_URL = `${MEOO_AI_HOST}/meoo-ai/compatible-mode/v1/chat/completions`

/** 账户与积分查询端点。 */
export const MEOO_POINTS_URL = `${MEOO_API_BASE}/open/v1/cli-compat/account/points`

/** 每日签到与权益初始化端点。 */
export const MEOO_ENTITLEMENT_INIT_URL = `${MEOO_API_BASE}/api/mc/entitlement/init`

/** OAuth 令牌端点。 */
export const MEOO_OAUTH_TOKEN_URL = `${MEOO_API_BASE}/oauth/token`

/** Meoo CLI 生产环境 Client ID（来自官方 CLI 逆向）。 */
export const MEOO_CLI_PRODUCTION_CLIENT_ID = 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh'

/** 默认模型。 */
export const MEOO_DEFAULT_MODEL = 'qwen3.6-plus'

/** 每日登录签到赠送基准积分。 */
export const MEOO_DAILY_GRANT_AMOUNT = 2000

/**
 * Meoo 官方支持的核心模型列表。
 */
export const MEOO_MODELS: readonly ProviderModel[] = [
  {
    id: 'qwen3.6-plus',
    name: 'Qwen 3.6 Plus (默认)',
    contextWindow: 131_072,
    maxOutput: 8192,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'deepseek-v3.2',
    name: 'DeepSeek V3.2',
    contextWindow: 131_072,
    maxOutput: 8192,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    contextWindow: 131_072,
    maxOutput: 8192,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    contextWindow: 131_072,
    maxOutput: 8192,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'MiniMax-M2.5',
    name: 'MiniMax M2.5',
    contextWindow: 131_072,
    maxOutput: 8192,
    supportsImage: false,
    isFree: true,
  },
]

// ─────────────────────────── 辅助纯函数 ───────────────────────────

/**
 * 64 位 FNV-1a 稳定指纹（纯 Web 标准，不依赖 node:crypto）。
 */
export function fingerprint(text: string): string {
  const FNV_PRIME = 0x100000001b3n
  const FNV_MASK = 0xffffffffffffffffn
  const hash = (offset: bigint): bigint => {
    let h = offset
    for (let i = 0; i < text.length; i += 1) {
      h = (h ^ BigInt(text.charCodeAt(i))) & FNV_MASK
      h = (h * FNV_PRIME) & FNV_MASK
    }
    return h
  }
  const a = hash(0xcbf29ce484222325n).toString(16).padStart(16, '0')
  const b = hash(0x84222325cbf29ce4n).toString(16).padStart(16, '0')
  return `${a}${b}`
}

/** 提取上游响应中的错误细节。 */
function detailOf(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '(空响应体)'
  try {
    const record = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof record === 'object' && record !== null) {
      for (const k of ['message', 'msg', 'error', 'detail', 'error_description']) {
        const v = record[k]
        if (typeof v === 'string' && v.trim().length > 0) return v
      }
      if (typeof record.error === 'object' && record.error !== null) {
        const errObj = record.error as Record<string, unknown>
        if (typeof errObj.message === 'string' && errObj.message.trim().length > 0) {
          return errObj.message
        }
      }
    }
  } catch {
    // 文本不是合法 JSON，直接截取原文
  }
  return trimmed.slice(0, 300)
}

/**
 * 判定对象凭据是否属于 Meoo。
 *
 * ⚠️ 边界与防误判纪律：
 * 绝不能仅凭通用的 `accessToken` 或通用的 `apiKey` 就贪婪认领，那会抢走 WorkBuddy、OpenCode 等其他供应商的凭据。
 * 必须包含 Meoo 特征字段（如 `projectUrlId`、包含 `meoo` 的字段或域名，或者显式声明了 `provider === 'meoo'`）。
 */
export function looksLikeMeooCredential(input: Record<string, unknown>): boolean {
  // 1. 显式 provider 标记
  if (input['provider'] === MEOO_PROVIDER_ID) return true

  // 2. 独有字段：projectUrlId / project_url_id（Meoo 项目绑定的独有字段）
  for (const k of ['projectUrlId', 'project_url_id']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim().length > 0) return true
  }

  // 3. 环境变量独有前缀或包含 meoo 的键名
  for (const key of Object.keys(input)) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.includes('meoo')) {
      const val = input[key]
      if (typeof val === 'string' && val.trim().length > 0) return true
      if (typeof val === 'object' && val !== null) return true
    }
  }

  // 4. 嵌套 auth / credential 检查
  for (const subKey of ['auth', 'credential', 'credentials']) {
    const sub = input[subKey]
    if (typeof sub === 'object' && sub !== null && !Array.isArray(sub)) {
      if (looksLikeMeooCredential(sub as Record<string, unknown>)) return true
    }
  }

  // 5. 独有域名或 token 前缀
  const flat = JSON.stringify(input)
  if (flat.includes('meoo.com') || flat.includes('api.meoo.host')) return true
  if (flat.includes('meoo_ak_') || flat.includes('cli.compat')) return true

  return false
}

// ─────────────────────────── Provider 方法实现 ───────────────────────────

/**
 * 解析用户输入的凭据（字符串或对象）。
 */
export function parseCredential(input: unknown): ProviderCredential {
  let source: Record<string, unknown>

  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          source = parsed as Record<string, unknown>
        } else {
          throw new Error('JSON 不是有效对象')
        }
      } catch (error) {
        throw new ProviderError({
          provider: MEOO_PROVIDER_ID,
          message: `Meoo 凭据 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    } else {
      if (trimmed.length === 0) {
        throw new ProviderError({
          provider: MEOO_PROVIDER_ID,
          message: 'Meoo 凭据不能为空字符串',
        })
      }
      source = { apiKey: trimmed }
    }
  } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    source = input as Record<string, unknown>
    for (const k of ['credential', 'credentials', 'data', 'meoo', 'auth']) {
      const nested = source[k]
      if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
        source = nested as Record<string, unknown>
        break
      }
    }
  } else {
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      message: 'Meoo 凭据必须是 API Key 字符串或包含 apiKey / accessToken 的 JSON 对象',
    })
  }

  // 提取 token / apiKey
  const tokenCandidates = [
    source['apiKey'],
    source['api_key'],
    source['MEOO_PROJECT_API_KEY'],
    source['MEOO_API_KEY'],
    source['MEOO_TOKEN'],
    source['accessToken'],
    source['access_token'],
    source['token'],
    source['key'],
  ]

  let token = ''
  for (const cand of tokenCandidates) {
    if (typeof cand === 'string' && cand.trim().length > 0) {
      token = cand.trim()
      break
    }
  }

  if (token === '') {
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      message: 'Meoo 凭据缺少有效 apiKey 或 accessToken（如 MEOO_PROJECT_API_KEY、apiKey、accessToken）',
    })
  }

  // 提取 refreshToken
  const refreshCandidates = [
    source['refreshToken'],
    source['refresh_token'],
    source['MEOO_REFRESH_TOKEN'],
  ]
  let refreshToken = ''
  for (const cand of refreshCandidates) {
    if (typeof cand === 'string' && cand.trim().length > 0) {
      refreshToken = cand.trim()
      break
    }
  }

  // 提取过期时间 expiresAt (epoch ms)
  let expiresAt = 0
  if (typeof source['accessTokenExpiresAt'] === 'number' && Number.isFinite(source['accessTokenExpiresAt'])) {
    expiresAt = source['accessTokenExpiresAt']
  } else if (typeof source['expiresAt'] === 'number' && Number.isFinite(source['expiresAt'])) {
    expiresAt = source['expiresAt']
  } else if (typeof source['expires_at'] === 'number' && Number.isFinite(source['expires_at'])) {
    expiresAt = source['expires_at'] > 1e11 ? source['expires_at'] : source['expires_at'] * 1000
  } else if (typeof source['expires_at'] === 'string') {
    expiresAt = Date.parse(source['expires_at']) || 0
  } else if (typeof source['expires_in'] === 'number' && Number.isFinite(source['expires_in'])) {
    expiresAt = Date.now() + source['expires_in'] * 1000
  }

  // 提取 stable uid
  const uidCandidates = [
    source['uid'],
    source['userId'],
    source['user_id'],
    source['username'],
    source['openid'],
    source['openId'],
    source['projectUrlId'],
    source['project_url_id'],
    source['tenantId'],
    source['tenant_id'],
  ]
  let uid = ''
  for (const cand of uidCandidates) {
    if (cand !== undefined && cand !== null) {
      const s = String(cand).trim()
      if (s.length > 0) {
        uid = s
        break
      }
    }
  }
  if (uid === '') {
    uid = `meoo-${fingerprint(token)}`
  }

  // 提取昵称
  const nicknameCandidates = [
    source['nickname'],
    source['username'],
    source['userId'],
    source['user_id'],
  ]
  let nickname = ''
  for (const cand of nicknameCandidates) {
    if (typeof cand === 'string' && cand.trim().length > 0) {
      nickname = cand.trim()
      break
    }
  }
  if (nickname === '') {
    nickname = `Meoo (${uid.length > 12 ? uid.slice(0, 12) + '...' : uid})`
  }

  // 提取 extras
  const extras: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string' && v.trim().length > 0 && !['apiKey', 'accessToken', 'refreshToken', 'token'].includes(k)) {
      extras[k] = v.trim()
    }
  }

  // 规整特定关键字段
  if (typeof source['projectUrlId'] === 'string' && source['projectUrlId'].trim()) {
    extras['projectUrlId'] = source['projectUrlId'].trim()
  } else if (typeof source['project_url_id'] === 'string' && source['project_url_id'].trim()) {
    extras['projectUrlId'] = source['project_url_id'].trim()
  }

  if (typeof source['tenantId'] === 'string' && source['tenantId'].trim()) {
    extras['tenantId'] = source['tenantId'].trim()
  } else if (typeof source['tenant_id'] === 'string' && source['tenant_id'].trim()) {
    extras['tenantId'] = source['tenant_id'].trim()
  }

  if (typeof source['edition'] === 'string' && source['edition'].trim()) {
    extras['edition'] = source['edition'].trim()
  }

  const credentialType = typeof source['credentialType'] === 'string' && source['credentialType'].trim()
    ? source['credentialType'].trim()
    : (source['apiKey'] || source['api_key'] || source['MEOO_PROJECT_API_KEY'] || token.startsWith('meoo_ak_') || token.startsWith('sk-')
      ? 'api_key'
      : (refreshToken ? 'oauth' : 'bearer'))
  extras['credentialType'] = credentialType

  return {
    provider: MEOO_PROVIDER_ID,
    uid,
    accessToken: token,
    refreshToken,
    expiresAt,
    nickname,
    extras,
  }
}

/**
 * 列出 Meoo 支持的模型列表。
 */
export async function listModels(
  _credential: ProviderCredential,
  _signal: AbortSignal,
): Promise<ProviderModel[]> {
  return [...MEOO_MODELS]
}

/**
 * 发起对话请求（OpenAI 兼容协议，支持流式与非流式透传）。
 */
export async function chat(
  credential: ProviderCredential,
  request: ChatRequest,
): Promise<Response> {
  const model = request.model || MEOO_DEFAULT_MODEL
  const body: Record<string, unknown> = {
    ...request.body,
    model,
  }

  const isStream = body['stream'] === true
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-Meoo-Client': 'cli',
  }
  if (isStream) {
    headers['Accept'] = 'text/event-stream'
  }
  if (credential.extras['projectUrlId']) {
    headers['OneDay-App-Id'] = credential.extras['projectUrlId']
  }

  try {
    const res = await fetch(MEOO_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError({
        provider: MEOO_PROVIDER_ID,
        httpStatus: res.status,
        message: `Meoo 对话失败（http=${res.status}）：${detailOf(text)}`,
        retryable: res.status === 429 || res.status === 402,
      })
    }

    return res
  } catch (error) {
    if (request.signal.aborted) {
      throw new ProviderError({ provider: MEOO_PROVIDER_ID, message: '请求已被客户端取消' })
    }
    if (error instanceof ProviderError) throw error
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      message: `Meoo 网络请求失败：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }
}

/**
 * 查询账户积分余额。
 * 调用 GET https://meoo.com/open/v1/cli-compat/account/points
 */
export async function balance(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<ProviderBalance> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-Meoo-Client': 'cli',
    'Accept': 'application/json',
  }
  if (credential.extras['projectUrlId']) {
    headers['OneDay-App-Id'] = credential.extras['projectUrlId']
  }

  let res: Response
  try {
    res = await fetch(MEOO_POINTS_URL, {
      method: 'GET',
      headers,
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderError({ provider: MEOO_PROVIDER_ID, message: '请求已被客户端取消' })
    }
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      message: `Meoo 积分查询网络异常：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      httpStatus: res.status,
      message: `Meoo 查询余额失败（http=${res.status}）：${detailOf(text)}`,
      retryable: res.status === 429 || res.status === 502 || res.status === 503,
    })
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const data = (json['data'] && typeof json['data'] === 'object' ? json['data'] : json) as Record<string, unknown>
  const account = (data['account'] && typeof data['account'] === 'object' ? data['account'] : data) as Record<string, unknown>

  const rawAvailable = account['availableBalance'] ?? data['availableBalance']
  const availableBalance = typeof rawAvailable === 'number'
    ? rawAvailable
    : (Number(rawAvailable) || 0)

  const totalGranted = typeof account['totalGranted'] === 'number' ? account['totalGranted'] : undefined
  const totalConsumed = typeof account['totalConsumed'] === 'number' ? account['totalConsumed'] : undefined

  const packages: Array<{ name: string; amount: number; expiry: number }> = [
    { name: '可用积分', amount: availableBalance, expiry: 0 },
  ]
  if (totalGranted !== undefined) {
    packages.push({ name: '累计获得积分', amount: totalGranted, expiry: 0 })
  }
  if (totalConsumed !== undefined) {
    packages.push({ name: '累计消耗积分', amount: totalConsumed, expiry: 0 })
  }

  return {
    total: availableBalance,
    expiring: 0,
    earliestExpiry: 0,
    packages,
  }
}

/**
 * 执行每日登录签到。
 * 调用 GET https://meoo.com/api/mc/entitlement/init
 */
export async function checkin(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<CheckinResult> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-Meoo-Client': 'cli',
    'Accept': 'application/json',
  }
  if (credential.extras['projectUrlId']) {
    headers['OneDay-App-Id'] = credential.extras['projectUrlId']
  }

  let res: Response
  try {
    res = await fetch(MEOO_ENTITLEMENT_INIT_URL, {
      method: 'GET',
      headers,
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderError({ provider: MEOO_PROVIDER_ID, message: '请求已被客户端取消' })
    }
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      message: `Meoo 每日签到网络异常：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      httpStatus: res.status,
      message: `Meoo 每日签到失败（http=${res.status}）：${detailOf(text)}`,
      retryable: res.status === 429 || res.status === 502 || res.status === 503,
    })
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const data = (json['data'] && typeof json['data'] === 'object' ? json['data'] : json) as Record<string, unknown>

  const dailyLoginGranted = data['dailyLoginGranted'] === true
  const rawGrantAmount = data['dailyLoginGrantAmount']
  const grantAmount = typeof rawGrantAmount === 'number'
    ? rawGrantAmount
    : (Number(rawGrantAmount) || MEOO_DAILY_GRANT_AMOUNT)

  if (dailyLoginGranted) {
    return {
      alreadyDone: false,
      gained: grantAmount,
      detail: `今日签到成功，获得 ${grantAmount} 积分`,
    }
  }

  // dailyLoginGranted === false 或已领过，幂等成功返回
  return {
    alreadyDone: true,
    gained: 0,
    detail: '今日已完成每日登录签到（幂等命中，未重复发放）',
  }
}

/**
 * 刷新 OAuth 凭据（若具备 refreshToken）。
 */
export async function refresh(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<ProviderCredential> {
  if (!credential.refreshToken) {
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      message: '当前 Meoo 凭据缺少 refreshToken，无法执行自动续期',
    })
  }

  const apiBaseUrl = credential.extras['apiBaseUrl'] || MEOO_API_BASE
  const tokenUrl = `${apiBaseUrl.replace(/\/+$/, '')}/oauth/token`

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: MEOO_CLI_PRODUCTION_CLIENT_ID,
    refresh_token: credential.refreshToken,
  })

  let res: Response
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body,
      signal,
    })
  } catch (error) {
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      message: `Meoo OAuth 续期网络失败：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      httpStatus: res.status,
      message: `Meoo OAuth 续期被拒（http=${res.status}）：${detailOf(text)}`,
      retryable: false,
    })
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const newAccessToken = typeof json['access_token'] === 'string' ? json['access_token'] : ''
  const newRefreshToken = typeof json['refresh_token'] === 'string' ? json['refresh_token'] : credential.refreshToken
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 7200

  if (!newAccessToken) {
    throw new ProviderError({
      provider: MEOO_PROVIDER_ID,
      message: 'Meoo 续期响应缺少有效 access_token',
    })
  }

  return {
    ...credential,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * 判断是否值得换号重试。
 */
export function shouldRotate(status: number, bodyText: string): boolean {
  if (status === 429 || status === 402) return true
  const lower = bodyText.toLowerCase()
  return lower.includes('insufficient_quota')
    || lower.includes('quota')
    || lower.includes('balance')
    || lower.includes('rate_limit')
    || lower.includes('额度不足')
    || lower.includes('积分不足')
}

// ─────────────────────────── Provider 实例导出 ───────────────────────────

export const meooProvider: Provider = {
  id: MEOO_PROVIDER_ID,
  name: MEOO_PROVIDER_NAME,
  capabilities: {
    login: false,
    loginBlockedReason:
      'Meoo 官方 CLI 依赖本地 127.0.0.1 端口接收 OAuth 回调，Workers 环境无法提供本地端口监听；'
      + '请通过环境变量（MEOO_TOKEN / MEOO_API_KEY）或导出 credentials.json 凭据文件直接导入。',
    listModels: true,
    chat: true,
    balance: true,
    checkin: true,
  },
  matchesShape: looksLikeMeooCredential,
  bareStringPattern: /^(meoo_[A-Za-z0-9_.-]+|meoo-[A-Za-z0-9_.-]+)$/,
  parseCredential,
  listModels,
  chat,
  balance,
  checkin,
  refresh,
  shouldRotate,
}
