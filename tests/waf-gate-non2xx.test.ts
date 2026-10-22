/**
 * G5：非 2xx 出口也必须给 WAF / 波次闸门投喂证据。
 *
 * ## 缺陷（2026-10-22 核查确认）
 * `handleProviderChat` 有两条失败出口：
 * - **ProviderError**（8 家抛异常）→ `2451`/`2454` 已做 `noteRestriction` / `noteWaf` 双记账；
 * - **非 2xx Response**（`trae` / `opencode` 原样 return）→ **一条都没记**。
 *
 * 而顶部的 `wafGateActive` 靠「短窗内 ≥2 个不同账号命中 403」才激活 ——
 * 这两家的 403 永远攒不够证据，闸门对它们形同虚设：
 * 出口 IP 被 WAF 拦了，网关还在一个接一个地换号撞同一堵墙。
 *
 * 本测试用 `opencode`（返回非 2xx Response）复现：两个账号各吃一次 403 后，
 * 下一次请求必须被闸门拦下（503 + 不再打上游）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import { handleProviderChat } from '../src/gateway/server.js'
import { findProvider } from '../src/providers/index.js'

function freshRuntime(name: string) {
  fs.mkdirSync(path.join(process.cwd(), '.build'), { recursive: true })
  const dbPath = path.join(process.cwd(), '.build', `test-g5-${name}.db`)
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  const runtime = createNodeRuntime(dbPath)
  return {
    ...runtime,
    cleanup: () => {
      runtime.db.close()
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
    },
  }
}

test('🔴 provider 返回非 2xx 的 403 也必须喂给 WAF 闸门（否则闸门对它形同虚设）', async () => {
  const rt = freshRuntime('opencode403')
  const provider = findProvider('opencode')
  assert.ok(provider !== undefined)
  const originalChat = provider.chat
  const originalLog = console.log
  const originalWarn = console.warn
  let upstreamCalls = 0
  console.log = () => {}
  console.warn = () => {}

  provider.chat = (async () => {
    upstreamCalls += 1
    // 403 + 无业务信封 ⇒ classify 判 waf_blocked
    return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })
  }) as never

  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    for (const uid of ['wg1', 'wg2']) {
      const st = createAccountState({ uid, nickname: uid, realm: 'cn', provider: 'opencode' })
      st.credits = 100
      await pool.upsertAccount(st, Date.now())
      await pool.putCredential(
        uid,
        { uid, nickname: uid, accessToken: `tok-${uid}`, refreshToken: '', expiresAt: Date.now() + 3600_000 },
        Date.now(),
      )
    }

    const run = () => handleProviderChat({
      providerId: 'opencode', model: 'm', wantsStream: false,
      rawBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      request: new Request('https://example.test/v1/chat/completions', { method: 'POST', headers: {} }),
      env: rt.env, realm: 'cn', tried: [], sessionKey: '', failoverDepth: 1,
    })

    // ⚠️ `waf_blocked` 的 rotate=false ⇒ 一次请求只会试**一个**账号，
    // 所以不能指望「一次请求内两个号各吃一次 403」。
    // 改为：先替另一个账号预置一次命中，再让本请求的账号命中第二次 ——
    // 这样能精确验证「非 2xx 出口确实调了 noteWaf」（而不是闸门本来就开着）。
    const pre = await pool.noteWaf('wg-other', Date.now())
    assert.equal(pre, false, '只命中一个账号时闸门不该激活')

    const res = await run()
    const text = await res.response.text()

    assert.equal(
      res.response.status,
      503,
      `⚠️ 非 2xx 出口没有喂 WAF 闸门（否则第二个账号命中时应当场 503）；实际 ${res.response.status} body=${text.slice(0, 200)}`,
    )
    assert.match(text, /WAF/)
    assert.equal(upstreamCalls, 1, '本请求应只打了一次上游（rotate=false）')
  } finally {
    provider.chat = originalChat
    console.log = originalLog
    console.warn = originalWarn
    rt.cleanup()
  }
})
