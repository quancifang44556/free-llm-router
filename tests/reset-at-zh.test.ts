/**
 * 上游「重置时刻」解析与中文文案识别（2026-10-20 实测确证的真实缺陷）
 *
 * ## 缺陷一：中文文案的重置时间**从未被解析**
 *
 * 上游对国内服下发的是中文：
 *   `您的使用量已超出频率限制，将在 2026-10-21 13:16:46 UTC+8 重置，
 *     您也可以切换其他模型继续使用。`
 *
 * 旧 `parseResetAt` 只匹配英文 `reset at … UTC+8` ⇒ 这类**完全解析不出**，
 * 于是一直走「自己猜的退避」：猜短了白撞、猜长了账号白关。
 * 而用户看到的正是「上游说了几点恢复，你还是关着」。
 *
 * ## 缺陷二：中文的「可切换其他模型」没被认成模型级
 *
 * 那句「您也可以切换其他模型继续使用」明确说明**换个模型就能用**。
 * 旧实现只认英文 `model busy / switch to other model` ⇒ 判成 `soft`（账号级）
 * ⇒ **整个账号被关**，而实际上只需换模型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseResetAt, refineModelScoped } from '../src/gateway/server.ts'

const ZH_REAL =
  'rate_limited: 您的使用量已超出频率限制，将在 2026-10-21 13:16:46 UTC+8 重置，' +
  '您也可以切换其他模型继续使用。'

test('🔴 中文「将在 … 重置」必须解析出墙钟', () => {
  const at = parseResetAt(ZH_REAL)
  assert.ok(at !== undefined, '中文文案的重置时刻不能被丢弃')
  // 2026-10-21 13:16:46 UTC+8 == 2026-10-21T05:16:46Z
  assert.equal(new Date(at).toISOString(), '2026-10-21T05:16:46.000Z')
})

test('英文旧格式仍然可用（不能为了支持中文而退化）', () => {
  const at = parseResetAt('your usage will reset at 2026-10-05 14:47:23 UTC+8')
  assert.equal(new Date(at).toISOString(), '2026-10-05T06:47:23.000Z')
})

test('⚠️ 措辞再变也能兜底：只要有 日期时间 + UTC 偏移', () => {
  const at = parseResetAt('额度 2026-10-22 09:00:00 UTC+8 恢复')
  assert.equal(new Date(at).toISOString(), '2026-10-22T01:00:00.000Z')
})

test('时区偏移必须按文案换算，不能用运行时本地时区', () => {
  const plus8 = parseResetAt('将在 2026-10-21 13:16:46 UTC+8 重置')
  const minus5 = parseResetAt('将在 2026-10-21 13:16:46 UTC-5 重置')
  assert.ok(plus8 !== undefined && minus5 !== undefined)
  // UTC+8 与 UTC-5 相差 13 小时
  assert.equal((minus5 - plus8) / 3600000, 13)
})

test('没有时间信息的限流文案：返回 undefined（回落本地退避）', () => {
  assert.equal(parseResetAt('rate limited, try later'), undefined)
  assert.equal(parseResetAt(''), undefined)
})

test('🔴 中文「可切换其他模型」必须判成**模型级**（不能关整个账号）', () => {
  const r = refineModelScoped('rate_limited', ZH_REAL)
  assert.equal(r.dimension, 'model', '模型级限流只该换模型，不该关账号')
  assert.ok(r.resetAt !== undefined, '且必须带上上游给的重置时刻')
})

test('⚠️ 真·账号级限流不得被误判成模型级', () => {
  const r = refineModelScoped('rate_limited', '{"code":14017,"msg":"too many requests"}')
  assert.equal(r.dimension, 'soft', '泛泛的 too many requests 是账号级')
})

test('英文模型忙仍判模型级（回归）', () => {
  const r = refineModelScoped(
    'rate_limited',
    '{"code":6004,"msg":"model busy, switch to the other model"}',
  )
  assert.equal(r.dimension, 'model')
})
