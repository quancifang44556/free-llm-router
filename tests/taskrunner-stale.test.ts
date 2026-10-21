/**
 * 任务运行「被重启打断」必须能自愈（2026-10-21 审查补，M6 指出高危）。
 *
 * ## 缺陷链（三步一起才致命）
 * 1. `storage.ts` 在**执行前**就删除 `system_alarms` 记录；
 * 2. 进程在执行中**被重启/被杀**（不是抛异常，走不到兜底重排）⇒ 重启扫不到记录；
 * 3. `start()` 看到「未完成且有队列」就**直接 return**，且**不重排 alarm**。
 *
 * ⇒ 该账号任务**永久停在「进行中」**：面板一直转圈、点「手动执行」返回 ok:true
 *   却什么都不做，只能手改 SQLite 才能恢复。
 *
 * 本测试直接驱动 DO：同一 uid 连续两次 `start`，第二次把 `now` 推到 31 分钟后，
 * 断言 ①队列被重开（不是原样返回）②原因被带进新一轮（面板能看到为什么重来）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'

test('🔴 陈旧运行（重启打断）必须判超时并重开，而不是永久卡在「进行中」', async () => {
  const tmp = path.join(os.tmpdir(), `taskrunner-stale-${Date.now()}.db`)
  const rt = createNodeRuntime(tmp)
  try {
    const stub = rt.env.TASK_RUNNER.get(rt.env.TASK_RUNNER.idFromName('stale-uid'))
    const steps = [
      { code: 'signin', action: 'signin', params: {} },
      { code: 'checkin', action: 'checkin', params: {} },
    ] as never
    const ctx = { uid: 'stale-uid' } as never
    const t0 = Date.now()

    const first = await stub.start('stale-uid', steps, ctx, t0)
    assert.equal(first.queue.length, 2)

    // 31 分钟后：模拟「上次运行被重启打断、之后再没人动过」
    const t1 = t0 + 31 * 60_000
    const second = await stub.start('stale-uid', steps, ctx, t1)

    assert.equal(
      second.queue.length,
      2,
      '⚠️ 陈旧运行必须被重开（队列恢复）—— 否则任务永久卡在「进行中」',
    )
    assert.ok(
      second.lastError.includes('超时') || second.lastError.includes('无进展'),
      `新一轮必须带上「为什么重来」的说明（实际 lastError="${second.lastError}"）`,
    )
  } finally {
    rt.db.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
