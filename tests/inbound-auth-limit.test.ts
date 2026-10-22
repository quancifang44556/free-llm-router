/**
 * 鉴权失败必须限速（2026-10-21 审查补，安全面专项）。
 *
 * ## 缺陷
 * 全仓**没有入站限流**（`gateway/throttle.ts` 是出站打上游的节奏层）。
 * 实测 200 个乱猜的 Bearer 并发打完只要 **179 ms**（≈1100 rps），
 * 全部 401、**无 429、无延时、无锁定**，每个请求还要一次 SHA-256 + 一次 DO 查询。
 *
 * 两条利用路径：① 在线爆破弱主密钥（`API_KEY` 默认无强度校验，只 `trim()`）；
 * ② 无凭据即可打满 CPU + 数据库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AUTH_LIMIT_CONSTANTS, authBlocked, noteAuthFailure, noteAuthSuccess, resetAuthLimiter } from '../src/gateway/inbound-limit.js'
import { startServer } from '../src/server/index.js'

const KEY = 'inbound-limit-key'

test('🔴 同一 IP 连续失败到阈值后必须被挡（并且给 Retry-After）', () => {
  resetAuthLimiter()
  const ip = '203.0.113.9'
  const now = 1_000_000
  for (let i = 0; i < AUTH_LIMIT_CONSTANTS.MAX_FAILURES; i += 1) {
    assert.equal(authBlocked(ip, now).limited, false, `第 ${i + 1} 次失败前不该已被锁`)
    noteAuthFailure(ip, now)
  }
  const decision = authBlocked(ip, now)
  assert.equal(decision.limited, true, '达到阈值后必须拒绝')
  assert.ok(decision.retryAfterMs > 0, '必须给出 Retry-After')
})

test('🔴 窗口滑过之后必须自动恢复（不能永久锁死）', () => {
  resetAuthLimiter()
  const ip = '203.0.113.10'
  const now = 2_000_000
  for (let i = 0; i < AUTH_LIMIT_CONSTANTS.MAX_FAILURES; i += 1) noteAuthFailure(ip, now)
  assert.equal(authBlocked(ip, now).limited, true)
  assert.equal(
    authBlocked(ip, now + AUTH_LIMIT_CONSTANTS.WINDOW_MS + 1).limited,
    false,
    '窗口过后必须自动恢复 —— 否则一次攻击就把这个 IP 永久锁死',
  )
})

test('🔴 鉴权成功必须清零（防爆破不能变成拒绝服务）', () => {
  resetAuthLimiter()
  const ip = '203.0.113.11'
  for (let i = 0; i < AUTH_LIMIT_CONSTANTS.MAX_FAILURES; i += 1) noteAuthFailure(ip)
  assert.equal(authBlocked(ip).limited, true)
  noteAuthSuccess(ip)
  assert.equal(
    authBlocked(ip).limited,
    false,
    '⚠️ 同事在共享出口 IP 上拿着正确 key 也被锁住 —— 防爆破变成了拒绝服务',
  )
})

test('🔴 线上行为：乱猜 Bearer 到阈值后必须回 429', async () => {
  const tmp = path.join(os.tmpdir(), `inbound-${Date.now()}.db`)
  const saved = process.env.API_KEY
  process.env.API_KEY = KEY
  resetAuthLimiter()
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
    let saw429 = false
    let lastStatus = 0
    for (let i = 0; i < AUTH_LIMIT_CONSTANTS.MAX_FAILURES + 5; i += 1) {
      const res = await fetch(`${base}/admin/accounts`, {
        headers: { authorization: `Bearer wrong-${i}` },
      })
      lastStatus = res.status
      if (res.status === 429) {
        saw429 = true
        assert.ok(res.headers.get('retry-after'), '429 必须带 Retry-After')
        break
      }
    }
    assert.ok(saw429, `⚠️ 连打 ${AUTH_LIMIT_CONSTANTS.MAX_FAILURES + 5} 次错 key 仍未被限速（最后一次 ${lastStatus}）—— 可以无限爆破`)

    // 正确密钥也必须等窗口过去（同一个 IP 已被锁），这是有意的：
    // 说明限速真的生效，而不是「只拦错的那几个」。
    const good = await fetch(`${base}/admin/accounts`, { headers: { authorization: `Bearer ${KEY}` } })
    assert.equal(good.status, 429, '被锁期间正确密钥同样应被挡（限速是按 IP 的）')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runtime.db.close()
    console.log = originalLog
    resetAuthLimiter()
    if (saved === undefined) delete process.env.API_KEY
    else process.env.API_KEY = saved
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
