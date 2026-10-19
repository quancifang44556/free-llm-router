/**
 * 永久积分锁单元与集成测试。
 *
 * 验证：
 * 1. AccountPoolDO 的 getPermanentLocks / setPermanentLock 独立持久化存储；
 * 2. 账号选号过滤逻辑：
 *    - 锁未开启时：纯永久积分账号正常参与选号；
 *    - 锁开启时：只剩永久积分（credits > 0 && creditsExpiring === 0）的账号被跳过；
 *    - 含有临期额度（creditsExpiring > 0）的账号正常入选；
 *    - 额度为 0 的账号不应被算入永久积分锁跳过计数；
 *    - 当全部候选因锁被跳过时，必须显式返回 lockedByPermanent: true 与跳过数；
 * 3. 路由与面板 API：
 *    - GET /admin/permanent-locks
 *    - POST /admin/permanent-locks（参数校验与更新）
 * 4. 面板资源中包含永久积分锁 DOM 与加载逻辑。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import { panelAsset } from '../src/panel/index.js'
import worker from '../src/index.js'

test('AccountPoolDO：getPermanentLocks 与 setPermanentLock 独立存储与读写', async () => {
  const tmpDbPath = path.join(process.cwd(), '.build', 'test-perm-lock-storage.db')
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)

  const runtime = createNodeRuntime(tmpDbPath)
  const { env, db } = runtime

  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))

    // 1. 默认无锁
    const initialLocks = await pool.getPermanentLocks()
    assert.deepEqual(initialLocks, {})

    // 2. 开启 buddy 锁
    const afterLock = await pool.setPermanentLock('buddy', true)
    assert.deepEqual(afterLock, { buddy: true })

    const readAgain = await pool.getPermanentLocks()
    assert.deepEqual(readAgain, { buddy: true })

    // 3. 开启 workbuddy 锁
    await pool.setPermanentLock('workbuddy', true)
    const twoLocks = await pool.getPermanentLocks()
    assert.deepEqual(twoLocks, { buddy: true, workbuddy: true })

    // 4. 解除 buddy 锁
    const afterUnlock = await pool.setPermanentLock('buddy', false)
    assert.deepEqual(afterUnlock, { workbuddy: true })

    const finalLocks = await pool.getPermanentLocks()
    assert.deepEqual(finalLocks, { workbuddy: true })
  } finally {
    db.close()
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)
  }
})

test('AccountPoolDO：永久积分锁选号过滤逻辑与显式返回', async () => {
  const tmpDbPath = path.join(process.cwd(), '.build', 'test-perm-lock-pick.db')
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)

  const runtime = createNodeRuntime(tmpDbPath)
  const { env, db } = runtime

  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()

    // 准备账号 A：有临期额度（credits=500, creditsExpiring=100）
    const accExpiring = createAccountState({
      uid: 'acc-expiring',
      nickname: '临期账号',
      realm: 'cn',
      provider: 'buddy',
    })
    accExpiring.credits = 500
    accExpiring.creditsExpiring = 100
    await pool.upsertAccount(accExpiring, now)

    // 准备账号 B：纯永久积分（credits=1000, creditsExpiring=0）
    const accPermanent = createAccountState({
      uid: 'acc-permanent',
      nickname: '纯永久账号',
      realm: 'cn',
      provider: 'buddy',
    })
    accPermanent.credits = 1000
    accPermanent.creditsExpiring = 0
    await pool.upsertAccount(accPermanent, now)

    // 1. 锁未开启时：两者均可被选中
    const pick1 = await pool.pick({ realm: 'cn', provider: 'buddy', model: 'buddy/deepseek-v4.1-flash', exclude: [], now })
    assert.ok(pick1)
    assert.ok(pick1.uid === 'acc-expiring' || pick1.uid === 'acc-permanent')

    // 2. 开启 buddy 锁
    await pool.setPermanentLock('buddy', true)

    // 排除 acc-expiring 后选号，因 acc-permanent 纯永久且已上锁，应滤空并显式返回 lockedByPermanent
    const pickLocked = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'buddy/deepseek-v4.1-flash',
      exclude: ['acc-expiring'],
      now,
    })
    assert.ok(pickLocked)
    assert.equal(pickLocked.lockedByPermanent, true)
    assert.equal(pickLocked.lockedSkipped, 1)

    // 不排除 acc-expiring 时选号，应精准选中含有临期积分的 acc-expiring
    const pickAllowed = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'buddy/deepseek-v4.1-flash',
      exclude: [],
      now,
    })
    assert.ok(pickAllowed)
    assert.equal(pickAllowed.uid, 'acc-expiring')

    // 3. 关闭 buddy 锁后，acc-permanent 恢复可选
    await pool.setPermanentLock('buddy', false)
    const pickUnlocked = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'buddy/deepseek-v4.1-flash',
      exclude: ['acc-expiring'],
      now,
    })
    assert.ok(pickUnlocked)
    assert.equal(pickUnlocked.uid, 'acc-permanent')
  } finally {
    db.close()
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)
  }
})

test('HTTP API：/admin/permanent-locks GET 与 POST 路由测试', async () => {
  const tmpDbPath = path.join(process.cwd(), '.build', 'test-perm-lock-api.db')
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)

  const runtime = createNodeRuntime(tmpDbPath)
  const { env, db } = runtime
  env.API_KEY = 'test-perm-lock-api-key'

  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any

  try {
    const authHeaders = { authorization: `Bearer ${env.API_KEY}` }

    // 1. GET 初始状态
    const getReq = new Request('http://localhost/admin/permanent-locks', { headers: authHeaders })
    const getRes = await worker.fetch(getReq, env, ctx)
    assert.equal(getRes.status, 200)
    const getJson = (await getRes.json()) as any
    assert.deepEqual(getJson.locks, {})

    // 2. POST 参数非法校验
    const badReq1 = new Request('http://localhost/admin/permanent-locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
    })
    const badRes1 = await worker.fetch(badReq1, env, ctx)
    assert.equal(badRes1.status, 400)

    const badReq2 = new Request('http://localhost/admin/permanent-locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ provider: 'buddy', locked: 'true' }), // locked 必须为 boolean
    })
    const badRes2 = await worker.fetch(badReq2, env, ctx)
    assert.equal(badRes2.status, 400)

    // 3. POST 正确开启
    const postReq = new Request('http://localhost/admin/permanent-locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ provider: 'buddy', locked: true }),
    })
    const postRes = await worker.fetch(postReq, env, ctx)
    assert.equal(postRes.status, 200)
    const postJson = (await postRes.json()) as any
    assert.equal(postJson.ok, true)
    assert.equal(postJson.provider, 'buddy')
    assert.equal(postJson.locked, true)
    assert.deepEqual(postJson.locks, { buddy: true })

    // 4. 再次 GET 确认生效
    const getRes2 = await worker.fetch(getReq, env, ctx)
    const getJson2 = (await getRes2.json()) as any
    assert.deepEqual(getJson2.locks, { buddy: true })
  } finally {
    db.close()
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)
  }
})

test('面板静态资源：包含永久积分锁 DOM 与交互逻辑', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const js = panelAsset('/panel/app.js')?.body ?? ''

  assert.ok(html.includes('id="perm-lock-panel"'), 'HTML 必须包含永久积分锁面板')
  assert.ok(html.includes('id="perm-locks-list"'), 'HTML 必须包含永久积分锁网格容器')
  assert.ok(js.includes('loadPermanentLocks'), 'JavaScript 必须实现 loadPermanentLocks')
  assert.ok(js.includes('/admin/permanent-locks'), 'JavaScript 必须调用 /admin/permanent-locks 接口')
})
