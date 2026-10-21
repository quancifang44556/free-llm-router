/**
 * 余额快照刷新（2026-10-20 实测确证的真实缺陷）
 *
 * ## 缺陷
 *
 * `credits` / `creditsExpiring` / `creditsEarliestExpiry` 三个字段此前**只在
 * `revive()` 里写入**，正常流程无刷新入口 ⇒ 恒为初始值 0。
 *
 * 实测：面板显示两个账号 `credits=0`，而直连上游拿到的是 2870 / 3514（充足）。
 *
 * ## 后果（不是显示问题，是行为错）
 *
 * 1. **永久积分锁失效** —— 判据 `credits > 0` 恒不命中，本该拦下的
 *    「只剩永久额度」账号照样被选中，烧掉不可撤回的积分；
 * 2. `expiry` 策略（默认）按 `creditsExpiring` 排序 ⇒ 键全等 ⇒ 退化成 uid 轮转；
 * 3. `random` 策略的加权退化成等权。
 *
 * ## 本文件钉住的两条硬约束
 *
 * - `updateBalance` **只写额度三元组**，绝不动惩罚态（否则每次刷新都等于偷偷解冻）；
 * - 余额被正确写入后，**永久积分锁必须真的生效**（端到端反证）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'

function freshRuntime(tag: string) {
  const dbPath = path.join(process.cwd(), '.build', `test-balance-${tag}.db`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  return { runtime: createNodeRuntime(dbPath), dbPath }
}

test('🔴 updateBalance 写入额度三元组', async () => {
  const { runtime } = freshRuntime('write')
  const { env, db } = runtime
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    const uid = 'uid-balance-1'
    await pool.upsertAccount(createAccountState({ uid, provider: 'buddy', realm: 'cn' }), now)

    const ok = await pool.updateBalance(uid, now, {
      credits: 2870,
      expiring: 500,
      earliestExpiry: now + 86400_000,
    })
    assert.equal(ok, true)

    const acc = (await pool.listAccounts('cn', now)).find((a) => a.uid === uid)
    assert.ok(acc !== undefined)
    assert.equal(acc.credits, 2870)
    assert.equal(acc.creditsExpiring, 500)
    assert.equal(acc.creditsEarliestExpiry, now + 86400_000)
  } finally {
    db.close()
  }
})

test('⚠️ updateBalance 绝不能碰惩罚态（否则等于每次刷新都偷偷解冻）', async () => {
  const { runtime } = freshRuntime('punish')
  const { env, db } = runtime
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    const uid = 'uid-balance-2'
    const st = createAccountState({ uid, provider: 'buddy', realm: 'cn', now })
    // 造一个「正在熔断 + 有模型冷却」的账号
    st.breakerUntil = now + 30 * 60_000
    st.fails = 2
    st.retryCount = 1
    st.until = now + 5 * 60_000
    st.coolKind = 'soft'
    st.modelCooldowns['glm-5.3'] = {
      until: now + 10 * 60_000,
      resetAt: 0,
      reason: 'busy',
      hits: 1,
      cause: 'busy',
      auditOnly: false,
    }
    await pool.upsertAccount(st, now)

    await pool.updateBalance(uid, now, { credits: 100, expiring: 0, earliestExpiry: 0 })

    const acc = (await pool.listAccounts('cn', now)).find((a) => a.uid === uid)
    assert.ok(acc !== undefined)
    // 余额被写入
    assert.equal(acc.credits, 100)
    // 但惩罚态一个都没动
    assert.equal(acc.breakerUntil, st.breakerUntil, '熔断不得被清')
    assert.equal(acc.fails, 2, '失败计数不得被清')
    assert.equal(acc.until, st.until, '冷却不得被清')
    assert.equal(acc.coolKind, 'soft')
    assert.ok(acc.modelCooldowns['glm-5.3'] !== undefined, '模型冷却不得被清')
  } finally {
    db.close()
  }
})

test('负数余额归一为 0（上游偶尔回负值）', async () => {
  const { runtime } = freshRuntime('neg')
  const { env, db } = runtime
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    const uid = 'uid-balance-3'
    await pool.upsertAccount(createAccountState({ uid, provider: 'buddy', realm: 'cn' }), now)
    await pool.updateBalance(uid, now, { credits: -50, expiring: -1, earliestExpiry: -9 })
    const acc = (await pool.listAccounts('cn', now)).find((a) => a.uid === uid)
    assert.ok(acc !== undefined)
    assert.equal(acc.credits, 0)
    assert.equal(acc.creditsExpiring, 0)
    assert.equal(acc.creditsEarliestExpiry, 0)
  } finally {
    db.close()
  }
})

test('🔴 端到端：余额刷新后，永久积分锁必须真的生效', async () => {
  const { runtime } = freshRuntime('lock')
  const { env, db } = runtime
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()

    // 两个账号：A 只有永久额度，B 有临期额度
    const a = 'uid-perm-a'
    const b = 'uid-temp-b'
    await pool.upsertAccount(createAccountState({ uid: a, provider: 'buddy', realm: 'cn' }), now)
    await pool.upsertAccount(createAccountState({ uid: b, provider: 'buddy', realm: 'cn' }), now)

    // 刷新前：两者 credits 都是 0 ⇒ 锁的判据 `credits > 0` 不成立 ⇒ 锁不生效
    await pool.setPermanentLock('buddy', true)
    const beforeA = (await pool.listAccounts('cn', now)).find((x) => x.uid === a)
    assert.equal(beforeA?.credits, 0)

    // 刷新余额：A 只剩永久（expiring=0），B 有临期
    await pool.updateBalance(a, now, { credits: 1000, expiring: 0, earliestExpiry: 0 })
    await pool.updateBalance(b, now, { credits: 1000, expiring: 300, earliestExpiry: now + 86400_000 })

    // 现在选号：A 应被锁过滤，只能选到 B
    const picked = await pool.pick({ realm: 'cn', provider: 'buddy', model: 'glm-5.3', exclude: [], now })
    assert.ok(picked !== undefined)
    assert.equal(
      (picked as { uid?: string }).uid,
      b,
      '只剩永久额度的账号必须被永久积分锁挡掉 —— 这只有在余额被正确刷新后才成立',
    )
  } finally {
    db.close()
  }
})

/**
 * ## ⚠️ buddy 的 `balance()` 必须用**绑定版** provider
 *
 * 实测踩到的真缺陷：`findProvider('buddy')` 返回的是**未绑定的模板**，
 * 而 buddy 国内版的 `balance()` 闭包捕获了 `env`（用于决定计费域）。
 * 拿模板去调会抛：
 *
 *   `Cannot read properties of undefined (reading 'UPSTREAM_CHAT_BASE')`
 *
 * 现象：3 个 buddy 账号的余额刷新**全部失败**，而 workbuddy/qodercn 正常
 * —— 因为只有 buddy 需要 `bindBuddy(env)`。
 *
 * 本测试钉住「模板版确实不可用、绑定版才可用」这一事实，
 * 防止有人把调用改回 `findProvider()`。
 */
test('🔴 findProvider(buddy) 是未绑定模板，balance 会抛 env 缺失', async () => {
  const { findProvider } = await import('../src/providers/index.js')
  const template = findProvider('buddy')
  assert.ok(template !== undefined)
  assert.ok(template.balance !== undefined, 'buddy 应声明 balance 能力')
  // 用一个最小凭据调用：未绑定版应当抛错（env 为 undefined）
  await assert.rejects(
    async () => template.balance!(
      { uid: 'u', accessToken: 't', refreshToken: '', expiresAt: 0, extras: {} } as never,
      AbortSignal.timeout(1000),
    ),
    (err: unknown) => err instanceof Error,
    '未绑定模板调用 balance 必须失败 —— 这正是当初 3 个账号刷不出余额的原因',
  )
})

test('⚠️ bindBuddy(env) 产出的是可用的绑定版', async () => {
  const { bindBuddy } = await import('../src/providers/buddy.js')
  const { createNodeRuntime } = await import('../src/server/env.js')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dbPath = path.join(process.cwd(), '.build', 'test-balance-bind.db')
  for (const sfx of ['', '-wal', '-shm']) {
    const p = dbPath + sfx
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  const { env, db } = createNodeRuntime(dbPath)
  try {
    const bound = bindBuddy(env)
    assert.ok(bound.balance !== undefined)
    // 绑定版不再因 env 缺失而在「进入网络请求前」就抛错；
    // 这里只验证它拿到了 env（用一个必然失败但**不是 env 缺失**的凭据）。
    let msg = ''
    try {
      await bound.balance!(
        { uid: 'u', accessToken: 'invalid', refreshToken: '', expiresAt: 0, extras: {} } as never,
        AbortSignal.timeout(2000),
      )
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    assert.ok(
      !msg.includes('UPSTREAM_CHAT_BASE'),
      `绑定版不应再报 env 缺失，实际: ${msg}`,
    )
  } finally {
    db.close()
  }
})

test('🔴 「解冻」（clearCooldowns）必须清掉**全部**惩罚维度，不能只清账号级', async () => {
  // 2026-10-21 审查（M2）发现的「解冻语义碎片化」：
  // 原来只清 until/breakerUntil/degradeUntil/coolKind/fails/… 这几个账号级字段，
  // **漏了 `modelCooldowns` 与 `restrictedUntil`**。
  // ⇒ 用户点面板「解冻」，模型级冷却还在、11140 封号标记还在，
  //    面板显示「正常」但该模型仍然选不到 —— 典型的「状态看着对、行为不对」。
  const { runtime } = freshRuntime('clear-all')
  const { env, db } = runtime
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    const uid = 'uid-clear-all'
    const st = createAccountState({ uid, provider: 'buddy', realm: 'cn', now })
    // 把**五个**维度全部置为「惩罚中」
    st.until = now + 5 * 60_000
    st.coolKind = 'soft'
    st.breakerUntil = now + 30 * 60_000
    st.degradeUntil = now + 10 * 60_000
    st.restrictedUntil = now + 2 * 3600_000
    st.fails = 3
    st.softStreak = 2
    st.modelCooldowns['glm-5.3'] = {
      until: now + 10 * 60_000,
      resetAt: 0,
      reason: 'busy',
      hits: 2,
      cause: 'busy',
      auditOnly: false,
    }
    st.modelConfirm['glm-5.3'] = 2
    await pool.upsertAccount(st, now)

    const cleared = await pool.clearCooldowns('cn', uid)
    assert.equal(cleared, 1, '应清掉 1 个账号')

    const acc = (await pool.listAccounts('cn', now)).find((a) => a.uid === uid)
    assert.ok(acc !== undefined)
    assert.equal(acc.until, 0, '账号级冷却必须清')
    assert.equal(acc.coolKind, '', 'coolKind 必须清')
    assert.equal(acc.breakerUntil, 0, '熔断必须清')
    assert.equal(acc.degradeUntil, 0, '降级必须清')
    assert.equal(acc.restrictedUntil, 0, '⚠️ 11140 封号标记必须清（原来漏了）')
    assert.equal(acc.fails, 0)
    assert.equal(acc.softStreak, 0)
    assert.equal(Object.keys(acc.modelCooldowns).length, 0, '⚠️ 模型级冷却必须清（原来漏了）')
    assert.equal(Object.keys(acc.modelConfirm).length, 0, '模型确认计数也必须归零，否则下次更快熔断')
  } finally {
    db.close()
  }
})

test('⚠️ 只有模型级冷却时，clearCooldowns 也必须认为「有事可清」', async () => {
  // 边界：账号级全干净、只有 modelCooldowns —— 旧的条件判断会认为「无事可清」，
  // 直接跳过 ⇒ 模型级冷却永远清不掉。
  const { runtime } = freshRuntime('clear-model-only')
  const { env, db } = runtime
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    const uid = 'uid-clear-model-only'
    const st = createAccountState({ uid, provider: 'buddy', realm: 'cn', now })
    st.modelCooldowns['glm-5.3'] = {
      until: now + 10 * 60_000, resetAt: 0, reason: 'busy', hits: 1, cause: 'busy', auditOnly: false,
    }
    await pool.upsertAccount(st, now)

    const cleared = await pool.clearCooldowns('cn', uid)
    assert.equal(cleared, 1, '只有模型级冷却时也必须算「清掉了东西」')
    const acc = (await pool.listAccounts('cn', now)).find((a) => a.uid === uid)
    assert.ok(acc !== undefined)
    assert.equal(Object.keys(acc.modelCooldowns).length, 0)
  } finally {
    db.close()
  }
})
