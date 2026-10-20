/**
 * 国际版网页端每日活跃打卡（移植自 ardeyouxipianyi/workbuddy2api-hub）的单测。
 *
 * 用注入的 fetch 模拟 console API + ACP 沙箱，核对：请求顺序、`session/set_model`
 * 必发且钉到免费模型、X-User-Id 去前缀、completed 才算成功、各类失败如实折成 detail。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DAILY_CHAT_MODEL,
  WEB_CONVERSATIONS_URL,
  parseSseMessages,
  runWebDailyChat,
  webAgentHeaders,
} from '../src/upstream/webagent.ts'
import { planByName } from '../src/taskrunner/plans.ts'
import { registeredActions } from '../src/taskrunner/actions.ts'

const LINK = 'https://sandbox.example/acp/abc'

interface MockOpts {
  create?: unknown
  session?: unknown
  statuses?: string[]
  connectionId?: string
  failMethod?: string
}

function mockUpstream(opts: MockOpts = {}) {
  const rpcs: Array<{ method: string; params: Record<string, unknown>; headers: Headers }> = []
  const calls: Array<{ method: string; url: string; headers: Headers; body: string }> = []
  let statusIdx = 0
  let sseCancelled = false
  const statuses = opts.statuses ?? ['running', 'completed']
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ method, url, headers, body })

    if (url === WEB_CONVERSATIONS_URL && method === 'POST') {
      return json(opts.create ?? { code: 0, data: { id: 'conv1' } })
    }
    if (url === `${WEB_CONVERSATIONS_URL}conv1/session`) {
      return json(opts.session ?? { code: 0, data: { link: LINK, token: 'sess-token', sessionId: 's1', cwd: '/w' } })
    }
    if (url === `${WEB_CONVERSATIONS_URL}conv1`) {
      const s = statuses[Math.min(statusIdx, statuses.length - 1)]
      statusIdx += 1
      return json({ code: 0, data: { status: s } })
    }
    if (url === LINK && method === 'GET') {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(
            'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}\n'
            + 'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call"}}}\n'
            + 'data: {"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}\n',
          ))
          // 保持打开，直到被取消
        },
        cancel() {
          sseCancelled = true
        },
      })
      const h: Record<string, string> = { 'Content-Type': 'text/event-stream' }
      const cid = opts.connectionId ?? 'conn-1'
      if (cid !== '') h['Acp-Connection-Id'] = cid
      return new Response(stream, { status: 200, headers: h })
    }
    if (url === LINK && method === 'POST') {
      const msg = JSON.parse(body) as { method: string; params: Record<string, unknown> }
      rpcs.push({ method: msg.method, params: msg.params, headers })
      if (msg.method === opts.failMethod) return new Response('boom', { status: 500 })
      return new Response('', { status: 202 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  return { fetchImpl, rpcs, calls, sseCancelled: () => sseCancelled }
}

/** 假时钟：sleep 推进时间，但仍让出事件循环（让 SSE 读流跑起来）。 */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return new Promise<void>((r) => setTimeout(r, 1))
    },
  }
}

const INPUT = { uid: 'workbuddy:u-123', accessToken: 'tok' }

test('网页端打卡：完整流程成功，JSON-RPC 顺序正确且必发 session/set_model', async () => {
  const m = mockUpstream()
  const clock = fakeClock()
  const r = await runWebDailyChat(INPUT, { fetchImpl: m.fetchImpl, ...clock })
  assert.equal(r.ok, true, r.detail)
  assert.equal(r.conversationId, 'conv1')
  assert.equal(r.status, 'completed')
  assert.equal(r.modelPinned, true)
  assert.deepEqual(m.rpcs.map((x) => x.method), ['initialize', 'session/load', 'session/set_model', 'session/prompt'])
  assert.deepEqual(m.rpcs[2]?.params, { sessionId: 's1', modelId: DEFAULT_DAILY_CHAT_MODEL })
  assert.deepEqual(m.rpcs[1]?.params, { sessionId: 's1', cwd: '/w', mcpServers: [] })
  for (const rpc of m.rpcs) {
    assert.equal(rpc.headers.get('Acp-Connection-Id'), 'conn-1')
    assert.equal(rpc.headers.get('Authorization'), 'Bearer sess-token')
  }
  assert.equal(r.chunks, 1)
  assert.equal(r.updates, 2)
  assert.equal(m.sseCancelled(), true, '结束后必须关掉 SSE 流')
})

test('网页端打卡：建会话 body 与头形态（X-User-Id 去 workbuddy: 前缀）', async () => {
  const m = mockUpstream()
  await runWebDailyChat(INPUT, { fetchImpl: m.fetchImpl, ...fakeClock(), model: 'm-x' })
  const create = m.calls[0]
  assert.ok(create !== undefined)
  assert.equal(create.headers.get('X-User-Id'), 'u-123')
  assert.equal(create.headers.get('Authorization'), 'Bearer tok')
  assert.equal(create.headers.get('Origin'), 'https://www.workbuddy.ai')
  const body = JSON.parse(create.body) as Record<string, unknown>
  assert.equal(body.model, 'm-x')
  assert.equal(body.prompt, 'Hi')
  assert.equal(body.conversationOrigin, 'workbuddy-app')
  assert.equal(webAgentHeaders({ uid: 'plain', accessToken: 'a' })['X-User-Id'], 'plain')
})

test('网页端打卡：set_model 失败不致命，但结果里要警示', async () => {
  const m = mockUpstream({ failMethod: 'session/set_model' })
  const r = await runWebDailyChat(INPUT, { fetchImpl: m.fetchImpl, ...fakeClock() })
  assert.equal(r.ok, true, r.detail)
  assert.equal(r.modelPinned, false)
  assert.match(r.detail, /set_model 失败/)
  assert.ok(m.rpcs.some((x) => x.method === 'session/prompt'), '仍要把这一轮跑完')
})

test('网页端打卡：各类失败如实折成 detail（不抛）', async () => {
  const bad = await runWebDailyChat(INPUT, {
    fetchImpl: mockUpstream({ create: { code: 14001, msg: 'nope' } }).fetchImpl, ...fakeClock(),
  })
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /建会话失败：code=14001 msg=nope/)

  const noLink = await runWebDailyChat(INPUT, {
    fetchImpl: mockUpstream({ session: { code: 0, data: {} } }).fetchImpl, ...fakeClock(),
  })
  assert.equal(noLink.ok, false)
  assert.match(noLink.detail, /沙箱未就绪/)

  const noConn = await runWebDailyChat(INPUT, {
    fetchImpl: mockUpstream({ connectionId: '' }).fetchImpl, ...fakeClock(),
  })
  assert.equal(noConn.ok, false)
  assert.match(noConn.detail, /Acp-Connection-Id/)

  const failed = await runWebDailyChat(INPUT, {
    fetchImpl: mockUpstream({ statuses: ['running', 'failed'] }).fetchImpl, ...fakeClock(),
  })
  assert.equal(failed.ok, false)
  assert.match(failed.detail, /会话状态=failed/)

  const loadFail = await runWebDailyChat(INPUT, {
    fetchImpl: mockUpstream({ failMethod: 'session/load' }).fetchImpl, ...fakeClock(),
  })
  assert.equal(loadFail.ok, false)
  assert.match(loadFail.detail, /session\/load 返回 HTTP 500/)
})

test('网页端打卡：超时截止且轮询次数有界（Workers 子请求预算）', async () => {
  const m = mockUpstream({ statuses: ['running'] })
  const r = await runWebDailyChat(INPUT, { fetchImpl: m.fetchImpl, ...fakeClock(), waitMs: 20_000, pollMs: 5_000 })
  assert.equal(r.ok, false)
  assert.match(r.detail, /20s 内没有跑完/)
  const polls = m.calls.filter((c) => c.url === `${WEB_CONVERSATIONS_URL}conv1`).length
  assert.equal(polls, 5)
  // 默认参数下的最坏子请求数也要压在 50 以内
  const m2 = mockUpstream({ statuses: ['running'] })
  await runWebDailyChat(INPUT, { fetchImpl: m2.fetchImpl, ...fakeClock() })
  assert.ok(m2.calls.length <= 40, `默认最坏 ${m2.calls.length} 个子请求`)
})

test('parseSseMessages：只取 data 行里的 JSON 对象', () => {
  const msgs = parseSseMessages('event: x\ndata: {"a":1}\n\ndata: [DONE]\ndata: nope\ndata: [1]\n')
  assert.deepEqual(msgs, [{ a: 1 }])
})

test('intlDaily 计划：只有一步 webDailyChat，且动作已注册', () => {
  const steps = planByName('intlDaily')
  assert.deepEqual(steps.map((s) => s.action), ['webDailyChat'])
  assert.ok(registeredActions().includes('webDailyChat'))
})
