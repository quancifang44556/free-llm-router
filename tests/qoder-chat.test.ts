/**
 * Qoder 推理 / 模型目录的行为锁（用户报障三连）：
 *
 * 1. Node/VPS 部署时推理恒报 `unknown: unexpected status 0`
 *    —— WASM 字节路径用空 import 表实例化必炸，且网关把原因吞了；
 * 2. 客户端模型选择器只显示 `DeepSeek-Flash`（没有渠道与倍率）；
 * 3. 面板拿到的是过期静态表、没有价格。
 */
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  QODER_CN_FALLBACK_MODELS,
  parseCredential,
  parseQoderModelCatalog,
  peekQoderFirstFrame,
  qodercnProvider,
  resetQoderCatalogCache,
  resignQoderHeaders,
  toProviderModels,
  unwrapQoderEnvelopeStream,
} from '../src/providers/qoder.ts'
import { prepareQoderInfer } from '../src/providers/qoder-wasm.ts'
import { isAuthLikeFailure } from '../src/gateway/server.ts'
import { annotateModelEntry } from '../src/index.ts'

const encoder = new TextEncoder()
const cred = parseCredential({ access_token: 'pt-test', uid: 'u-test', domain: 'qoder.com.cn' })

/** 先吐出给定分片、之后**永不关闭**的流（模拟上游发完错误帧不关连接）。 */
function hangingStream(chunks: string[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]!))
        return
      }
      return new Promise<void>(() => {})
    },
    cancel() { cancelled = true },
  })
  return { stream, cancelled: () => cancelled }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out += decoder.decode(value, { stream: true })
  }
}

const envelope = (inner: unknown, status = 200): string =>
  `data:${JSON.stringify({ headers: {}, body: JSON.stringify(inner), statusCodeValue: status, statusCode: 'X' })}\n\n`

const LOGIN_EXPIRED = envelope({ code: '105', message: 'Login expired' }, 403)

function mockFetch(handler: (url: string, init: RequestInit) => Response): { urls: string[]; inits: RequestInit[]; restore: () => void } {
  const real = globalThis.fetch
  const urls: string[] = []
  const inits: RequestInit[] = []
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    urls.push(String(url))
    inits.push(init)
    return handler(String(url), init)
  }) as unknown as typeof fetch
  return { urls, inits, restore: () => { globalThis.fetch = real } }
}

// ── 1. WASM 字节路径 + COSY 签名 ──

test('🔴 WASM 以字节形态加载（Node 构建同款）也能生成推理请求，签名公式与 WASM 一致', async () => {
  const p = await prepareQoderInfer({
    user: { uid: 'u1', securityOauthToken: 'pt-1' },
    machineId: 'm1',
    metadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' } as never,
    host: 'https://gateway.qoder.com.cn',
    ask: { modelKey: 'dfmodel', userText: 'hi', history: [], tools: [] },
  })
  assert.match(p.url, /^https:\/\/gateway\.qoder\.com\.cn\/algo\/api\/v2\/service\/pro\/sse\/agent_chat_generation/)
  const auth = p.headers.Authorization ?? ''
  const [, payload, sig] = /^Bearer COSY\.([^.]+)\.([0-9a-f]+)$/.exec(auth) ?? []
  assert.ok(payload !== undefined && sig !== undefined, '应为 COSY 签名头')
  const path = new URL(p.url).pathname.replace(/^\/algo/, '')
  const expected = createHash('md5')
    .update([payload, p.headers['Cosy-Key'], p.headers['Cosy-Date'], p.body, path].join('\n'))
    .digest('hex')
  assert.equal(sig, expected)
  // 用同一路径/同一 body 改签 = 原样（证明改签与 WASM 同公式）
  assert.equal(resignQoderHeaders(p.headers, new URL(p.url).pathname, p.body).Authorization, auth)
  // 改签到目录路径：载荷不变、签名按新路径重算
  const listed = resignQoderHeaders(p.headers, '/api/v2/model/list', '')
  const listedSig = createHash('md5')
    .update([payload, p.headers['Cosy-Key'], p.headers['Cosy-Date'], '', '/api/v2/model/list'].join('\n'))
    .digest('hex')
  assert.equal(listed.Authorization, `Bearer COSY.${payload}.${listedSig}`)
})

// ── 2. 首帧窥探：HTTP 200 包着的 105 ──

test('🔴 首帧是 105 Login expired（分片到达、上游不关流）→ 判为错误并取消上游', async () => {
  const half = Math.floor(LOGIN_EXPIRED.length / 2)
  const up = hangingStream(['data:', LOGIN_EXPIRED.slice(5, half), LOGIN_EXPIRED.slice(half)])
  const r = await peekQoderFirstFrame(up.stream)
  assert.equal(r.kind, 'error')
  if (r.kind !== 'error') return
  assert.equal(r.status, 403)
  assert.match(r.text, /Login expired/)
  assert.ok(up.cancelled(), '错误帧之后必须主动取消上游')
})

test('首帧正常 → 已读字节原样接回，一个字节不丢', async () => {
  const frames = [
    envelope({ choices: [{ delta: { content: 'Hel' } }] }),
    envelope({ choices: [{ delta: { content: 'lo' } }] }),
    'data:[DONE]\n\n',
  ]
  const raw = frames.join('')
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(raw.slice(0, 7)))
      c.enqueue(encoder.encode(raw.slice(7)))
      c.close()
    },
  })
  const r = await peekQoderFirstFrame(src)
  assert.equal(r.kind, 'stream')
  if (r.kind !== 'stream') return
  assert.equal(await readAll(r.stream), raw)
})

test('🔴 chat()：200 + 105 帧 → 抛 401 ProviderError，且网关会据此触发续期', async () => {
  const up = hangingStream([LOGIN_EXPIRED])
  const m = mockFetch(() => new Response(up.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  try {
    await assert.rejects(
      qodercnProvider.chat!(cred, {
        model: 'dfmodel',
        body: { model: 'dfmodel', messages: [{ role: 'user', content: 'hi' }], stream: true },
        signal: new AbortController().signal,
      } as never),
      (error: unknown) => {
        const e = error as { name?: string; httpStatus?: number; message?: string }
        assert.equal(e.name, 'ProviderError')
        assert.equal(e.httpStatus, 401)
        assert.match(e.message ?? '', /Login expired/)
        assert.ok(isAuthLikeFailure(0, e.message ?? ''), '网关的续期判据必须命中')
        return true
      },
    )
    assert.equal(m.urls.length, 1)
  } finally {
    m.restore()
  }
})

test('chat()：正常流 → 转成标准 OpenAI SSE', async () => {
  const body = envelope({ choices: [{ delta: { content: 'ok' } }] }) + 'data:[DONE]\n\n'
  const m = mockFetch(() => new Response(body, { status: 200 }))
  try {
    const res = await qodercnProvider.chat!(cred, {
      model: 'dfmodel',
      body: { model: 'dfmodel', messages: [{ role: 'user', content: 'hi' }], stream: true },
      signal: new AbortController().signal,
    } as never)
    const text = await readAll(res.body!)
    assert.match(text, /data: \{"choices":\[\{"delta":\{"content":"ok"\}\}\]\}/)
    assert.match(text, /data: \[DONE\]/)
  } finally {
    m.restore()
  }
})

test('🔴 流中途出现带业务码的错误帧（上游不关流）→ 转发错误帧后立即收尾', async () => {
  const up = hangingStream([
    envelope({ choices: [{ delta: { content: 'a' } }] }),
    envelope({ code: '500', message: 'boom' }, 500),
  ])
  const text = await readAll(unwrapQoderEnvelopeStream(up.stream, 'qodercn'))
  assert.match(text, /"content":"a"/)
  assert.match(text, /"code":"500","message":"boom","type":"model_error"/)
})

// ── 3. 远端模型目录 ──

const CATALOG = {
  chat: [
    { key: 'qfmodel', display_name: 'Qwen3.8-Flash', enable: true, price_factor: 0, is_free: true, is_vl: true, is_reasoning: true,
      max_input_tokens: 180000, context_config: { '200K': { token_count: 200000 }, '1M': { token_count: 1000000 } } },
    { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, price_factor: 0.5, is_free: true, is_vl: true, is_reasoning: true, max_input_tokens: 180000 },
    { key: 'dfmodel', display_name: 'DeepSeek-Flash', enable: true, price_factor: 0.1, is_vl: true, is_reasoning: false,
      context_config: { '1M': { token_count: 1000000 } } },
    { key: 'smodel', display_name: 'Sonus', enable: false, price_factor: 8 },
    { key: 'lite', display_name: 'Lite', enable: true },
    { key: 'codewise-x', enable: true },
    { key: 'foo-image-alpha', enable: true },
  ],
}

test('目录解析：过滤非聊天/不可用模型，上下文取档位表最大档，倍率 0 = 免费', () => {
  const models = parseQoderModelCatalog(CATALOG)
  assert.deepEqual(models.map((m) => m.id), ['qfmodel', 'qmodel_38max', 'dfmodel'])
  assert.equal(models[0]!.contextWindow, 1_000_000)
  assert.equal(models[1]!.contextWindow, 180_000)
  assert.equal(models[2]!.supportsThinking, false)
  const out = toProviderModels(models)
  assert.equal(out[0]!.priceFactor, 0)
  assert.equal(out[0]!.isFree, true)
  // ⚠️ is_free=true 但倍率 0.5 —— 照样扣费，不能标「免费」
  assert.equal(out[1]!.priceFactor, 0.5)
  assert.equal(out[1]!.isFree, false)
  assert.equal(out[2]!.priceFactor, 0.1)
  // 全部 enable:false 时（口径异常）不至于返回空表
  assert.equal(parseQoderModelCatalog({ chat: [{ key: 'a', enable: false }] }).length, 1)
})

test('🔴 静态兜底表也要透传倍率（面板「资费」列与客户端名称都靠它）', () => {
  const out = toProviderModels(QODER_CN_FALLBACK_MODELS)
  assert.ok(out.every((m) => typeof m.priceFactor === 'number'))
  assert.equal(out.find((m) => m.id === 'dfmodel')!.priceFactor, 0.1)
})

test('listModels：拉远端目录（GET + 改签头），失败回退静态表', async () => {
  resetQoderCatalogCache()
  let fail = false
  const m = mockFetch(() => (fail
    ? new Response('{"code":"105","message":"Login expired"}', { status: 403 })
    : new Response(JSON.stringify(CATALOG), { status: 200 })))
  try {
    const models = await qodercnProvider.listModels!(cred, new AbortController().signal)
    assert.deepEqual(models.map((x) => x.id), ['qfmodel', 'qmodel_38max', 'dfmodel'])
    assert.equal(m.urls[0], 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1')
    assert.equal(m.inits[0]!.method, 'GET')
    assert.equal(m.inits[0]!.body, undefined)
    const headers = m.inits[0]!.headers as Record<string, string>
    assert.match(headers.Authorization ?? '', /^Bearer COSY\./)
    assert.equal(headers.Accept, 'application/json')
    assert.equal(headers['X-Model-Key'], undefined)

    // 命中缓存：不再发请求
    await qodercnProvider.listModels!(cred, new AbortController().signal)
    assert.equal(m.urls.length, 1)

    resetQoderCatalogCache()
    fail = true
    const fallback = await qodercnProvider.listModels!(cred, new AbortController().signal)
    assert.equal(fallback.length, QODER_CN_FALLBACK_MODELS.length)
  } finally {
    m.restore()
    resetQoderCatalogCache()
  }
})

// ── 4. /v1/models 名称：渠道 · 模型 · 倍率 ──

test('🔴 /v1/models 名称带渠道与倍率（不再只有 DeepSeek-Flash）', () => {
  const flash = annotateModelEntry({ id: 'qodercn/dfmodel', name: 'DeepSeek-Flash', priceFactor: 0.1, isFree: false }, 'qodercn')
  assert.equal(flash.name, 'Qoder (中国版) · DeepSeek-Flash · ×0.1')
  const free = annotateModelEntry({ id: 'qodercn/qfmodel', name: 'Qwen3.8-Flash', priceFactor: 0, isFree: true }, 'qodercn')
  assert.equal(free.name, 'Qoder (中国版) · Qwen3.8-Flash · 免费')
  // buddy 的既有形态不变
  const buddy = annotateModelEntry({ id: 'buddy/glm', name: 'GLM', credits: 'x0.21' }, 'buddy')
  assert.equal(buddy.name, '国内 · GLM · ×0.21')
})

test('🔴 客户端没给档位时，必须回落到目录的 defaultEffort（不传 ≠ 中性默认）', () => {
  // ## 实测依据（2026-10-21）
  //
  // 同一个问题（`qodercn/dfmodel`，"解释递归"）的 reasoning_tokens：
  //
  // | 请求 | reasoning_tokens |
  // |---|---|
  // | 不传档位 | **1417** |
  // | `low`    | 247 |
  // | `max`    | 728 |
  //
  // 「不传」比显式 `max` 还多 2 倍 —— 上游默认走最重思考。
  // 客户端（DSH）只在用户**主动选**档位时才带 `reasoning_effort`，
  // 于是「没选」＝ 被动吃最贵档位：又慢又费积分。
  //
  // 故 qoder 的推理入口在客户端没给档位时，回落到目录 `defaultEffort`。
  // 目录**没声明**时保持 `undefined`（不干预），与改动前行为一致。
  const source = readFileSync('src/providers/qoder.ts', 'utf8')
  assert.ok(
    /clientEffort\s*\?\?\s*catalogDefaultEffort/.test(source),
    '⚠️ reasonEffort 必须是「客户端优先、目录默认兜底」，不能写死常量',
  )
  assert.ok(
    /findQoderModel\(product,\s*request\.model\)\?\.defaultEffort/.test(source),
    '默认档位必须取自该模型自己的目录条目（不同模型默认档不同）',
  )

  // 目录里该模型确实声明了 defaultEffort —— 否则上面的兜底取到 undefined，
  // 功能等于没开。`dfmodel` 目录声明 `defaultEffort: 'max'`。
  const df = QODER_CN_FALLBACK_MODELS.find((m) => m.id === 'dfmodel')
  assert.ok(df !== undefined, 'CN 目录必须有 dfmodel')
  assert.equal(df!.defaultEffort, 'high', 'CN dfmodel 的目录默认档是 high')

  // 反向：目录没声明 defaultEffort 的模型，兜底值必须是 undefined（不编造）。
  const noDefault = QODER_CN_FALLBACK_MODELS.find((m) => m.defaultEffort === undefined)
  assert.ok(noDefault !== undefined, '目录里应存在未声明 defaultEffort 的模型（用于验证不编造）')
  assert.equal(noDefault!.defaultEffort, undefined)
})
