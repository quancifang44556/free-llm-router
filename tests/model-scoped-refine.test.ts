/**
 * G3：`refineModelScoped()` 必须拿到**原始报文**，否则模型级限流退化成账号级。
 *
 * ## 缺陷（2026-10-22 核查确认）
 * `ProviderError` 分支里先算出 `detail`：
 * ```
 * const detail = c.code === undefined && c.kind !== 'waf_blocked' ? message : (c.msg || message)
 * ```
 * 然后在惩罚那一行传的是 `refineModelScoped(c.kind, detail)`。
 * 而「已解析出业务码」时 `detail` 是 `c.msg`（人话文案）——
 * `refineModelScoped` 内部靠 `parseBusinessCode(bodyText)` 找码，传文案必然找不到。
 *
 * ⇒ `110 / 6004 / 14003 / 11134` 全部退化成账号级 `soft`：
 * 一个模型当日次数用完，整个账号被锁，换个模型明明立刻可用。
 *
 * 本测试用真实网关路径（`handleProviderChat`）复现：单账号 + 抛 ProviderError，
 * 断言冷却落在**模型**上而不是整个账号上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import { handleProviderChat } from '../src/gateway/server.js'
import { findProvider } from '../src/providers/index.js'
import { ProviderError } from '../src/providers/types.js'

function freshRuntime(name: string) {
  fs.mkdirSync(path.join(process.cwd(), '.build'), { recursive: true })
  const dbPath = path.join(process.cwd(), '.build', `test-g3-${name}.db`)
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

const MODEL = 'qmodel'

test('🔴 110（模型级日次数）只该冷却模型，不该锁整个账号', async () => {
  const rt = freshRuntime('qoder110')
  const provider = findProvider('qodercn')
  assert.ok(provider !== undefined, '应能找到 qodercn')
  const originalChat = provider.chat
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}

  provider.chat = (async () => {
    throw new ProviderError({
      provider: 'qodercn',
      httpStatus: 0,
      // ⚠️ 关键：业务码在**报文**里，不在 `msg` 的人话文案里
      message: '{"code":110,"msg":"Billing daily count exceeded","data":null}',
    })
  }) as never

  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const state = createAccountState({ uid: 'q1', nickname: 'q1', realm: 'cn', provider: 'qodercn' })
    state.credits = 100
    await pool.upsertAccount(state, Date.now())
    await pool.putCredential(
      'q1',
      { uid: 'q1', nickname: 'q1', accessToken: 'tok', refreshToken: '', expiresAt: Date.now() + 3600_000 },
      Date.now(),
    )

    const res = await handleProviderChat({
      providerId: 'qodercn', model: MODEL, wantsStream: false,
      rawBody: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
      request: new Request('https://example.test/v1/chat/completions', { method: 'POST', headers: {} }),
      env: rt.env, realm: 'cn', tried: [], sessionKey: '', failoverDepth: 1,
    })
    await res.response.text()

    const after = (await pool.listAccounts('cn', Date.now())).find((a) => a.uid === 'q1')
    assert.ok(after !== undefined)
    const now = Date.now()

    assert.ok(
      Object.values(after.modelCooldowns ?? {}).some((m) => m.until > now),
      '⚠️ 模型没有被冷却 —— 110 应判模型级（切模型即可用）',
    )
    assert.ok(
      after.until <= now,
      `⚠️ 整个账号被锁到 ${new Date(after.until).toISOString()} —— 模型级限流被当成了账号级`,
    )
    assert.ok(after.breakerUntil <= now, '⚠️ 账号被熔断 —— 110 不该熔断账号')
  } finally {
    provider.chat = originalChat
    console.log = originalLog
    console.warn = originalWarn
    rt.cleanup()
  }
})
