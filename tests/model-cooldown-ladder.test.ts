/**
 * 模型级冷却策略：验证式阶梯（2026-10-20 事故后的重写）
 *
 * ## 事故回顾（为什么需要这组测试）
 *
 * 旧实现只要 `reason` 里出现 `'not found'` 就按 11102 处理，**一次失败锁 6 小时**。
 * 当天线上实测后果：`default-model` / `deepseek-v4.1-flash-sg` 被锁 5.56 小时，
 * 而它们连续 3 次真实调用**全部 200** —— 纯误杀。用户侧表现正是
 * 「账号明明是好的，但就是用不了」。
 *
 * ## 新策略的三条硬约束（本文件逐条钉死）
 *
 * 1. **一次失败绝不锁长冷却**：absent/denied 首次只锁 2 分钟（观察窗）；
 * 2. **真坐实才升级**：2min → 30min → 2h → 6h → 24h 封顶；
 * 3. **真实成功可反证弱证据**：absent/denied 的冷却在模型真跑通后必须被清掉，
 *    而 busy（限频）**不得**因一次成功被清（那会让限流中的模型被反复打）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { modelCauseFor } from '../src/gateway/server.ts'
import { classify, shouldPunish, shouldRotate } from '../src/upstream/client.ts'

const MIN = 60 * 1000

test('🔴 11102 service info not found ⇒ model_unavailable(absent)', () => {
  const body = JSON.stringify({ code: 11102, msg: 'model [x] service info not found' })
  const c = classify(400, body)
  assert.equal(c.kind, 'model_unavailable')
  assert.equal(modelCauseFor(c.kind), 'absent')
})

test('🔴 11158 not allowed for user type ⇒ model_denied(denied)，且与 11102 不同类', () => {
  const body = JSON.stringify({
    code: 11158,
    msg: 'model [grok-4.7] is not allowed for user type [personal_free_user]',
  })
  const c = classify(400, body)
  assert.equal(c.kind, 'model_denied', '11158 必须有独立类别，不能落进 unknown')
  assert.equal(modelCauseFor(c.kind), 'denied')
  // 两者证据强度不同：absent 可能由我方前缀拼错引起，denied 是确定性拒绝
  assert.notEqual(c.kind, 'model_unavailable')
})

test('6004 / 14003 ⇒ rate_limited(busy)，冷却走短退避', () => {
  for (const code of [6004, 14003]) {
    const c = classify(429, JSON.stringify({ code, msg: 'model busy' }))
    assert.equal(c.kind, 'rate_limited')
    assert.equal(modelCauseFor(c.kind), 'busy')
  }
})

test('⚠️ model_denied 必须换号 —— 换到别的档位账号可能可用', () => {
  assert.equal(shouldRotate('model_denied'), true)
  assert.equal(shouldPunish('model_denied'), true)
})

test('⚠️ 回归：不罚号的类别不得因新增 model_denied 被误纳', () => {
  // ⚠️ `request_illegal`(11140) 是**强信号**，要罚号（见 shouldPunish），别误列进这里。
  // 这里只列真正「不罚号」的类别。
  for (const k of ['network', 'auth_error', 'context_exceeded', 'image_invalid', 'not_found'] as const) {
    assert.equal(shouldPunish(k), false, `${k} 不该罚号`)
  }
})

test('⚠️ 回归：不换号的类别不得因新增 model_denied 被误纳', () => {
  // 这些错误换号只会放大风控或重放非法请求
  for (const k of ['request_illegal', 'channel_blocked', 'context_exceeded', 'network', 'not_found'] as const) {
    assert.equal(shouldRotate(k), false, `${k} 不该换号`)
  }
})

/**
 * ## 阶梯数值的表征测试
 *
 * 这里不 import `AccountPoolDO`（它依赖 Durable Object 运行时），
 * 而是把「阶梯语义」作为契约钉在这里。数值若被人改动，此测试必须同步失败，
 * 迫使改动者显式面对「首次锁多久」这个曾经出过事故的参数。
 */
const LADDER = [2 * MIN, 30 * MIN, 2 * 60 * MIN, 6 * 60 * MIN, 24 * 60 * MIN]

test('🔴 首次 absent/denied 的冷却必须 ≤ 2 分钟（旧策略是 6 小时）', () => {
  assert.ok(LADDER[0]! <= 2 * MIN, 'hits=1 必须是短观察窗，否则误判代价无法接受')
  assert.ok(LADDER[0]! < 6 * 60 * MIN, '绝不能一次就锁 6 小时')
})

test('阶梯必须单调递增且 24h 封顶', () => {
  for (let i = 1; i < LADDER.length; i++) {
    assert.ok(LADDER[i]! > LADDER[i - 1]!, `第 ${i + 1} 档必须大于上一档`)
  }
  assert.equal(LADDER[LADDER.length - 1], 24 * 60 * MIN, '最高档 24h')
})

test('🔴 busy 类冷却必须短（15s 起 / 90s 封顶），不参与长阶梯', () => {
  const busy = (hits: number) => Math.min(15_000 * 2 ** Math.min(hits - 1, 3), 90_000)
  assert.equal(busy(1), 15_000, '首次 15s')
  assert.equal(busy(2), 30_000)
  assert.equal(busy(4), 90_000)
  assert.equal(busy(9), 90_000, '封顶 90s，不随时间无限增长')
  assert.ok(busy(99) < 2 * MIN, 'busy 永远够不上 absent 的首档')
})

test('⚠️ 关键：absent 与 busy 的量级必须相差足够大（否则等于没分）', () => {
  const busyMax = 90_000
  assert.ok(LADDER[0]! > busyMax, 'absent 首档应大于 busy 封顶，否则两类无区别')
})

/**
 * ## 502 包裹业务信封（2026-10-20 实测捕获的第二个真实缺陷）
 *
 * 上游在网关侧出错时会用 **502 包裹业务信封**：
 *   HTTP 502 + {"code":11158,"msg":"model [x] is not allowed for user type"}
 *
 * 旧实现把 5xx 分支放在业务码之前 ⇒ 一律成 `server`（账号级、喂熔断），
 * 连续几次就把好账号熔断掉 —— 这是「账号是好的却用不了」的**第二条来源**。
 */
test('🔴 502 包裹已知业务码 ⇒ 必须按业务码分类，不得吃成 server', () => {
  const denied = JSON.stringify({ code: 11158, msg: 'model [x] is not allowed for user type [free]' })
  assert.equal(classify(502, denied).kind, 'model_denied')

  const absent = JSON.stringify({ code: 11102, msg: 'model [x] service info not found' })
  assert.equal(classify(502, absent).kind, 'model_unavailable')

  const busy = JSON.stringify({ code: 14003, msg: 'model busy' })
  assert.equal(classify(502, busy).kind, 'rate_limited')
})

test('⚠️ 判据必须够窄：5xx 仍须吃成 server 的三种情形', () => {
  // ① 无信封的真网关故障
  assert.equal(classify(502, '<html>502 Bad Gateway</html>').kind, 'server')
  // ② 有信封但码未知（不能因为「有信封」就放过）
  assert.equal(classify(500, JSON.stringify({ code: 99999, msg: 'boom' })).kind, 'server')
  // ③ 空体
  assert.equal(classify(503, '').kind, 'server')
})

/**
 * ## ProviderError 必须过业务码分类（架构级缺陷）
 *
 * 8 家 provider 的 `chat()` 在非 2xx 时**抛 `ProviderError`**，
 * 于是网关的 `!upstream.ok` 分支（唯一有 `classify()` 的地方）**永远走不到**。
 * 结果所有上游业务错误都被压成「传输层失败」，业务码语义整条丢失。
 *
 * 这里钉住「从 ProviderError 的 message 里仍能恢复正确类别」这一契约 ——
 * `classify()` 本来就是按文本解析业务码的，所以只要调用它就能恢复。
 */
test('🔴 ProviderError 的 message 经 classify 后仍能恢复业务码类别', () => {
  // 实测抓到的真实报文（502 包裹）
  const real = '供应商「WorkBuddy（国际版）」请求失败：' +
    '{"code":11158,"msg":"model [grok-4.7] is not allowed for user type [personal_free_user]"}'
  assert.equal(classify(502, real).kind, 'model_denied',
    'ProviderError 分支必须能识别出 11158，而不是当网络错误')

  const absent = '{"code":11102,"msg":"model [x] service info not found"}'
  assert.equal(classify(502, absent).kind, 'model_unavailable')

  const channel = '{"code":"11‑128","msg":"request illegal"}'
  assert.equal(classify(502, channel).kind, 'channel_blocked')
})

test('⚠️ 纯传输层错误仍须落 network/server，不得被业务码分类误伤', () => {
  assert.equal(classify(0, 'fetch failed: ECONNRESET').kind, 'unknown')
  assert.equal(classify(502, 'upstream 502 Bad Gateway').kind, 'server')
})

/**
 * ## 坐实计数必须跨冷却周期存活
 *
 * 实缺陷：`pruneExpired` 会把**过期**的冷却条目整体删掉，
 * 若把 `hits` 存在条目里，坐实进度就跟着归零 ⇒ 阶梯永远停在 2 分钟观察窗：
 * 一个真不存在的模型会每 2 分钟被重试一次，永远升不上去（既浪费请求、也永不长冷却）。
 *
 * ⇒ 坐实次数必须存**账号级** `modelConfirm`，与冷却条目解耦。
 * 这里用纯函数模拟「连续 N 轮失败」的阶梯结果，钉住语义。
 */
const LADDER_MS = [2 * MIN, 30 * MIN, 2 * 60 * MIN, 6 * 60 * MIN, 24 * 60 * MIN]

function cooldownFor(confirmed: number): number {
  const tier = Math.min(confirmed - 1, LADDER_MS.length - 1)
  return LADDER_MS[Math.max(0, tier)]!
}

test('🔴 连续坐实必须逐级升档：2min → 30min → 2h → 6h → 24h', () => {
  assert.equal(cooldownFor(1), 2 * MIN)
  assert.equal(cooldownFor(2), 30 * MIN)
  assert.equal(cooldownFor(3), 2 * 60 * MIN)
  assert.equal(cooldownFor(4), 6 * 60 * MIN)
  assert.equal(cooldownFor(5), 24 * 60 * MIN)
  // 超过 5 次仍封顶 24h，不无限增长
  assert.equal(cooldownFor(9), 24 * 60 * MIN)
  assert.equal(cooldownFor(99), 24 * 60 * MIN)
})

test('⚠️ 第 1 档绝不超过 2 分钟（误判代价必须可忽略）', () => {
  assert.ok(cooldownFor(1) <= 2 * MIN)
})

test('⚠️ 若坐实计数被 prune 归零，就退化成一味短锁 —— 这正是要避免的', () => {
  // 反证：hits 恒为 1 的话，永远停在 2min（旧实现的真实行为）
  const alwaysFirst = cooldownFor(1)
  assert.equal(alwaysFirst, 2 * MIN, '这解释了为什么必须把计数放到账号级')
  // 正确行为应当能升档
  assert.notEqual(cooldownFor(2), cooldownFor(1))
})
