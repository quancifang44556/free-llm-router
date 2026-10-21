/**
 * 消耗速率异常熔断（burn-rate breaker）
 *
 * ## 缺陷（来自同类项目封禁复盘的明确建议）
 *
 * > 轮询 `POST /billing/meter/get-user-resource`，暴露 `GET /v1/credits`，
 * > **消耗速率异常（如 5 分钟烧掉 20%）自动熔断**
 *
 * 本项目刚实现了余额刷新（`refreshAccountBalances`），但 `credits` 只是**快照**：
 * `2870 → 2296` 与 `2870 → 2800` 在快照上都是「一个数字」，看不出「烧得太快」。
 * 后果是账号被盗用、或某模型倍率异常高时**发现不了** —— 等快照变成 0，
 * 积分已经不可撤回地烧掉了。
 *
 * ## 本文件钉住的硬约束
 *
 * 1. 采样史随 state 持久化，**上限 6 条**，满了挤掉最旧的；
 * 2. 正常速率**绝不**误熔断（否则等于把好号锁起来，比不检测更糟）；
 * 3. 异常速率**必须**落到**现有软冷却**（`until` + `coolKind='soft'`），
 *    不新造第二套惩罚态；
 * 4. `BURN_RATE_THRESHOLD_PCT=0` 必须真的关掉（`||` 陷阱：`0` 是合法值却 falsy）；
 * 5. 余额**增加**（充值 / 签到 / 退款）绝不判为消耗；
 * 6. 旧 state 缺 `samples` 字段时**不崩**（升级兼容）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState, normalizeAccountState } from '../src/pool/state.js'
import { BURN_SAMPLE_LIMIT, appendBalanceSample, detectBurnRate } from '../src/pool/burn-rate.js'
import { parseBurnRateThresholdPct, parseBurnRateWindowMs, resolveBurnRate } from '../src/env.js'

const REALM = 'cn'

/** 每个用例一个**独立 SQLite 文件**：账号状态是「整条 JSON 重写」，共库会互相污染。 */
function freshRuntime(tag: string) {
  const dbPath = path.join(process.cwd(), '.build', `test-burn-${tag}.db`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  return { runtime: createNodeRuntime(dbPath), dbPath }
}

/** 显式写死本用例的配置（**不依赖**运行环境的真实 env，避免用例间互相影响）。 */
function configure(env: any, windowMs: string | undefined, thresholdPct: string | undefined): void {
  env.BURN_RATE_WINDOW_MS = windowMs
  env.BURN_RATE_THRESHOLD_PCT = thresholdPct
}

async function seed(pool: any, uid: string, now: number): Promise<void> {
  await pool.upsertAccount(createAccountState({ uid, nickname: uid, realm: REALM, provider: 'buddy' }), now)
}

async function readAccount(pool: any, uid: string, now: number): Promise<any> {
  const acc = (await pool.listAccounts(REALM, now)).find((a: any) => a.uid === uid)
  assert.ok(acc !== undefined, `账号 ${uid} 应存在`)
  return acc
}

// ─────────────────────────── 配置解析（`||` 陷阱） ───────────────────────────

test('🔴 BURN_RATE_THRESHOLD_PCT=0 必须真的关掉检测（严禁 `|| 默认值`）', () => {
  // `0` 是合法值却是 falsy：写成 `parseInt(x) || 20` 会被静默换成 20，
  // 开关永远关不掉，且没有任何报错 —— AGENTS.md §6.8 的同型缺陷。
  assert.equal(parseBurnRateThresholdPct('0'), 0)
  assert.equal(parseBurnRateThresholdPct('-5'), 0, '负数 = 关闭')
  assert.equal(parseBurnRateThresholdPct(undefined), 20, '未设置 = 默认 20')
  assert.equal(parseBurnRateThresholdPct('35'), 35)

  assert.equal(parseBurnRateWindowMs('0'), 0)
  assert.equal(parseBurnRateWindowMs('-1'), 0)
  // ⚠️ 默认窗口是 **1 小时**（不是 5 分钟）：采样的唯一生产调用点是整点 cron，
  // 窗口比采样间隔短会让检测永远只有 1 个采样点 ⇒ 恒等于自身 ⇒ **永不生效**。
  assert.equal(parseBurnRateWindowMs(undefined), 3_600_000, '未设置 = 默认 1 小时（对齐整点 cron 采样节奏）')

  // 任一项关闭 ⇒ 整体归一为「关闭」，让「是否启用」只有一处判据。
  assert.deepEqual(resolveBurnRate({ BURN_RATE_THRESHOLD_PCT: '0' } as never), { windowMs: 0, thresholdPct: 0 })
  assert.deepEqual(resolveBurnRate({ BURN_RATE_WINDOW_MS: '0' } as never), { windowMs: 0, thresholdPct: 0 })
  assert.deepEqual(resolveBurnRate({} as never), { windowMs: 3_600_000, thresholdPct: 20 })

  // 非法值取**收紧**方向（检测保持开启），而不是静默关闭。
  assert.equal(parseBurnRateThresholdPct('abc'), 20)
  assert.equal(parseBurnRateWindowMs('5m'), 3_600_000)
})

// ─────────────────────────── 采样史 ───────────────────────────

test('🔴 采样史最多 6 条，满了挤掉最旧的（且随 state 持久化）', async () => {
  const { runtime } = freshRuntime('samples')
  const { env, db } = runtime
  try {
    configure(env, '300000', '20')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
    const uid = 'uid-burn-samples'
    const t0 = 1_700_000_000_000
    await seed(pool, uid, t0)

    // 余额恒定 ⇒ 无消耗 ⇒ 不会触发熔断，只观察「挤掉最旧」。
    for (let i = 0; i < BURN_SAMPLE_LIMIT + 1; i += 1) {
      await pool.updateBalance(uid, t0 + i * 30_000, { credits: 1000, expiring: 0, earliestExpiry: 0 })
    }

    const acc = await readAccount(pool, uid, t0)
    assert.equal(acc.samples.length, BURN_SAMPLE_LIMIT, `采样上限必须是 ${BURN_SAMPLE_LIMIT} 条`)
    // 第 0 条（t0）已被挤掉，最早的一条应是第 1 次（t0+30s）。
    assert.equal(acc.samples[0].at, t0 + 30_000, '最旧的采样必须被挤掉')
    assert.equal(acc.samples[acc.samples.length - 1].at, t0 + BURN_SAMPLE_LIMIT * 30_000, '最新一条在末尾')
    assert.equal(acc.until, 0, '余额恒定不得触发任何冷却')
  } finally {
    db.close()
  }
})

test('纯函数：appendBalanceSample 不修改入参且按时间升序', () => {
  const input = [{ at: 20, credits: 5 }]
  const out = appendBalanceSample(input, 10, 9)
  assert.deepEqual(input, [{ at: 20, credits: 5 }], '不得原地修改入参')
  assert.deepEqual(out, [{ at: 10, credits: 9 }, { at: 20, credits: 5 }], '乱序输入必须被排好')

  let acc = [...Array(BURN_SAMPLE_LIMIT).keys()].map((i) => ({ at: i, credits: 100 }))
  acc = appendBalanceSample(acc, 99, 100)
  assert.equal(acc.length, BURN_SAMPLE_LIMIT)
  assert.equal(acc[0]!.at, 1, '挤掉的必须是最旧的那条')
})

// ─────────────────────────── 判定 ───────────────────────────

test('✅ 正常消耗（1 分钟烧 2%）不触发软冷却', async () => {
  const { runtime } = freshRuntime('normal')
  const { env, db } = runtime
  try {
    configure(env, '300000', '20')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
    const uid = 'uid-burn-normal'
    const t0 = 1_700_000_000_000
    await seed(pool, uid, t0)

    await pool.updateBalance(uid, t0, { credits: 1000, expiring: 0, earliestExpiry: 0 })
    await pool.updateBalance(uid, t0 + 60_000, { credits: 980, expiring: 0, earliestExpiry: 0 })

    const acc = await readAccount(pool, uid, t0 + 60_000)
    assert.equal(acc.credits, 980)
    assert.equal(acc.until, 0, '2% 的消耗远低于 20% 阈值，绝不能冷却')
    assert.equal(acc.coolKind, '')
    assert.equal(acc.samples.length, 2)
  } finally {
    db.close()
  }
})

test('🔴 异常消耗（5 分钟烧 25%）触发软冷却（复用现有 `until` / `coolKind`）', async () => {
  const { runtime } = freshRuntime('trip')
  const { env, db } = runtime
  try {
    configure(env, '300000', '20')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
    const uid = 'uid-burn-trip-0001'
    const t0 = 1_700_000_000_000
    await seed(pool, uid, t0)

    await pool.updateBalance(uid, t0, { credits: 1000, expiring: 0, earliestExpiry: 0 })
    const now = t0 + 300_000
    await pool.updateBalance(uid, now, { credits: 750, expiring: 0, earliestExpiry: 0 })

    const acc = await readAccount(pool, uid, now)
    assert.equal(acc.credits, 750, '额度仍要如实写入')
    assert.equal(acc.coolKind, 'soft', '必须落到**现有软冷却**，不新造惩罚态')
    assert.ok(acc.until > now, `必须真的开始冷却（until=${acc.until}, now=${now}）`)
    assert.ok(
      String(acc.reason).includes('burn'),
      `冷却原因应可读出来是速率异常，实际：${acc.reason}`,
    )
    assert.equal(acc.softStreak, 1, '复用软冷却的退避计数')

    // 熔断后该账号不再可选（端到端验证：惩罚态真的生效）。
    const picked = await pool.pick({ realm: REALM, provider: 'buddy', model: 'glm-5.3', exclude: [], now })
    assert.ok(picked === undefined || picked.uid !== uid, '软冷却中的账号不得被选中')
  } finally {
    db.close()
  }
})

test('⚠️ 阈值设为 0 时检测整体关闭（即使烧掉 90% 也不冷却）', async () => {
  const { runtime } = freshRuntime('off')
  const { env, db } = runtime
  try {
    configure(env, '300000', '0')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
    const uid = 'uid-burn-off'
    const t0 = 1_700_000_000_000
    await seed(pool, uid, t0)

    await pool.updateBalance(uid, t0, { credits: 1000, expiring: 0, earliestExpiry: 0 })
    await pool.updateBalance(uid, t0 + 60_000, { credits: 100, expiring: 0, earliestExpiry: 0 })

    const acc = await readAccount(pool, uid, t0 + 60_000)
    assert.equal(acc.credits, 100)
    assert.equal(acc.until, 0, '阈值 0 = 关闭，绝不能冷却')
    assert.equal(acc.coolKind, '')
    // 关闭检测**仍然采样**：采样史是廉价的历史，关掉判定不该让历史断档
    // （否则「先观察后开启」时手上没有任何数据）。
    assert.equal(acc.samples.length, 2)
  } finally {
    db.close()
  }
})

test('⚠️ 余额增加（充值 / 签到）绝不误判为消耗', async () => {
  const { runtime } = freshRuntime('topup')
  const { env, db } = runtime
  try {
    configure(env, '300000', '20')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
    const uid = 'uid-burn-topup'
    const t0 = 1_700_000_000_000
    await seed(pool, uid, t0)

    await pool.updateBalance(uid, t0, { credits: 100, expiring: 0, earliestExpiry: 0 })
    // 签到 +900：若判据写成 `|差|` 或忘了判方向，这里会被算成「烧掉 900%」并误熔断。
    await pool.updateBalance(uid, t0 + 300_000, { credits: 1000, expiring: 0, earliestExpiry: 0 })

    const acc = await readAccount(pool, uid, t0 + 300_000)
    assert.equal(acc.credits, 1000)
    assert.equal(acc.until, 0, '余额增加不是消耗，绝不能冷却')
    assert.equal(acc.coolKind, '')
  } finally {
    db.close()
  }
})

test('纯函数：detectBurnRate 的边界（同刻 / 零分母 / 窗口外 / 达阈）', () => {
  const cfg = { windowMs: 300_000, thresholdPct: 20 }
  const now = 1_000_000

  assert.equal(detectBurnRate([], now, cfg), undefined, '无采样')
  assert.equal(detectBurnRate([{ at: now - 1000, credits: 100 }], now, cfg), undefined, '只有 1 条')
  assert.equal(
    detectBurnRate([{ at: now, credits: 100 }, { at: now, credits: 50 }], now, cfg)?.pct,
    undefined,
    '同一时刻无法构成速率',
  )
  assert.equal(
    detectBurnRate([{ at: now - 1000, credits: 0 }, { at: now, credits: 0 }], now, cfg),
    undefined,
    '起点余额 0 时不做 0 除',
  )
  assert.equal(
    detectBurnRate([{ at: now - 600_000, credits: 1000 }, { at: now, credits: 100 }], now, cfg),
    undefined,
    '两条采样都在窗口外/跨窗口时不得判为 5 分钟爆发',
  )
  // 恰好达到阈值必须命中（「达到」不该被写成「超过」）。
  const exact = detectBurnRate([{ at: now - 1000, credits: 100 }, { at: now, credits: 80 }], now, cfg)
  assert.ok(exact !== undefined)
  assert.equal(exact.pct, 20)
  assert.equal(exact.burned, 20)
  // 关闭时（windowMs = 0）永远不命中。
  assert.equal(
    detectBurnRate([{ at: now - 1000, credits: 100 }, { at: now, credits: 1 }], now, { windowMs: 0, thresholdPct: 20 }),
    undefined,
  )
})

test('⚠️ 已在硬冷却（余额耗尽）时，速率判定不得把 coolKind 降级成 soft', async () => {
  const { runtime } = freshRuntime('hard')
  const { env, db } = runtime
  try {
    configure(env, '300000', '20')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
    const uid = 'uid-burn-hard'
    const t0 = 1_700_000_000_000
    const st = createAccountState({ uid, nickname: uid, realm: REALM, provider: 'buddy' })
    st.samples = [{ at: t0, credits: 1000 }]
    st.until = t0 + 12 * 3600_000
    st.coolKind = 'hard'
    await pool.upsertAccount(st, t0)

    await pool.updateBalance(uid, t0 + 60_000, { credits: 100, expiring: 0, earliestExpiry: 0 })

    const acc = await readAccount(pool, uid, t0 + 60_000)
    assert.equal(acc.coolKind, 'hard', '「没钱」不得被改写成「被限流」')
    assert.equal(acc.until, st.until, '硬冷却的截止时刻不得被缩短')
  } finally {
    db.close()
  }
})

// ─────────────────────────── 向后兼容 ───────────────────────────

test('🔴 旧 state 没有 `samples` 字段时：不崩、补空、随后能正常追加', async () => {
  const { runtime } = freshRuntime('legacy')
  const { env, db } = runtime
  try {
    configure(env, '300000', '20')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
    const uid = 'uid-burn-legacy'
    const t0 = 1_700_000_000_000

    // 模拟升级前的落盘记录：整条 JSON 里**没有** samples 键。
    const legacy = createAccountState({ uid, nickname: uid, realm: REALM, provider: 'buddy' })
    delete (legacy as { samples?: unknown }).samples
    await pool.upsertAccount(legacy as never, t0)

    assert.equal(normalizeAccountState({ uid: 'u', samples: undefined })?.samples.length, 0)
    assert.equal(normalizeAccountState({ uid: 'u' })?.samples.length, 0)
    // 坏数据（非数组 / 元素缺字段 / NaN）必须被丢弃，而不是让判定拿到 NaN
    // —— NaN 会让 `pct < threshold` 恒为 false，熔断**永不触发**且毫无报错。
    assert.deepEqual(
      normalizeAccountState({ uid: 'u', samples: [null, 'x', { at: 1 }, { at: 2, credits: Number.NaN }, { at: 3, credits: 7 }] })?.samples,
      [{ at: 3, credits: 7 }],
    )

    await pool.updateBalance(uid, t0, { credits: 1000, expiring: 0, earliestExpiry: 0 })
    const acc = await readAccount(pool, uid, t0)
    assert.equal(acc.credits, 1000)
    assert.equal(acc.samples.length, 1, '旧记录必须在第一次刷新后正常开始采样')
    assert.deepEqual(acc.samples[0], { at: t0, credits: 1000 })
  } finally {
    db.close()
  }
})

test('⚠️ 熔断日志只含 uid 前 8 位与额度，不含完整 uid / 凭据', async () => {
  const { runtime } = freshRuntime('log')
  const { env, db } = runtime
  const original = console.warn
  const lines: string[] = []
  try {
    configure(env, '300000', '20')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
    const uid = 'uid-burn-log-abcdef123456'
    const t0 = 1_700_000_000_000
    await seed(pool, uid, t0)

    console.warn = ((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }) as typeof console.warn

    await pool.updateBalance(uid, t0, { credits: 1000, expiring: 0, earliestExpiry: 0 })
    await pool.updateBalance(uid, t0 + 300_000, { credits: 700, expiring: 0, earliestExpiry: 0 })

    const burn = lines.filter((l) => l.includes('[burn]'))
    assert.equal(burn.length, 1, `应打印恰好一条熔断日志，实际：${JSON.stringify(lines)}`)
    const line = burn[0]!
    assert.ok(line.includes(uid.slice(0, 8)), '日志必须含 uid 前 8 位')
    assert.ok(!line.includes(uid), '日志不得含完整 uid')
    assert.ok(line.includes('300'), `日志必须含消耗量，实际：${line}`)
    assert.ok(line.includes('30%'), `日志必须含占比，实际：${line}`)
    assert.ok(line.includes('300s'), `日志必须含窗口时长，实际：${line}`)
  } finally {
    console.warn = original
    db.close()
  }
})
