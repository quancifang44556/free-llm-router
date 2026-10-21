/**
 * 导入「一条都没成功」不得回 200（2026-10-21 审查补，M5 指出）。
 *
 * ## 缺陷
 * 原来无论成不成，都回 `200 + {ok:false, imported:[], skipped:[...]}`。
 * 而面板的 `useAction` **只认 HTTP 状态**（`api()` 在 `!res.ok` 时才抛错）
 * ⇒ **一条都没导入也照弹「账号已导入」**，而 `skipped[].reason` 全库无人读。
 *
 * 用户以为导入成功、列表里却没有新账号，只能怀疑「是不是要刷新一下」。
 *
 * 本测试断言：全都不可用时 → **非 2xx**，且错误里带上跳过原因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startServer } from '../src/server/index.js'

test('🔴 导入全失败必须回非 2xx（否则面板照弹「账号已导入」）', async () => {
  const tmp = path.join(os.tmpdir(), `import-resp-${Date.now()}.db`)
  const originalApiKey = process.env.API_KEY
  process.env.API_KEY = 'import-resp-key'
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
    const res = await fetch(`${base}/admin/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer import-resp-key', 'content-type': 'application/json' },
      // 能解析成 1 条 entry，但内容缺关键字段 ⇒ 全部被跳过
      body: JSON.stringify({ accounts: [{ nothing: 'useful' }] }),
    })
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string }
      imported?: unknown[]
    }
    assert.ok(
      res.status >= 400,
      `⚠️ 一条都没导入却回了 ${res.status} —— 面板会照弹「账号已导入」`,
    )
    assert.equal((body.imported ?? []).length, 0)
    assert.ok(
      typeof body.error?.message === 'string' && body.error.message.includes('没有导入'),
      `错误里必须说明「一条都没导入」并带上原因（实际：${JSON.stringify(body.error)}）`,
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
