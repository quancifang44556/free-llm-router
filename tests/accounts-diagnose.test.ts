/**
 * 账号状态诊断与主动探测的测试。
 *
 * ## 为什么用行为断言而非源码文本断言
 * 本项目已有太多「grep 源码字符串」的脆弱断言（改个实现就红，而行为没变）。
 * `diagnoseAccount` / `humanizeMs` 都是**纯函数**，直接喂输入断言输出，
 * 既稳又能真正锁住语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diagnoseAccount, humanizeMs, type AccountState } from '../src/pool/state.js'

/** 造一个「完全健康」的账号状态，再按需覆盖字段。 */
function makeState(over: Partial<AccountState> = {}): AccountState {
  return {
    uid: 'qodercn:test',
    provider: 'qodercn',
    nickname: '测试号',
    realm: 'cn',
    disabled: false,
    reason: '',
    until: 0,
    coolKind: '',
    softStreak: 0,
    modelCooldowns: {},
    modelConfirm: {},
    breakerUntil: 0,
    restrictedUntil: 0,
    retryCount: 0,
    fails: 0,
    degradeUntil: 0,
    consecutiveFails: 0,
    sessionDeadFails: 0,
    modelCosts: {},
    successCount: 0,
    errTotal: 0,
    lastSuccess: 0,
    lastErr: 0,
    ...over,
  } as AccountState
}

test('humanizeMs：毫秒转人话', () => {
  assert.equal(humanizeMs(0), '0 秒')
  assert.equal(humanizeMs(-100), '0 秒')
  assert.equal(humanizeMs(42_000), '42 秒')
  assert.equal(humanizeMs(60_000), '1 分钟')
  assert.equal(humanizeMs(12 * 60_000), '12 分钟')
  assert.equal(humanizeMs(60 * 60_000), '1 小时')
  assert.equal(humanizeMs(118 * 60_000), '1 小时 58 分')
})

test('🔴 健康账号：summary 为「可用」，blockedBy 为空', () => {
  const now = 1_000_000
  const d = diagnoseAccount(makeState(), now)
  assert.equal(d.healthy, true)
  assert.deepEqual(d.blockedBy, [])
  assert.equal(d.summary, '可用')
})

test('🔴 账号级软冷却：remainingMs 正确、summary 含剩余时间', () => {
  const now = 1_000_000
  const d = diagnoseAccount(makeState({ until: now + 42_000, coolKind: 'soft', reason: 'rate limited' }), now)
  assert.equal(d.healthy, false)
  assert.ok(d.blockedBy.includes('account_cooldown'))
  assert.equal(d.dimensions.accountCooldown.active, true)
  assert.equal(d.dimensions.accountCooldown.remainingMs, 42_000)
  assert.match(d.summary, /限流/)
  assert.match(d.summary, /42 秒/)
})

test('🔴 硬冷却（余额耗尽）文案要与软冷却区分', () => {
  const now = 1_000_000
  const d = diagnoseAccount(makeState({ until: now + 3600_000, coolKind: 'hard' }), now)
  assert.match(d.summary, /余额耗尽/)
  assert.doesNotMatch(d.summary, /限流/)
})

test('🔴 模型级冷却：healthy 仍为 true（账号可服务其他模型），但 blockedBy 有 model_cooldown', () => {
  const now = 1_000_000
  const d = diagnoseAccount(
    makeState({
      modelCooldowns: { 'qwen3-max': { until: now + 42_000, resetAt: 0, reason: '6004', hits: 2 } },
    }),
    now,
  )
  // ⚠️ 这不是矛盾：`healthy()` 不看模型级冷却（那是 `healthyForModel()` 的事）
  assert.equal(d.healthy, true, '账号本身可用，只是那个模型不行')
  assert.ok(d.blockedBy.includes('model_cooldown'), '但仍要提示用户这个模型在冷却')
  assert.match(d.summary, /qwen3-max/)
  assert.match(d.summary, /账号本身可用/)
})

test('🔴 上游账号级限制（11140）优先级最高，summary 必须体现', () => {
  const now = 1_000_000
  // ⚠️ 用 118 分钟（不是整 2 小时）：这样能同时验证「小时+分」的组合格式。
  // 我第一版写 `2 * 3600_000` 却期望「1 小时 58 分」，那是把两个不同场景的
  // 期望值混在一起了 —— 整 2 小时应显示「2 小时」。
  const d = diagnoseAccount(makeState({ restrictedUntil: now + 118 * 60_000 }), now)
  assert.equal(d.healthy, false)
  assert.ok(d.blockedBy.includes('restricted'))
  assert.match(d.summary, /上游标记账号受限/)
  assert.match(d.summary, /1 小时 58 分/)
})

test('🔴 多维度命中：summary 取「最远的那个」（决定何时恢复）', () => {
  const now = 1_000_000
  const d = diagnoseAccount(
    makeState({
      until: now + 30_000, // 最近
      breakerUntil: now + 600_000, // 最远
    }),
    now,
  )
  assert.ok(d.blockedBy.includes('account_cooldown'))
  assert.ok(d.blockedBy.includes('breaker'))
  assert.match(d.summary, /熔断/, '应取最远的熔断作为主因')
  assert.match(d.summary, /10 分钟/)
})

test('⚠️ 审计条目（auditOnly）不参与判定，但要展示出来', () => {
  const now = 1_000_000
  const d = diagnoseAccount(
    makeState({
      modelCooldowns: { 'x': { until: now + 42_000, resetAt: 0, reason: 'audit', auditOnly: true } },
    }),
    now,
  )
  assert.equal(d.healthy, true)
  assert.ok(!d.blockedBy.includes('model_cooldown'), 'auditOnly 不参与选号判定')
  assert.equal(d.dimensions.modelCooldowns.length, 1, '但要在明细里可见')
  assert.equal(d.dimensions.modelCooldowns[0]!.auditOnly, true)
})

test('⚠️ 已过期维度不得显示为 active', () => {
  const now = 1_000_000
  const d = diagnoseAccount(makeState({ until: now - 1, breakerUntil: now - 1 }), now)
  assert.equal(d.dimensions.accountCooldown.active, false)
  assert.equal(d.dimensions.breaker.active, false)
  assert.equal(d.dimensions.accountCooldown.remainingMs, 0)
  assert.equal(d.summary, '可用')
})

test('⚠️ disabled 账号：blockedBy 含 disabled', () => {
  const d = diagnoseAccount(makeState({ disabled: true }), 1_000_000)
  assert.equal(d.healthy, false)
  assert.ok(d.blockedBy.includes('disabled'))
  assert.match(d.summary, /停用/)
})
