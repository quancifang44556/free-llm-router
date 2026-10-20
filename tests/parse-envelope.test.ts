/**
 * 业务码解析（任务 4.3）：字符串码 `"11-128"` 归一 + 数字码不被吞。
 *
 * ## 为什么必须单测
 *
 * `parseEnvelope` 是整个错误分类的入口。上游国际服把渠道校验失败写成
 * **带连字符的字符串**（`"code":"11-128"`），而 `Number('11-128')` 是 `NaN` ——
 * 原实现直接 `return undefined`，于是：
 *
 * - 整条响应被当成「**没有业务信封的裸 400**」；
 * - 错误文案全丢（用户只看到一个含糊的 400）；
 * - `classify` 走到「按状态码兜底」⇒ 归为 `unknown` ⇒ 后续按最坏情况处理。
 *
 * 修法是把 `数字-数字` 形态归一成常量 `CHANNEL_BLOCKED_CODE` 再查表。
 * ⚠️ 反向风险同样要钉死：**数字码不能被这次放宽吞掉**（6004 一旦被归成渠道拦截，
 * 限流就永远不会换号/冷却，账号会一直空转打上游）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHANNEL_BLOCKED_CODE, classify, parseEnvelope } from '../src/upstream/client.ts'

test('🔴 字符串码 "11-128" 必须解析成 CHANNEL_BLOCKED_CODE，而不是被丢弃', () => {
  const got = parseEnvelope('{"code":"11-128","msg":"request illegal"}')
  assert.notEqual(got, undefined, '整条信封不得被丢弃（原实现 Number("11-128")=NaN 会丢）')
  assert.equal(got?.code, CHANNEL_BLOCKED_CODE)
  assert.equal(CHANNEL_BLOCKED_CODE, -108128, '归一码必须是字面量负数（写成 -11-128 会被求值成 -139）')
  // ⚠️ msg 必须保留上游原文：用户与日志都靠它定位
  assert.equal(got?.msg, 'request illegal')
})

test('🔴 msg 为空时回落到原始码字符串（不能给出空错误文案）', () => {
  const got = parseEnvelope('{"code":"11-128"}')
  assert.equal(got?.code, CHANNEL_BLOCKED_CODE)
  assert.equal(got?.msg, '11-128')
})

test('🔴 classify(400, 字符串码体) 必须是 channel_blocked（不是 request_illegal / unknown）', () => {
  // 11-128 说的是**请求指纹**不被认可，与账号好坏无关；
  // 归成 request_illegal 会罚号（3 次熔断 30 分钟），归成 unknown 会按最坏情况处理。
  const body = JSON.stringify({
    code: '11-128',
    msg: 'request illegal',
    displayTips: {
      en: 'This call failed channel verification, possibly because it was not sent from an official client.',
    },
  })
  const got = classify(400, body)
  assert.equal(got.kind, 'channel_blocked')
  assert.equal(got.code, CHANNEL_BLOCKED_CODE)
  // ⚠️ 也不能是 waf_blocked：那会触发 IP 级判定，凑够 2 个账号就误报全局封锁
  assert.notEqual(got.kind, 'waf_blocked')
})

test('🔴 回归：数字码 6004 仍然解析为 6004（不得被字符串分支吞掉）', () => {
  // 6004 是**模型级**限流，必须按数字码认出来才能写模型冷却。
  const got = parseEnvelope('{"code":6004,"msg":"usage exceeds frequency limit"}')
  assert.equal(got?.code, 6004)
  assert.equal(classify(429, '{"code":6004}').kind, 'rate_limited')
  // 双保险：别被归一成渠道拦截
  assert.notEqual(got?.code, CHANNEL_BLOCKED_CODE)
})

test('⚠️ 字符串形式的数字码 "6004" 仍按数字解析（不是「任何字符串都算渠道拦截」）', () => {
  // 上游在不同端点上混用数字与字符串两种形态。若把「字符串码」一律当渠道拦截，
  // 一个字符串化的限流码就会被误判成渠道问题 ⇒ 不换号、不冷却 ⇒ 无限打上游。
  const got = parseEnvelope('{"code":"6004","msg":"rate limited"}')
  assert.equal(got?.code, 6004)
  assert.equal(classify(429, '{"code":"6004"}').kind, 'rate_limited')
})

test('⚠️ 无 code / 非 JSON 体仍然返回 undefined（不得凭空造信封）', () => {
  assert.equal(parseEnvelope('<html>403 Forbidden</html>'), undefined)
  assert.equal(parseEnvelope('{"msg":"no code here"}'), undefined)
  // 非「数字-数字」形态的字符串码不归一到渠道拦截（也解析不出数字 ⇒ 丢弃）
  assert.equal(parseEnvelope('{"code":"abc"}'), undefined)
  // 单段数字字符串则是合法数字码，保留
  assert.equal(parseEnvelope('{"code":"14003"}')?.code, 14003)
})

test('⚠️ SSE 帧里的字符串码同样能被解析（上游错误帧偶尔带 data: 前缀）', () => {
  const got = parseEnvelope('data: {"code":"11-128","msg":"request illegal"}')
  assert.equal(got?.code, CHANNEL_BLOCKED_CODE)
  assert.equal(got?.msg, 'request illegal')
})
