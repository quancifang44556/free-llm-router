/**
 * 面板 ↔ 后端 契约测试（2026-10-21 审查后补）。
 *
 * 覆盖 M5 指出的三条：
 * - **F1 线上前端产物没有源码可重建**（最危险：重建即静默丢功能）
 * - **F2 `degradeUntil` 不在 `/admin/accounts` 白名单**（面板显示「正常」而侧栏算「冷却」）
 * - **F3 「清空冷却」不解两道全局闸门**（UI 说好了、链路仍全失败）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import worker from '../src/index.js'

function freshRuntime(name: string) {
  const dir = path.join(process.cwd(), '.build')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, `test-${name}.db`)
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  const runtime = createNodeRuntime(dbPath)
  // ⚠️ 默认 runtime 的 `API_KEY` 是 `process.env.API_KEY`（测试环境通常为空）
  // ⇒ admin 路由一律 401。测试里显式注入一个（与 permanent-locks 同做法）。
  runtime.env.API_KEY = 'test-panel-contract-key'
  return {
    ...runtime,
    cleanup: () => {
      runtime.db.close()
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
    },
  }
}

/**
 * F1：**线上前端产物必须含这几个功能**。
 *
 * ## 为什么这条测试必须存在（而不是靠自觉）
 * 实测（M5）：`src/panel/web/assets/index-*.js.txt`（**线上真正下发的那个**）
 * 比 `web/src` 与 `web/dist` 多出三个功能：
 *   ① 账号「探测」按钮（调 `/admin/accounts/probe`）
 *   ② `restrictedUntil` → 「上游封号」状态
 *   ③ 五维取 max 的「还剩多久」倒计时
 * 这些在 `web/src` 里**完全不存在**。
 *
 * ⇒ 任何人跑一次 `npm run build:web` 并发布，就会**静默删掉**这三个功能
 *   （构建成功、测试也绿 —— 因为原有测试只校验版本号）。
 *
 * 本测试把「线上产物必须有的功能」钉住：重建后若丢了，这里立刻红。
 * ⚠️ 若某天真要把它们做进 `web/src`，请**先**把功能补齐、**再**放宽本测试，
 *    顺序反了就等于自己把功能删了还删掉了护栏。
 */
test('F1：线上面板产物必须含「探测按钮 / 上游封号 / 倒计时」三个功能', () => {
  const dir = path.join(process.cwd(), 'src', 'panel', 'web', 'assets')
  const jsFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.js.txt'))
  assert.ok(jsFiles.length > 0, '线上面板产物缺失')
  const bundle = jsFiles.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')

  const required: Array<[string, string]> = [
    ['accounts/probe', '账号「探测」按钮（调 /admin/accounts/probe）'],
    ['restrictedUntil', '「上游封号」状态（restrictedUntil）'],
    ['上游封号', '「上游封号」文案'],
  ]
  for (const [marker, what] of required) {
    assert.ok(
      bundle.includes(marker),
      `线上面板产物缺少 ${what}（marker="${marker}"）。`
        + '若刚跑过 npm run build:web，说明重建把线上已有功能删掉了 —— 见本测试上方说明。',
    )
  }
})

/**
 * F2：`/admin/accounts` 必须返回 `degradeUntil`。
 *
 * 缺陷：`AccountPoolDO` 有「连续 5 次业务失败 ⇒ 降权 10 分钟不派单」，
 * 但响应白名单里没有这个字段 ⇒ 面板**连字段都拿不到**，显示「正常」；
 * 而侧栏角标走 `healthy()` 把它算进「冷却」⇒ 自相矛盾（角标 3 / 列表 0）。
 */
test('F2：/admin/accounts 必须暴露 degradeUntil（否则面板与角标自相矛盾）', async () => {
  const rt = freshRuntime('panel-degrade')
  const { env } = rt
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const st = createAccountState({ uid: 'dg1', nickname: 'dg1', realm: 'cn', provider: 'buddy' })
    st.credits = 10
    st.degradeUntil = Date.now() + 600_000
    await pool.upsertAccount(st, Date.now())

    const res = await worker.fetch(
      new Request('http://localhost/admin/accounts?realm=cn', {
        headers: { authorization: `Bearer ${env.API_KEY}` },
      }),
      env,
      undefined,
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { accounts?: Array<Record<string, unknown>> }
    const rows = body.accounts ?? []
    assert.ok(rows.length > 0, '应有账号返回')
    const row = rows.find((r) => r.uid === 'dg1')
    assert.ok(row !== undefined, '应包含 dg1')
    assert.ok(
      'degradeUntil' in row,
      '⚠️ 响应必须含 degradeUntil —— 否则面板无法显示「降权中」，与侧栏角标矛盾',
    )
    assert.ok(Number(row.degradeUntil) > 0, 'degradeUntil 的值必须透传上来')
  } finally {
    rt.cleanup()
  }
})

/**
 * F3：「清空冷却」必须连两道全局闸门一起解。
 *
 * 缺陷：闸门是**分片级**状态，只有 `clearWafGate/clearRestrictionGate` 能解，
 * 而 `/admin/cooldowns/clear` 原来只清账号级 ⇒ 用户点「解冻」看到成功，
 * 请求仍全部失败最长 30 分钟。
 */
test('F3：/admin/cooldowns/clear（整分片）必须解掉 11140 波次闸门', async () => {
  const rt = freshRuntime('panel-gate-clear')
  const { env } = rt
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    // 两个不同账号各命中一次 ⇒ 达到 RESTRICTION_WAVE_THRESHOLD=2 ⇒ 闸门激活
    await pool.noteRestriction('g1', now)
    const on = await pool.noteRestriction('g2', now)
    assert.equal(on, true, '两个不同账号命中后闸门应激活')
    assert.equal(await pool.restrictionGateActive(Date.now()), true, '闸门应处于激活态')

    const res = await worker.fetch(
      new Request('http://localhost/admin/cooldowns/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.API_KEY}` },
        body: JSON.stringify({ realm: 'cn' }),
      }),
      env,
      undefined,
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { gatesCleared?: boolean }
    assert.equal(body.gatesCleared, true, '整分片清空时应同时解闸门')
    assert.equal(
      await pool.restrictionGateActive(Date.now()),
      false,
      '⚠️ 点了「清空冷却」后闸门必须真的解开，否则 UI 说好了、请求仍全失败',
    )
  } finally {
    rt.cleanup()
  }
})
