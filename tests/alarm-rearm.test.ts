/**
 * 丢失 alarm 记录后，`start()` 必须把它补回来（2026-10-21 审查补，并发专项）。
 *
 * ## 缺陷
 * alarm 触发时适配层会**先删掉** `system_alarms` 那行。若进程恰在那一步执行中
 * 被重启/OOM 杀掉，这行永远回不来；而 `start()` 的幂等早退分支**只看 age**
 * ⇒ 返回 `ok:true`、什么都不做、也不排 alarm ⇒ 任务**永久静默卡死**
 *（只能手改 SQLite，或等 30 分钟后**再有一次** `start()`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'

test('🔴 start() 必须保证「有活着的 alarm」，哪怕复用了已有运行', async () => {
  const tmp = path.join(os.tmpdir(), `alarm-rearm-${Date.now()}.db`)
  const rt = createNodeRuntime(tmp)
  const originalLog = console.log
  console.log = () => {}
  try {
    const uid = 'rearm-user'
    const runner = rt.env.TASK_RUNNER.get(rt.env.TASK_RUNNER.idFromName(uid))
    const steps = [{ code: 'a', action: 'checkin', delayMs: 0 }] as never

    /** 直接读 `system_alarms` 表：这是 alarm 是否「活着」的唯一权威。 */
    const alarmRows = () =>
      (rt.db.prepare(`SELECT id FROM system_alarms WHERE id = ?`).all(`task_runner:${uid}`) as unknown[]).length

    await runner.start(uid, steps as never, { uid, nickname: 'n', realm: 'cn', accessToken: 'x' } as never, Date.now(), 'daily')
    assert.equal(alarmRows(), 1, '首次 start 应排上 alarm')

    // 模拟「alarm 已触发（行被删）+ 进程被杀」
    // ⚠️ 直接删表：这正是适配层 `triggerAlarm()` 的第一件事，也是「进程被杀后」的残留状态
    rt.db.prepare(`DELETE FROM system_alarms WHERE id = ?`).run(`task_runner:${uid}`)
    assert.equal(alarmRows(), 0, '删除后应没有 alarm')

    // 用户在 30 分钟内再次点「手动执行」
    await runner.start(uid, steps as never, { uid, nickname: 'n', realm: 'cn', accessToken: 'x' } as never, Date.now(), 'daily')

    const alarm = alarmRows() > 0 ? Date.now() : null
    assert.notEqual(
      alarm,
      null,
      '⚠️ 复用了已有运行却没补 alarm —— 任务会永久静默卡死（面板一直转圈、手动执行返回 ok 但什么都不做）',
    )
  } finally {
    console.log = originalLog
    try {
      await rt.env.TASK_RUNNER.get(rt.env.TASK_RUNNER.idFromName('rearm-user')).cancel('rearm-user')
    } catch {}
    await new Promise((r) => setTimeout(r, 60))
    rt.db.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
