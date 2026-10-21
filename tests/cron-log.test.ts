/**
 * 后台任务（续期 / 余额刷新）的失败必须进**面板日志**（2026-10-21 审查补，M6）。
 *
 * ## 缺陷
 * 这两处的失败原来只有 `console.error` / `console.warn` ——
 * 面板「日志」页**一条都看不到**。用户体验是：某账号登录态悄悄失效、
 * 余额悄悄不更新，而面板上一片正常，只能靠 `docker logs` 才发现。
 *
 * 本测试让余额刷新必然失败（账号凭据是假的），断言面板日志里出现该失败。
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import worker from '../src/index.js'

function utc8NineAm(): number {
  const utc8 = new Date(Date.now() + 8 * 3600_000)
  return Date.UTC(utc8.getUTCFullYear(), utc8.getUTCMonth(), utc8.getUTCDate(), 1, 0, 0)
}

test('🔴 余额刷新失败必须出现在面板日志里（而不是只进 console）', async () => {
  const tmp = path.join(os.tmpdir(), `cron-log-${Date.now()}.db`)
  const rt = createNodeRuntime(tmp)
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const st = createAccountState({ uid: 'logacc', nickname: 'logacc', realm: 'cn', provider: 'buddy' })
    // 凭据故意无效 + 到期时间在「续期窗口」内 ⇒ 续期与余额刷新都会失败
    st.credits = 10
    await pool.upsertAccount(st, Date.now())
    await pool.putCredential(
      'logacc',
      { uid: 'logacc', accessToken: 'bogus', refreshToken: 'bogus', expiresAt: Date.now() + 60_000 } as never,
      Date.now(),
    )

    const at = utc8NineAm()
    mock.timers.enable({ apis: ['Date'], now: at })
    try {
      await worker.scheduled(
        { cron: '0 * * * *', scheduledTime: at } as never,
        rt.env,
        { waitUntil: () => {}, passThroughOnException: () => {} } as never,
      )
    } finally {
      mock.timers.reset()
    }

    // 日志写入是 fire-and-forget ⇒ 给它一点时间
    await new Promise((r) => setTimeout(r, 150))
    const logs = await pool.readLogs(100)
    const mine = logs.filter((l) => typeof l.error === 'string' && String(l.uid) === 'logacc')
    assert.ok(
      mine.length > 0,
      '⚠️ 后台任务失败必须写进面板日志 —— 否则用户只能去 docker logs 里找',
    )
    assert.ok(
      mine.some((l) => String(l.model).startsWith('cron:')),
      `日志条目应带 cron: 前缀的动作名（实际：${JSON.stringify(mine.map((l) => l.model))}）`,
    )
  } finally {
    // ⚠️ 必须先把排着的 alarm 取消并等它落地，再关库 ——
    // 否则 alarm 会在 `db.close()` 之后触发，抛出
    // 「database is not open」并让整轮测试以 unhandledRejection 失败。
    const runner = rt.env.TASK_RUNNER.get(rt.env.TASK_RUNNER.idFromName('logacc'))
    await runner.cancel('logacc').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 80))
    console.log = originalLog
    console.warn = originalWarn
    rt.db.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
