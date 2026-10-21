/**
 * `buddy.chat` 的首帧超时（2026-10-21 审查补，M3 指出）。
 *
 * ## 缺陷
 * 原来把 `request.signal` **直接**交给 `fetch`，而那个信号只在客户端断开时触发
 * ⇒ 上游「接了连接但永不回响应头」时请求**无限挂起**，网关也不会换号。
 *
 * ## 本测试锁什么
 * 1. `fetch` 拿到的**不是**原始 `request.signal`（说明中间有 `AbortController`，
 *    也才有地方挂超时计时器）；
 * 2. 客户端取消能**穿透**到上游（组合信号必须保留这条通路，
 *    否则用户取消后上游还在跑，白烧额度）。
 *
 * 只验这两条，不验 120s 的真实超时（跑不动），也不靠 grep 源码文本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { findProvider } from '../src/providers/index.js'

test('buddy.chat 必须用组合信号：客户端取消能穿透到上游', async () => {
  const provider = findProvider('buddy')
  assert.ok(provider !== undefined, 'buddy provider 应存在')

  const originalFetch = globalThis.fetch
  let capturedSignal: AbortSignal | undefined
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      capturedSignal = init?.signal ?? undefined
      init?.signal?.addEventListener('abort', () => reject(new Error('upstream aborted')))
    })) as unknown as typeof fetch

  try {
    const ac = new AbortController()
    const pending = provider.chat(
      { uid: 'u1', nickname: 'u1', accessToken: 'tok', refreshToken: '', expiresAt: Date.now() + 3600_000 },
      {
        body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
        signal: ac.signal,
      } as never,
    )
    // 让 fetch 先被调用，再模拟客户端断开
    setTimeout(() => ac.abort(new Error('client gone')), 20)
    await assert.rejects(pending, /upstream aborted|aborted/i)

    assert.ok(capturedSignal !== undefined, '应把某个信号传给 fetch')
    assert.notEqual(
      capturedSignal,
      ac.signal,
      '⚠️ 不得把 request.signal 直接透传给 fetch —— 那样就没有地方挂首帧超时',
    )
    assert.equal(capturedSignal?.aborted, true, '客户端取消必须穿透到上游请求')
  } finally {
    globalThis.fetch = originalFetch
  }
})
