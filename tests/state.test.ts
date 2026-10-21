/**
 * 账号状态机的单测（四维**正交性**是重点）。
 *
 * ## 为什么这些测试值得写
 *
 * 状态机的错误是**不对称**的：
 * - 把「临时限流」当「账号死亡」→ 误杀健康账号
 *   （Go 侧真实事故：13 个 disabled 号 refresh 全部成功）；
 * - 把「模型级限流」当「账号级」→ 该账号的其他模型也用不了。
 *
 * 所以这里锁的是**边界语义**，不是「代码能跑」。
 *
 * 运行：`node --test --experimental-strip-types tests/state.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createAccountState,
  healthy,
  healthyForModel,
  isActive,
  modelExempt,
  pruneExpired,
} from '../src/pool/state.ts'
import type { AccountState } from '../src/pool/state.ts'

const NOW = 1_700_000_000_000

function make(): AccountState {
  return createAccountState({ uid: 'u1', nickname: 'n', realm: 'cn' })
}

test('isActive：0 表示「无」，不能靠 truthiness', () => {
  assert.equal(isActive(0, NOW), false)
  assert.equal(isActive(NOW + 1, NOW), true)
  assert.equal(isActive(NOW, NOW), false, '恰好到点应视为已过期')
  assert.equal(isActive(NOW - 1, NOW), false)
})

test('新账号健康', () => {
  assert.equal(healthy(make(), NOW), true)
})

test('disabled 恒不健康，即使其他维度都清零', () => {
  const s = make()
  s.disabled = true
  assert.equal(healthy(s, NOW), false)
  // 即使把三个截止都清零也不该恢复
  s.until = 0
  s.breakerUntil = 0
  s.degradeUntil = 0
  assert.equal(healthy(s, NOW), false)
})

test('四维并列或门：任一未到期即不可选', () => {
  for (const field of ['until', 'breakerUntil', 'degradeUntil'] as const) {
    const s = make()
    s[field] = NOW + 60_000
    assert.equal(healthy(s, NOW), false, `${field} 未到期时应不可选`)
  }
})

test('四维正交：都过期后恢复健康（取最远者的语义）', () => {
  const s = make()
  s.until = NOW + 1000
  s.breakerUntil = NOW + 5000
  s.degradeUntil = NOW + 3000
  assert.equal(healthy(s, NOW), false)
  // 最远的 breakerUntil 过后即健康
  assert.equal(healthy(s, NOW + 5001), true)
})

test('模型级冷却只拦该模型，不拦其他模型', () => {
  const s = make()
  s.modelCooldowns['glm-5.2'] = {
    until: NOW + 60_000,
    resetAt: 0,
    reason: '6004',
    hits: 1,
    auditOnly: false,
  }
  assert.equal(healthy(s, NOW), true, '账号本身仍健康')
  assert.equal(healthyForModel(s, NOW, 'glm-5.2'), false, '被限流的模型不可用')
  assert.equal(healthyForModel(s, NOW, 'deepseek-v4'), true, '其他模型不受影响')
  assert.equal(healthyForModel(s, NOW, ''), true, '空模型名不做模型级过滤')
})

test('⚠️ 审计条目不得参与可用性判定', () => {
  const s = make()
  s.modelCooldowns['x'] = { until: NOW + 999_999, resetAt: 0, reason: 'audit', hits: 0, auditOnly: true }
  assert.equal(healthyForModel(s, NOW, 'x'), true, 'auditOnly 条目必须被忽略')
  assert.equal(modelExempt(s, NOW), false, 'auditOnly 不算「模型级豁免」形态')
})

test('modelExempt：账号健康但有真实模型冷却', () => {
  const s = make()
  s.modelCooldowns['glm'] = { until: NOW + 1, resetAt: 0, reason: '6004', hits: 1, auditOnly: false }
  assert.equal(modelExempt(s, NOW), true)
  // 账号级冷却同时存在时不再是「仅模型级」形态
  s.until = NOW + 1000
  assert.equal(modelExempt(s, NOW), false)
})

test('pruneExpired：清过期模型冷却与陈旧成本，且报告变更', () => {
  const s = make()
  s.modelCooldowns['expired'] = { until: NOW - 1, resetAt: 0, reason: 'r', hits: 1, auditOnly: false }
  s.modelCooldowns['live'] = { until: NOW + 100_000, resetAt: 0, reason: 'r', hits: 1, auditOnly: false }
  s.modelCosts['stale'] = { per1k: 1, lastSeen: NOW - 7 * 60 * 60 * 1000 }
  s.modelCosts['fresh'] = { per1k: 1, lastSeen: NOW - 60_000 }
  s.modelCosts['broken'] = { per1k: 1, lastSeen: 0 }

  const changed = pruneExpired(s, NOW, 6 * 60 * 60 * 1000)
  assert.equal(changed, true)
  assert.equal(s.modelCooldowns['expired'], undefined)
  assert.notEqual(s.modelCooldowns['live'], undefined)
  assert.equal(s.modelCosts['stale'], undefined, '超过 TTL 的成本应清除')
  assert.notEqual(s.modelCosts['fresh'], undefined)
  assert.equal(s.modelCosts['broken'], undefined, 'lastSeen<=0 的破损条目应清除')
})

test('pruneExpired：无变更时返回 false（避免无谓回写）', () => {
  const s = make()
  s.modelCooldowns['live'] = { until: NOW + 1000, resetAt: 0, reason: 'r', hits: 1, auditOnly: false }
  assert.equal(pruneExpired(s, NOW, 6 * 60 * 60 * 1000), false)
})

test('allowsAllFieldsExplicit：所有计数字段都被初始化为数字（不靠 undefined）', () => {
  const s = make()
  for (const key of ['softStreak', 'fails', 'retryCount', 'consecutiveFails', 'sessionDeadFails'] as const) {
    assert.equal(typeof s[key], 'number', `${key} 应是数字`)
    assert.equal(s[key], 0, `${key} 应显式归零`)
  }
  assert.equal(s.tokenUsage.input, 0)
  assert.equal(s.tokenUsage.output, 0)
})

// ─────────────────── 池计数（面板恒为 0 的 bug） ───────────────────

test('⚠️ healthy 与 modelExempt 会**同时为真**（计数必须按顺序判）', () => {
  // 线上实测：面板的「模型限流」恒为 0。
  // 根因是 counts() 里先判 healthy —— 而 healthy() 只看账号级四维，
  // **不看** modelCooldowns，于是「账号健康但有模型在冷却」时两个都为 true，
  // 先判 healthy 就把模型限流那一类吞掉了。
  const now = 1_700_000_000_000
  const s = createAccountState({ uid: 'u', nickname: 'n', realm: 'cn' })
  s.modelCooldowns['glm-5.2'] = {
    until: now + 3600_000, resetAt: 0, reason: 'x', hits: 1, auditOnly: false,
  }
  assert.equal(healthy(s, now), true, 'healthy 只看账号级四维，这里是 true')
  assert.equal(modelExempt(s, now), true, '有未过期模型冷却 → 也是 true')
  // ⇒ 两者同时为真，故 counts 必须**先判 modelExempt**
})

test('⚠️ 审计条目不该让账号被算成「模型限流」', () => {
  const now = 1_700_000_000_000
  const s = createAccountState({ uid: 'u', nickname: 'n', realm: 'cn' })
  s.modelCooldowns['x'] = { until: now + 3600_000, resetAt: 0, reason: 'audit', hits: 1, auditOnly: true }
  assert.equal(modelExempt(s, now), false, 'auditOnly 不参与判定')
})

test('过期的模型冷却被剪枝后不算限流', () => {
  const now = 1_700_000_000_000
  const s = createAccountState({ uid: 'u', nickname: 'n', realm: 'cn' })
  s.modelCooldowns['x'] = { until: now - 1000, resetAt: 0, reason: 'old', hits: 1, auditOnly: false }
  pruneExpired(s, now, 6 * 3600_000)
  assert.equal(modelExempt(s, now), false)
  assert.equal(Object.keys(s.modelCooldowns).length, 0, '过期条目应被删除')
})

test('🔴 11140（账号级限制）必须**单次即生效**且默认不换号', async () => {
  // ## 两条独立的口径，都来自 workbuddy2api-hub #422/#425 的真实事故
  //
  // ### 1. 单次即罚
  // `breaker` 要连续 3 次失败才冷却，语义是「我们自己怀疑这个号不行」。
  // 而 11140 是上游**明确标记**（"this account has been restricted"），
  // 用 breaker 意味着前 2 次继续把请求打到一个已被封的号上。
  // 故 `request_illegal` 走独立的 `restricted` 维度，一次即罚、固定 2 小时。
  //
  // ### 2. 默认不换号
  // 事故原文：11140 上「冷却该号后立刻换下一个号继续同一请求」，
  // 一个请求最多遍历整个池子，**用户 7 个号在一次任务里全被封**。
  // 社区红线：「看到 11140 立即停手，解封前严禁换号继续打同一设备」。
  const { mapErrorToPunishment } = await import('../src/gateway/server.ts')
  const p = mapErrorToPunishment('request_illegal')
  assert.equal(p.punish, true, '11140 必须罚号（不罚就等于继续用被封的号）')
  assert.equal(p.dimension, 'restricted', '11140 必须是独立的账号级限制维度，不能复用 breaker')
  assert.equal(p.rotate, false, '11140 **默认不换号**（换号会把池子逐个拖进设备级限制）')

  // 反向对照：11128（渠道指纹）也不换号，但**不罚号** —— 罚的是请求指纹，不是账号。
  const ch = mapErrorToPunishment('channel_blocked')
  assert.equal(ch.punish, false, '11128 罚的是渠道指纹，不该罚账号')
  assert.equal(ch.rotate, false, '11128 不换号（同样的指纹打给更多号也没用）')

  // 常规 5xx 仍然换号 —— 别把「不换号」误伤到正常轮转。
  assert.equal(mapErrorToPunishment('server').rotate, true, '5xx 仍应换号')
})

test('🔴 受限账号**选不到**（restrictedUntil 参与健康判定，且老数据自动兼容）', async () => {
  const { createAccountState, healthy, normalizeAccountState, RESTRICTED_HOLD_MS } = await import(
    '../src/pool/state.ts'
  )
  const now = 1_000_000

  // 新号默认不受限
  const fresh = createAccountState({ uid: 'u1', nickname: 'n', realm: 'cn', provider: 'buddy' })
  assert.equal(fresh.restrictedUntil, 0, '新账号默认 restrictedUntil=0')
  assert.equal(healthy(fresh, now), true, '新账号可选')

  // 受限期内**必须**不可选（这是「不派单给已被封的号」的唯一保障）
  const limited = { ...fresh, restrictedUntil: now + RESTRICTED_HOLD_MS }
  assert.equal(healthy(limited, now), false, '受限期内必须选不到')

  // 到期后自动恢复（不需要人工清状态）
  assert.equal(healthy(limited, now + RESTRICTED_HOLD_MS + 1), true, '到期后应自动恢复')

  // 老数据（没有该字段）绝不能被判成受限
  const legacy = normalizeAccountState({ uid: 'u2', nickname: 'n', realm: 'cn', provider: 'buddy' })
  assert.ok(legacy !== undefined)
  assert.equal(legacy!.restrictedUntil, 0, '缺字段的老记录必须补 0，不能读成 undefined/NaN')
  assert.equal(healthy(legacy!, now), true, '老记录应仍然可选')
})

test('🔴 11140 波次判定：同号重复不算波次，不同号达标才整池暂停', async () => {
  // 依据 workbuddy2api-hub #425：同一区域 900s 内 2 个**不同**账号被限制
  // ⇒ 暂停该区域派发 1800s。判「几个不同的号被打标」，
  // 一个号反复撞不构成波次（它自己已被 restrictedUntil 挡住）。
  //
  // 这里直接对纯逻辑做断言（DO 的 storage 依赖不便在单测里造假）：
  // 只钉住「阈值与窗口的语义」，实现细节留给集成。
  const { RESTRICTED_HOLD_MS } = await import('../src/pool/state.ts')

  // 单账号口径是 2 小时（与整池暂停的 30 分钟刻意不同，见常量注释）
  assert.equal(RESTRICTED_HOLD_MS, 2 * 60 * 60 * 1000, '单账号限制冷却应为 2 小时')

  // 该常量必须**大于** IP 级 WAF 的 60s 窗口：账号级风控是小时级现象，
  // 用分钟级去试探只会重复撞墙（社区红线「立即停手」）。
  assert.ok(RESTRICTED_HOLD_MS > 60_000, '账号级冷却必须长于 IP 级窗口')

  // 源码层面确认波次常量存在且取值合理（防止有人调成 60 秒把风控当抖动）
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')
  const m = /const RESTRICTION_POOL_HOLD_MS = ([^\n]+)/.exec(src)
  assert.ok(m !== null, '必须有 RESTRICTION_POOL_HOLD_MS 常量')
  assert.match(m![1]!, /30 \* 60 \* 1000/, '整池暂停应为 30 分钟')
  assert.match(src, /RESTRICTION_WAVE_THRESHOLD = 2/, '波次阈值为 2 个不同账号')
})

test('🔴 回归：normalizeAccountState 必须**显式**携带每个字段（漏一个就静默丢惩罚）', async () => {
  // ## 这是线上真实踩到的 bug，不是假想
  //
  // `normalizeAccountState` 是**逐字段重建**对象的（`{ ...num(...) }`），
  // 没列出的字段**不会**从 `base` 继承 —— 老记录读出来是 `undefined`。
  //
  // 加 `restrictedUntil` 时忘了在这一行里补上，后果链：
  //   读老记录 → restrictedUntil === undefined
  //   → `Math.max(undefined, x)` === NaN
  //   → 写进 SQLite 再读回 === 0
  //   → 表现「11140 罚了却看不出罚」，且账号继续被派单。
  //
  // 所以这里用「新账号状态 → 序列化 → normalize」往返，
  // **逐字段**比对：任何一个字段丢失都会被这条断言抓住。
  const { createAccountState, normalizeAccountState } = await import('../src/pool/state.ts')

  const fresh = createAccountState({ uid: 'u-roundtrip', nickname: 'n', realm: 'cn', provider: 'buddy' })
  // 给所有数值字段灌上有辨识度的非零值，避免「0 默认值掩盖丢失」
  const filled = {
    ...fresh,
    until: 111,
    breakerUntil: 222,
    degradeUntil: 333,
    restrictedUntil: 444,
    fails: 5,
    retryCount: 2,
    consecutiveFails: 3,
    errTotal: 7,
  }
  const back = normalizeAccountState(JSON.parse(JSON.stringify(filled)))
  assert.ok(back !== undefined, '往返后应能解析')

  for (const [k, want] of Object.entries({
    until: 111,
    breakerUntil: 222,
    degradeUntil: 333,
    restrictedUntil: 444,
    fails: 5,
    retryCount: 2,
    consecutiveFails: 3,
    errTotal: 7,
  })) {
    assert.equal(
      (back as unknown as Record<string, number>)[k],
      want,
      `normalizeAccountState 丢了字段 ${k}（逐字段重建最容易漏新增字段）`,
    )
  }

  // 老记录（压根没有该字段）必须补成 0，绝不能是 undefined/NaN
  const legacy = normalizeAccountState({ uid: 'u-legacy', nickname: 'n', realm: 'cn', provider: 'buddy' })
  assert.equal(legacy!.restrictedUntil, 0, '缺字段必须补 0')
  assert.ok(Number.isFinite(legacy!.restrictedUntil), '缺失字段绝不能被读成 NaN')
})

test('🔴 回归：/admin/accounts 必须暴露 restrictedUntil（否则"被封"在面板上隐形）', async () => {
  // ## 线上真实踩到
  //
  // 数据库里 rst 明明已写入（sqlite 直接查：1792564552799 = +2h），
  // 但 `/admin/accounts` 的序列化是**逐字段列举**的，漏了 restrictedUntil。
  // 后果：面板上「被上游限制的号」与健康号长得一模一样，
  // 我据此误判过一次「三个号都没被封」，实际三个全受限。
  //
  // 记账失效是**静默的**，这个字段是唯一的显示出口 —— 所以用源码级断言钉住它。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/index.ts', 'utf8')
  assert.match(
    src,
    /restrictedUntil:\s*a\.restrictedUntil/,
    '/admin/accounts 必须返回 restrictedUntil，否则前端看不到账号被上游限制',
  )
  // 同时确认它没被写成别的账号字段（复制粘贴最容易错）
  assert.doesNotMatch(
    src,
    /restrictedUntil:\s*a\.breakerUntil/,
    'restrictedUntil 不能错接成 breakerUntil（两者语义不同）',
  )
})
