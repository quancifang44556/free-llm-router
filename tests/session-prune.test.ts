/**
 * 过期会话必须被清理（2026-10-21 审查补，M6 指出）。
 *
 * ## 缺陷
 * `pruneSessions` / `pruneLoginSessions` 两个函数都实现好了，
 * 却**没有任何调用者** ⇒ `sessions` / `login_sessions` **只增不减**：
 * 每次登录插一行、过期也不删，长期运行后查询变慢、库文件膨胀。
 *
 * 本测试插入一条**已过期**的会话，跑一次 cron，断言它被删掉。
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import worker from '../src/index.js'

test('🔴 过期会话必须被 cron 清掉（否则表只增不减）', async () => {
  const tmp = path.join(os.tmpdir(), `session-prune-${Date.now()}.db`)
  const rt = createNodeRuntime(tmp)
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    // 一个已过期很久的会话
    await pool.bindSession('stale-key', 1, Date.now() - 10 * 24 * 3600_000)

    const at = Date.now()
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

    // ⚠️ 断言方向：**cron 已经清过了**，所以这里再清应当是 **0 条**。
    //（第一版把断言写成 `=== 1`，逻辑正好反了 —— 0 才是「已清干净」。）
    const leftover = await pool.pruneStaleSessions(at)
    assert.equal(
      leftover,
      0,
      '⚠️ cron 跑完后不应再有可清理的过期会话 —— 非 0 说明 cron 没清',
    )
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    rt.db.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
