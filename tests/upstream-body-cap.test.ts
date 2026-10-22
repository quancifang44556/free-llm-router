/**
 * 上游响应体的读取上限（2026-10-22 事故回归）。
 *
 * ## 事故
 * 并发专项里我把 `callUpstream()` 改成「只读前 4 KiB」（本意是防 WAF 回几 MB
 * HTML 时整包进内存）。但 `callUpstream` 是**所有 JSON 业务接口**的公共出口
 * （签到、余额、任务、补偿），而余额接口对一个有 21 个积分包的账号返回约 15 KB。
 *
 * 截断 ⇒ `JSON.parse` 失败 ⇒ `parseEnvelope` 返回 `undefined`
 * ⇒ `fetchBalance` 把「解析失败」当成「余额 0」⇒ **真实积分 1976 被覆盖成 0**。
 *
 * 用户看到「积分全变 0」，日志却是「余额刷新完成：成功 8 / 失败 0」。
 *
 * ⇒ 上限必须容纳合法 JSON；且**截断必须报错**，不能被下游当成空数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { callUpstream } from '../src/upstream/client.ts'
import { parseBalance } from '../src/upstream/checkin.ts'

/** 造一份和线上同形的余额响应：18 个有效包（276 + 17×100 = 1976）+ 3 个失效包。 */
function balancePayload(): string {
  const accounts = []
  for (let i = 0; i < 18; i += 1) {
    accounts.push({
      AccountId: 1610620092545461200 + i,
      Uin: '330127795819',
      AppId: 1508123272,
      DealName: `20261016819184426486${200 + i}`,
      CapacityType: 1,
      CapacityUnit: 'credits',
      CycleStartTime: '2026-10-16 11:43:33',
      CycleEndTime: '2026-11-16 11:43:32',
      DeductionEndTime: 1794800612000,
      PackageName: 'CodeBuddy个人版国内运营裂变',
      CapacityRemain: 100,
      CapacityUsed: 0,
      CapacitySize: 100,
      CycleCapacityRemain: i === 0 ? 276 : 100,
      CycleCapacitySize: 100,
      Status: 0,
    })
  }
  for (let i = 0; i < 3; i += 1) {
    accounts.push({
      AccountId: 1 + i, PackageName: 'CodeBuddy个人版拉新权益包',
      CapacityRemain: 0, CycleCapacityRemain: 0, Status: 3,
      DeductionEndTime: 1794800612000,
    })
  }
  return JSON.stringify({
    code: 0,
    msg: 'OK',
    requestId: '07355aa3-dd7a-4f64-bc63-a55d1d5c5d42',
    data: { Response: { Data: { TotalCount: accounts.length, Accounts: accounts } } },
  })
}

test('🔴 余额响应超过 4 KiB 时必须能完整解析（否则真实积分会被覆盖成 0）', async () => {
  const payload = balancePayload()
  assert.ok(payload.length > 4096, `测试数据必须大于 4 KiB（实际 ${payload.length}）`)
  assert.ok(payload.length < 2 * 1024 * 1024)

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(payload)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  try {
    const res = await callUpstream({ method: 'POST', url: `http://127.0.0.1:${port}/`, headers: {}, body: '{}' })
    assert.ok(res.envelope !== undefined, '⚠️ 响应被截断 ⇒ envelope 为 undefined ⇒ 下游会把余额当 0')
    assert.equal(res.envelope.code, 0)

    const packages = parseBalance(res.envelope.data, Date.now())
    assert.ok(packages !== null, '形状正确时不该返回 null')
    const live = packages.filter((p) => !p.expired)
    const total = live.reduce((sum, p) => sum + p.cycleRemain, 0)
    assert.equal(total, 1976, `⚠️ 解析出的余额是 ${total}，与上游真实值 1976 不符`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('🔴 超过 2 MiB 上限时必须报错，而不是静默返回空数据', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    // 3 MiB 的合法 JSON（一个巨大的字符串字段）
    res.end(`{"code":0,"msg":"OK","data":"${'x'.repeat(3 * 1024 * 1024)}"}`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  try {
    await assert.rejects(
      () => callUpstream({ method: 'POST', url: `http://127.0.0.1:${port}/`, headers: {}, body: '{}' }),
      /上限|截断/,
      '⚠️ 截断被当成成功 ⇒ 下游会把「读不全」解释成「内容为空」',
    )
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
