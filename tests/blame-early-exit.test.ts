/**
 * S11 + S4：`blame`（延迟记账收件箱）的两个缺陷。
 *
 * ## S11 —— 早退出口静默丢弃 blame
 *
 * `blame` 的语义是「先把失败挂起、等换号成功后结算」，所以它只有两个出口：
 * **结算**（`settleBlame`）与**丢弃**。丢弃本身是对的（全池同样失败更可能是上游
 * 整体故障 / 本机断网，逐个记账会造成连锁熔断），缺的只是**可观测性**。
 *
 * 而「丢弃 + 日志」此前只写在**两处循环尾**。两个处理函数里另有 4 个早退出口
 * （只用指定账号却不可用 / 跨渠道容灾 ×2 / 没有可用账号）直接 `return`，
 * `blame` 既不结算也不打日志 ⇒ 账号该罚却没罚，事后零痕迹。
 * 而「全池都失败」最常见的形态恰好走的是**没有日志**的那条早退路径。
 *
 * ## S4 —— 结算时丢掉上游给的重置时刻
 *
 * blame 元素类型原来只有 `uid/kind/reason`，而「立即结算」的两条路径都会把
 * `resetAt`（文案 `reset at … UTC+8` 或 `Retry-After`）交给池 ⇒ 同一个错误
 * 只因走了延迟就丢掉上游墙钟。
 *
 * ⚠️ 边界：真正消费 `resetAt` 的是 `soft` / `model`；`breaker` / `degrade`
 * 是计数型、根本不读它。故这里断言的是「透传、不再丢信息」，不是「熔断时长会变」。
 *
 * ## 为什么这组用例不驱动真实 HTTP
 *
 * 早期版本逐个构造「跨渠道容灾」「全池失败」的真实请求去抓日志，结果对
 * 账号/provider 的前置条件极其敏感（容灾没触发 ⇒ 502 ⇒ 用例红），
 * 而且红的原因与「blame 有没有被丢弃」毫无关系 —— 那是**脆弱的**测试。
 * 这里改为：**行为断言**（直接调两个导出函数）+ **接线断言**（数调用点）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { discardBlame, settleBlame, type BlameEntry } from '../src/gateway/server.js'

const SRC = fs.readFileSync('src/gateway/server.ts', 'utf8')

test('🔴 discardBlame：留一条含数量与原因的日志，且**一次 applyFailure 都不调**', () => {
  const entries: BlameEntry[] = [
    { uid: 'aaaaaaaa-1111', kind: 'breaker', reason: 'upstream 500' },
    { uid: 'bbbbbbbb-2222', kind: 'degrade', reason: 'upstream 502' },
  ]
  const logs: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  try {
    discardBlame(entries, '全池同样失败')
  } finally {
    console.warn = original
  }

  assert.equal(logs.length, 1, `应恰好一条日志，实际 ${logs.length}`)
  assert.match(logs[0]!, /全池同样失败/, '日志必须带原因（否则排查时不知道是哪条出口丢的）')
  assert.match(logs[0]!, /2 条/, '日志必须带丢弃的条数')
  assert.match(logs[0]!, /aaaaaaaa/, '日志应能定位到账号（uid 前 8 位即可）')
  // ⚠️ 只有前 8 位：不能把完整 uid 打进日志
  assert.ok(!logs[0]!.includes('aaaaaaaa-1111'), '日志不得输出完整 uid')
})

test('discardBlame：空收件箱不产生日志（避免每个请求刷一条噪音）', () => {
  const logs: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  try {
    discardBlame([], '全池同样失败')
  } finally {
    console.warn = original
  }
  assert.equal(logs.length, 0)
})

test('🔴 settleBlame：必须把 resetAt 透传给 applyFailure（不再吃掉上游墙钟）', async () => {
  const calls: Array<Record<string, unknown>> = []
  const pool = {
    applyFailure: async (input: Record<string, unknown>) => { calls.push(input) },
  } as never

  const entries: BlameEntry[] = [
    { uid: 'u1', kind: 'soft', reason: 'rate limited', resetAt: 1_700_000_000_000 },
    { uid: 'u2', kind: 'breaker', reason: 'upstream 500' },
  ]
  await settleBlame(pool, entries, 1_700_000_000_500)

  assert.equal(calls.length, 2, '两条都该结算')
  assert.equal(calls[0]!.resetAt, 1_700_000_000_000, '⚠️ 有 resetAt 的必须透传')
  assert.equal('resetAt' in calls[1]!, false, '没有 resetAt 的不得凭空塞一个')
})

test('🔴 六个出口都必须丢弃 blame：4 个早退 + 2 个循环尾', () => {
  // ## 为什么数调用点而不是跑一遍
  //
  // 这些出口的触发条件分散在「pin 阻塞 / 跨渠道容灾 / 无可用账号」等分支上，
  // 逐个构造真实请求既脆弱又容易误红（见文件头）。而**漏一个出口**正是本缺陷的形态，
  // 所以这里把「有几个出口、分别在哪」钉死：新增早退分支却忘了 discardBlame 时，
  // 这条测试会红，而不是等下一次线上事故。
  const calls = [...SRC.matchAll(/discardBlame\(blame, '([^']+)'\)/g)].map((m) => m[1]!)
  assert.equal(calls.length, 6, `应有 6 个丢弃点，实际 ${calls.length}：${calls.join(' | ')}`)

  const joined = calls.join(' | ')
  for (const [label, pattern] of [
    ['只用指定账号且不可用', /只用指定账号/],
    ['buddy → 国际版容灾', /跨渠道容灾至国际版/],
    ['provider → 国内版容灾', /跨渠道容灾至国内版/],
    ['buddy 无可用账号', /没有可用账号/],
    ['buddy 循环尾', /(^|\| )全池同样失败( \||$)/],
    ['provider 循环尾', /provider 路径全池同样失败/],
  ] as const) {
    assert.match(joined, pattern, `⚠️ 缺「${label}」这个丢弃点 —— 该出口会静默丢 blame`)
  }
})

test('S11/S4 回归：blame 元素类型必须带可选 resetAt', () => {
  // 类型层的东西用源码断言兜一层：`tsc` 只能证明「用得对」，证明不了「字段还在」。
  assert.match(SRC, /export type BlameEntry = \{[\s\S]{0,400}?resetAt\?: number/, 'BlameEntry 必须带可选 resetAt')
})
