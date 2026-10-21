/**
 * cron 扇出的**按日去重**与**计划名写入**（2026-10-21 审查补，M6 指出）。
 *
 * ## 缺陷（两条，同源）
 * 1. `RunState.plan` **从未被写入** ⇒ 任务日志里每行计划名恒为 `daily`，
 *    用户分不清「这次跑的是签到还是含 5 个真实对话的 growth」。
 * 2. 国际版扇出会跳过「今天已成功」的账号，**国内这条循环没有**
 *    ⇒ cron 在同一小时窗口被触发两次（进程在整点后 2 分钟内重启，
 *    `lastDispatchedHour` 是进程内变量、重启即归零）时，
 *    `growth`（含 5 个真实对话）会**再烧一遍配额**。
 *
 * 本测试走真实 `scheduled()`：第一次入队 → 手动置为已完成 → 再触发一次，
 * 断言**没有**开新一轮（`startedAt` 不变）。
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import worker from '../src/index.js'

/** 取「今天 UTC+8 09:00」的时间戳（签到时点）。 */
function utc8NineAm(): number {
  const now = Date.now()
  const utc8 = new Date(now + 8 * 3600_000)
  const y = utc8.getUTCFullYear()
  const m = utc8.getUTCMonth()
  const d = utc8.getUTCDate()
  // 09:00 UTC+8 == 01:00 UTC
  return Date.UTC(y, m, d, 1, 0, 0)
}

test('🔴 cron 不得对「今天已跑完同一计划」的账号重复入队', async () => {
  const tmp = path.join(os.tmpdir(), `cron-dedup-${Date.now()}.db`)
  const rt = createNodeRuntime(tmp)
  const originalLog = console.log
  console.log = () => {}
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const st = createAccountState({ uid: 'cron1', nickname: 'cron1', realm: 'cn', provider: 'buddy' })
    st.credits = 10
    await pool.upsertAccount(st, Date.now())

    const at = utc8NineAm()
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never

    // ⚠️ `scheduled()` 用的是 `Date.now()`（不是 `event.scheduledTime`），
    // 所以必须**钉住时钟**才能落到 09:00 这个任务时点。
    mock.timers.enable({ apis: ['Date'], now: at })
    try {
      await worker.scheduled({ cron: '0 * * * *', scheduledTime: at } as never, rt.env, ctx)
    } finally {
      mock.timers.reset()
    }

    const runner = rt.env.TASK_RUNNER.get(rt.env.TASK_RUNNER.idFromName('cron1'))
    const first = await runner.status('cron1')
    assert.ok(first !== undefined, '应已入队')
    assert.equal(first.plan, 'daily', '⚠️ 计划名必须写进 RunState（否则日志恒为 daily）')
    const firstStarted = first.startedAt

    // 模拟「这一轮已经跑完」
    await runner.cancel('cron1')

    // 同一小时内再触发一次（重启场景）
    mock.timers.enable({ apis: ['Date'], now: at + 120_000 })
    try {
      await worker.scheduled({ cron: '0 * * * *', scheduledTime: at + 120_000 } as never, rt.env, ctx)
    } finally {
      mock.timers.reset()
    }
    const second = await runner.status('cron1')
    assert.ok(second !== undefined)
    assert.equal(
      second.startedAt,
      firstStarted,
      '⚠️ 今天已跑完同一计划的账号不得被重复入队 —— 否则 growth 会再烧一遍配额',
    )
  } finally {
    console.log = originalLog
    rt.db.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
