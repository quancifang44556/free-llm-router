/**
 * 子密钥**模型白名单**（2026-10-21 审查补，M6 指出高危）。
 *
 * ## 缺陷
 * 子密钥支持三维限制（IP / 模型 / token），但 `authenticate()` 只在鉴权那一刻
 * 调用一次 —— 那一刻**模型名还未知**（在请求体里）⇒ 传入 `model = ''`
 * ⇒ 模型检查**恒被跳过**。源码里那句「真正的模型校验见下方 chat 分支」
 * 指向的代码**从来不存在**。
 *
 * ⇒ 给子密钥配「只允许 X 模型」，实际**任何模型都能用**。这是**安全项**。
 *
 * 本测试走真实 HTTP（起一个 Node server），验证：
 * - 不在白名单的模型 → **403**
 * - 在白名单的模型 → **不是 403**（会继续进路由，可能因无账号而 503）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startServer } from '../src/server/index.js'

test('🔴 子密钥模型白名单必须真的生效', async () => {
  const tmp = path.join(os.tmpdir(), `subkey-model-${Date.now()}.db`)
  const originalApiKey = process.env.API_KEY
  process.env.API_KEY = 'subkey-model-key'
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
    const auth = { authorization: 'Bearer subkey-model-key', 'content-type': 'application/json' }
    const mk = async (models: string[]): Promise<string> => {
      const r = (await (await fetch(`${base}/admin/apikeys`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'm', limits: { models } }),
      })).json()) as { key?: string }
      assert.ok(typeof r.key === 'string' && r.key !== '')
      return r.key
    }
    const key = await mk(['only-this-model'])

    const ask = async (model: string): Promise<number> => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      })
      await res.text().catch(() => '')
      return res.status
    }

    assert.equal(
      await ask('some-other-model'),
      403,
      '⚠️ 不在白名单的模型必须 403 —— 否则子密钥的模型限制等于不存在',
    )
    assert.notEqual(
      await ask('only-this-model'),
      403,
      '在白名单内的模型不得被 403 拦住',
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
