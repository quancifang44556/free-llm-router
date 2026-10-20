/**
 * 国际版（workbuddy.ai）**每日活跃打卡**：把一条网页端云 agent 会话真正跑完。
 *
 * 移植自 [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)
 *（MIT）的 `wb_accounts.py::_daily_chat_web_once` 与 `wb_webagent.py::run_turn`。
 *
 * ## 为什么不是 chat/completions
 *
 * 国际版**没有**签到接口；官方的每日活跃积分（30/50）认的是「**跑完的网页端 agent 会话**」：
 * - 桌面身份发 chat/completions **不计数**（参考项目 issue #75、#59 实测）；
 * - 只建会话、不接沙箱也**不计数** —— 会话会永远停在 CREATING（issue #90 实测）。
 *
 * ## 流程（全部来自参考项目抓包）
 *
 * 1. `POST /console/as/conversations/` 建会话（只是**排队**）；
 * 2. `GET /console/as/conversations/{id}/session` 取沙箱 `link` + `token`；
 * 3. ACP over streamable HTTP：`GET link`（SSE）拿 `Acp-Connection-Id`，保持流打开；
 *    再逐条 `POST link` JSON-RPC：`initialize` → `session/load` →
 *    `session/set_model` → `session/prompt`；
 * 4. 轮询 `GET /console/as/conversations/{id}` 直到 `status === 'completed'`。
 *
 * ⚠️ `session/set_model` **必须发**：建会话 body 里的 `model` 只写进 manifest，
 * 不发这条的话这一轮按账号默认模型（网页端默认 Auto，**按付费模型计费**）跑 ——
 * 每天的活跃都在扣积分。失败不致命（仍把这一轮跑完），但会写进结果说明。
 *
 * ## Workers 预算
 *
 * 一次打卡 ≈ 1 建会话 + ≤3 取沙箱 + 1 SSE + 4 JSON-RPC + ≤25 轮询 ≈ 35 个子请求，
 * 在 Free 计划单次调用 50 的上限内 —— 故**只能**在 TaskRunner 的单步 alarm 里跑
 *（每步独立预算），不能在一个 HTTP 请求里对多个账号串行跑。
 */

export const WEB_ORIGIN = 'https://www.workbuddy.ai'
export const WEB_CONVERSATIONS_URL = `${WEB_ORIGIN}/console/as/conversations/`
/** 网页端 UA（参考项目抓包值）。 */
export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
/** 打卡用的免费模型（参考项目默认值；可用 env `WORKBUDDY_DAILY_CHAT_MODEL` 覆盖）。 */
export const DEFAULT_DAILY_CHAT_MODEL = 'deepseek-v4.1-flash'
export const DAILY_CHAT_PROMPT = 'Hi'

const ACP_PROTOCOL_VERSION = 1
/** 打卡只需要 agent 把话说完，不提供文件系统/终端能力。 */
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }

export interface WebDailyChatInput {
  uid: string
  accessToken: string
}

export interface WebDailyChatOptions {
  model?: string
  prompt?: string
  /** 发出 prompt 后最多等多久跑完（默认 120s；参考实测一次「Hi」十几秒）。 */
  waitMs?: number
  /** 状态轮询间隔（默认 5s）。 */
  pollMs?: number
  /** 单个 HTTP 请求的超时（默认 30s）。 */
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface WebDailyChatResult {
  ok: boolean
  conversationId: string
  status: string
  /** SSE 收到的 `session/update` 条数。 */
  updates: number
  /** 其中 `agent_message_chunk` 的条数（agent 真的说话了）。 */
  chunks: number
  /** `session/set_model` 是否成功（false ⇒ 这一轮可能按付费模型计费）。 */
  modelPinned: boolean
  elapsedMs: number
  detail: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

class WebAgentError extends Error {}

/** 网页版 app 的出站头：只有 bearer 与 X-User-Id，没有桌面端指纹。 */
export function webAgentHeaders(input: WebDailyChatInput): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken}`,
    // ⚠️ 账号池里的 uid 带 `workbuddy:` 前缀，上游要裸 uid（同 headers.ts 国际版桌面头）
    'X-User-Id': input.uid.replace(/^workbuddy:/, ''),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/app`,
    'User-Agent': WEB_USER_AGENT,
  }
}

/** 解析一段 SSE 文本里的 JSON-RPC 消息（只看 `data:` 行）。 */
export function parseSseMessages(text: string): Obj[] {
  const out: Obj[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const msg = JSON.parse(payload) as unknown
      if (isObj(msg)) out.push(msg)
    } catch {
      // 半行/非 JSON：忽略
    }
  }
  return out
}

/**
 * 跑一次国际版网页端每日活跃对话。
 *
 * **不抛异常**：任何失败都折成 `{ ok: false, detail }`，便于任务引擎如实记录。
 */
export async function runWebDailyChat(
  input: WebDailyChatInput,
  options: WebDailyChatOptions = {},
): Promise<WebDailyChatResult> {
  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? Date.now
  const model = (options.model ?? '').trim() || DEFAULT_DAILY_CHAT_MODEL
  const prompt = options.prompt ?? DAILY_CHAT_PROMPT
  const waitMs = Math.max(1_000, options.waitMs ?? 120_000)
  const pollMs = Math.max(0, options.pollMs ?? 5_000)
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  const headers = webAgentHeaders(input)
  const started = now()

  const result: WebDailyChatResult = {
    ok: false, conversationId: '', status: '', updates: 0, chunks: 0, modelPinned: false, elapsedMs: 0, detail: '',
  }
  const finish = (ok: boolean, detail: string): WebDailyChatResult => {
    result.ok = ok
    result.detail = detail
    result.elapsedMs = now() - started
    return result
  }

  const getJson = async (url: string, init: RequestInit): Promise<Obj> => {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    if (!res.ok) throw new WebAgentError(`HTTP ${res.status}${text === '' ? '' : `: ${text.slice(0, 120)}`}`)
    try {
      const parsed = JSON.parse(text === '' ? '{}' : text) as unknown
      if (!isObj(parsed)) throw new WebAgentError('响应不是 JSON 对象')
      return parsed
    } catch (error) {
      if (error instanceof WebAgentError) throw error
      throw new WebAgentError(`响应不是 JSON：${text.slice(0, 120)}`)
    }
  }
  const conversationStatus = async (id: string): Promise<string> => {
    try {
      const payload = await getJson(WEB_CONVERSATIONS_URL + encodeURIComponent(id), { method: 'GET', headers })
      return str(isObj(payload.data) ? payload.data.status : '').trim().toLowerCase()
    } catch {
      return ''
    }
  }

  // 1. 建会话（只是排队）
  let conversation = ''
  try {
    const payload = await getJson(WEB_CONVERSATIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt,
        model,
        // 网页端建会话时固定带上这两项（抓包所得），保持请求形态一致
        conversationOrigin: 'workbuddy-app',
        plugins: [{ name: 'weixinpay', marketplace: 'codebuddy-builtin' }],
      }),
    })
    conversation = str(isObj(payload.data) ? payload.data.id : '')
    const code = payload.code
    if ((code !== undefined && code !== null && code !== 0) || conversation === '') {
      return finish(false, `建会话失败：code=${str(code) || '?'} msg=${str(payload.msg) || str(payload.message) || '无'}`)
    }
  } catch (error) {
    return finish(false, `建会话失败：${error instanceof Error ? error.message : String(error)}`)
  }
  result.conversationId = conversation

  // 2. 取沙箱（刚建完可能还没分配，短轮询几次）
  let link = ''
  let token = ''
  let sessionId = conversation
  let cwd = '/workspace'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = await getJson(`${WEB_CONVERSATIONS_URL}${encodeURIComponent(conversation)}/session`, {
        method: 'GET', headers,
      })
      const data = isObj(payload.data) ? payload.data : {}
      link = str(data.link) || str(data.endpoint)
      token = str(data.token)
      sessionId = str(data.sessionId) || str(data.session_id) || conversation
      cwd = str(data.cwd) || '/workspace'
    } catch (error) {
      if (attempt === 2) return finish(false, `沙箱查询失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (link !== '' && token !== '') break
    if (attempt < 2) await sleep(2_000)
  }
  if (link === '' || token === '') return finish(false, '沙箱未就绪（session 没有 link/token）')
  if (!/^https?:\/\//i.test(link)) return finish(false, `沙箱地址不可用：${link.slice(0, 80)}`)

  // 3. ACP：SSE 通道 + JSON-RPC
  const sseAbort = new AbortController()
  let sseReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let pump: Promise<void> | undefined
  let promptDone = false
  try {
    const sse = await doFetch(link, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}`, 'User-Agent': WEB_USER_AGENT },
      signal: sseAbort.signal,
    })
    if (sse.status !== 200) {
      await sse.body?.cancel().catch(() => {})
      throw new WebAgentError(`SSE 通道返回 HTTP ${sse.status}`)
    }
    const connectionId = sse.headers.get('Acp-Connection-Id') ?? ''
    if (connectionId === '') {
      await sse.body?.cancel().catch(() => {})
      throw new WebAgentError('SSE 通道没有返回 Acp-Connection-Id')
    }

    // 后台读流：统计 session/update；看到 session/prompt（id 4）的响应 ⇒ 这一轮说完了
    if (sse.body !== null) {
      const reader = sse.body.getReader()
      sseReader = reader
      pump = (async () => {
        const decoder = new TextDecoder()
        let buf = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const cut = buf.lastIndexOf('\n')
            if (cut < 0) continue
            const complete = buf.slice(0, cut)
            buf = buf.slice(cut + 1)
            for (const msg of parseSseMessages(complete)) {
              if (msg.method === 'session/update') {
                result.updates += 1
                const update = isObj(msg.params) && isObj(msg.params.update) ? msg.params.update : {}
                if (update.sessionUpdate === 'agent_message_chunk') result.chunks += 1
              } else if (msg.id === 4 && ('result' in msg || 'error' in msg)) {
                promptDone = true
              }
            }
          }
        } catch {
          // 连接被关/超时：由状态轮询兜底
        }
      })()
    }

    const rpc = async (id: number, method: string, params: Obj): Promise<void> => {
      const res = await doFetch(link, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Acp-Connection-Id': connectionId,
          Authorization: `Bearer ${token}`,
          'User-Agent': WEB_USER_AGENT,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      // 读完响应体（同参考实现）；读不完（流式响应超时）不算失败
      await res.text().catch(() => '')
      if (res.status !== 200 && res.status !== 202) throw new WebAgentError(`${method} 返回 HTTP ${res.status}`)
    }

    await rpc(1, 'initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES })
    await rpc(2, 'session/load', { sessionId, cwd, mcpServers: [] })
    try {
      await rpc(3, 'session/set_model', { sessionId, modelId: model })
      result.modelPinned = true
    } catch {
      result.modelPinned = false
    }
    await rpc(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })

    // 4. 轮询会话状态（completed 才算数）
    const deadline = now() + waitMs
    for (;;) {
      const status = await conversationStatus(conversation)
      if (status !== '') result.status = status
      if (status === 'completed') break
      if (status === 'failed' || status === 'error') throw new WebAgentError(`会话状态=${status}`)
      if (now() + pollMs > deadline) {
        throw new WebAgentError(
          `会话在 ${Math.round(waitMs / 1000)}s 内没有跑完（状态=${result.status || '未知'}${promptDone ? '，agent 已回复' : ''}）`,
        )
      }
      await sleep(pollMs)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return finish(false, `网页端会话失败：${reason}`)
  } finally {
    sseAbort.abort()
    await sseReader?.cancel().catch(() => {})
    await pump?.catch(() => {})
  }

  return finish(
    true,
    `网页端会话跑完：${result.chunks} 段输出`
      + (result.modelPinned ? `（模型 ${model}）` : `（⚠️ session/set_model 失败，可能按默认模型计费）`),
  )
}
