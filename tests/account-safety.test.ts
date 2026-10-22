/**
 * **按账号**的防封配置覆盖（`AccountState.safetyOverride`）。
 *
 * ## 用户诉求（2026-10-22 原话）
 *
 * > 「我希望这个功能放到账号那里，因为我目前只是不想给 qd 限制，
 * > 防封开关也是，我希望我可以每个账号不同设置」
 *
 * 这句话点出全局开关的根本问题：**不同上游的风控模型完全不同**。
 * - `workbuddy` 是我们在冒充桌面客户端 ⇒ 需要伪装（节奏、b3 三件套）；
 * - `qodercn` 用官方凭据，实测 20 并发零损伤 ⇒ 给它加延迟纯属自限。
 *
 * 一个全局开关只能让两边互相迁就。配置粒度必须与被约束对象对齐。
 *
 * ## 本文件钉住的四件事
 *
 * 1. `resolveSafetyFor` 的合并语义（尤其 **`0` / `false` 是合法覆盖值**）；
 * 2. 写入侧「只写提供的字段」+「`null` = 删除覆盖」；
 * 3. 模型冷却真的**按账号**生效（A 号关闭不影响 B 号）；
 * 4. 越界值必须被拒并如实回报（不静默）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import { writeAccount } from '../src/store/db.js'
import { resolveSafetyFor } from '../src/gateway/safety.js'

const REALM = 'cn'

const GLOBAL = {
  sessionTrace: true,
  modelCooldownEnabled: true,
  maxContextMessages: 300,
  burnRateWindowMs: 3_600_000,
  burnRateThresholdPct: 20,
  rateLimitQps: 0.5,
  rateJitterMs: 300,
}

function freshRuntime(tag: string) {
  const dir = path.join(process.cwd(), '.build', 'test-account-safety')
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

async function seed(pool: any, uid: string, provider = 'qodercn') {
  const st = createAccountState({ uid, nickname: uid, realm: REALM, provider })
  st.credits = 4000
  writeAccount(pool.ctx.storage.sql, st.uid, st.realm, JSON.stringify(st), Date.now())
  return st
}

// ─────────────────────── 合并语义 ───────────────────────

test('无覆盖 ⇒ 完全等于全局（不是"复制一份"，是同一个对象）', () => {
  const got = resolveSafetyFor(GLOBAL as any, undefined)
  assert.equal(got, GLOBAL, '没有覆盖时应当直接返回全局对象，不该造一份新对象')
})

test('🔴 `0` 与 `false` 是合法覆盖值，绝不能被当成「没设置」', () => {
  // 这是本项目最经典的坑（`parseInt(x) || 默认值` 同型）：
  // 三个最常用的"关闭"语义 —— 不限速(0)、不裁剪(0)、不锁模型(false) —— 全是 falsy。
  // 用 `||` 兜底会让它们**静默失效**，用户点了"关闭"却毫无变化。
  const got = resolveSafetyFor(GLOBAL as any, {
    rateLimitQps: 0,
    maxContextMessages: 0,
    modelCooldownEnabled: false,
  })
  assert.equal(got.rateLimitQps, 0, 'rateLimitQps: 0 必须生效（不限速）')
  assert.equal(got.maxContextMessages, 0, 'maxContextMessages: 0 必须生效（不裁剪）')
  assert.equal(got.modelCooldownEnabled, false, 'modelCooldownEnabled: false 必须生效（不锁模型）')
  // 未提供的字段仍然是全局值
  assert.equal(got.sessionTrace, true)
  assert.equal(got.burnRateThresholdPct, 20)
})

test('部分覆盖：只改一个字段，其余沿用全局', () => {
  const got = resolveSafetyFor(GLOBAL as any, { modelCooldownEnabled: false })
  assert.equal(got.modelCooldownEnabled, false)
  assert.equal(got.rateLimitQps, 0.5, '未提供的字段必须沿用全局')
  assert.equal(got.maxContextMessages, 300)
})

test('覆盖成空对象 ⇒ 等价于没有覆盖（全部沿用全局）', () => {
  const got = resolveSafetyFor(GLOBAL as any, {})
  assert.deepEqual({ ...got }, { ...GLOBAL })
})

// ─────────────────────── 写入语义 ───────────────────────

test('🔴 写入只影响提供的字段，且 `null` 删除覆盖回到全局', async () => {
  const { runtime } = freshRuntime('write')
  const pool = poolOf(runtime.env)
  await seed(pool, 'u1')

  // 先给一个全局值，便于观察回落到它
  await pool.setSafetyConfig({ rateLimitQps: 0.5 })

  const r1 = await pool.setAccountSafety('u1', { modelCooldownEnabled: false })
  assert.equal(r1?.override.modelCooldownEnabled, false)

  const r2 = await pool.setAccountSafety('u1', { maxContextMessages: 10 })
  assert.equal(r2?.override.modelCooldownEnabled, false, '第二次写入不该抹掉第一次的字段')
  assert.equal(r2?.override.maxContextMessages, 10)

  // `null` = 删除该覆盖 ⇒ 回到全局
  const r3 = await pool.setAccountSafety('u1', { modelCooldownEnabled: null })
  assert.equal(
    'modelCooldownEnabled' in (r3?.override ?? {}),
    false,
    '`null` 必须把该字段从覆盖里删掉，而不是写成 false/0',
  )
  assert.equal(r3?.override.maxContextMessages, 10, '其它字段不该受影响')

  runtime.db.close()
})

test('全部覆盖被删空 ⇒ safetyOverride 整个字段消失（与「从没设置过」等价）', async () => {
  const { runtime } = freshRuntime('clear-all')
  const pool = poolOf(runtime.env)
  await seed(pool, 'u1')

  await pool.setAccountSafety('u1', { modelCooldownEnabled: false })
  await pool.setAccountSafety('u1', { modelCooldownEnabled: null })

  const acc = (await pool.listAccounts(REALM, Date.now())).find((a: any) => a.uid === 'u1')
  assert.equal(
    acc?.safetyOverride,
    undefined,
    '删空后整个字段应当消失，少一个需要解释的状态',
  )

  runtime.db.close()
})

test('越界值必须被拒并如实回报（不能静默吞掉）', async () => {
  const { runtime } = freshRuntime('reject')
  const pool = poolOf(runtime.env)
  await seed(pool, 'u1')

  const r = await pool.setAccountSafety('u1', {
    rateLimitQps: 999, // 上限 50
    maxContextMessages: -1, // 下限 0
    sessionTrace: 'yes', // 不是布尔
  })
  assert.deepEqual(
    [...(r?.rejected ?? [])].sort(),
    ['maxContextMessages', 'rateLimitQps', 'sessionTrace'].sort(),
    '三个非法字段都必须出现在 rejected 里 —— 静默忽略会让用户以为"已经设上了"',
  )
  assert.equal(r?.override.rateLimitQps, undefined, '非法值不该被写进去')

  runtime.db.close()
})

test('账号不存在 ⇒ 返回 undefined（调用方据此 404，不是静默成功）', async () => {
  const { runtime } = freshRuntime('missing')
  const pool = poolOf(runtime.env)
  const r = await pool.setAccountSafety('no-such-uid', { modelCooldownEnabled: false })
  assert.equal(r, undefined)
  runtime.db.close()
})

// ─────────────────────── 真正按账号生效（核心） ───────────────────────

test('🔴 模型冷却按账号生效：A 号关闭不影响 B 号', async () => {
  // 这是用户要的核心行为：qodercn 放开、workbuddy 保留。
  const { runtime } = freshRuntime('per-account')
  const pool = poolOf(runtime.env)
  const now = Date.now()
  await seed(pool, 'uid-off', 'qodercn')
  await seed(pool, 'uid-on', 'workbuddy')

  // 全局保持**开启**（这样"能写出冷却"是默认行为）
  await pool.setSafetyConfig({ modelCooldownEnabled: true })
  // 只给 uid-off 关闭
  await pool.setAccountSafety('uid-off', { modelCooldownEnabled: false })

  for (const uid of ['uid-off', 'uid-on']) {
    await pool.applyFailure({
      uid,
      kind: 'model',
      model: 'dfmodel',
      now,
      reason: 'rate_limited: 上游排队',
      modelCause: 'busy',
    })
  }

  const off = (await pool.listAccounts(REALM, Date.now())).find((a: any) => a.uid === 'uid-off')
  const on = (await pool.listAccounts(REALM, Date.now())).find((a: any) => a.uid === 'uid-on')

  assert.equal(
    off?.modelCooldowns?.dfmodel,
    undefined,
    'uid-off 已单独关闭模型冷却，不该被写入冷却',
  )
  assert.ok(
    on?.modelCooldowns?.dfmodel !== undefined,
    'uid-on 沿用全局（开启），必须照常写入冷却 —— 否则「按账号」就变成了「全关」',
  )

  runtime.db.close()
})

test('🔴 pick() 按账号解释已有冷却：关闭的号照常可选，开启的号被拦', async () => {
  const { runtime } = freshRuntime('per-account-pick')
  const pool = poolOf(runtime.env)
  const now = Date.now()
  await seed(pool, 'uid-off', 'qodercn')
  await seed(pool, 'uid-on', 'qodercn')

  // 两个号都挂着旧冷却（模拟"开关开着时留下的"）
  for (const uid of ['uid-off', 'uid-on']) {
    const raw = (await pool.listAccounts(REALM, now)).find((a: any) => a.uid === uid)!
    raw.modelCooldowns.dfmodel = {
      until: now + 5 * 3600_000,
      resetAt: 0,
      reason: 'x',
      hits: 2,
      confirmed: 2,
      cause: 'busy',
      auditOnly: false,
    }
    writeAccount(pool.ctx.storage.sql, raw.uid, raw.realm, JSON.stringify(raw), now)
  }

  await pool.setSafetyConfig({ modelCooldownEnabled: true })
  await pool.setAccountSafety('uid-off', { modelCooldownEnabled: false })

  // 只允许选 uid-off（用 exclude 排除 uid-on）
  const picked = await pool.pick({
    realm: REALM, provider: 'qodercn', model: 'dfmodel',
    exclude: ['uid-on'], now,
  })
  assert.equal(
    picked?.uid,
    'uid-off',
    'uid-off 关闭了模型冷却，即使挂着旧条目也必须可选',
  )

  // 反过来：只允许选 uid-on ⇒ 应当选不到（它沿用全局"开启"）
  const blocked = await pool.pick({
    realm: REALM, provider: 'qodercn', model: 'dfmodel',
    exclude: ['uid-off'], now,
  })
  assert.equal(
    blocked,
    undefined,
    'uid-on 沿用全局开启，挂着 5 小时冷却时必须被拦',
  )

  runtime.db.close()
})

test('🔴 counts() 也按账号解释（面板不能显示「模型限流」却可选中）', async () => {
  const { runtime } = freshRuntime('per-account-counts')
  const pool = poolOf(runtime.env)
  const now = Date.now()
  await seed(pool, 'uid-off', 'qodercn')
  const raw = (await pool.listAccounts(REALM, now))[0]!
  raw.modelCooldowns.dfmodel = {
    until: now + 5 * 3600_000, resetAt: 0, reason: 'x',
    hits: 2, confirmed: 2, cause: 'busy', auditOnly: false,
  }
  writeAccount(pool.ctx.storage.sql, raw.uid, raw.realm, JSON.stringify(raw), now)

  await pool.setSafetyConfig({ modelCooldownEnabled: true })

  const before = await pool.counts(REALM, Date.now())
  assert.equal(before.modelExempt, 1, '开启时应当统计成「模型限流」')

  await pool.setAccountSafety('uid-off', { modelCooldownEnabled: false })
  const after = await pool.counts(REALM, Date.now())
  assert.equal(
    after.modelExempt,
    0,
    '该账号已关闭模型冷却 ⇒ 面板不能再说它「模型限流」，否则与实际选号结果矛盾',
  )
  assert.equal(after.healthy, 1)

  runtime.db.close()
})

test('SET 语句：同一账号的覆盖不串到别的 realm', async () => {
  // ⚠️ 覆盖存在**账号自己的状态**里，而账号按 realm 分片存。
  // 这条防的是「在 cn 分片里改了，global 里的同名 uid 也变了」这种串味。
  const { runtime } = freshRuntime('realm-isolation')
  const poolCn = poolOf(runtime.env)
  const poolGlobal = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('global'))

  await seed(poolCn, 'same-uid', 'qodercn')
  const g = createAccountState({ uid: 'same-uid', nickname: 'g', realm: 'global', provider: 'workbuddy' })
  writeAccount(poolGlobal.ctx.storage.sql, g.uid, g.realm, JSON.stringify(g), Date.now())

  await poolCn.setAccountSafety('same-uid', { modelCooldownEnabled: false })

  const inGlobal = (await poolGlobal.listAccounts('global', Date.now())).find((a: any) => a.uid === 'same-uid')
  assert.equal(
    inGlobal?.safetyOverride,
    undefined,
    'cn 分片里的覆盖不该出现在 global 分片 —— 两个 realm 的账号是独立实体',
  )

  runtime.db.close()
})

test('🔴 同一 uid 在两个 realm 必须各自独立（否则账号会莫名消失）', async () => {
  // ## 这条测试的来历：变异测试暴露了我自己的漏测
  //
  // 我修了 `accounts` 主键（`uid` → `(uid, realm)`）并给 `readAccount` 加了 realm 过滤，
  // 但**没有任何测试覆盖它** —— 变异实验里把过滤条件删掉，12 条测试全绿。
  //
  // ## 缺陷本身（探针实测）
  //
  // 所有 realm 共用同一个 `router.db`，`accounts` 是全库一张表。
  // 旧主键是 `uid`，且 `readAccount/deleteAccount` 只按 uid 操作 ⇒
  // 同一个 uid 出现在两个 realm 时互相覆盖：
  //
  // ```
  // cn  里 same 的数量: 0      ← 被 global 那条顶掉了
  // gl  里 same 的数量: 1
  // cn 读到的 nickname: undefined
  // ```
  //
  // ## ⚠️ 分层防护：真正挡住覆盖的是**复合主键**，不是查询过滤
  //
  // 变异实验（2026-10-22）测出来的：把 `readAccount` 的 `AND realm = ?` 删掉，
  // 这一组测试**依然全绿** —— 因为两个分片共用同一个 SQLite 句柄，
  // `writeAccount` 的 `ON CONFLICT(uid, realm)` 已经保证「两条各存一份」，
  // 查询少一个过滤条件时 `rows[0]` 也恰好是对的。
  //
  // 而把主键改回 `ON CONFLICT(uid)`，**六条测试同时失败**。
  // ⇒ 主键是不可或缺的那道；查询过滤是纵深防御（防止将来有人写
  //   `WHERE uid = ?` 的单条查询时又串味）。两者都要，别因为「测不出来」就删。
  //
  // 线上目前靠「uid 带供应商前缀」（`workbuddy:…` / `qodercn:…`）侥幸没撞上，
  // 但多家上游的凭据里 uid 是裸 uuid —— 那是运气，不是保证。
  const { runtime } = freshRuntime('realm-independent')
  const poolCn = poolOf(runtime.env)
  const poolGlobal = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('global'))

  // ⚠️ **先写 global、后写 cn**（顺序有语义，不要改成先 cn）。
  //
  // 变异实验发现：先写 cn 时，把 `readAccount` 的 realm 过滤删掉，测试**依然全绿** ——
  // 因为无过滤的查询返回两条，`firstRow` 取 `rows[0]`，而它恰好是 cn 那条。
  // 改成先写 global 后，无过滤时 `rows[0]` 是 global 那条 ⇒ 断言必然失败。
  // 这让测试**不依赖插入顺序碰巧正确**。
  const b = createAccountState({ uid: 'same-uid', nickname: 'GL-account', realm: 'global', provider: 'workbuddy' })
  b.credits = 222
  writeAccount(poolGlobal.ctx.storage.sql, b.uid, b.realm, JSON.stringify(b), Date.now())

  const a = createAccountState({ uid: 'same-uid', nickname: 'CN-account', realm: 'cn', provider: 'qodercn' })
  a.credits = 111
  writeAccount(poolCn.ctx.storage.sql, a.uid, a.realm, JSON.stringify(a), Date.now())

  const inCn = await poolCn.listAccounts('cn', Date.now())
  const inGlobal = await poolGlobal.listAccounts('global', Date.now())

  assert.equal(inCn.length, 1, 'cn 分片必须还有自己那条')
  assert.equal(inGlobal.length, 1, 'global 分片必须有自己那条')
  assert.equal(inCn[0]?.nickname, 'CN-account', 'cn 读到的必须是 cn 那条（不许被 global 覆盖）')
  assert.equal(inGlobal[0]?.nickname, 'GL-account', 'global 读到的必须是 global 那条')
  assert.equal(inCn[0]?.credits, 111, 'cn 的积分不该被 global 覆盖')

  // `getAccount` 走的是 readAccount，必须同样隔离
  const gotCn = await poolCn.getAccount('same-uid')
  assert.equal(gotCn?.nickname, 'CN-account', 'getAccount 也必须带 realm 过滤')

  runtime.db.close()
})

test('🔴 删除账号只删本 realm 的那条（不许连带删掉另一个 realm）', async () => {
  // `deleteAccount` 原来只按 uid 删 —— 那会**同时删掉**另一个 realm 的同名账号。
  const { runtime } = freshRuntime('realm-delete')
  const poolCn = poolOf(runtime.env)
  const poolGlobal = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('global'))

  for (const [pool, realm, nick] of [
    [poolCn, 'cn', 'CN'],
    [poolGlobal, 'global', 'GL'],
  ] as const) {
    const st = createAccountState({ uid: 'dup', nickname: nick, realm, provider: 'qodercn' })
    writeAccount(pool.ctx.storage.sql, st.uid, st.realm, JSON.stringify(st), Date.now())
  }

  await poolCn.removeAccount('dup')

  assert.equal((await poolCn.listAccounts('cn', Date.now())).length, 0, 'cn 那条应被删除')
  assert.equal(
    (await poolGlobal.listAccounts('global', Date.now())).length,
    1,
    'global 的同名账号不该被 cn 的删除操作连带删掉',
  )

  runtime.db.close()
})
