/**
 * 零输出越墙熔断（`src/gateway/zero-output.ts`）的行为断言。
 *
 * ## 为什么这些断言重要
 *
 * 这个守卫的失败形态**全是静默的**：
 * - 判据漏了「零输出」⇒ 正常的长回答被当成空轮**重发** ⇒ 用户看到正文消失/重复；
 * - 判据漏了「排除 tool_calls」⇒ **成功**的工具调用被当成空响应 ⇒ 健康账号被冷却；
 * - 判据漏了「客户端取消」⇒ 用户点停止就熔断健康账号（本项目为此踩过坑 3 次）；
 * - 过滤 `finish` 帧漏了 ⇒ 守卫**永不触发**（看起来在工作，实际没有）。
 *
 * ## 纪律
 *
 * 断言**验行为**（喂真实形状的流，看判定与副作用），不锁源码文本。
 * 正反两向都必须有：正向（零输出 ⇒ 该改道）与反向（有输出/工具调用/取消 ⇒ 不改道）。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ZERO_OUTPUT_COOLDOWN_MS,
  emptyZeroOutputProbe,
  isZeroOutputWallHit,
  noteUpstreamFrame,
  producedVisibleOutput,
  screenZeroOutputStream,
} from '../src/gateway/zero-output.ts'
import { handleChatCompletions, handleProviderChat } from '../src/gateway/server.ts'
import type { Env } from '../src/env.ts'
import { findProvider } from '../src/providers/index.ts'

// ───────────────────────── 工具：造流与假环境 ─────────────────────────

/** 把若干文本片段组成一条上游流（**故意按给定边界切块**，模拟 TCP 分包）。 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i++]!))
    },
  })
}

/** 把一条流读成字符串（用于断言「原样透传」）。 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let out = ''
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

/**
 * 捕获 `console.warn`（Worker 日志通道），跑完必定还原。
 *
 * ⚠️ 只断言面板日志（`recordLog`）是不够的：**运维看的是 Worker 日志**，
 * 而面板日志需要打开面板才看得到。两条通道都必须留痕 ——
 * 变异测试实测过「只删 console.warn」不会被任何断言抓到。
 */
async function captureWarn<T>(run: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '))
  }
  try {
    return { result: await run(), warns }
  } finally {
    console.warn = original
  }
}

/** 一帧上游 SSE。 */
function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** role 帧（上游每轮的第一帧，内容为空）。 */
const ROLE_FRAME = frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })

/** 长度截断的终止帧。 */
const LENGTH_FRAME = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })

/** 正常结束的终止帧。 */
const STOP_FRAME = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })

const DONE = 'data: [DONE]\n\n'

/** 记录到假账号池的 `applyFailure` 调用。 */
interface FailureCall {
  uid: string
  kind: string
  model?: string
  resetAt?: number
  reason?: string
}

/**
 * 构造一个只实现 `handleProviderChat` 所需面的假 Env。
 *
 * ⚠️ 用假 Env 而不是真 DO：本组测试要断言的是**判据与改道行为**，
 * 不是账号池的 SQLite 实现（那由 `node-runtime` 覆盖）。
 */
function makeEnv(input: {
  providerId: string
  model: string
  /** 每次 `chat()` 调用返回的上游流（按顺序取，用完后重复最后一个）。 */
  bodies: string[][]
  failures: FailureCall[]
  successes: string[]
  logs: string[]
}): Env {
  const provider = findProvider(input.providerId)
  if (provider === undefined) throw new Error(`测试用供应商不存在：${input.providerId}`)
  let call = 0
  // ⚠️ 不改注册表里的 Provider 对象（那会污染其它测试）。改为在假 Env 上
  // 记录一个计数器，让 `fetch` 与 provider 的选择解耦 —— 这里直接替换
  // `provider.chat` 的引用会泄漏，故用「monkey patch + finally 还原」的
  // 做法在测试末尾还原（见 `withStubbedChat`）。
  void call

  const uids = ['uid-a', 'uid-b', 'uid-c']
  let next = 0
  const pool = {
    getSession: async () => '',
    bindSession: async () => {},
    unbindSession: async () => {},
    getProviderSettings: async () => ({ order: [], disabled: [] }),
    listAccounts: async () => [],
    pick: async (req: { exclude: string[] }) => {
      for (const uid of uids) {
        if (req.exclude.includes(uid)) continue
        return { uid }
      }
      return undefined
    },
    getCredential: async (uid: string) => ({ provider: input.providerId, uid, accessToken: 'tok', refreshToken: '' }),
    noteSuccess: async (uid: string) => {
      input.successes.push(uid)
    },
    applyFailure: async (req: FailureCall) => {
      input.failures.push(req)
      return { disabled: false }
    },
    recordUsage: async () => {},
    appendLog: async (entry: { error?: string }) => {
      if (entry.error !== undefined) input.logs.push(entry.error)
    },
    noteWaf: async () => false,
    wafGateActive: async () => false,
  }
  next += 0
  return {
    ACCOUNT_POOL: {
      idFromName: (name: string) => name,
      get: () => pool,
    },
  } as unknown as Env
}

/**
 * 让 `findProvider(id).chat` 在测试期间返回给定流，结束后**必定还原**。
 *
 * ⚠️ 必须 try/finally：注册表是模块单例，泄漏的桩会让后续测试莫名失败。
 */
async function withStubbedChat<T>(
  providerId: string,
  handler: () => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const provider = findProvider(providerId)
  if (provider === undefined) throw new Error(`测试用供应商不存在：${providerId}`)
  const original = provider.chat
  provider.chat = handler
  try {
    return await run()
  } finally {
    provider.chat = original
  }
}

// ───────────────────────── ① 判据（纯函数） ─────────────────────────

test('🔴 零输出 + 长度截断 ⇒ 命中（这是要治的失败形态）', () => {
  let probe = emptyZeroOutputProbe()
  probe = noteUpstreamFrame(probe, JSON.parse(ROLE_FRAME.slice(6)))
  probe = noteUpstreamFrame(probe, JSON.parse(LENGTH_FRAME.slice(6)))
  assert.equal(probe.sawLength, true, '应识别 finish_reason=length')
  assert.equal(probe.sawOutput, false, 'role 帧与终止帧都不算产出')
  assert.equal(isZeroOutputWallHit(probe), true, '零输出 + length ⇒ 必须命中')
})

test('🔴 有输出 + 长度截断 ⇒ **不**命中（正常答到半截，改道会丢正文）', () => {
  let probe = emptyZeroOutputProbe()
  probe = noteUpstreamFrame(probe, JSON.parse(ROLE_FRAME.slice(6)))
  probe = noteUpstreamFrame(probe, JSON.parse(frame({ choices: [{ index: 0, delta: { content: '半截正文' } }] }).slice(6)))
  probe = noteUpstreamFrame(probe, JSON.parse(LENGTH_FRAME.slice(6)))
  assert.equal(probe.sawLength, true)
  assert.equal(probe.sawOutput, true, '正文即产出')
  assert.equal(isZeroOutputWallHit(probe), false,
    '⚠️ 有输出时绝不能改道 —— 那会把已产出的正文丢掉')
})

test('🔴 只调用工具（content 为空）⇒ **不**命中（假阳性比原缺陷更糟）', () => {
  // 只调用工具时 `content` 也是 `''`。若不把 tool_calls 算作产出，
  // 一次**成功**的工具调用会被误判成零输出 ⇒ 健康账号被冷却、工具调用凭空消失。
  let probe = emptyZeroOutputProbe()
  probe = noteUpstreamFrame(probe, JSON.parse(frame({
    choices: [{
      index: 0,
      delta: {
        content: '',
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city"' } }],
      },
    }],
  }).slice(6)))
  // 工具调用的收尾帧同样可能带 length
  probe = noteUpstreamFrame(probe, JSON.parse(frame({
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }).slice(6)))
  assert.equal(probe.sawOutput, true, '⚠️ tool_calls 必须算作「有输出」')
  assert.equal(isZeroOutputWallHit(probe), false, '工具调用绝不能被当成空响应')
})

test('🔴 只有思考内容（reasoning_content）也算有输出', () => {
  const probe = noteUpstreamFrame(
    emptyZeroOutputProbe(),
    JSON.parse(frame({ choices: [{ index: 0, delta: { content: '', reasoning_content: '先想一想' } }] }).slice(6)),
  )
  assert.equal(probe.sawOutput, true, '思考也是用户可见内容')
})

test('🔴 客户端取消 ⇒ **不**命中（健康账号不能因用户点停止被熔断）', () => {
  const probe = { ...emptyZeroOutputProbe(), sawLength: true, sawAborted: true }
  assert.equal(isZeroOutputWallHit(probe), false,
    '⚠️ 取消是用户的动作，不是账号/目标的问题')
})

test('错误帧 ⇒ 不命中（走既有的错误分类，别抢它的活）', () => {
  const probe = noteUpstreamFrame(
    emptyZeroOutputProbe(),
    { error: { message: 'boom' }, choices: [] },
  )
  assert.equal(probe.sawError, true)
  assert.equal(isZeroOutputWallHit({ ...probe, sawLength: true }), false)
})

test('纯 usage 计量帧不算产出（它不是内容）', () => {
  assert.equal(producedVisibleOutput({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } }), false,
    '`choices: []` 的计量帧不是内容')
  assert.equal(producedVisibleOutput({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }), true,
    '⚠️ 但上游若说它真生成了 token，保守起见按「有输出」处理')
})

test('未知形状的帧一律算产出（保守方向：宁可漏判改道，不可丢内容）', () => {
  assert.equal(producedVisibleOutput({ 奇怪: '形状' }), true)
  assert.equal(producedVisibleOutput({ choices: [{ index: 0, 莫名其妙: 1 }] }), true)
})

test('🔴 终止帧**不带 delta/message** 时不算产出（否则守卫永不触发）', () => {
  // 部分上游的终止帧形状是 `{"choices":[{"index":0,"finish_reason":"length"}]}`
  // —— **既没有 `delta` 也没有 `message`**。
  //
  // ⚠️ 若把这种帧按「未知形状 ⇒ 算产出」处理，每个终止帧都会把 `sawOutput`
  // 置真 ⇒ 判据恒为 false ⇒ **整个守卫静默失效**。
  // 「永远不触发的守卫」比没有守卫更糟：它看起来在工作。
  assert.equal(
    producedVisibleOutput({ choices: [{ index: 0, finish_reason: 'length' }] }),
    false,
    '⚠️ 只有 finish_reason 的终止帧不是内容',
  )

  const probe = noteUpstreamFrame(
    noteUpstreamFrame(emptyZeroOutputProbe(), JSON.parse(ROLE_FRAME.slice(6))),
    { choices: [{ index: 0, finish_reason: 'length' }] },
  )
  assert.equal(probe.sawOutput, false, '终止帧不得被算作产出')
  assert.equal(probe.sawLength, true, '但它必须提供「被长度截断」的信号')
  assert.equal(isZeroOutputWallHit(probe), true, '⚠️ 少了这条，守卫会永不触发')
})

test('`max_tokens` 是 `length` 的等价写法，两种都必须认', () => {
  // 本项目内部词汇与部分上游用 `max_tokens` 表示同一个「被截断」语义。
  // 只认一种会让另一形态漏判（漏判方向安全，但等于守卫少覆盖一半上游）。
  for (const reason of ['length', 'max_tokens']) {
    const probe = noteUpstreamFrame(
      noteUpstreamFrame(emptyZeroOutputProbe(), JSON.parse(ROLE_FRAME.slice(6))),
      { choices: [{ index: 0, finish_reason: reason }] },
    )
    assert.equal(probe.sawLength, true, `finish_reason=${reason} 必须被识别为长度截断`)
    assert.equal(isZeroOutputWallHit(probe), true, `finish_reason=${reason} + 零输出 ⇒ 必须命中`)
  }
  // ⚠️ 但正常结束**不得**被识别成截断
  const normal = noteUpstreamFrame(emptyZeroOutputProbe(), JSON.parse(STOP_FRAME.slice(6)))
  assert.equal(normal.sawLength, false, 'finish_reason=stop 不是截断')
})

// ───────────────────────── ② 预读（流层面） ─────────────────────────

test('🔴 零输出 + length：预读命中，且**原样还原**上游字节（一字节不丢）', async () => {
  const chunks = [ROLE_FRAME, LENGTH_FRAME, DONE]
  const screen = await screenZeroOutputStream(streamOf(chunks))
  assert.equal(screen.decided, true, '应能给出判定')
  assert.equal(screen.hit, true, '零输出 + length ⇒ 命中')
  // ⚠️ 还原后的流必须与上游逐字节相同：调用方可能不改道（或改道失败），
  // 那时这条流要能正常工作。
  assert.equal(await drain(screen.stream), chunks.join(''), '⚠️ 预读不得篡改/丢失任何字节')
})

test('🔴 有输出 + length：不命中，且正文完整透传（改道会丢正文）', async () => {
  const chunks = [
    ROLE_FRAME,
    frame({ choices: [{ index: 0, delta: { content: '这是正文' } }] }),
    LENGTH_FRAME,
    DONE,
  ]
  const screen = await screenZeroOutputStream(streamOf(chunks))
  assert.equal(screen.hit, false, '⚠️ 有输出时绝不能改道')
  assert.equal(screen.probe.sawOutput, true)
  assert.equal(await drain(screen.stream), chunks.join(''), '正文必须完整透传')
})

test('🔴 只调用工具：不命中，工具调用完整透传', async () => {
  const chunks = [
    ROLE_FRAME,
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    DONE,
  ]
  const screen = await screenZeroOutputStream(streamOf(chunks))
  assert.equal(screen.hit, false, '⚠️ 工具调用是成功响应，不得改道')
  assert.equal(await drain(screen.stream), chunks.join(''))
})

test('客户端取消 ⇒ 不命中、decided=false（判定不可信，绝不据此改道）', async () => {
  const screen = await screenZeroOutputStream(
    streamOf([ROLE_FRAME, LENGTH_FRAME]),
    { isCancelled: () => true },
  )
  assert.equal(screen.probe.sawAborted, true)
  assert.equal(screen.decided, false, '⚠️ 取消时判定必须标为不可信')
  assert.equal(screen.hit, false)
})

test('正常结束（finish_reason=stop）⇒ 不命中，也不被预读卡住', async () => {
  const chunks = [ROLE_FRAME, frame({ choices: [{ index: 0, delta: { content: 'hi' } }] }), STOP_FRAME, DONE]
  const screen = await screenZeroOutputStream(streamOf(chunks))
  assert.equal(screen.hit, false)
  assert.equal(screen.probe.sawLength, false)
  assert.equal(await drain(screen.stream), chunks.join(''))
})

test('跨 chunk 分包（一帧被拆成两半）仍能判定，且字节完整', async () => {
  // ⚠️ 实测上游会用 TCP 分包把一帧 JSON 从中间截断。预读必须按行累积，
  // 不能对单个 chunk 直接 JSON.parse（那会漏判，落到「保守 ⇒ 不改道」，
  // 即守卫静默失效）。
  const whole = ROLE_FRAME + LENGTH_FRAME
  const cut = whole.indexOf('"finish_reason"')
  const chunks = [whole.slice(0, cut), whole.slice(cut), DONE]
  const screen = await screenZeroOutputStream(streamOf(chunks))
  assert.equal(screen.hit, true, '分包不应影响判定')
  assert.equal(await drain(screen.stream), chunks.join(''))
})

test('超预算 ⇒ decided=false（宁可漏判，不可误伤）', async () => {
  const big = frame({ choices: [{ index: 0, delta: { content: '' } }] })
  const chunks = Array.from({ length: 20 }, () => big)
  const screen = await screenZeroOutputStream(streamOf(chunks), { maxFrames: 3 })
  assert.equal(screen.decided, false, '超过帧预算时必须放弃判定')
  assert.equal(screen.hit, false)
  assert.equal(await drain(screen.stream), chunks.join(''), '放弃判定也必须原样放行')
})

// ───────────────────────── ③ 端到端：改道 / 不改道 ─────────────────────────

test('🔴 端到端：第一个目标零输出 ⇒ 冷却该目标并改道下一个账号重发', async () => {
  const failures: FailureCall[] = []
  const successes: string[] = []
  const logs: string[] = []
  const providerId = 'cline'
  const model = 'test-model'
  const env = makeEnv({ providerId, model, bodies: [], failures, successes, logs })

  const goodBody = [ROLE_FRAME, frame({ choices: [{ index: 0, delta: { content: '改道后的回答' } }] }), STOP_FRAME, DONE]
  let calls = 0
  const { result, warns } = await captureWarn(async () => withStubbedChat(providerId, async () => {
    calls += 1
    if (calls === 1) {
      // 第一次：收下请求但零输出 + length（越墙的真实形态）
      return new Response(streamOf([ROLE_FRAME, LENGTH_FRAME, DONE]), { status: 200 })
    }
    return new Response(streamOf(goodBody), { status: 200 })
  }, async () => handleProviderChat({
    providerId, model, wantsStream: true,
    rawBody: { model, messages: [{ role: 'user', content: 'hi' }], stream: true },
    request: new Request('https://example.test/v1/chat/completions', { method: 'POST' }),
    env, realm: 'cn', tried: [], sessionKey: '',
  })))

  // ① 改道发生了：第二次调用返回 200 且带正文
  assert.equal(calls, 2, '⚠️ 零输出命中后必须换下一个候选重发一次')
  assert.ok(result.response.status < 400, `最终响应应为成功，实际 ${result.response.status}`)
  assert.match(await result.response.text(), /改道后的回答/, '客户端应拿到改道后的正文')

  // ② 冷却记在**目标（模型）维度**，且必须是 `model` 而不是 `breaker`
  const cool = failures.filter((f) => f.kind === 'model')
  assert.equal(cool.length, 1, `应记一次模型级冷却（实际 ${failures.length} 条：${JSON.stringify(failures)}）`)
  assert.equal(cool[0]?.uid, 'uid-a', '应罚刚失败的那个账号')
  assert.equal(cool[0]?.model, model, '必须带上模型名（否则罚成账号级）')
  assert.equal(cool[0]?.resetAt !== undefined, true, '必须显式给 resetAt（不走 11102 的 6h 退避）')
  const ttl = (cool[0]?.resetAt ?? 0) - Date.now()
  assert.ok(ttl > 0 && ttl <= ZERO_OUTPUT_COOLDOWN_MS, `冷却时长应在冷却窗口内，实际 ${ttl}`)
  assert.match(cool[0]?.reason ?? '', /zero-output/, '原因里必须能看出是零输出越墙')

  // ③ ⚠️ §7.2「失败必须显式」：不能静默改道。
  // 两条通道都要留痕：Worker 日志（运维看）+ 面板日志（用户看）。
  assert.ok(warns.some((l) => l.includes('零输出')), `⚠️ Worker 日志里必须有这次改道的痕迹，实际：${JSON.stringify(warns)}`)
  assert.ok(logs.some((l) => l.includes('零输出')), `面板日志里必须有这次改道的痕迹，实际：${JSON.stringify(logs)}`)
})

test('🔴 端到端：有输出 + length ⇒ **不**改道、**不**冷却，正文原样交给客户端', async () => {
  const failures: FailureCall[] = []
  const successes: string[] = []
  const logs: string[] = []
  const providerId = 'cline'
  const model = 'test-model'
  const env = makeEnv({ providerId, model, bodies: [], failures, successes, logs })

  const body = [
    ROLE_FRAME,
    frame({ choices: [{ index: 0, delta: { content: '答到一半就被上限截断的正文' } }] }),
    LENGTH_FRAME,
    DONE,
  ]
  let calls = 0
  const result = await withStubbedChat(providerId, async () => {
    calls += 1
    return new Response(streamOf(body), { status: 200 })
  }, async () => handleProviderChat({
    providerId, model, wantsStream: true,
    rawBody: { model, messages: [{ role: 'user', content: 'hi' }], stream: true },
    request: new Request('https://example.test/v1/chat/completions', { method: 'POST' }),
    env, realm: 'cn', tried: [], sessionKey: '',
  }))

  assert.equal(calls, 1, '⚠️ 有输出时绝不能再发一次（那会把正文丢掉重来）')
  assert.equal(failures.length, 0, `⚠️ 有输出时不得冷却任何目标，实际：${JSON.stringify(failures)}`)
  assert.equal(result.response.status, 200)
  const text = await result.response.text()
  assert.match(text, /答到一半就被上限截断的正文/, '正文必须完整交给客户端')
  assert.match(text, /"finish_reason":"length"/, 'finish_reason 必须原样保留（客户端据此判断截断）')
})

test('🔴 端到端：只调用工具 ⇒ 不改道（成功的工具调用不能被当成空响应）', async () => {
  const failures: FailureCall[] = []
  const successes: string[] = []
  const logs: string[] = []
  const providerId = 'cline'
  const model = 'test-model'
  const env = makeEnv({ providerId, model, bodies: [], failures, successes, logs })

  const body = [
    ROLE_FRAME,
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    DONE,
  ]
  let calls = 0
  const result = await withStubbedChat(providerId, async () => {
    calls += 1
    return new Response(streamOf(body), { status: 200 })
  }, async () => handleProviderChat({
    providerId, model, wantsStream: true,
    rawBody: { model, messages: [{ role: 'user', content: 'hi' }], stream: true },
    request: new Request('https://example.test/v1/chat/completions', { method: 'POST' }),
    env, realm: 'cn', tried: [], sessionKey: '',
  }))

  assert.equal(calls, 1, '⚠️ 工具调用不得触发改道')
  assert.equal(failures.length, 0, '⚠️ 工具调用不得冷却任何目标')
  assert.match(await result.response.text(), /get_weather/, '工具调用必须完整交给客户端')
})

test('端到端：客户端已取消 ⇒ 不改道、不冷却（用户点停止不算账号失败）', async () => {
  const failures: FailureCall[] = []
  const successes: string[] = []
  const logs: string[] = []
  const providerId = 'cline'
  const model = 'test-model'
  const env = makeEnv({ providerId, model, bodies: [], failures, successes, logs })

  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await withStubbedChat(providerId, async () => {
    calls += 1
    return new Response(streamOf([ROLE_FRAME, LENGTH_FRAME, DONE]), { status: 200 })
  }, async () => handleProviderChat({
    providerId, model, wantsStream: true,
    rawBody: { model, messages: [{ role: 'user', content: 'hi' }], stream: true },
    request: new Request('https://example.test/v1/chat/completions', { method: 'POST', signal: controller.signal }),
    env, realm: 'cn', tried: [], sessionKey: '',
  }))

  assert.equal(calls, 1, '取消时不得改道')
  assert.equal(failures.length, 0, `⚠️ 取消不得冷却任何目标，实际：${JSON.stringify(failures)}`)
})

// ─────────────────── ④ 端到端：buddy（默认供应商）路径 ───────────────────

/**
 * 用给定上游流桩掉 `globalThis.fetch`，跑一次 buddy（默认供应商）路径。
 *
 * ⚠️ buddy 路径**不走 `Provider.chat`**（它直接 `fetch` 上游固定端点），
 * 故这里必须桩 `fetch` 而不是桩 Provider —— 两条 chat 路径的实现是分开的，
 * 守卫也必须**两条都覆盖**（否则主力渠道等于没有守卫）。
 */
async function runBuddyOnce(bodies: string[][]): Promise<{
  calls: number
  result: { response: Response }
  failures: FailureCall[]
  logs: string[]
  warns: string[]
  restore: () => void
}> {
  const failures: FailureCall[] = []
  const successes: string[] = []
  const logs: string[] = []
  const warns: string[] = []
  const env = makeEnv({ providerId: 'buddy', model: 'm', bodies, failures, successes, logs })
  const original = globalThis.fetch
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warns.push(args.map((a) => String(a)).join(' ')) }
  let calls = 0
  globalThis.fetch = (async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)] ?? []
    calls += 1
    return new Response(streamOf(body), { status: 200 })
  }) as typeof fetch
  const restore = (): void => {
    globalThis.fetch = original
    console.warn = originalWarn
  }
  const result = await handleChatCompletions(
    new Request('https://example.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }),
    env,
    'cn',
    undefined,
    1, // failoverDepth ≥1 ⇒ 禁止跨渠道容灾递归（本测试只关心单渠道内的改道）
  )
  return { calls, result, failures, logs, warns, restore }
}

test('🔴 端到端（buddy 主力路径）：零输出 ⇒ 冷却目标并改道', async () => {
  const good = [ROLE_FRAME, frame({ choices: [{ index: 0, delta: { content: '改道后的回答' } }] }), STOP_FRAME, DONE]
  const run = await runBuddyOnce([[ROLE_FRAME, LENGTH_FRAME, DONE], good])
  try {
    assert.equal(run.calls, 2, '⚠️ 主力渠道的零输出也必须触发改道（否则守卫等于不存在）')
    assert.equal(run.result.response.status, 200)
    assert.match(await run.result.response.text(), /改道后的回答/)
    const cool = run.failures.filter((f) => f.kind === 'model')
    assert.equal(cool.length, 1, `应记一次模型级冷却，实际：${JSON.stringify(run.failures)}`)
    assert.equal(cool[0]?.model, 'm', '必须带模型名')
    // 两条可观测通道都要有痕迹（§7.2 失败必须显式）
    assert.ok(run.warns.some((l) => l.includes('零输出')), `Worker 日志必须留痕，实际：${JSON.stringify(run.warns)}`)
    assert.ok(run.logs.some((l) => l.includes('零输出')), '面板日志必须留痕（§7.2 失败必须显式）')
  } finally {
    run.restore()
  }
})

test('🔴 端到端（buddy 主力路径）：有输出 + length ⇒ 不改道、正文完整', async () => {
  const body = [
    ROLE_FRAME,
    frame({ choices: [{ index: 0, delta: { content: '半截正文' } }] }),
    LENGTH_FRAME,
    DONE,
  ]
  const run = await runBuddyOnce([body])
  try {
    assert.equal(run.calls, 1, '⚠️ 有输出时绝不改道')
    assert.equal(run.failures.length, 0, `⚠️ 有输出时不得冷却，实际：${JSON.stringify(run.failures)}`)
    assert.match(await run.result.response.text(), /半截正文/)
  } finally {
    run.restore()
  }
})
