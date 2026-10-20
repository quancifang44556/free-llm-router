const KEY = 'wb_api_key'

export const auth = {
  get: () => localStorage.getItem(KEY) ?? '',
  set: (k: string) => localStorage.setItem(KEY, k),
  clear: () => localStorage.removeItem(KEY),
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(errorMessage(body) ?? `HTTP ${status}`)
  }
}

/** 从各种错误体里取人话：`{error:{message}}`（OpenAI 风格）/ `{error:'…'}` / `{message}`。 */
function errorMessage(body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim()) return body.slice(0, 300)
  if (!body || typeof body !== 'object') return undefined
  const b = body as { error?: unknown; message?: unknown; detail?: unknown }
  if (typeof b.error === 'string') return b.error
  if (b.error && typeof b.error === 'object' && typeof (b.error as { message?: unknown }).message === 'string')
    return (b.error as { message: string }).message
  if (typeof b.message === 'string') return b.message
  if (typeof b.detail === 'string') return b.detail
  return undefined
}

type Init = Omit<RequestInit, 'body'> & {
  json?: unknown
  key?: string
  timeoutMs?: number
}

/** 统一请求：带主密钥、默认 30 秒超时（真正 abort 掉连接）、非 2xx 抛 ApiError、401 广播登出。 */
export async function api<T>(path: string, init: Init = {}): Promise<T> {
  const { json, key, timeoutMs = 30_000, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set('authorization', 'Bearer ' + (key ?? auth.get()))
  if (json !== undefined) headers.set('content-type', 'application/json')

  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  rest.signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
  try {
    const res = await fetch(path, {
      ...rest,
      method: rest.method ?? (json !== undefined ? 'POST' : 'GET'),
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      /* 非 JSON 原样返回 */
    }
    if (res.status === 401 && key === undefined) window.dispatchEvent(new Event('auth:expired'))
    if (!res.ok) throw new ApiError(res.status, data)
    return data as T
  } catch (e) {
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
