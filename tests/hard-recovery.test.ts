/**
 * `hard`（402 余额耗尽）的两条真缺陷：**余额恢复从不解冻** + **soft 把它改写掉**
 *
 * ## 缺陷 1：S3 —— 「余额恢复 ⇒ 自动解冻」从未实现
 *
 * `applyFailure` 的 `hard` 分支注释、`state.ts` 的维度表、`plans.ts:90`
 *（「余额恢复的冷却账号由调用方解冻」）与 `actions.ts:144` 都写着这条能力，
 * 但全仓**没有一行实现**：`updateBalance` 刻意「绝不动惩罚态」，
 * `revive` 只在导入凭据时被调用。
 *
 * 后果是**用户直接可感知的**：充了钱、余额已是 2870，账号仍被锁到次日 04:00，
 * 面板写「余额耗尽」，只能干等或手动点「解冻」。
 * 这也是本仓库最典型的一类缺陷 —— **注释承诺了代码里不存在的行为**。
 *
 * ⇒ 现在由 `AccountPoolDO.clearHardIfRecovered()` 实现，两条余额刷新入口
 *（`/admin/accounts/balance` 与整点 cron）在余额**落盘之后**显式调用它。
 * 本文件直接调池方法（不起 HTTP），钉住四件事：
 *   1. 余额 > 0 且正因 `hard` 冷却 ⇒ 清掉（`until` / `coolKind` / `reason`）；
 *   2. **只清 `hard` 这一维** —— `breakerUntil` / `degradeUntil` /
 *      `restrictedUntil` / `modelCooldowns` 一个都不许动（混清会掩盖真实故障）；
 *   3. 余额 ≤ 0（含负数、`NaN`）⇒ 不清；
 *   4. `updateBalance` 本身**仍然不碰惩罚态**（那是既有单测钉住的语义），
 *      所以「写余额」与「判恢复」必须是**两步**。
 *
 * ## 缺陷 2：S5 —— soft 无条件把 `coolKind` 改写成 `'soft'`
 *
 * `applyFailure` 的 `soft` 分支第一行是 `state.coolKind = 'soft'`，**没有任何前置判断**。
 * 于是「因 402 余额耗尽被锁到次日 04:00」的账号，只要再来一次普通 429，
 * 面板就从「余额耗尽」变成「临时冷却（还剩 40 分钟）」，
 * 而真实恢复时刻仍是次日 04:00 —— 用户按「等一分钟」去处理，永远等不到。
 * 若这次 soft 带上游重置墙钟，`until` 还会被**提前缩短**。
 *
 * 全仓此前只有 `enforceBurnRate` 挡了一处（同一判据），这正是
 * 「同一个概念两处判据、只修一处」的典型。
 * ⇒ 判据统一抽成 `hardCooldownActive()`，本文件同时钉住
 * 「hard 期间 soft 不得改写」与「非 hard 时 soft 必须照常生效」（防止修过头）。
 *
 * ⚠️ 这些用例在**旧代码**上必然失败：
 *   - `clearHardIfRecovered` 旧代码里根本不存在（`TypeError: not a function`）；
 *   - `coolKind` 旧代码会被改写成 `'soft'`，`until` 会被缩短。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState, healthy } from '../src/pool/state.js'
import { readAccount, writeAccount } from '../src/store/db.js'
import { findProvider } from '../src/providers/index.js'

const REALM = 'cn'

/** 每个用例一个**独立 SQLite 文件**：账号状态是「整条 JSON 重写」，共库会互相污染。 */
function freshRuntime(tag: string) {
  // ⚠️ 用**专属子目录**：`.build/tests/` 是 `scripts/test.sh` 每次 `rm -rf` 重建的，
  // 把用例库放那里会与并发跑的整套测试互相踩。
  const dir = path.join(process.cwd(), '.build', 'test-hard-recovery')
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, `${tag}.db`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  return { runtime: createNodeRuntime(dbPath), dbPath }
}

/** 池实例（`AccountPoolDO` 本身；Node 适配层 `get()` 返回真实实例）。 */
function poolOf(env: any) {
  return env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
}

/** 读出**已落盘**的状态（走 `listAccounts`，与面板同一条读路径）。 */
async function readState(pool: any, uid: string, now: number): Promise<any> {
  const acc = (await pool.listAccounts(REALM, now)).find((a: any) => a.uid === uid)
  assert.ok(acc !== undefined, `账号 ${uid} 应存在`)
  return acc
}

/** 读**原始**（未归一）的落盘 JSON —— 用来判定「默认值有没有真的写进库」。 */
function readRaw(pool: any, uid: string): string | undefined {
  return readAccount(pool.ctx.storage.sql, uid)
}

/** 造一个「因 402 余额耗尽被锁到次日 04:00」的账号。 */
function hardLockedState(uid: string, now: number) {
  const st = createAccountState({ uid, nickname: uid, realm: REALM, provider: 'buddy' })
  st.until = now + 10 * 3600_000
  st.coolKind = 'hard'
  st.reason = 'credit exhausted'
  return st
}

// ───────────────────── S3：余额恢复 ⇒ 解冻 hard ─────────────────────

test('🔴 余额恢复（>0）必须清掉 hard 冷却，账号重新可用', async () => {
  const { runtime } = freshRuntime('recover')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-hard-1'
    const st = hardLockedState(uid, now)
    await pool.upsertAccount(st, now)

    // 解锁前：不可选（这是「充值了却仍被锁」的现象本身）
    assert.equal(healthy(await readState(pool, uid, now), now), false)

    const cleared = await pool.clearHardIfRecovered(uid, 2870, now)
    assert.equal(cleared, true, '余额 > 0 且正因 hard 冷却 ⇒ 必须返回「已解冻」')

    const acc = await readState(pool, uid, now)
    assert.equal(acc.coolKind, '', 'coolKind 必须清空')
    assert.equal(acc.until, 0, 'until 必须清 0（否则号仍选不到）')
    assert.equal(acc.reason, '', 'reason 是冷却域的展示文案，必须一起清（否则面板显示「可用 + 余额错误」）')
    assert.equal(healthy(acc, now), true, '解冻后必须真的可选 —— 这才是行为层面的反证')
  } finally {
    db.close()
  }
})

test('🔴 只清 hard 一维：breaker / degrade / restricted / 模型冷却 一个都不许动', async () => {
  const { runtime } = freshRuntime('only-hard')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-hard-2'
    const st = hardLockedState(uid, now)
    // 四维全部「正在生效」，并且故意让它们与 hard 同时存在
    st.breakerUntil = now + 30 * 60_000
    st.fails = 2
    st.retryCount = 1
    st.degradeUntil = now + 10 * 60_000
    st.consecutiveFails = 4
    st.restrictedUntil = now + 2 * 3600_000
    st.softStreak = 3
    st.modelCooldowns['glm-5.3'] = {
      until: now + 10 * 60_000,
      resetAt: 0,
      reason: 'busy',
      hits: 1,
      cause: 'busy',
      auditOnly: false,
    }
    await pool.upsertAccount(st, now)

    assert.equal(await pool.clearHardIfRecovered(uid, 1000, now), true)

    const acc = await readState(pool, uid, now)
    assert.equal(acc.coolKind, '', 'hard 必须清')
    assert.equal(acc.until, 0)
    // ⚠️ 以下任一被清 = 掩盖真实故障：充钱不能证明「它不再反复 5xx」或「上游解封了」
    assert.equal(acc.breakerUntil, st.breakerUntil, '熔断不得被清')
    assert.equal(acc.fails, 2, '失败计数不得被清')
    assert.equal(acc.retryCount, 1, '退避指数不得被清')
    assert.equal(acc.degradeUntil, st.degradeUntil, '降权不得被清')
    assert.equal(acc.consecutiveFails, 4, '连败进度不得被清')
    assert.equal(acc.restrictedUntil, st.restrictedUntil, '上游封号（11140）不得被清')
    assert.equal(acc.softStreak, 3, 'soft 退避档位不属于 hard，不得被清')
    assert.ok(acc.modelCooldowns['glm-5.3'] !== undefined, '模型级冷却不得被清')
    assert.equal(healthy(acc, now), false, '其它维度仍在冷却 ⇒ 账号仍不可选（正确）')
  } finally {
    db.close()
  }
})

test('余额为 0 / 负数 / NaN 一律不解冻（NaN 是 `credits <= 0` 的陷阱）', async () => {
  const { runtime } = freshRuntime('no-credits')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-hard-3'
    const st = hardLockedState(uid, now)
    await pool.upsertAccount(st, now)

    // ⚠️ `NaN <= 0` 是 false —— 只写 `credits <= 0` 会把 NaN 当成「有余额」而误解冻。
    for (const credits of [0, -5, Number.NaN]) {
      assert.equal(
        await pool.clearHardIfRecovered(uid, credits, now),
        false,
        `credits=${credits} 表示「没恢复」，不得解冻`,
      )
      const acc = await readState(pool, uid, now)
      assert.equal(acc.coolKind, 'hard')
      assert.equal(acc.until, st.until)
    }
  } finally {
    db.close()
  }
})

test('⚠️ 非 hard 的冷却不许被「余额恢复」清掉（soft 有它自己的恢复条件）', async () => {
  const { runtime } = freshRuntime('soft-untouched')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-soft-1'
    const st = createAccountState({ uid, nickname: uid, realm: REALM, provider: 'buddy' })
    st.until = now + 60_000
    st.coolKind = 'soft'
    st.reason = 'rate limited'
    await pool.upsertAccount(st, now)

    assert.equal(await pool.clearHardIfRecovered(uid, 5000, now), false, 'soft 不是「没钱」，充钱与它无关')
    const acc = await readState(pool, uid, now)
    assert.equal(acc.coolKind, 'soft')
    assert.equal(acc.until, st.until)
  } finally {
    db.close()
  }
})

test('⚠️ 已自然到期的 hard 不解冻、不写库（等到 04:00 之后无需再动）', async () => {
  const { runtime } = freshRuntime('expired')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-hard-4'
    const st = hardLockedState(uid, now)
    st.until = now - 1000 // 已经过了 04:00
    await pool.upsertAccount(st, now)

    assert.equal(await pool.clearHardIfRecovered(uid, 100, now), false)
    const acc = await readState(pool, uid, now)
    assert.equal(acc.coolKind, 'hard', '不主动改写历史状态（它自己已失效）')
    assert.equal(acc.until, st.until)
  } finally {
    db.close()
  }
})

test('🔴 「写余额」与「判恢复」必须是两步：updateBalance 单独跑时不许解冻', async () => {
  const { runtime } = freshRuntime('two-steps')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-hard-5'
    const st = hardLockedState(uid, now)
    await pool.upsertAccount(st, now)

    // 第 1 步：余额落盘。⚠️ 既有单测（balance-refresh / burn-rate）钉住它**不碰惩罚态**，
    // 若把解冻塞进 updateBalance，那两条测试会立刻红 —— 故这里是两步。
    await pool.updateBalance(uid, now, { credits: 2870, expiring: 0, earliestExpiry: 0 })
    const afterWrite = await readState(pool, uid, now)
    assert.equal(afterWrite.credits, 2870, '余额必须落盘')
    assert.equal(afterWrite.coolKind, 'hard', 'updateBalance 单独跑不得解冻（保持「只写额度」语义）')
    assert.equal(afterWrite.until, st.until)

    // 第 2 步：判恢复（两条余额刷新入口在 updateBalance 之后显式调这一步）。
    assert.equal(await pool.clearHardIfRecovered(uid, 2870, now), true)
    const afterRecover = await readState(pool, uid, now)
    assert.equal(afterRecover.coolKind, '')
    assert.equal(afterRecover.until, 0)
    assert.equal(healthy(afterRecover, now), true)
  } finally {
    db.close()
  }
})

// ───────────────────── S5：soft 不得改写 hard ─────────────────────

test('🔴 hard 冷却期内的一次 soft 失败，不得把 coolKind 改写成 soft', async () => {
  const { runtime } = freshRuntime('soft-vs-hard')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-mix-1'
    const st = hardLockedState(uid, now)
    await pool.upsertAccount(st, now)

    await pool.applyFailure({ uid, kind: 'soft', now: now + 60_000, reason: 'rate_limited: 429' })

    const acc = await readState(pool, uid, now + 60_000)
    assert.equal(acc.coolKind, 'hard', '「没钱」不得被改写成「被限流」—— 面板会误导用户去等一分钟')
    assert.equal(acc.until, st.until, 'hard 的截止时刻（次日 04:00）不得变')
    assert.equal(acc.reason, 'credit exhausted', '冷却原因文案必须与 coolKind 自洽')
    assert.equal(acc.softStreak, 0, '不是 soft 冷却，退避档位不得推进')
    // 但这次失败**是**一次错误，仍要计入观测
    assert.equal(acc.errTotal, 1, '错误计数仍要记（它确实失败了一次）')
  } finally {
    db.close()
  }
})

test('🔴 hard 期间 soft 带上游重置墙钟，也不得把 until 提前缩短', async () => {
  const { runtime } = freshRuntime('soft-shorten')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-mix-2'
    const st = hardLockedState(uid, now)
    await pool.upsertAccount(st, now)

    // 上游说「2 分钟后重试」——若照抄，余额问题会凭空变成一次 2 分钟的短冷却
    await pool.applyFailure({ uid, kind: 'soft', now, resetAt: now + 120_000, reason: 'rate_limited: 429' })

    const acc = await readState(pool, uid, now)
    assert.equal(acc.coolKind, 'hard')
    assert.equal(acc.until, st.until, 'until 不得被缩短（否则账号会被提前放回上游，再撞一次 402）')
  } finally {
    db.close()
  }
})

test('⚠️ 非 hard 时 soft 必须照常生效（防止修过头把 soft 关掉）', async () => {
  const { runtime } = freshRuntime('soft-normal')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-mix-3'
    await pool.upsertAccount(createAccountState({ uid, nickname: uid, realm: REALM, provider: 'buddy' }), now)

    await pool.applyFailure({ uid, kind: 'soft', now, reason: 'rate_limited: 429' })

    const acc = await readState(pool, uid, now)
    assert.equal(acc.coolKind, 'soft', '健康账号遇 429 仍要落 soft 冷却')
    assert.ok(acc.until > now, 'soft 冷却必须有截止时刻')
    assert.equal(acc.softStreak, 1, '退避档位必须推进')
    assert.equal(healthy(acc, now), false)
  } finally {
    db.close()
  }
})

test('⚠️ hard 已过期后，soft 必须能正常接管（判据是「仍在冷却期内」，不是「曾经 hard」）', async () => {
  const { runtime } = freshRuntime('soft-after-expiry')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000
    const uid = 'uid-mix-4'
    const st = createAccountState({ uid, nickname: uid, realm: REALM, provider: 'buddy' })
    st.until = now - 1000 // 04:00 已过
    st.coolKind = 'hard'
    await pool.upsertAccount(st, now)

    await pool.applyFailure({ uid, kind: 'soft', now, reason: 'rate_limited: 429' })

    const acc = await readState(pool, uid, now)
    assert.equal(acc.coolKind, 'soft', '过期的 hard 不再拦 soft，否则账号会永远停在「余额耗尽」')
    assert.ok(acc.until > now)
  } finally {
    db.close()
  }
})

// ───────────────────── S7：四条写路径必须过归一 ─────────────────────

/**
 * 四条裸 `JSON.parse` 写路径（`noteSuccess` / `revive` / `noteCheckinDone` / `disable`）
 * 此前**没过 `normalizeAccountState`**，于是升级前落盘的记录缺 `provider` / `samples` /
 * `restrictedUntil` 时，会把「缺字段」原样写回并**永久固化**。
 *
 * ⚠️ 断言必须看**原始落盘 JSON**：`getAccount` / `listAccounts` 都会归一，
 * 读出来的值永远有默认值 —— 用它们断言等于什么都没测。
 */
test('🔴 四条写路径都必须把默认值真的写进库（原来裸 JSON.parse 会静默丢字段）', async () => {
  const { runtime } = freshRuntime('normalize')
  const { env, db } = runtime
  try {
    const pool = poolOf(env)
    const now = 1_700_000_000_000

    // 造一条「升级前」的落盘记录：没有 provider / samples / restrictedUntil
    const legacy = (uid: string) => {
      const st: any = createAccountState({ uid, nickname: uid, realm: REALM, provider: 'buddy' })
      delete st.provider
      delete st.samples
      delete st.restrictedUntil
      return JSON.stringify(st)
    }

    const cases: Array<{ tag: string; write: (uid: string) => Promise<unknown> }> = [
      { tag: 'noteSuccess', write: (uid) => pool.noteSuccess(uid, now) },
      { tag: 'revive', write: (uid) => pool.revive(uid, now) },
      { tag: 'noteCheckinDone', write: (uid) => pool.noteCheckinDone(uid, now) },
      { tag: 'disable', write: (uid) => pool.disable(uid, '11140 restricted', now) },
    ]

    for (const c of cases) {
      const uid = `uid-legacy-${c.tag}`
      writeAccount(pool.ctx.storage.sql, uid, REALM, legacy(uid), now)
      const before = JSON.parse(readRaw(pool, uid) as string)
      assert.equal(before.provider, undefined, '前置条件：记录里确实没有 provider')

      await c.write(uid)

      const after = JSON.parse(readRaw(pool, uid) as string)
      assert.equal(after.provider, 'buddy', `${c.tag} 写入后必须补上 provider 默认值（否则字段永远缺失）`)
      assert.deepEqual(after.samples, [], `${c.tag} 写入后必须补上 samples: []（否则余额采样展开会抛 TypeError）`)
      assert.equal(after.restrictedUntil, 0, `${c.tag} 写入后必须补上 restrictedUntil: 0（否则 Math.max(undefined,x)=NaN）`)
      // 原有语义不许被改坏
      assert.equal(after.uid, uid)
    }

    // 逐条核对各自该有的效果（补默认值不能顺手改语义）
    const disabled = JSON.parse(readRaw(pool, 'uid-legacy-disable') as string)
    assert.equal(disabled.disabled, true, 'disable 仍必须禁用')
    assert.equal(disabled.reason, '11140 restricted', 'disable 仍必须写入原因')
    const checked = JSON.parse(readRaw(pool, 'uid-legacy-noteCheckinDone') as string)
    assert.notEqual(checked.lastCheckinDay, '', 'noteCheckinDone 仍必须写入签到日')
  } finally {
    db.close()
  }
})

test('🔴 解冻 hard 时不得抹掉「停用原因」（reason 是共用字段）', async () => {
  // ## 复核发现的副作用（2026-10-22）
  //
  // `clearHardIfRecovered` 原本无条件 `state.reason = ''`。
  // 但 `reason` **同时**是「停用原因」：面板对 `disabled` 账号显示的就是它
  //（`ProvidersPage` 的 `s === 'disabled' ? a.reason`）。
  //
  // 于是「余额耗尽被锁 + 已被手动停用」的账号，在整点 cron 刷完余额后，
  // 停用原因被清空 —— 账号仍停着，面板却不说明为什么。
  // 同类还有 `session dead (12153 ×3)` 这种真实故障原因。
  //
  // ⇒ 只在**没被停用**时才清 reason。
  const { runtime } = freshRuntime('keep-reason')
  try {
    const pool = poolOf(runtime.env)
    const now = Date.now()

    // ① 停用 + hard：停用原因必须保留
    const a = hardLockedState('kr1', now)
    a.disabled = true
    a.reason = '已被手动停用'
    await pool.upsertAccount(a, now)

    assert.equal(await pool.clearHardIfRecovered('kr1', 2870, now), true, 'hard 仍应被解冻')
    const afterA = await readState(pool, 'kr1', now)
    assert.equal(afterA.until, 0, '冷却应清掉')
    assert.equal(afterA.coolKind, '', 'coolKind 应清空')
    assert.equal(afterA.disabled, true, '停用状态本身不受影响')
    assert.equal(afterA.reason, '已被手动停用', '⚠️ 停用原因被抹掉了 —— 面板将不说明为什么停用')

    // ② 未停用 + hard：原因照常清空（否则会留下过期的「credit exhausted」）
    const b = hardLockedState('kr2', now)
    await pool.upsertAccount(b, now)
    assert.equal(await pool.clearHardIfRecovered('kr2', 2870, now), true)
    const afterB = await readState(pool, 'kr2', now)
    assert.equal(afterB.reason, '', '未停用时，过期的「余额耗尽」原因应清掉')
  } finally {
    runtime.db.close()
  }
})

test('🔴 接线：POST /admin/accounts/balance 必须真的解冻 hard（否则前面全是空转）', async () => {
  // ## 复核发现的缺口（2026-10-22）
  //
  // `clearHardIfRecovered` 本身有 6 条用例，但**唯一产生用户可见效果的两行**
  //（`src/index.ts` 里两条余额刷新入口的调用）没有任何测试覆盖：
  // 把这两行删掉，`hard-recovery.test.ts` 仍然全绿。
  //
  // 这正是本项目反复出现的「能力实现了，但没接线」—— 本次 S3 的病根本身
  // 就是「注释承诺了、代码里没有」。所以接线必须有测试。
  //
  // 这里走**真实 HTTP 路由**（与 `account-pins.test.ts` 同一手法），
  // 只把 `provider.balance()` 换成固定返回值，不碰网络。
  const { runtime } = freshRuntime('wiring')
  const { env } = runtime
  env.API_KEY = 'test-hard-recovery-key-0123456789'
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  const auth = { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' }
  const pool = poolOf(env)
  const now = Date.now()

  // ⚠️ 必须用**非 DEFAULT_PROVIDER** 的家：`/admin/accounts/balance` 对 buddy
  // 走 `bindBuddy(env)`（另一个对象），打在 `findProvider('buddy')` 上的桩不会被用到。
  const provider = findProvider('cline')
  assert.ok(provider !== undefined)
  const originalBalance = provider.balance
  provider.balance = (async () => ({ total: 2870, expiring: 2870, earliestExpiry: now + 86400_000 })) as never

  try {
    const st = hardLockedState('wr1', now)
    st.provider = 'cline'
    await pool.upsertAccount(st, now)
    await pool.putCredential(
      'wr1',
      { uid: 'wr1', nickname: 'wr1', accessToken: 't', refreshToken: '', expiresAt: now + 3600_000 },
      now,
    )
    assert.equal((await readState(pool, 'wr1', now)).coolKind, 'hard', '前置：应先处于 hard 冷却')

    const { default: worker } = await import('../src/index.js')
    const res = await worker.fetch(
      new Request('http://localhost/admin/accounts/balance', { method: 'POST', headers: auth, body: '{}' }),
      env,
      ctx,
    )
    assert.equal(res.status, 200, `余额刷新接口应成功，实际 ${res.status}`)
    await res.text()

    const after = await readState(pool, 'wr1', Date.now())
    assert.equal(
      after.coolKind,
      '',
      '⚠️ 余额刷新后仍是 hard —— `clearHardIfRecovered` 没有接线到 /admin/accounts/balance',
    )
    assert.equal(healthy(after, Date.now()), true, '账号应已恢复可用')
  } finally {
    provider.balance = originalBalance
    runtime.db.close()
  }
})
