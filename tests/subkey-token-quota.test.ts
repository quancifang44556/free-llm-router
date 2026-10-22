/**
 * 子密钥 token 配额必须真的记账（2026-10-21 审查补，安全面专项）。
 *
 * ## 缺陷
 * `authenticate()` 在鉴权那一刻用 `input=0/output=0` 记一次请求（那时还不知道用量），
 * 而唯一能把真实 token 补上去的 `settleUsage()` **零调用者**。
 * ⇒ `maxTokens` 永远判不到：实测 `maxTokens=5` 时连发 3 次全部放行，
 * 面板「已用 0 / 100000」永远不动，管理员零告警。
 *
 * 把子密钥发给第三方时，配额条看起来受控，实际只受 `maxRequests` 约束。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'
import { registerSubkeyUsage, settleSubkeyUsage } from '../src/gateway/authz.js'

test('🔴 用量已知时必须把真实 token 补进子密钥配额', async () => {
  const tmp = path.join(os.tmpdir(), `subkey-${Date.now()}.db`)
  const rt = createNodeRuntime(tmp)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    // 直接走 DO 的底层方法（管理端点会做 hash/加密，这里只关心记账链路）
    const record = await pool.addApiKey({ name: 'quota-test', hash: 'h'.repeat(64), prefix: 'sk-quotate' })
    assert.ok(record.id, '应拿到记录 id')

    const ctx = { fake: 'ctx' }
    registerSubkeyUsage(ctx, { id: record.id } as never, '1.2.3.4')

    // 模拟网关在「用量已知」时调用两次
    settleSubkeyUsage(ctx, rt.env, 100, 50, 'buddy/test')
    settleSubkeyUsage(ctx, rt.env, 30, 20, 'buddy/test')
    // 记账是 fire-and-forget（void），等事件循环把它跑完
    await new Promise((r) => setTimeout(r, 120))

    const usage = (await pool.getApiKeyUsage(record.id)) as {
      inputTokens?: number
      outputTokens?: number
    }
    assert.ok(
      (usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0,
      `⚠️ 真实用量没有记进子密钥配额（inputTokens=${usage.inputTokens ?? 0}, outputTokens=${usage.outputTokens ?? 0}）—— maxTokens 永远不会触发`,
    )
  } finally {
    rt.db.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})

test('🔴 网关必须在每一个「用量已知」的点调用 settleSubkeyUsage', () => {
  const src = fs.readFileSync('src/gateway/server.ts', 'utf8')
  const calls = src.match(/settleSubkeyUsage\(/g)?.length ?? 0
  // 4 个用量点（buddy 流式/非流式 + provider 流式/非流式）；少了任何一个都会漏记
  assert.ok(
    calls >= 4,
    `只找到 ${calls} 处 settleSubkeyUsage 调用（应有 4 处，对应 4 个用量记录点）`,
  )
})
