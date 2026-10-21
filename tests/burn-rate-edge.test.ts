/**
 * burn-rate 的**窗口边界**（2026-10-21 审查补，M6 指出）。
 *
 * ## 缺陷
 * 采样每小时一次，默认窗口也恰好 1 小时 ⇒ 两次采样刚好卡在边界上。
 * 只要这一次采样比上一次**晚**几秒（网络抖动、整点对齐偏差），
 * 上一个点就落到 `cutoff` 之外 ⇒ `inWindow.length < 2` ⇒ **静默不判**，
 * 整整一小时的爆发检测被跳过，且没有任何日志。
 *
 * 本测试构造「恰好差一点点超出窗口」的两个点，断言仍然能判出爆发。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { detectBurnRate } from '../src/pool/burn-rate.js'

const HOUR = 3600_000

test('🔴 两次采样恰好跨在窗口边界上时，不得静默跳过检测', () => {
  const now = 1_000_000_000_000
  // 上一次采样：now 往前 1 小时零 5 秒（**已在窗口外**）
  // 这一次采样：now（窗口内）
  // 消耗：credits 从 1000 掉到 100（90%）
  const samples = [
    { at: now - HOUR - 5_000, credits: 1000 },
    { at: now, credits: 100 },
  ]
  const trip = detectBurnRate(samples, now, { windowMs: HOUR, thresholdPct: 50 })
  assert.ok(
    trip !== undefined,
    '⚠️ 边界抖动不应让检测整小时失效 —— 否则爆发时该账号照样被继续消耗',
  )
  assert.ok(trip.pct >= 50, `应判出高消耗（实际 ${trip.pct}%）`)
})

test('基线外移只会让速率更小，不会把慢速消耗误判成爆发', () => {
  const now = 1_000_000_000_000
  // 跨度约 2 小时、掉 30%（约 15%/时）：补基线后仍不应触发 50% 阈值
  const samples = [
    { at: now - 2 * HOUR, credits: 1000 },
    { at: now, credits: 700 },
  ]
  assert.equal(detectBurnRate(samples, now, { windowMs: HOUR, thresholdPct: 50 }), undefined)
})
