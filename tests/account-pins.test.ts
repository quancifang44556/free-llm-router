/**
 * 指定账号（account pins）单元与集成测试。
 *
 * 验证：
 * 1. DO 的 getPins / setPin / clearPin：独立存储、供应商取自账号、校验失败不写入；
 * 2. 选号：
 *    - `only`：只选它；它不可用时显式返回 pinnedUnavailable + 人话原因（不回落）；
 *    - `prefer`：优先选它；它不可用时自然回落到其余候选；
 *    - 请求级 `pinned`（X-FLR-Account）优先于面板指定；
 *    - 删除账号连带清掉指向它的指定；
 * 3. 管理接口 GET/POST /admin/pins；
 * 4. 网关：只用指定账号但它不可用 ⇒ 503 + 说明，**不调上游、不换号**；
 * 5. 永久积分锁必须镜像到 global 分片（国际版账号在那里选号）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import { handleChatCompletions, handleProviderChat } from '../src/gateway/server.js'
import { findProvider } from '../src/providers/index.js'
import { ProviderError } from '../src/providers/types.js'
import worker from '../src/index.js'

function freshRuntime(name: string) {
  fs.mkdirSync(path.join(process.cwd(), '.build'), { recursive: true })
  const dbPath = path.join(process.cwd(), '.build', `test-pins-${name}.db`)
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  const runtime = createNodeRuntime(dbPath)
  return {
    ...runtime,
    cleanup: () => {
      runtime.db.close()
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
    },
  }
}

type Pool = ReturnType<ReturnType<typeof createNodeRuntime>['env']['ACCOUNT_POOL']['get']>

async function addAccount(pool: Pool, uid: string, opts: { provider?: string; realm?: string; nickname?: string } = {}) {
  const state = createAccountState({
    uid,
    nickname: opts.nickname ?? uid,
    realm: opts.realm ?? 'cn',
    provider: opts.provider ?? 'buddy',
  })
  state.credits = 100
  state.creditsExpiring = 100
  await pool.upsertAccount(state, Date.now())
  return state
}

const MODEL = 'deepseek-v4-flash'

test('DO：setPin / getPins / clearPin —— 供应商取自账号，校验失败不写入', async () => {
  const rt = freshRuntime('store')
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    await addAccount(pool, 'a1')
    await addAccount(pool, 'c1', { provider: 'cline' })

    assert.deepEqual(await pool.getPins(), {})

    const ok = await pool.setPin('a1', 'only')
    assert.equal(ok.ok, true)
    assert.deepEqual(await pool.getPins(), { buddy: { uid: 'a1', mode: 'only' } })

    // 同一供应商只保留一个指定（后设覆盖先设）；不同供应商互不影响
    await pool.setPin('c1', 'prefer')
    assert.deepEqual(await pool.getPins(), {
      buddy: { uid: 'a1', mode: 'only' },
      cline: { uid: 'c1', mode: 'prefer' },
    })

    // 账号不存在 ⇒ not_found，不写入
    const missing = await pool.setPin('nope', 'only')
    assert.equal(missing.ok, false)
    assert.equal(missing.ok === false && missing.code, 'not_found')

    // ⚠️ 调用方以为的供应商与实际不符 ⇒ 拒绝且**不动原有指定**
    const mismatch = await pool.setPin('c1', 'only', 'buddy')
    assert.equal(mismatch.ok, false)
    assert.deepEqual((await pool.getPins()).buddy, { uid: 'a1', mode: 'only' })
    assert.deepEqual((await pool.getPins()).cline, { uid: 'c1', mode: 'prefer' })

    // 非法 mode
    const bad = await pool.setPin('a1', 'always' as never)
    assert.equal(bad.ok, false)

    // 取消
    assert.deepEqual(await pool.clearPin('buddy'), { cline: { uid: 'c1', mode: 'prefer' } })
    // 幂等
    assert.deepEqual(await pool.clearPin('buddy'), { cline: { uid: 'c1', mode: 'prefer' } })
  } finally {
    rt.cleanup()
  }
})

test('选号 only：只选指定账号；不可用时显式返回原因，不回落', async () => {
  const rt = freshRuntime('only')
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    await addAccount(pool, 'a1')
    await addAccount(pool, 'a2', { nickname: '二号' })
    await addAccount(pool, 'a3')
    await pool.setPin('a2', 'only')

    // 多次选号都只落 a2（轮询/防惊群都不能把它摊走）
    for (let i = 0; i < 5; i += 1) {
      const r = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now() })
      assert.equal(r?.uid, 'a2')
    }

    // 本次请求里它失败过 ⇒ 不换号
    const tried = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: ['a2'], now: Date.now() })
    assert.equal(tried?.pinnedUnavailable, true)
    assert.equal(tried?.pinnedUid, 'a2')
    assert.equal(tried?.pinnedLabel, '二号')
    assert.match(tried?.pinnedReason ?? '', /失败过/)
    assert.equal(tried?.uid, undefined, '不能顺手选别的号')

    // 停用
    const s2 = (await pool.getAccount('a2'))!
    s2.disabled = true
    await pool.upsertAccount(s2, Date.now())
    const disabled = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now() })
    assert.equal(disabled?.pinnedUnavailable, true)
    assert.match(disabled?.pinnedReason ?? '', /已停用/)

    // 冷却
    s2.disabled = false
    s2.until = Date.now() + 5 * 60_000
    await pool.upsertAccount(s2, Date.now())
    const cooling = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now() })
    assert.match(cooling?.pinnedReason ?? '', /冷却中，约 5 分钟后恢复/)

    // 模型级限流：只影响该模型，别的模型照常选它
    s2.until = 0
    s2.modelCooldowns[MODEL] = { until: Date.now() + 10 * 60_000 } as never
    await pool.upsertAccount(s2, Date.now())
    const modelCool = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now() })
    assert.match(modelCool?.pinnedReason ?? '', new RegExp(`模型 ${MODEL} 在它上面限流中`))
    const other = await pool.pick({ realm: 'cn', provider: 'buddy', model: 'glm-5', exclude: [], now: Date.now() })
    assert.equal(other?.uid, 'a2')

    // 永久积分锁
    s2.modelCooldowns = {}
    s2.creditsExpiring = 0
    await pool.upsertAccount(s2, Date.now())
    await pool.setPermanentLock('buddy', true)
    const locked = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now() })
    assert.equal(locked?.pinnedUnavailable, true)
    assert.match(locked?.pinnedReason ?? '', /永久积分锁/)
  } finally {
    rt.cleanup()
  }
})

test('选号 prefer：优先指定账号；不可用时自然回落', async () => {
  const rt = freshRuntime('prefer')
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    await addAccount(pool, 'a1')
    await addAccount(pool, 'a2')
    await pool.setPin('a2', 'prefer')

    for (let i = 0; i < 3; i += 1) {
      const r = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now() })
      assert.equal(r?.uid, 'a2')
    }
    // ⚠️ 指定优先于会话粘性
    const sticky = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now(), preferred: 'a1' })
    assert.equal(sticky?.uid, 'a2')

    // 它失败过 / 停用 ⇒ 回落到 a1，而不是报错
    const fallback = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: ['a2'], now: Date.now() })
    assert.equal(fallback?.uid, 'a1')
    assert.equal(fallback?.pinnedUnavailable, undefined)

    // 指定只作用于它所属的供应商
    await addAccount(pool, 'c1', { provider: 'cline' })
    const cline = await pool.pick({ realm: 'cn', provider: 'cline', model: MODEL, exclude: [], now: Date.now() })
    assert.equal(cline?.uid, 'c1')
  } finally {
    rt.cleanup()
  }
})

test('请求级 pinned（X-FLR-Account）优先于面板指定，且恒为「只用它」', async () => {
  const rt = freshRuntime('request')
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    await addAccount(pool, 'a1')
    await addAccount(pool, 'a2')
    await addAccount(pool, 'c1', { provider: 'cline' })
    await pool.setPin('a2', 'prefer')

    const r = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now(), pinned: 'a1' })
    assert.equal(r?.uid, 'a1')

    const failed = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: ['a1'], now: Date.now(), pinned: 'a1' })
    assert.equal(failed?.pinnedUnavailable, true, '请求级指定不回落（即便面板指定是 prefer）')

    const wrongProvider = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now(), pinned: 'c1' })
    assert.equal(wrongProvider?.pinnedUnavailable, true)
    assert.match(wrongProvider?.pinnedReason ?? '', /属于供应商「cline」/)

    const missing = await pool.pick({ realm: 'cn', provider: 'buddy', model: MODEL, exclude: [], now: Date.now(), pinned: 'ghost' })
    assert.equal(missing?.pinnedUnavailable, true)
    assert.match(missing?.pinnedReason ?? '', /不存在/)
  } finally {
    rt.cleanup()
  }
})

test('删除账号连带清掉指向它的指定', async () => {
  const rt = freshRuntime('remove')
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    await addAccount(pool, 'a1')
    await addAccount(pool, 'c1', { provider: 'cline' })
    await pool.setPin('a1', 'only')
    await pool.setPin('c1', 'only')
    await pool.removeAccount('a1')
    assert.deepEqual(await pool.getPins(), { cline: { uid: 'c1', mode: 'only' } })
  } finally {
    rt.cleanup()
  }
})

test('HTTP API：GET/POST /admin/pins', async () => {
  const rt = freshRuntime('api')
  const { env } = rt
  env.API_KEY = 'test-pins-api-key-0123456789'
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  const auth = { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' }
  const post = (body: unknown) =>
    worker.fetch(new Request('http://localhost/admin/pins', { method: 'POST', headers: auth, body: JSON.stringify(body) }), env, ctx)
  try {
    const cn = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const global = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))
    await addAccount(cn, 'a1', { nickname: '国内一号' })
    await addAccount(global, 'w1', { provider: 'workbuddy', realm: 'global', nickname: '国际一号' })

    // 未鉴权
    const anon = await worker.fetch(new Request('http://localhost/admin/pins'), env, ctx)
    assert.equal(anon.status, 401)

    // 参数校验
    assert.equal((await post({ realm: 'mars', uid: 'a1' })).status, 400)
    assert.equal((await post({ realm: 'cn', uid: 'a1', mode: 'always' })).status, 400)
    assert.equal((await post({ realm: 'cn', uid: 'ghost' })).status, 404)
    assert.equal((await post({ realm: 'cn', uid: 'a1', provider: 'cline' })).status, 400)
    assert.equal((await post({ realm: 'cn', uid: '' })).status, 400, '取消指定需要 provider')

    // 设置（mode 缺省为 only）
    const set1 = await post({ realm: 'cn', uid: 'a1' })
    assert.equal(set1.status, 200)
    const set1Json = (await set1.json()) as { provider: string; pinned: { mode: string } }
    assert.equal(set1Json.provider, 'buddy')
    assert.equal(set1Json.pinned.mode, 'only')
    assert.equal((await post({ realm: 'global', uid: 'w1', mode: 'prefer' })).status, 200)

    // GET 合并两个分片，带昵称
    const list = await worker.fetch(new Request('http://localhost/admin/pins', { headers: auth }), env, ctx)
    const listJson = (await list.json()) as { pins: Array<Record<string, string>> }
    assert.deepEqual(listJson.pins, [
      { realm: 'cn', provider: 'buddy', uid: 'a1', mode: 'only', nickname: '国内一号' },
      { realm: 'global', provider: 'workbuddy', uid: 'w1', mode: 'prefer', nickname: '国际一号' },
    ])

    // 取消
    const clear = await post({ realm: 'cn', provider: 'buddy', uid: '' })
    assert.equal(clear.status, 200)
    const after = (await (await worker.fetch(new Request('http://localhost/admin/pins?realm=cn', { headers: auth }), env, ctx)).json()) as { pins: unknown[] }
    assert.deepEqual(after.pins, [])
  } finally {
    rt.cleanup()
  }
})

/** 一段最小的成功 SSE。 */
function okStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    'data: [DONE]\n\n',
  ]
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

async function withGateway(
  name: string,
  setup: (pool: Pool) => Promise<void>,
  upstream: () => Response,
  headers: Record<string, string> = {},
) {
  const rt = freshRuntime(name)
  const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
  for (const uid of ['a1', 'a2']) {
    await addAccount(pool, uid)
    await pool.putCredential(uid, { uid, nickname: uid, accessToken: `tok-${uid}`, refreshToken: '', expiresAt: Date.now() + 3600_000 }, Date.now())
  }
  await setup(pool)
  const original = globalThis.fetch
  const originalLog = console.log
  const picked: string[] = []
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ')
    const m = /\[pick:buddy\] 选中账号 uid=(\S+)/.exec(line)
    if (m?.[1] !== undefined) picked.push(m[1])
  }
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return upstream()
  }) as typeof fetch
  try {
    const result = await handleChatCompletions(
      new Request('https://example.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: false }),
      }),
      rt.env,
      'cn',
      undefined,
      1,
    )
    const text = await result.response.text()
    // 让「流结束后才记账」的异步写入先落库，再关库（否则日志里刷 database is not open）
    await new Promise((r) => setTimeout(r, 30))
    return { status: result.response.status, text, calls, picked }
  } finally {
    globalThis.fetch = original
    console.log = originalLog
    rt.cleanup()
  }
}

test('网关：只用指定账号但它已停用 ⇒ 503 + 说明，不调上游', async () => {
  const r = await withGateway('gw-disabled', async (pool) => {
    await pool.setPin('a2', 'only')
    const s = (await pool.getAccount('a2'))!
    s.disabled = true
    await pool.upsertAccount(s, Date.now())
  }, () => new Response(okStream('不该出现'), { status: 200 }))
  assert.equal(r.status, 503)
  assert.equal(r.calls, 0, '⚠️ 指定账号不可用时不得换号去打上游')
  assert.match(r.text, /已指定只用账号「a2」/)
  assert.match(r.text, /已停用/)
  assert.match(r.text, /pinned_account_unavailable/)
})

test('网关：只用指定账号 ⇒ 用它；它失败了不换号，报它的真实原因', async () => {
  const ok = await withGateway('gw-ok', async (pool) => { await pool.setPin('a2', 'only') },
    () => new Response(okStream('来自指定账号'), { status: 200 }))
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.picked, ['a2'])
  assert.match(ok.text, /来自指定账号/)

  const fail = await withGateway('gw-fail', async (pool) => { await pool.setPin('a2', 'only') },
    () => new Response('{"error":{"message":"upstream boom"}}', { status: 500 }))
  assert.notEqual(fail.status, 200)
  assert.deepEqual(fail.picked, ['a2'], '⚠️ 只用它 ⇒ 失败后不得换到 a1')
  assert.match(fail.text, /已指定只用账号「a2」，它这次请求失败了/)
})

test('网关：优先用指定账号，它失败时换号', async () => {
  const r = await withGateway('gw-prefer', async (pool) => { await pool.setPin('a2', 'prefer') }, (() => {
    let n = 0
    return () => {
      n += 1
      return n === 1
        ? new Response('{"error":{"message":"upstream boom"}}', { status: 500 })
        : new Response(okStream('换号成功'), { status: 200 })
    }
  })())
  assert.equal(r.picked[0], 'a2', '先用指定账号')
  assert.equal(r.picked[1], 'a1', '失败后回落')
  assert.equal(r.status, 200)
})

test('网关：请求头 X-FLR-Account 指定不存在的账号 ⇒ 503 + 提示去掉请求头', async () => {
  const r = await withGateway('gw-header', async () => {}, () => new Response(okStream('x'), { status: 200 }), {
    'x-flr-account': 'ghost',
  })
  assert.equal(r.status, 503)
  assert.equal(r.calls, 0)
  assert.match(r.text, /X-FLR-Account/)
  assert.match(r.text, /去掉该请求头/)

  const hit = await withGateway('gw-header-hit', async (pool) => { await pool.setPin('a2', 'only') },
    () => new Response(okStream('头部指定'), { status: 200 }), { 'x-flr-account': 'a1' })
  assert.equal(hit.status, 200)
  assert.deepEqual(hit.picked, ['a1'], '请求头优先于面板指定')
})

test('永久积分锁：POST 必须镜像到 global 分片（国际版账号在那里选号）', async () => {
  const rt = freshRuntime('perm-mirror')
  const { env } = rt
  env.API_KEY = 'test-pins-api-key-0123456789'
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  try {
    const res = await worker.fetch(
      new Request('http://localhost/admin/permanent-locks', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'workbuddy', locked: true }),
      }),
      env,
      ctx,
    )
    assert.equal(res.status, 200)
    const global = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))
    assert.deepEqual(await global.getPermanentLocks(), { workbuddy: true })

    // 锁真的在 global 分片生效：只剩永久积分的国际版账号不参与选号
    const w = createAccountState({ uid: 'w1', nickname: 'w1', realm: 'global', provider: 'workbuddy' })
    w.credits = 500
    w.creditsExpiring = 0
    await global.upsertAccount(w, Date.now())
    const r = await global.pick({ realm: 'global', provider: 'workbuddy', model: MODEL, exclude: [], now: Date.now() })
    assert.equal(r?.lockedByPermanent, true)
  } finally {
    rt.cleanup()
  }
})

test('网关（供应商路径 cline）：只用指定账号不可用 ⇒ 不调上游；可用 ⇒ 只用它', async () => {
  const rt = freshRuntime('gw-provider')
  const provider = findProvider('cline')
  assert.ok(provider !== undefined)
  const originalChat = provider.chat
  const originalLog = console.log
  const used: string[] = []
  console.log = () => {}
  provider.chat = (async (credential: { uid?: string; accessToken?: string }) => {
    used.push(String(credential.accessToken))
    return new Response(okStream('cline 回答'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as never
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    for (const uid of ['c1', 'c2']) {
      await addAccount(pool, uid, { provider: 'cline' })
      await pool.putCredential(uid, { uid, nickname: uid, accessToken: `tok-${uid}`, refreshToken: '', expiresAt: Date.now() + 3600_000 }, Date.now())
    }
    const run = (headers: Record<string, string> = {}) => handleProviderChat({
      providerId: 'cline', model: 'm', wantsStream: false,
      rawBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      request: new Request('https://example.test/v1/chat/completions', { method: 'POST', headers }),
      env: rt.env, realm: 'cn', tried: [], sessionKey: '', failoverDepth: 1,
    })

    await pool.setPin('c2', 'only')
    const s2 = (await pool.getAccount('c2'))!
    s2.disabled = true
    await pool.upsertAccount(s2, Date.now())
    const blocked = await run()
    assert.equal(blocked.response.status, 503)
    assert.match(await blocked.response.text(), /已指定只用账号「c2」.*已停用/)
    assert.equal(used.length, 0, '⚠️ 不得换号去打上游')

    s2.disabled = false
    await pool.upsertAccount(s2, Date.now())
    for (let i = 0; i < 3; i += 1) {
      const ok = await run()
      assert.equal(ok.response.status, 200)
      await ok.response.text()
    }
    assert.deepEqual(used, ['tok-c2', 'tok-c2', 'tok-c2'])

    // 请求头覆盖面板指定
    used.length = 0
    const viaHeader = await run({ 'x-flr-account': 'c1' })
    await viaHeader.response.text()
    assert.deepEqual(used, ['tok-c1'])
    await new Promise((r) => setTimeout(r, 30))
  } finally {
    provider.chat = originalChat
    console.log = originalLog
    rt.cleanup()
  }
})

test('🔴 provider 路径必须受 WAF / 11140 全局闸门保护（此前完全不设防）', async () => {
  // 2026-10-21 审查（M1）发现的高危：两道全局闸门
  //（IP 级 WAF 与 11140 波次）**只在 buddy 分支接线**（server.ts:987/1252），
  // provider 分支既不查询也不投喂 ⇒ 带前缀模型（qodercn/*, workbuddy/* …）
  // 完全不受防封保护。
  //
  // 本文钉住：闸门激活时，`handleProviderChat` 必须**一个上游请求都不发**就返回可读错误。
  const rt = freshRuntime('waf-gate-provider')
  try {
    const provider = findProvider('cline')
    assert.ok(provider !== undefined)
    const originalChat = provider.chat
    const originalWarn = console.warn
    const originalLog = console.log
    let upstreamCalls = 0
    console.log = () => {}
    console.warn = () => {}
    provider.chat = (async () => {
      upstreamCalls += 1
      // 必须回 SSE 流：上游一律以流式形态响应，非流的聚合由网关自己做。
      return new Response(okStream('cline ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as never
    try {
      const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
      for (const uid of ['w1', 'w2']) {
        await addAccount(pool, uid, { provider: 'cline' })
        await pool.putCredential(uid, { uid, nickname: uid, accessToken: `tok-${uid}`, refreshToken: '', expiresAt: Date.now() + 3600_000 }, Date.now())
      }

      const run = () => handleProviderChat({
        providerId: 'cline', model: 'm', wantsStream: false,
        rawBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        request: new Request('https://example.test/v1/chat/completions', { method: 'POST', headers: {} }),
        env: rt.env, realm: 'cn', tried: [], sessionKey: '', failoverDepth: 1,
      })

      // 先确认没激活时是通的（否则下面的 503 可能是别的原因）
      const before = await run()
      assert.equal(before.response.status, 200, '闸门未激活时应正常转发')
      await before.response.text()
      upstreamCalls = 0

      // 让 2 个不同账号各命中一次 403 ⇒ 达到 WAF_IP_THRESHOLD=2 ⇒ 闸门激活
      const now = Date.now()
      await pool.noteWaf('w1', now)
      const activated = await pool.noteWaf('w2', now)
      assert.equal(activated, true, '两个不同账号命中后闸门应激活')

      const blocked = await run()
      assert.equal(blocked.response.status, 503, '闸门激活后 provider 路径必须拦下')
      assert.match(await blocked.response.text(), /WAF/)
      assert.equal(upstreamCalls, 0, '⚠️ 闸门激活时不得再向上游发任何请求（否则等于撞同一堵墙）')
    } finally {
      provider.chat = originalChat
      console.warn = originalWarn
      console.log = originalLog
    }
  } finally {
    rt.cleanup()
  }
})

test('🔴 provider 返回非 2xx 时必须按业务语义罚，不能一律熔断', async () => {
  // 2026-10-21 审查（M4）指出的**严重**项：`handleProviderChat` 的 HTTP 非 2xx 分支
  // 把 `classify()` 的结论只用于 channel_blocked，其余一律硬编码 `breaker`。
  // 而 opencode / trae 两家**返回非 2xx Response**（其余家抛异常），
  // 于是它们的 400/401/403 全部把健康号熔断 30 分钟起（还按 2^retryCount 递增到 6h）。
  //
  // 同文件的 SSE 预读分支**已经**用了 mapErrorToPunishment —— 又是一处「只修一半」。
  // 本测试钉住：400（参数类，不罚号）不得产生任何冷却。
  const rt = freshRuntime('non2xx-no-breaker')
  try {
    const provider = findProvider('opencode')
    assert.ok(provider !== undefined)
    const originalChat = provider.chat
    const originalLog = console.log
    const originalWarn = console.warn
    console.log = () => {}
    console.warn = () => {}
    provider.chat = (async () => new Response(
      '{"code":11101,"message":"invalid parameter: messages"}',
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as never
    try {
      const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
      await addAccount(pool, 'n1', { provider: 'opencode' })
      await pool.putCredential('n1', { uid: 'n1', nickname: 'n1', accessToken: 't', refreshToken: '', expiresAt: Date.now() + 3600_000 }, Date.now())


      const res = await handleProviderChat({
        providerId: 'opencode', model: 'm', wantsStream: false,
        rawBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        request: new Request('https://example.test/v1/chat/completions', { method: 'POST', headers: {} }),
        env: rt.env, realm: 'cn', tried: [], sessionKey: '', failoverDepth: 1,
      })
      await res.response.text()

      const acc = (await pool.listAccounts('cn', Date.now())).find((a) => a.uid === 'n1')
      assert.ok(acc !== undefined)
      assert.equal(acc.breakerUntil, 0, '⚠️ 400 参数错误不得熔断账号')
      assert.equal(acc.fails, 0, '失败计数也不该涨')
      assert.equal(acc.until, 0, '也不该产生冷却')
    } finally {
      provider.chat = originalChat
      console.log = originalLog
      console.warn = originalWarn
    }
  } finally {
    rt.cleanup()
  }
})

test('🔴 换号时必须重算 conversationId（不得把同一会话 id 发给两个账号）', async () => {
  // 2026-10-21 审查（M3）指出的高危：源码注释明写「换号**必须**换 id
  //（同一段会话 id 发给两个账号就是跨账号关联键）」，但实现是
  //   let providerConversationId = sessionKey === '' ? crypto.randomUUID() : ''
  //   … 循环内 if (providerConversationId === '') { … }
  // ⇒ 只在第一个账号身上算一次，之后换号全程复用。
  // buddy 路径的 `conversationId` 有同一缺陷（两处都已修）。
  const rt = freshRuntime('conv-id-rotate')
  try {
    const provider = findProvider('cline')
    assert.ok(provider !== undefined)
    const originalChat = provider.chat
    const originalLog = console.log
    const originalWarn = console.warn
    const seen: string[] = []
    let calls = 0
    console.log = () => {}
    console.warn = () => {}
    provider.chat = (async (_cred: unknown, opts: { conversation?: { conversationId?: string } }) => {
      calls += 1
      seen.push(String(opts?.conversation?.conversationId ?? ''))
      if (calls === 1) throw new Error('upstream busy')
      return new Response(okStream('ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as never
    try {
      const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
      for (const uid of ['cq1', 'cq2']) {
        await addAccount(pool, uid, { provider: 'cline' })
        await pool.putCredential(uid, { uid, nickname: uid, accessToken: `tok-${uid}`, refreshToken: '', expiresAt: Date.now() + 3600_000 }, Date.now())
      }

      const res = await handleProviderChat({
        providerId: 'cline', model: MODEL, wantsStream: false,
        rawBody: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
        request: new Request('https://example.test/v1/chat/completions', { method: 'POST', headers: {} }),
        env: rt.env, realm: 'cn', tried: [], sessionKey: '', failoverDepth: 1,
      })
      const bodyText = await res.response.text()

      assert.ok(calls >= 2, `应发生换号重试（实际 ${calls} 次）；响应=${bodyText.slice(0, 200)}`)
      assert.notEqual(seen[0], seen[1], '⚠️ 换号后 conversationId 必须变化（否则是跨账号关联键）')
    } finally {
      provider.chat = originalChat
      console.log = originalLog
      console.warn = originalWarn
    }
  } finally {
    rt.cleanup()
  }
})

test('🔴 provider.shouldRotate()=false 时不得换号（此前从未被调用）', async () => {
  // 2026-10-21 审查（M4）指出的高危：`provider.shouldRotate?.(status, text)`
  // 在**抛 ProviderError 的路径上从未被调用** —— 唯一消费点在那个
  //「provider 返回非 2xx Response」的分支，而 8 家 provider 都是抛异常。
  //
  // 后果是**反向**的：cline 的 `shouldRotate` 明写「403 地域封锁不换号」
  //（换号会连坐其它健康账号），而网关按通用判据把 403 当 `auth_error.rotate=true`
  // ⇒ **整池轮转** —— 与作者意图完全相反。
  //
  // 本测试把 `shouldRotate` 固定为 false，验证网关真的听它。
  const rt = freshRuntime('shouldrotate-honored')
  try {
    const provider = findProvider('opencode')
    assert.ok(provider !== undefined)
    const originalChat = provider.chat
    const originalShouldRotate = provider.shouldRotate
    const originalLog = console.log
    const originalWarn = console.warn
    let calls = 0
    console.log = () => {}
    console.warn = () => {}
    provider.shouldRotate = (() => false) as never
    provider.chat = (async () => {
      calls += 1
      throw new ProviderError({
        provider: 'opencode',
        httpStatus: 403,
        // ⚠️ 文案必须含中文：`isWafBlocked(403, 英文)` 会判成 WAF，
        // 那条路径本来就 `rotate=false`，会把本测试要验证的东西**掩盖掉**。
        message: '上游地域限制：该地区不支持此服务',
      })
    }) as never
    try {
      const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
      for (const uid of ['cr1', 'cr2']) {
        await addAccount(pool, uid, { provider: 'opencode' })
        await pool.putCredential(uid, { uid, nickname: uid, accessToken: `tok-${uid}`, refreshToken: '', expiresAt: Date.now() + 3600_000 }, Date.now())
      }

      const res = await handleProviderChat({
        providerId: 'opencode', model: MODEL, wantsStream: false,
        rawBody: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
        request: new Request('https://example.test/v1/chat/completions', { method: 'POST', headers: {} }),
        env: rt.env, realm: 'cn', tried: [], sessionKey: '', failoverDepth: 1,
      })
      await res.response.text()

      assert.equal(calls, 1, `⚠️ shouldRotate=false 时只应尝试 1 个号（实际 ${calls} 次）`)
    } finally {
      provider.chat = originalChat
      provider.shouldRotate = originalShouldRotate
      console.log = originalLog
      console.warn = originalWarn
    }
  } finally {
    rt.cleanup()
  }
})
