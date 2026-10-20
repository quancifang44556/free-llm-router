/**
 * Qoder 每日签到（`/sash/api/v1/me/campaigns`）的行为锁。
 *
 * 用户报障：中国版签到恒报「需要设备身份头 Cosy-MachineToken + Cosy-MachineType」。
 * 依据多个参考实现的单变量对照（Zhengyuuuui/qoder2api `checkin.go:73-88`、
 * shuishuipingan/qoder2api-hub、L0NE-6/Qoder-Daily）：
 * - 中国版**不带**指纹头即可正常下发 `CLAIM_BENEFIT`，带自造/过期 token 反而被过滤；
 * - 国际版必须带真实指纹头。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCredential, qoderProvider, qodercnProvider } from '../src/providers/qoder.ts'

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function mockFetch(handler: (call: Call) => Response): { calls: Call[]; restore: () => void } {
  const realFetch = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    const call: Call = { url: String(url), method: init.method ?? 'GET', headers, body: init.body }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const claimable = { campaigns: [
  { campaignId: 'c1', campaignKey: 'cn_daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
] }
const viewOnly = { campaigns: [{ campaignId: 'v1', actionType: 'VIEW_DETAILS', claimStatus: 'NONE' }] }
const bare = parseCredential({ access_token: 'tok', uid: 'u1' })
const withMachine = parseCredential({ access_token: 'tok', uid: 'u1', machineToken: 'mt', machineType: 'mty', machineCode: 'mc' })

test('🔴 中国版缺 machine 头时**照常签到**（不再直接抛错），且不带任何 Cosy-Machine* 头', async () => {
  const m = mockFetch((c) => c.method === 'GET'
    ? json(claimable)
    : json({ status: 'CLAIMED', benefit: { amount: 100, validity: { days: 7 } } }))
  try {
    const r = await qodercnProvider.checkin!(bare, AbortSignal.timeout(5_000))
    assert.deepEqual([r.alreadyDone, r.gained], [false, 100])
    assert.match(r.detail, /\+100/)
    assert.equal(m.calls.length, 2)
    assert.match(m.calls[0]!.url, /^https:\/\/openapi\.qoder\.com\.cn\/sash\/api\/v1\/me\/campaigns\?forceRefresh=true$/)
    const claim = m.calls[1]!
    assert.equal(claim.url, 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/c1/claim')
    assert.equal(claim.method, 'POST')
    assert.equal(claim.body, '', '抓包实测 claim 为空 body')
    assert.equal(claim.headers.origin, 'https://openapi.qoder.com.cn')
    for (const call of m.calls) {
      assert.equal(call.headers['cosy-clienttype'], '10')
      assert.equal(Object.keys(call.headers).some((k) => k.startsWith('cosy-machine')), false)
    }
  } finally { m.restore() }
})

test('🔴 中国版带了（过期）machine 头却拿不到 CLAIM_BENEFIT → 不带头重试并用同一身份领取', async () => {
  const m = mockFetch((c) => {
    if (c.method === 'GET') return json(c.headers['cosy-machinetoken'] === undefined ? claimable : viewOnly)
    return json({ status: 'CLAIMED', benefit: { amount: 100 } })
  })
  try {
    const r = await qodercnProvider.checkin!(withMachine, AbortSignal.timeout(5_000))
    assert.equal(r.gained, 100)
    assert.equal(m.calls.length, 3)
    assert.equal(m.calls[0]!.headers['cosy-machinetoken'], 'mt')
    assert.equal(m.calls[0]!.headers['cosy-machinecode'], 'mc')
    assert.equal(m.calls[1]!.headers['cosy-machinetoken'], undefined)
    assert.equal(m.calls[2]!.headers['cosy-machinetoken'], undefined, '领取必须沿用拿到可领项的那套头')
  } finally { m.restore() }
})

test('🔴 没有可领项时**抛错**而不是报「今日已领」（调用方会据返回值记签到日）', async () => {
  const m = mockFetch(() => json(viewOnly))
  try {
    await assert.rejects(qodercnProvider.checkin!(bare, AbortSignal.timeout(5_000)), /没有可领取的签到活动/)
    assert.equal(m.calls.length, 1)
  } finally { m.restore() }
})

test('🔴 国际版缺 machine 头且无可领项 → 抛错说明要配 machineToken/machineType，不发 claim', async () => {
  const m = mockFetch(() => json(viewOnly))
  try {
    await assert.rejects(qoderProvider.checkin!(bare, AbortSignal.timeout(5_000)), /machineToken/)
    assert.equal(m.calls.length, 1)
    assert.match(m.calls[0]!.url, /^https:\/\/openapi\.qoder\.sh\//)
  } finally { m.restore() }
})

test('列表里 CLAIM_BENEFIT 已 CLAIMED → 已领；兼容 {data:{campaigns}} 外形', async () => {
  const m = mockFetch(() => json({ data: { campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' }] } }))
  try {
    const r = await qodercnProvider.checkin!(bare, AbortSignal.timeout(5_000))
    assert.equal(r.alreadyDone, true)
  } finally { m.restore() }
})

test('claim 回 replayed / 409 / ALREADY_CLAIMED → 已领；status 非 CLAIMED → 抛错', async () => {
  const cases: Array<[Response, 'done' | 'error']> = [
    [json({ status: 'CLAIMED', replayed: true }), 'done'],
    [json({ result: 'ALREADY_CLAIMED' }, 409), 'done'],
    [json({ status: 'PENDING' }), 'error'],
  ]
  for (const [resp, expected] of cases) {
    const m = mockFetch((c) => c.method === 'GET' ? json(claimable) : resp.clone())
    try {
      const p = qodercnProvider.checkin!(bare, AbortSignal.timeout(5_000))
      if (expected === 'done') assert.equal((await p).alreadyDone, true)
      else await assert.rejects(p, /PENDING/)
    } finally { m.restore() }
  }
})
