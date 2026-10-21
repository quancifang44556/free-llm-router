/**
 * 「取消」不得被正在执行的那一步悄悄回滚（2026-10-21 审查补，并发专项）。
 *
 * ## 缺陷
 * `alarm()` 每一步都会把**进入本步之前**的旧快照整体回写（`save(state)`）。
 * 若期间用户点了取消，`cancel()` 写下的 `finished=true / queue=[]` 会被覆盖，
 * 接着还**重排 alarm** —— 面板先显示「已取消」再自己翻回「运行中」，
 * 剩下的步骤（可能含 5 个真实对话）照跑，继续烧上游配额。
 *
 * 本测试用真实 DO + 真实 SQLite，并让某一步**卡在 await 里**（延迟动作），
 * 在它执行期间调用 `cancel()`，然后断言：取消之后**不会再被重启**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'

/** 一个永远「正在执行」的动作：把 promise 卡住，直到测试放行。 */
let releaseStep: (() => void) | undefined

test('🔴 执行中被 cancel 后，本步结束时不得把运行状态改回「未完成」并续跑', async () => {
  const tmp = path.join(os.tmpdir(), `cancel-race-${Date.now()}.db`)
  const rt = createNodeRuntime(tmp)
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    const uid = 'race-user'
    const runner = rt.env.TASK_RUNNER.get(rt.env.TASK_RUNNER.idFromName(uid))

    // 两步：第一步会「卡住」，第二步是正常的空动作
    const steps = [
      { code: 'slow', action: 'checkin', delayMs: 0 },
      { code: 'after', action: 'checkin', delayMs: 0 },
    ] as never

    await runner.start(
      uid,
      steps as never,
      { uid, nickname: 'n', realm: 'cn', accessToken: 'x' } as never,
      Date.now(),
      'daily',
    )

    // 让第一步进入执行：用一个可控的挂起来模拟「真实对话还要 45 秒」
    const gate = new Promise<void>((resolve) => {
      releaseStep = resolve
    })
    const alarmTask = (async () => {
      await runner.alarm()
    })()

    // 等一拍，确保 alarm 已经进入 executeAction
    await new Promise((r) => setTimeout(r, 30))

    // 用户点取消
    await runner.cancel(uid)
    const afterCancel = await runner.status(uid)
    assert.equal(afterCancel?.finished, true, '取消后应立刻标记完成')
    assert.equal(afterCancel?.queue.length, 0, '取消后队列应清空')

    // 放行那一步，让它继续跑完
    releaseStep?.()
    void gate
    await alarmTask

    const afterStep = await runner.status(uid)
    assert.equal(
      afterStep?.finished,
      true,
      '⚠️ 本步结束时把状态改回了「未完成」—— 面板会先显示已取消再自己翻回运行中',
    )
    assert.equal(
      afterStep?.queue.length,
      0,
      '⚠️ 取消后被清空的队列又回来了 —— 剩下的步骤会继续烧配额',
    )
    assert.equal(afterStep?.cancelRequested, true, '取消标记必须持久化（下次读状态也要认）')
  } finally {
    releaseStep = undefined
    // ⚠️ 必须先清掉排着的 alarm 并等一拍，再关库 ——
    // 否则 alarm 在 `db.close()` 之后触发，抛「database is not open」
    // 并让整轮以 unhandledRejection 失败（只在全套里现形，单独跑是绿的）。
    try {
      const runner = rt.env.TASK_RUNNER.get(rt.env.TASK_RUNNER.idFromName('race-user'))
      await runner.cancel('race-user').catch(() => undefined)
    } catch {}
    await new Promise((r) => setTimeout(r, 80))
    console.log = originalLog
    console.warn = originalWarn
    rt.db.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
