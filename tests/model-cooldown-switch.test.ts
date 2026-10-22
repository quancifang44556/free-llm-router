/**
 * **模型级冷却总开关**（`modelCooldownEnabled`）。
 *
 * ## 用户诉求（2026-10-22 原话）
 *
 * > 「为啥又冷却，不能加个开关让我把冷却关了吗，实际上完全没有冷却」
 *
 * 这个判断有实测支撑：面板上 3 个 workbuddy 账号同时挂着 `deepseek-v4.1-flash`
 * 的 **5 小时**模型级冷却（上游 `6004` 说「19:34 重置」，我们就照锁到 19:34），
 * 而 qodercn 的 `dfmodel` 在冷却期内**直接打上游 3/3 全 200**。
 * ⇒ 冷却与被冷却对象的真实可用性**完全脱钩**。
 *
 * ## 本文件钉住四件事
 *
 * 1. 开关默认 **开**（升级不能让既有行为突然改变，否则持续 429 会变成每次白打）；
 * 2. 关掉后 `applyFailure({kind:'model'})` **什么都不写**（不建条目、不涨 `modelConfirm`）；
 * 3. 关掉后 `pick()` **不再**因模型冷却拒绝账号，但**账号级维度照旧拦截**
 *    （这条最重要：修过头会让「账号真被封」也放行）；
 * 4. 关掉的那一刻，池里**已经挂着**的旧冷却条目也一并失效
 *    （只挡新写入不够 —— 用户关开关时看到的正是那些旧条目）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import { writeAccount } from '../src/store/db.js'

const REALM = 'cn'
const PROVIDER = 'qodercn'
const MODEL = 'dfmodel'

function freshRuntime(tag: string) {
  const dir = path.join(process.cwd(), '.build', 'test-model-cooldown-switch')
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, `${tag}.db`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  return { runtime: createNodeRuntime(dbPath), dbPath }
}

function poolOf(env: any) {
  return env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
}

async function seedAccount(pool: any, uid: string, mutate: (s: any) => void = () => {}) {
  const state = createAccountState({ uid, nickname: uid, realm: REALM, provider: PROVIDER })
  state.credits = 4000
  mutate(state)
  writeAccount(pool.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
  return state
}

async function readAcc(pool: any, uid: string) {
  const acc = (await pool.listAccounts(REALM, Date.now())).find((a: any) => a.uid === uid)
  assert.ok(acc !== undefined, `账号 ${uid} 应存在`)
  return acc
}

test('开关默认必须是「开」（升级不改变既有行为）', async () => {
  const { runtime } = freshRuntime('default-on')
  const pool = poolOf(runtime.env)
  const cfg = await pool.getSafetyConfig()
  assert.equal(
    cfg.modelCooldownEnabled,
    true,
    '默认必须开启：否则持续 429 的场景会从「锁起来」变成「每次请求都白打一次」，'
      + '这是个静默的行为变更，不该由升级触发',
  )
  runtime.db.close()
})

test('🔴 关掉开关 ⇒ applyFailure(model) 完全不写冷却，也不涨 modelConfirm', async () => {
  const { runtime } = freshRuntime('off-no-write')
  const pool = poolOf(runtime.env)
  await pool.setSafetyConfig({ modelCooldownEnabled: false })
  await seedAccount(pool, 'u1')

  await pool.applyFailure({
    uid: 'u1',
    kind: 'model',
    model: MODEL,
    now: Date.now(),
    reason: 'rate_limited: 上游排队 10605',
    modelCause: 'busy',
  })

  const acc = await readAcc(pool, 'u1')
  assert.equal(
    acc.modelCooldowns[MODEL],
    undefined,
    `关掉开关后不该写入模型冷却，实际写了：${JSON.stringify(acc.modelCooldowns[MODEL])}`,
  )
  // ⚠️ `modelConfirm` 是「这个模型确实不存在」的坐实计数。
  // 冷却关着还继续累加，等用户哪天重新打开开关，第一次失败就会直接吃到封顶 24 小时。
  assert.equal(
    acc.modelConfirm?.[MODEL] ?? 0,
    0,
    '`modelConfirm` 也不许涨：否则「关开关期间的表现」会污染「开开关之后的行为」',
  )

  runtime.db.close()
})

test('开关开着 ⇒ 冷却照常写入（防止把修复做成了「永久关闭」）', async () => {
  const { runtime } = freshRuntime('on-still-works')
  const pool = poolOf(runtime.env)
  // 不显式设置，走默认（开）
  await seedAccount(pool, 'u1')

  await pool.applyFailure({
    uid: 'u1',
    kind: 'model',
    model: MODEL,
    now: Date.now(),
    reason: 'rate_limited: 上游排队 10605',
    modelCause: 'busy',
  })

  const acc = await readAcc(pool, 'u1')
  assert.ok(
    acc.modelCooldowns[MODEL] !== undefined,
    '开关默认开着时，模型冷却必须照常写入 —— 否则这个开关就成了「一上线就永久关闭冷却」',
  )

  runtime.db.close()
})

test('🔴 关掉开关 ⇒ pick() 不再因**已存在**的模型冷却拒绝账号', async () => {
  const { runtime } = freshRuntime('off-existing')
  const pool = poolOf(runtime.env)
  const now = Date.now()
  // 先造一个「开关还开着时留下的」5 小时冷却 —— 这正是用户关开关那一刻的真实状态。
  await seedAccount(pool, 'u1', (s) => {
    s.modelCooldowns[MODEL] = {
      until: now + 5 * 3600_000,
      resetAt: 0,
      reason: 'rate_limited: 上游 6004 说要 19:34 重置',
      hits: 2,
      confirmed: 2,
      cause: 'busy',
      auditOnly: false,
    }
  })
  await pool.setSafetyConfig({ modelCooldownEnabled: false })

  const picked = await pool.pick({ realm: REALM, provider: PROVIDER, model: MODEL, exclude: [], now })
  assert.ok(
    picked !== undefined,
    '关掉开关后，池里已有的旧冷却条目也必须失效 —— '
      + '只挡新写入不够，用户关开关时看到的正是这些旧条目',
  )

  runtime.db.close()
})

test('🔴 关掉模型冷却**不等于**关掉账号级冷却（账号被上游封仍须拦截）', async () => {
  const { runtime } = freshRuntime('off-still-blocks-account')
  const pool = poolOf(runtime.env)
  const now = Date.now()
  await seedAccount(pool, 'u1', (s) => {
    // 11140：上游明确标记该账号异常行为 —— 这是账号级维度，与「某模型排队」无关。
    s.restrictedUntil = now + 2 * 3600_000
  })
  await pool.setSafetyConfig({ modelCooldownEnabled: false })

  const picked = await pool.pick({ realm: REALM, provider: PROVIDER, model: MODEL, exclude: [], now })
  assert.equal(
    picked,
    undefined,
    '关掉模型冷却后仍必须拦住「上游已封号」的账号 —— 修过头会让被封的号继续被打，'
      + '而每打一次都可能让封禁加重',
  )

  runtime.db.close()
})

test('🔴 设置接口必须接受 modelCooldownEnabled（否则 UI 点了没反应）', async () => {
  // 这条是针对我自己刚差点犯的错：`getSafetyConfig()`（读侧）加了字段，
  // 而 `setSafetyConfig()`（写侧）是一串手写的 `if (input.sessionTrace !== undefined)`。
  // 只加读侧的话，`POST` 会回 `ok:true`、`GET` 回显还是旧值，用户以为「已经关了」。
  const { runtime } = freshRuntime('set-accepts')
  const pool = poolOf(runtime.env)

  const afterOff = await pool.setSafetyConfig({ modelCooldownEnabled: false })
  assert.equal(afterOff.modelCooldownEnabled, false, 'POST false 之后回显必须是 false')

  const afterOn = await pool.setSafetyConfig({ modelCooldownEnabled: true })
  assert.equal(afterOn.modelCooldownEnabled, true, '必须能再打开（不能只单向）')

  runtime.db.close()
})

test('设置 modelCooldownEnabled 不许把其他字段一起重置', async () => {
  // ⚠️ 这一条对应 `setSafetyConfig` 的「只写调用方真正提供的字段」纪律：
  // 整体写回会把未提供的字段固化成当前值，从此环境变量改不动它。
  const { runtime } = freshRuntime('set-partial')
  const pool = poolOf(runtime.env)

  await pool.setSafetyConfig({ maxContextMessages: 1234 })
  const after = await pool.setSafetyConfig({ modelCooldownEnabled: false })
  assert.equal(after.maxContextMessages, 1234, 'modelCooldownEnabled 的写入不该动 maxContextMessages')

  runtime.db.close()
})

test('🔴 关闭开关后，面板计数必须与 pick() 一致（不许显示「模型限流」却已放行）', async () => {
  // ## 这条测试的来历：我自己在这个功能的**第一次实现**里就漏了
  //
  // 加开关时只改了 `pick()`（放行）与 `applyFailure()`（不写入），
  // **忘了 `counts()`** —— 那是第三个读同一份状态的消费点。
  // 后果：关掉开关后池里旧条目仍让面板显示「模型限流」，
  // 而请求其实已经能派给这个账号 ⇒ 用户看面板以为不可用，去点「清除冷却」，
  // 而其实早就好了。
  //
  // 这正是本项目最反复的一类：改动落在**一个消费点**上，其余读同一状态的地方漂掉。
  // ⇒ 一个「开关」至少要覆盖三个地方：写入、拦截、**展示**。
  const { runtime } = freshRuntime('counts-consistency')
  const pool = poolOf(runtime.env)
  const now = Date.now()
  await seedAccount(pool, 'u1', (s) => {
    s.modelCooldowns[MODEL] = {
      until: now + 5 * 3600_000,
      resetAt: 0,
      reason: 'x',
      hits: 2,
      confirmed: 2,
      cause: 'busy',
      auditOnly: false,
    }
  })
  await pool.setSafetyConfig({ modelCooldownEnabled: false })

  const counts = await pool.counts(REALM, Date.now())
  const picked = await pool.pick({ realm: REALM, provider: PROVIDER, model: MODEL, exclude: [], now: Date.now() })

  assert.ok(picked !== undefined, 'pick() 应放行（模型冷却已关闭）')
  assert.equal(
    counts.modelExempt,
    0,
    'pick() 已放行，面板就不能把它统计成「模型限流」—— '
      + `否则用户看面板以为不可用。实际 counts=${JSON.stringify(counts)}`,
  )
  assert.equal(counts.healthy, 1, '关闭开关后它就是一个完全健康的账号')

  runtime.db.close()
})
