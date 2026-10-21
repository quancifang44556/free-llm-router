/**
 * 失败请求必须进用量表（2026-10-21 审查补，M6 指出高危）。
 *
 * ## 缺陷
 * 全库 `recordUsage` 的 4 个调用点**全部**写 `ok: true`，**没有任何**
 * `ok: false` 的生产者 ⇒ 用量表里「失败」恒 0 ⇒ **面板成功率恒 100%**。
 * 用户据此判断「网关很稳」，而整池失败全被静默吞掉。
 *
 * 本测试起真实 server、让池里**没有任何账号**，打一次 chat ⇒ 必然全池失败
 * ⇒ 断言用量里出现 `ok: false` 且带 `errorKind`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startServer } from '../src/server/index.js'

test('🔴 全池失败必须记一条 ok:false 的用量（否则面板成功率恒 100%）', async () => {
  const tmp = path.join(os.tmpdir(), `usage-fail-${Date.now()}.db`)
  const originalApiKey = process.env.API_KEY
  process.env.API_KEY = 'usage-fail-key'
  const originalLog = console.log
  console.log = () => {}
  const { server, runtime } = startServer({ port: 0, host: '127.0.0.1', databasePath: tmp, autoCron: false })
  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const base = `http://127.0.0.1:${addr.port}`
  try {
    const auth = { authorization: 'Bearer usage-fail-key', 'content-type': 'application/json' }
    // 池里没有任何账号 ⇒ 必然失败
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text().catch(() => '')
    assert.ok(res.status >= 400, `应失败（实际 ${res.status}）`)

    // 记账是异步的（waitUntil / 后台 promise）⇒ 给它一点时间落库
    await new Promise((r) => setTimeout(r, 120))

    const pool = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('cn'))
    const summary = await pool.usageSummary(0)
    assert.ok(
      summary.failed > 0,
      `⚠️ 全池失败必须在用量里留下 ok:false 记录 —— 否则面板成功率永远是 100%`
        + `（实际 failed=${summary.failed}, total=${summary.total}）`,
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runtime.db.close()
    console.log = originalLog
    if (originalApiKey === undefined) delete process.env.API_KEY
    else process.env.API_KEY = originalApiKey
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
