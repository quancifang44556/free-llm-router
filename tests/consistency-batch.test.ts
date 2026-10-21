/**
 * 判据收敛（2026-10-21 审查补，重复实现 + 安全面专项）。
 *
 * ① `modelExempt()` 手抄了 `healthy()` 的判据且**漏了 `restrictedUntil`** ——
 *    被封号 + 有模型限流的账号会被算进「模型限流」桶，
 *    池摘要说「换模型就行」，诊断说「上游标记受限，还剩 1 小时 58 分」。
 * ② 子密钥模型白名单对非字符串 `model` 是 **fail-open**（整条跳过校验）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAccountState } from '../src/pool/state.js'
import { modelExempt, healthy } from '../src/pool/state.js'
import { startServer } from '../src/server/index.js'

const KEY = 'consistency-batch-key'

test('🔴 被封号（restrictedUntil）的账号不得被当成「只是模型限流」', () => {
  const now = Date.now()
  const account = createAccountState('u1', 'cn')
  account.restrictedUntil = now + 2 * 3600_000 // 上游明确封号 2 小时
  account.modelCooldowns['m1'] = { until: now + 600_000, auditOnly: false } as never

  assert.equal(healthy(account, now), false, '封号账号必须判为不健康')
  assert.equal(
    modelExempt(account, now),
    false,
    '⚠️ 封号账号被判成「仅模型限流」—— 用户会按「换模型」去处理，实际要等 2 小时或点解冻',
  )
})

test('🔴 只有模型限流的账号仍应被判为 modelExempt（这是它的正常用途）', () => {
  const now = Date.now()
  const account = createAccountState('u2', 'cn')
  account.modelCooldowns['m1'] = { until: now + 600_000, auditOnly: false } as never
  assert.equal(healthy(account, now), true)
  assert.equal(modelExempt(account, now), true)
})

test('🔴 子密钥模型白名单对非字符串 model 必须 fail-closed（不能整条跳过）', async () => {
  const tmp = path.join(os.tmpdir(), `consistency-${Date.now()}.db`)
  const saved = process.env.API_KEY
  process.env.API_KEY = KEY
  const originalLog = console.log
  console.log = () => {}
  const { server, runtime } = startServer({ port: 0, host: '127.0.0.1', databasePath: tmp, autoCron: false })
  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const addr = server.address() as { port: number }
  const base = `http://127.0.0.1:${addr.port}`
  try {
    const created = await fetch(`${base}/admin/apikeys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'restricted', limits: { models: ['only-this-model'] } }),
    })
    const createdBody = (await created.json()) as { key?: string }
    assert.ok(createdBody.key, '应能创建子密钥')

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${createdBody.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 123, messages: [] }),
    })
    assert.equal(
      res.status,
      400,
      `⚠️ 非字符串 model 绕过了白名单校验（期望 400，实际 ${res.status}）`,
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runtime.db.close()
    console.log = originalLog
    if (saved === undefined) delete process.env.API_KEY
    else process.env.API_KEY = saved
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
