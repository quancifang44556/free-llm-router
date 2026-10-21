/**
 * 防封配置（面板「防封」分区）必须**真的接进链路**，且不能把「0」当没配。
 *
 * 这组测试盯三类容易出错的地方：
 * 1. **默认值来自环境变量**：老部署靠 `MAX_CONTEXT_MESSAGES` / `BURN_RATE_*` 配过，
 *    升级到有面板的版本后不能悄悄回落到代码默认；
 * 2. **`0` 是有意义的关闭值**：`0` 与「未设置」必须区分（项目里反复踩过的 `||` 坑）；
 * 3. **开关真的改变了发出的请求**：会话链关掉后必须一个头都不发，
 *    限速关掉后必须立即返回（不能白等）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import worker from '../src/index.js'
import {
  sessionTraceHeaders,
  setSessionTraceEnabled,
  isSessionTraceEnabled,
  referenceChatHeaders,
} from '../src/upstream/headers.js'
import {
  configureThrottle,
  resetThrottle,
  throttleUpstream,
  throttleParams,
} from '../src/gateway/throttle.js'
import { safetyConfigFor, resetSafetyConfigCache, SAFETY_TTL_MS } from '../src/gateway/safety.js'

function dbFile(name: string): string {
  fs.mkdirSync(path.join(process.cwd(), '.build'), { recursive: true })
  return path.join(process.cwd(), '.build', `test-safety-${name}.db`)
}
function wipe(dbPath: string): void {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
}

/**
 * 带临时环境变量创建运行时。
 *
 * ⚠️ `createNodeRuntime` 在**创建时**读 `process.env` 组装 `Env`，
 * 所以必须先设变量再创建；用完立刻还原，避免污染同进程里的其它测试文件。
 */
function withEnv(dbPath: string, vars: Record<string, string>) {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    return createNodeRuntime(dbPath)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

type Pool = ReturnType<ReturnType<typeof createNodeRuntime>['env']['ACCOUNT_POOL']['get']>

// ───────────────────── ① 默认值与环境变量回退 ─────────────────────

test('未存过配置 ⇒ 默认值来自环境变量而不是硬编码', async () => {
  const db = dbFile('defaults')
  wipe(db)
  const rt = createNodeRuntime(db)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const cfg = await pool.getSafetyConfig()
    assert.equal(cfg.sessionTrace, true, '会话链默认开启')
    assert.equal(cfg.maxContextMessages, 300, '默认 300（不是复盘建议的 100）')
    assert.equal(cfg.burnRateWindowMs, 3_600_000, '熔断窗口默认 1 小时')
    assert.equal(cfg.burnRateThresholdPct, 20)
    assert.equal(cfg.rateLimitQps, 0, '限速默认关闭')
    assert.equal(cfg.rateJitterMs, 0, '抖动默认关闭')
  } finally {
  }
})

test('环境变量设过 ⇒ 未存配置时回落到环境变量（升级不改变既有行为）', async () => {
  const db = dbFile('envfallback')
  wipe(db)
  const rt = withEnv(db, {
    MAX_CONTEXT_MESSAGES: '500',
    BURN_RATE_WINDOW_MS: '7200000',
    BURN_RATE_THRESHOLD_PCT: '35',
  })
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const cfg = await pool.getSafetyConfig()
    assert.equal(cfg.maxContextMessages, 500)
    assert.equal(cfg.burnRateWindowMs, 7_200_000)
    assert.equal(cfg.burnRateThresholdPct, 35)
  } finally {
  }
})

// ───────────────────── ② 0 的语义与越界夹取 ─────────────────────

test('🔴 0 必须被当成「关闭」保存下来，不能被当成「没配」', async () => {
  const db = dbFile('zero')
  wipe(db)
  const rt = createNodeRuntime(db)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const next = await pool.setSafetyConfig({
      maxContextMessages: 0,
      burnRateWindowMs: 0,
      burnRateThresholdPct: 0,
      rateLimitQps: 0,
      rateJitterMs: 0,
    })
    assert.equal(next.maxContextMessages, 0, '0 = 不限制，必须原样落库')
    assert.equal(next.burnRateWindowMs, 0)
    assert.equal(next.burnRateThresholdPct, 0)
    assert.equal(next.rateLimitQps, 0)
    assert.equal(next.rateJitterMs, 0)
    // 重新读一遍（绕过缓存）确认真的持久化了
    const again = await pool.getSafetyConfig()
    assert.equal(again.maxContextMessages, 0)
  } finally {
  }
})

test('越界 / 非数一律忽略（保持原值），不写进库', async () => {
  const db = dbFile('clamp')
  wipe(db)
  const rt = createNodeRuntime(db)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    await pool.setSafetyConfig({ maxContextMessages: 1234 })
    const next = await pool.setSafetyConfig({
      maxContextMessages: 999_999_999, // 超上界
      burnRateThresholdPct: 101, // 超上界
      rateLimitQps: -5, // 负数
      rateJitterMs: Number.NaN, // 非数
    })
    assert.equal(next.maxContextMessages, 1234, '越界不生效，保持上一次的值')
    assert.equal(next.burnRateThresholdPct, 20, '越界回落默认')
    assert.equal(next.rateLimitQps, 0)
    assert.equal(next.rateJitterMs, 0)
  } finally {
  }
})

test('sessionTrace 只认显式 false 才算关', async () => {
  const db = dbFile('trace')
  wipe(db)
  const rt = createNodeRuntime(db)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    assert.equal((await pool.getSafetyConfig()).sessionTrace, true)
    assert.equal((await pool.setSafetyConfig({ sessionTrace: false })).sessionTrace, false)
    // 非布尔的垃圾值不该把开关关掉
    assert.equal((await pool.setSafetyConfig({ sessionTrace: 'no' as never })).sessionTrace, false)
    assert.equal((await pool.setSafetyConfig({ sessionTrace: true })).sessionTrace, true)
  } finally {
  }
})

// ───────────────────── ③ 会话链开关真的改变发出去的头 ─────────────────────

test('🔴 关掉会话链只删 b3：会话头族是**必需头**，关掉会让上游回 11‑128', () => {
  setSessionTraceEnabled(true)
  const on = sessionTraceHeaders({ conversationId: 'abc', turnRequestId: 'r1' })
  assert.ok('X-B3-TraceId' in on, '开启时应有 b3')
  assert.ok('X-Conversation-ID' in on, '会话头族恒发')

  setSessionTraceEnabled(false)
  const off = sessionTraceHeaders({ conversationId: 'abc', turnRequestId: 'r1' })
  // ⚠️ 这条断言是本测试的重点：开关**绝不能**把会话头族一起干掉。
  // v0.1.2 的 11‑128 修复就是补这 5 个头；缺了上游直接拦截，请求根本发不出去。
  assert.ok(
    !off['X-B3-TraceId'] && !off['X-B3-SpanId'] && !off['b3'],
    '关闭后不得再发 b3',
  )
  assert.ok('X-Conversation-ID' in off, '会话头族必须保留（否则 11‑128）')
  assert.equal(Object.keys(off).length, Object.keys(on).length - 3, '只少了 b3 三件套')
  assert.equal(isSessionTraceEnabled(), false)

  setSessionTraceEnabled(true) // 复位，避免影响其它测试
})

// ───────────────────── ④ 限速与抖动 ─────────────────────

test('限速关闭时立即返回：一次 sleep 都不该发生', async () => {
  resetThrottle()
  const calls: number[] = []
  await throttleUpstream('u1', async (ms) => { calls.push(ms) })
  assert.deepEqual(calls, [], '默认关闭 ⇒ 零等待')
})

test('开启 QPS 后同一账号被排队，不同账号互不影响', async () => {
  resetThrottle()
  configureThrottle({ qps: 2, jitterMs: 0 }) // 最小间隔 500ms
  let clock = 1_000_000
  const sleeps: number[] = []
  const sleep = async (ms: number) => { sleeps.push(ms); clock += ms }

  await throttleUpstream('acc-a', sleep, () => clock) // 首次：无历史，不等待
  assert.deepEqual(sleeps, [])

  await throttleUpstream('acc-a', sleep, () => clock) // 立刻再来：应等满 500ms
  assert.equal(sleeps.length, 1)
  assert.equal(sleeps[0], 500)

  await throttleUpstream('acc-b', sleep, () => clock) // 另一个账号：不受影响
  assert.equal(sleeps.length, 1, '不同账号各算各的')

  resetThrottle()
})

test('抖动是**额外**延迟，且落在 [0, 上限) 内', async () => {
  resetThrottle()
  configureThrottle({ qps: 0, jitterMs: 100 })
  const sleeps: number[] = []
  for (let i = 0; i < 20; i += 1) {
    await throttleUpstream('acc', async (ms) => { sleeps.push(ms) })
  }
  assert.equal(sleeps.length, 20, '每次都抖')
  for (const ms of sleeps) {
    assert.ok(ms >= 0 && ms < 100, `抖动 ${ms} 必须落在 [0,100)`)
  }
  assert.ok(new Set(sleeps).size > 1, '必须是随机的，不能恒定')
  resetThrottle()
})

test('非法参数按关闭处理（NaN / 负数不生效）', () => {
  resetThrottle()
  configureThrottle({ qps: Number.NaN, jitterMs: -3 })
  assert.deepEqual(throttleParams(), { qps: 0, jitterMs: 0 })
})

// ───────────────────── ⑤ 网关侧缓存与兜底 ─────────────────────

test('safetyConfigFor 命中缓存，reset 后重新读', async () => {
  const db = dbFile('cache')
  wipe(db)
  const rt = createNodeRuntime(db)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    await pool.setSafetyConfig({ maxContextMessages: 111 })
    resetSafetyConfigCache()
    const first = await safetyConfigFor(rt.env, pool, 1_000_000)
    assert.equal(first.maxContextMessages, 111)
    // TTL 内即使库被改也读缓存
    await pool.setSafetyConfig({ maxContextMessages: 222 })
    const cached = await safetyConfigFor(rt.env, pool, 1_000_000 + SAFETY_TTL_MS - 1)
    assert.equal(cached.maxContextMessages, 111, 'TTL 内应命中缓存')
    // 过期后读到新值
    const fresh = await safetyConfigFor(rt.env, pool, 1_000_000 + SAFETY_TTL_MS)
    assert.equal(fresh.maxContextMessages, 222, 'TTL 过后应重新读')
  } finally {
  }
})

test('读配置失败 ⇒ 回落环境变量，绝不抛给请求', async () => {
  resetSafetyConfigCache()
  const broken = { getSafetyConfig: async () => { throw new Error('DO down') } } as unknown as Pool
  const env = { MAX_CONTEXT_MESSAGES: '777', BURN_RATE_WINDOW_MS: '0', BURN_RATE_THRESHOLD_PCT: '0' } as never
  const cfg = await safetyConfigFor(env, broken, 1)
  assert.equal(cfg.maxContextMessages, 777, '失败时用环境变量兜底')
  assert.equal(cfg.sessionTrace, true, '失败时不应把会话链关掉')
  resetSafetyConfigCache()
})

// ───────────────────── ⑥ 端点：双分片镜像 + 立刻生效 ─────────────────────

test('POST /admin/config/safety 镜像到 global 分片，并让缓存立刻失效', async () => {
  const db = dbFile('endpoint')
  wipe(db)
  const rt = createNodeRuntime(db)
  const { env } = rt
  env.API_KEY = 'test-safety-api-key-0123456789'
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  const auth = { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' }
  try {
    const cn = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const gl = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))
    resetSafetyConfigCache()
    // 先让缓存里有一份旧值
    await safetyConfigFor(env, cn, 1)

    const res = await worker.fetch(
      new Request('http://localhost/admin/config/safety', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ maxContextMessages: 456, sessionTrace: false, rateLimitQps: 1.5 }),
      }),
      env,
      ctx,
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; config: { maxContextMessages: number; sessionTrace: boolean; rateLimitQps: number } }
    assert.equal(body.config.maxContextMessages, 456)
    assert.equal(body.config.sessionTrace, false)
    assert.equal(body.config.rateLimitQps, 1.5, '小数 QPS 必须保留（0.5 QPS 是合法慢速）')

    // 镜像：global 分片必须一致（否则国际版账号那一侧读到旧值）
    const glCfg = await gl.getSafetyConfig()
    assert.equal(glCfg.maxContextMessages, 456)
    assert.equal(glCfg.sessionTrace, false)

    // 缓存已失效 ⇒ 立刻生效
    const after = await safetyConfigFor(env, cn, 2)
    assert.equal(after.maxContextMessages, 456)

    // GET 也应返回同一份
    const got = await worker.fetch(new Request('http://localhost/admin/config/safety', { headers: auth }), env, ctx)
    const gotBody = (await got.json()) as { config: { maxContextMessages: number } }
    assert.equal(gotBody.config.maxContextMessages, 456)
  } finally {
    resetThrottle()
    setSessionTraceEnabled(true)
    resetSafetyConfigCache()
  }
})

test('裁剪上限接线：服务端读的是配置值而不是环境变量', () => {
  // 源码级断言：server.ts 里必须用 safety.maxContextMessages，
  // 不能又退回 resolveMaxContextMessages(env) —— 那会让面板开关彻底失效。
  const src = fs.readFileSync(path.join(process.cwd(), 'src/gateway/server.ts'), 'utf8')
  assert.ok(src.includes('safety.maxContextMessages'), '必须用面板配置')
  const callSites = src.match(/const maxContextMessages =[^\n]*/g) ?? []
  assert.equal(callSites.length, 1, '只允许一处读取裁剪上限')
  assert.ok(
    !callSites[0].includes('resolveMaxContextMessages'),
    '裁剪上限不得再直接读环境变量（否则面板改了不生效）',
  )
})

// ───────────────────── ⑦ 国内版绝不可发 b3（真实封号事故） ─────────────────────

test('🔴 国内版 buddy 的 chat 头里**不能**有 b3（曾导致三个号全线 11-128）', () => {
  setSessionTraceEnabled(true)
  const cn = referenceChatHeaders({ uid: 'u1', accessToken: 't', variant: 'buddy' })
  assert.ok(!('X-B3-TraceId' in cn), '国内版不得带 X-B3-TraceId')
  assert.ok(!('X-B3-SpanId' in cn), '国内版不得带 X-B3-SpanId')
  assert.ok(!('X-B3-Sampled' in cn), '国内版不得带 X-B3-Sampled')
})

test('国际版仍要 b3（渠道要求链路可串联）', () => {
  setSessionTraceEnabled(true)
  const intl = referenceChatHeaders({ uid: 'u1', accessToken: 't', variant: 'workbuddy' })
  assert.ok('X-B3-TraceId' in intl, '国际版应当带 b3')
})

test('源码级：会话头族只在国际版路径出现（防止又被「统一一下」改回去）', () => {
  // ⚠️ 这条断言钉的是**契约**（谁该发 b3），不是某个具体写法。前两版都写错了：
  //  v1「国内版分支必须传 false」—— 国内版分支根本没有这个调用；
  //  v2「每处调用都被 variant==='workbuddy' 包住」—— 有一处位于
  //     `intlReferenceChatHeaders`，那个函数**本身**就是国际版专用
  //     （上层 `if (input.variant === 'workbuddy') return intlReferenceChatHeaders(input)`）。
  // 用**行号**判定函数归属（字符偏移会被注释里的同名文字骗到）。
  const src = fs.readFileSync(path.join(process.cwd(), 'src/upstream/headers.ts'), 'utf8')
  const lines = src.split('\n')

  const fnAt = (needle: string): number => lines.findIndex((l) => l.includes(needle))
  const defLine = fnAt('export function sessionTraceHeaders')
  const intlLine = fnAt('function intlReferenceChatHeaders')
  const cliLine = fnAt('export function cliChatHeaders')
  assert.ok(defLine > 0 && intlLine > defLine && cliLine > intlLine, '函数边界定位失败')

  // 所有调用点（排除定义）
  const callLines = lines
    .map((l, idx) => ({ idx, l }))
    .filter((x) => /sessionTraceHeaders\s*\(/.test(x.l) && x.idx !== defLine)
    .map((x) => x.idx)
  assert.ok(callLines.length >= 2, `应至少有 2 处调用（实际 ${callLines.length}）`)

  for (const at of callLines) {
    if (at > intlLine && at < cliLine) continue // intlReferenceChatHeaders 内 ⇒ 国际版专用
    assert.ok(at > cliLine, `第 ${at + 1} 行的调用不在国际版路径内`)
    const before = lines.slice(Math.max(cliLine, at - 12), at).join('\n')
    assert.ok(
      before.includes("variant === 'workbuddy'"),
      `第 ${at + 1} 行的调用必须被 variant==='workbuddy' 包住`,
    )
  }

  // 国内版主分支（referenceChatHeaders → intlReferenceChatHeaders 之间）不得直接调用
  const refSeg = lines.slice(fnAt('export function referenceChatHeaders'), intlLine).join('\n')
  assert.ok(!refSeg.includes('sessionTraceHeaders('), '国内版主分支不得直接调用 sessionTraceHeaders')
})
