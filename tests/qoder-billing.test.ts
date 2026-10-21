/**
 * Qoder 业务码 `110` 的识别（2026-10-21 审查补，M3 指出）。
 *
 * ## 缺陷
 * `looksLikeQoderBillingError` 的**字符串分支**只匹配三个英文关键词。
 * 而上游的 `message` 常是**被序列化的 JSON**，且文案会本地化（中文）。
 * ⇒ 中文文案一个都不命中 ⇒ 110 专用分支**永远走不到**，
 * 文档里那段「这不是余额耗尽」的解释用户永远看不到。
 *
 * ## 本测试锁什么
 * 识别必须对「英文 / 中文 / JSON 字符串 / 双层嵌套」四种形态都成立，
 * 且**不能**因为放宽而误伤（`"额度"` 之类泛词不得直接判 110）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { looksLikeQoderBillingError } from '../src/providers/qoder.js'

test('110：英文原文可识别', () => {
  assert.equal(looksLikeQoderBillingError('Billing daily count exceeded'), true)
})

test('110：JSON 对象（code 为字符串或数字）可识别', () => {
  assert.equal(looksLikeQoderBillingError({ code: '110', message: '今日调用次数已达上限' }), true)
  assert.equal(looksLikeQoderBillingError({ code: 110 }), true)
})

test('🔴 110：被序列化过的 JSON 字符串（中文文案）也必须识别', () => {
  // 这就是原缺陷：`message` 是 JSON 字符串，文案是中文 ⇒ 英文关键词全不中
  const s = '{"code":110,"message":"今日调用次数已达上限，请明日再试"}'
  assert.equal(looksLikeQoderBillingError(s), true, '⚠️ 序列化 JSON + 中文文案必须能认出 110')
})

test('🔴 110：JSON 里再套一层字符串也能识别', () => {
  const s = '{"code":403,"message":"{\\"code\\":110,\\"message\\":\\"今日次数已用完\\"}"}'
  assert.equal(looksLikeQoderBillingError(s), true)
})

test('110：不得因为放宽而误伤普通文案', () => {
  // 「额度」/「余额」之类泛词不是 110 的证据（模型正文可能就在讨论这些）
  assert.equal(looksLikeQoderBillingError('请问我的额度还剩多少？'), false)
  assert.equal(looksLikeQoderBillingError('{"code":11102,"message":"service info not found"}'), false)
  assert.equal(looksLikeQoderBillingError('请求成功'), false)
})
