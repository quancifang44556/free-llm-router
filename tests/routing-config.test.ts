/**
 * 路由与调度配置（面板「配置」页）必须**真的生效**。
 *
 * 背景：此前这页的五个设置几乎都是摆设 ——
 * - `strategy` 只读内存缓存，DO / 进程重启后缓存为空就静默回落到轮询；
 *   而且「临期优先」与「轮询」走的是同一段代码，根本没按到期时刻排序；
 * - `maxRetries` / `softCooldownSeconds` / `autoTaskCron` / `autoRefreshCredential`
 *   全仓库没有任何地方读取；
 * - 只写 cn 分片，国际版账号（global 分片）完全不受影响。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import { maxRotateFor, resetMaxRotateCache, MAX_ROTATE } from '../src/gateway/server.js'
import worker from '../src/index.js'

function dbFile(name: string): string {
  fs.mkdirSync(path.join(process.cwd(), '.build'), { recursive: true })
  return path.join(process.cwd(), '.build', `test-routing-${name}.db`)
}
function wipe(dbPath: string): void {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
}

type Pool = ReturnType<ReturnType<typeof createNodeRuntime>['env']['ACCOUNT_POOL']['get']>

async function addAccount(pool: Pool, uid: string, earliestExpiry: number) {
  const state = createAccountState({ uid, nickname: uid, realm: 'cn', provider: 'buddy' })
  state.credits = 100
  state.creditsExpiring = 100
  state.creditsEarliestExpiry = earliestExpiry
  await pool.upsertAccount(state, Date.now())
}

const MODEL = 'deepseek-v4-flash'

test('临期优先：最早到期的号先用；轮询：不看到期时刻', async () => {
  const dbPath = dbFile('expiry')
  wipe(dbPath)
  const rt = createNodeRuntime(dbPath)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    // a-far 字典序在前（轮询下平手时先选它），b-soon 到期更早
    await addAccount(pool, 'a-far', now + 30 * 86400_000)
    await addAccount(pool, 'b-soon', now + 2 * 86400_000)
    await addAccount(pool, 'c-unknown', 0)

    // 默认就是临期优先
    assert.equal((await pool.getRoutingConfig()).strategy, 'expiry')
    const first = await pool.pick({ realm: 'cn', model: MODEL, exclude: [], now })
    assert.equal(first?.uid, 'b-soon')
    // 排除掉它，下一个是到期次早的，不知道到期时刻的排最后
    const second = await pool.pick({ realm: 'cn', model: MODEL, exclude: ['b-soon'], now })
    assert.equal(second?.uid, 'a-far')

    await pool.setRoutingConfig({ strategy: 'roundrobin' })
    const rr = await pool.pick({ realm: 'cn', model: MODEL, exclude: ['b-soon'], now: now + 10_000 })
    // a-far 刚被选过，轮询应换到最久未用的 c-unknown（而不是按到期时刻）
    assert.equal(rr?.uid, 'c-unknown')
  } finally {
    rt.db.close()
    wipe(dbPath)
  }
})

test('重启后策略不丢：从 storage 读，而不是回落到默认', async () => {
  const dbPath = dbFile('restart')
  wipe(dbPath)
  const now = Date.now()
  const rt1 = createNodeRuntime(dbPath)
  const pool1 = rt1.env.ACCOUNT_POOL.get(rt1.env.ACCOUNT_POOL.idFromName('cn'))
  await addAccount(pool1, 'a-far', now + 30 * 86400_000)
  await addAccount(pool1, 'b-soon', now + 2 * 86400_000)
  await pool1.setRoutingConfig({ strategy: 'roundrobin' })
  rt1.db.close()

  const rt2 = createNodeRuntime(dbPath)
  try {
    const pool2 = rt2.env.ACCOUNT_POOL.get(rt2.env.ACCOUNT_POOL.idFromName('cn'))
    // 没调过 getRoutingConfig（缓存为空）：轮询下两个都没用过 ⇒ 字典序 a-far
    const picked = await pool2.pick({ realm: 'cn', model: MODEL, exclude: [], now })
    assert.equal(picked?.uid, 'a-far')
  } finally {
    rt2.db.close()
    wipe(dbPath)
  }
})

test('软冷却起步时长取自 softCooldownSeconds', async () => {
  const dbPath = dbFile('soft')
  wipe(dbPath)
  const rt = createNodeRuntime(dbPath)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    await addAccount(pool, 'u1', 0)
    await addAccount(pool, 'u2', 0)

    await pool.applyFailure({ uid: 'u1', kind: 'soft', now })
    await pool.setRoutingConfig({ softCooldownSeconds: 300 })
    await pool.applyFailure({ uid: 'u2', kind: 'soft', now })

    const list = await pool.listAccounts('cn', now)
    const until = (uid: string) => list.find((a) => a.uid === uid)?.until ?? 0
    assert.equal(until('u1') - now, 60_000, '默认起步 60 秒')
    assert.equal(until('u2') - now, 300_000, '改成 300 秒后按 300 秒起步')
  } finally {
    rt.db.close()
    wipe(dbPath)
  }
})

test('maxRetries：网关读配置（带缓存），读失败回落默认', async () => {
  const dbPath = dbFile('retries')
  wipe(dbPath)
  const rt = createNodeRuntime(dbPath)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    resetMaxRotateCache()
    assert.equal(await maxRotateFor(pool), MAX_ROTATE)

    await pool.setRoutingConfig({ maxRetries: 1 })
    // 缓存期内仍是旧值；清缓存后立即生效
    assert.equal(await maxRotateFor(pool), MAX_ROTATE)
    resetMaxRotateCache()
    assert.equal(await maxRotateFor(pool), 1)

    resetMaxRotateCache()
    const broken = { getRoutingConfig: async () => { throw new Error('boom') } } as unknown as Pool
    assert.equal(await maxRotateFor(broken), MAX_ROTATE)
  } finally {
    resetMaxRotateCache()
    rt.db.close()
    wipe(dbPath)
  }
})

test('POST /admin/config/routing 镜像到 global 分片，并让 maxRetries 立即生效', async () => {
  const dbPath = dbFile('api')
  wipe(dbPath)
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = 'test-routing-api-key-0123456789'
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  const auth = { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' }
  try {
    const cn = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    resetMaxRotateCache()
    assert.equal(await maxRotateFor(cn), MAX_ROTATE)

    const res = await worker.fetch(
      new Request('http://localhost/admin/config/routing', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ strategy: 'random', maxRetries: 5, softCooldownSeconds: 120, autoTaskCron: false }),
      }),
      env,
      ctx,
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { config: { strategy: string; maxRetries: number } }
    assert.equal(body.config.strategy, 'random')

    const global = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))
    const g = await global.getRoutingConfig()
    assert.deepEqual(
      { strategy: g.strategy, maxRetries: g.maxRetries, softCooldownSeconds: g.softCooldownSeconds, autoTaskCron: g.autoTaskCron },
      { strategy: 'random', maxRetries: 5, softCooldownSeconds: 120, autoTaskCron: false },
    )
    assert.equal(await maxRotateFor(cn), 5, '保存后本进程立即生效')

    const get = await worker.fetch(new Request('http://localhost/admin/config/routing', { headers: auth }), env, ctx)
    assert.equal(((await get.json()) as { config: { autoTaskCron: boolean } }).config.autoTaskCron, false)
  } finally {
    resetMaxRotateCache()
    rt.db.close()
    wipe(dbPath)
  }
})

test('定时任务尊重 autoTaskCron / autoRefreshCredential 开关（源码约束）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8')
  const body = src.slice(src.indexOf('async function scheduled('))
  assert.match(body, /getRoutingConfig\(\)/)
  assert.match(body, /if \(!routing\.autoRefreshCredential\)[\s\S]*refreshExpiringCredentials/)
  assert.match(body, /if \(!routing\.autoTaskCron\)[\s\S]*?return[\s\S]*startRun/)
})
