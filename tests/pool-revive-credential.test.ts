/**
 * S9 + S12：`revive` 漏清 `restrictedUntil`、`removeCredential` 不清内存缓存。
 *
 * ## S9
 * `revive` 的语义是「人工判定这个号是好的，重新开始」（面板「解冻」与
 * 「重新导入凭据」都走它）。它清了 until / breaker / degrade / modelCooldowns，
 * **唯独漏了 `restrictedUntil`**（11140 上游封号标记）⇒ 用户点完「解冻」，
 * 面板显示「正常」，账号却仍被 `healthy()` 排除 —— 又一例「状态看着对、行为不对」。
 *
 * ## S12
 * `removeCredential()` 只删库、不清 `credentialCache`，而 `deleteCredential()` 会清。
 * ⇒ 删掉凭据后 `getCredential()` 仍能从缓存里拿到已删的那份：
 * 面板上账号没凭据了，实际还能用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState, healthy } from '../src/pool/state.js'

const REALM = 'cn'

function freshRuntime(tag: string) {
  const dir = path.join(process.cwd(), '.build', 'test-pool-revive')
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, `${tag}.db`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  return createNodeRuntime(dbPath)
}

function poolOf(env: unknown) {
  const e = env as { ACCOUNT_POOL: { get: (id: unknown) => never; idFromName: (n: string) => unknown } }
  return e.ACCOUNT_POOL.get(e.ACCOUNT_POOL.idFromName(REALM))
}

test('🔴 revive 必须一起清 restrictedUntil（否则「解冻」后面板正常但账号仍不可用）', async () => {
  const rt = freshRuntime('revive')
  try {
    const pool = poolOf(rt.env) as unknown as {
      upsertAccount: (s: unknown, now: number) => Promise<unknown>
      listAccounts: (realm: string, now: number) => Promise<Array<Record<string, unknown>>>
      revive: (uid: string, now: number) => Promise<boolean>
    }
    const now = Date.now()
    const st = createAccountState({ uid: 'rv1', nickname: 'rv1', realm: REALM, provider: 'buddy' })
    // 上游封号（11140）+ 熔断 + 降权 + 模型冷却，四种惩罚态同时在场
    st.restrictedUntil = now + 6 * 3600_000
    st.breakerUntil = now + 30 * 60_000
    st.degradeUntil = now + 30 * 60_000
    st.until = now + 60 * 60_000
    st.coolKind = 'hard'
    st.modelCooldowns = { 'some-model': { until: now + 3600_000, reason: '6004' } }
    await pool.upsertAccount(st, now)

    const before = (await pool.listAccounts(REALM, now)).find((a) => a.uid === 'rv1')!
    assert.equal(healthy(before as never, now), false, '前置：四种惩罚态下应不可用')

    assert.equal(await pool.revive('rv1', now), true)

    const after = (await pool.listAccounts(REALM, now)).find((a) => a.uid === 'rv1')!
    assert.equal(after.restrictedUntil, 0, '⚠️ restrictedUntil 没清 —— 面板显示正常，账号仍被排除')
    assert.equal(after.breakerUntil, 0, '熔断应清')
    assert.equal(after.degradeUntil, 0, '降权应清')
    assert.equal(after.until, 0, '冷却应清')
    assert.deepEqual(after.modelCooldowns, {}, '模型冷却应清')
    assert.equal(healthy(after as never, now), true, '解冻后必须真的可用')
  } finally {
    rt.db.close()
  }
})

test('🔴 removeCredential 必须清内存缓存（否则「删了还能用」）', async () => {
  const rt = freshRuntime('cred')
  try {
    const pool = poolOf(rt.env) as unknown as {
      putCredential: (uid: string, c: unknown, now: number) => Promise<unknown>
      getCredential: (uid: string) => Promise<unknown>
      removeCredential: (uid: string) => Promise<void>
    }
    const now = Date.now()
    const credential = { uid: 'cr1', nickname: 'cr1', accessToken: 'tok', refreshToken: '', expiresAt: now + 3600_000 }

    await pool.putCredential('cr1', credential, now)
    // 先读一次 ⇒ 进缓存（这正是缺陷暴露的前提）
    assert.ok(await pool.getCredential('cr1') !== undefined, '前置：应能读到凭据')

    await pool.removeCredential('cr1')

    const after = await pool.getCredential('cr1')
    assert.equal(
      after,
      undefined,
      '⚠️ 删掉凭据后仍能读到 —— credentialCache 没清，账号「删了还能用」',
    )
  } finally {
    rt.db.close()
  }
})
