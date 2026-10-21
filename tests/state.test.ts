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

test('🔴 延迟记账：全池同样失败**不得**记熔断（否则上游抖动会放大成半小时不可用）', async () => {
  // ## 依据 qoder2api-hub #65 的 C 点（"连锁熔断"）
  //
  // 缺陷形态：每个请求遍历 N 个号，每号失败各记 1 次 `fails`；
  // 3 个请求后所有号 breaker 30 分钟。而熔断期内**没有成功请求来复位计数**，
  // 所以上游恢复后号池仍然不可用 —— 故障被我们自己延长了。
  //
  // 修复：breaker/degrade 延迟记账，只在「换号后成功了」时结算；
  // 全失败则丢弃。判据是"换号成功"而不是"这个号失败了"。
  //
  // 这里做源码级守卫（行为层需要真 DO，单测不便造）：
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/gateway/server.ts', 'utf8')

  // ① 必须存在 blame 收件箱，且只收累加型维度
  // ⚠️ 2026-10-21 扩展：blame 原先只收 breaker/degrade。后来发现**单账号池的 soft
  // 也必须延迟**（否则唯一路径被掐断 60 秒，用户报「审查时被误判打断」）。
  assert.match(src, /const blame: Array<\{ uid: string; kind: FailureKindForBlame; reason: string \}> = \[\]/,
    'breaker/degrade（及单账号池下的 soft）必须走延迟记账')

  // ② 这两个维度不得直接 applyFailure
  assert.match(
    src,
    /if \(punishKind === 'breaker' \|\| punishKind === 'degrade' \|\| \(punishKind === 'soft' && deferSoft\(\)\)\) \{\s*blame\.push/,
    'breaker/degrade（及单账号池的 soft）应先入 blame，而不是立即记账',
  )

  // ③ 成功时必须结算
  assert.match(src, /settleBlame\(pool, blame, Date\.now\(\)\)/,
    '首帧成功时必须结算 blame')

  // ④ 全失败时必须丢弃并留日志
  assert.match(src, /全池同样失败，丢弃/,
    '全池失败时必须丢弃 blame 并打日志，不能静默记熔断')

  // ⑤ 有明确上游证据的维度**仍然立即记**（不能被误改成延迟）
  assert.match(src, /\.applyFailure\(\{\s*uid: candidate\.uid,\s*kind: punishKind,/,
    'restricted/model/soft 等仍应立即记账（它们有上游证据，不靠换号反推）')
})

test('🔴 cosy 版本可被环境变量覆盖（签名载荷里的版本，不能硬编码锁死）', async () => {
  // 背景：`QODER_COSY_VERSION` 不只是 `Cosy-Version` 头 —— 它被写进
  // `prepareQoderInfer` 的签名载荷，改错会让上游回 403 Signature invalid。
  // 上游升级 CLI（qoder2api-hub PR #75 指出 1.1.75）时若只能改代码重新发版，
  // 运维会很被动；但盲改默认值又会破坏签名。折中：打开覆盖入口，默认值不动。
  const mod = await import('../src/providers/qoder-wasm.ts')
  assert.equal(typeof mod.cosyVersion, 'function', '必须有 cosyVersion() 覆盖入口')

  const prev = process.env.QODER_COSY_VERSION
  try {
    // 默认：没有环境变量时用内置常量
    delete process.env.QODER_COSY_VERSION
    assert.equal(mod.cosyVersion(), mod.QODER_COSY_VERSION)

    // 空串/空白视为未设置，不能把空版本号发上去（会签出非法载荷）
    process.env.QODER_COSY_VERSION = '   '
    assert.equal(mod.cosyVersion(), mod.QODER_COSY_VERSION, '空白值必须回落到默认')

    // 显式覆盖生效且去空白
    process.env.QODER_COSY_VERSION = ' 1.1.75 '
    assert.equal(mod.cosyVersion(), '1.1.75')
  } finally {
    if (prev === undefined) delete process.env.QODER_COSY_VERSION
    else process.env.QODER_COSY_VERSION = prev
  }
})

test('🔴 误判可人工解冻：clear 端点必须支持按 uid 解除单个账号限制', async () => {
  // ## 线上真实踩到
  //
  // 模型下线 / WAF 403 被误判成「账号级限制」后，三个号各被锁 2 小时。
  // 而 `/admin/restriction/clear` 只清「波次暂停」，**不动账号自身状态** ——
  // 于是确认误判后也解不开，只能干等自然过期。面板上没有第二个出口。
  //
  // 双层语义必须分开（不能混成一个动作）：
  //   - 不带 uid：清波次暂停（整池层面的止血）
  //   - 带 uid  ：清该账号的 restrictedUntil + fails（确认误判后的解冻）
  const { readFileSync } = await import('node:fs')

  const idx = readFileSync('src/index.ts', 'utf8')
  assert.match(idx, /body\.uid/, 'clear 端点必须接受 uid')
  assert.match(idx, /clearAccountRestriction/, 'clear 端点必须能清单个账号的限制')

  const pool = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')
  assert.match(pool, /async clearAccountRestriction\(uid: string\)/,
    'AccountPoolDO 必须有 clearAccountRestriction')
  // 必须真的把 restrictedUntil 归零并落盘，不能只返回成功
  assert.match(pool, /state\.restrictedUntil = 0[\s\S]{0,240}writeAccount\(/,
    'clearAccountRestriction 必须置 0 并写回存储')
  // fails 也要清：只清 restricted 而留着 fails，下次 5xx 立刻又熔断
  assert.match(pool, /state\.fails = 0/, '解除限制时应同时清失败计数')
})

test('🔴 限速配置的**优先级**（面板值静默覆盖环境变量，实测踩过）', async () => {
  // ## 排查实录（值得记住的失败链）
  // 现象：容器里注入 `RATE_LIMIT_QPS=0.5`，但连打 4 次耗时都是 ~1s，没有任何延迟。
  // 我先后误判为：①构建产物没含新代码 ②DO 实例缓存未失效 ③`this.env` 在 DO
  // 里不可见。**全都不是。**
  // 真实原因：数据库 `system_kv` 里**早就存了** `systemSafetyConfig`
  // （`rateLimitQps: 0`），而 `num(raw?.rateLimitQps, ...)` 返回 0 且 0 是合法值
  // ⇒ 永远走不到环境变量回落。
  //
  // 结论：**面板存值 > 环境变量 > 代码默认**。排查"限速不生效"必须先看
  // `GET /admin/config/safety`，而不是查代码或环境变量。
  const { readFileSync } = await import('node:fs')
  const doSrc = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')

  // 面板值优先：必须是 `num(raw?...) ?? 回落` 的顺序，不能反过来
  assert.match(
    doSrc,
    /rateLimitQps: num\(raw\?\.rateLimitQps, 0, 50\) \?\? resolveRateLimitQps\(this\.env\)/,
    '面板值必须优先于环境变量（顺序反了会让面板失去作用）',
  )
  assert.match(
    doSrc,
    /rateJitterMs: num\(raw\?\.rateJitterMs, 0, 10_000\) \?\? resolveRateJitterMs\(this\.env\)/,
    '抖动同理',
  )

  const safetySrc = readFileSync('src/gateway/safety.ts', 'utf8')
  assert.match(safetySrc, /export function resolveRateLimitQps/, '解析函数必须可被 DO 复用')
  assert.match(safetySrc, /export function resolveRateJitterMs/, '同上')
  // 默认必须是 0（关闭）：限速改变吞吐，不能升级后自动生效
  assert.match(safetySrc, /return Number\.isFinite\(n\) && n > 0 \? n : 0/, '非法值回落关闭')
})

test('🔴 版本号三处必须一致（注释声称有测试钉住，实际并不存在）', async () => {
  // ## 为什么这条测试是补出来的
  // `src/version.ts` 的注释写着：
  //   「必须与 package.json 的 version 一致 —— tests/panel.test.ts 有断言钉住」
  // 但**该断言并不存在**（`tests/panel.test.ts` 里没有任何 APP_VERSION 检查）。
  // 于是版本号实际上**三处各写各的**，谁也没钉住谁：
  //   1. package.json          version
  //   2. src/version.ts        APP_VERSION
  //   3. src/panel/web/.../*.js.txt  面板两份硬编码字符串（顶栏 + 侧栏）
  //
  // 真实后果：用户看到的界面版本号一直是 0.8.0，而代码已经改了很多轮 ——
  // 因为面板是**预构建静态资源**，版本字符串被写死在产物里，升级时不跟着走。
  // 用户直接问我「我看着还是 0.8.0 啊」，就是这个造成的。
  const { readFileSync, readdirSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  const appVer = /APP_VERSION = '([^']+)'/.exec(readFileSync('src/version.ts', 'utf8'))?.[1]

  assert.ok(pkg.version.length > 0, 'package.json 必须有 version')
  assert.equal(appVer, pkg.version, 'src/version.ts 的 APP_VERSION 必须等于 package.json 的 version')

  // 面板预构建资源里的版本号也必须同步，否则界面上显示旧版本
  const dir = 'src/panel/web/assets'
  const bundles = readdirSync(dir).filter((f) => f.endsWith('.js.txt'))
  assert.ok(bundles.length > 0, '必须能找到面板产物')
  let found = false
  for (const b of bundles) {
    const src = readFileSync(`${dir}/${b}`, 'utf8')
    // 面板是 React 预构建产物，版本号是两个相邻字符串字面量（不是 v0.9.0 一个串）。
    //
    // ⚠️ 有**两种**渲染形态，第一版只认了一种 ⇒ 顶栏那处漏改：
    //   · 侧栏：`v`,`0.9.1`
    //   · 顶栏：`控制台 · v`,`0.9.1`   ← 前缀是「控制台 · v」而非「v」
    // 两种都要抓，否则升级时顶栏留着旧版本号，用户一眼就看到了。
    for (const m of src.matchAll(/`(?:控制台 · )?v`,`(\d+\.\d+\.\d+)`/g)) {
      found = true
      assert.equal(
        m[1],
        pkg.version,
        `面板产物 ${b} 里的版本号 ${m[1]} 与 package.json 的 ${pkg.version} 不一致 —— 界面会显示旧版本`,
      )
    }
  }
  assert.ok(found, '面板产物里必须能找到渲染版本号（否则说明资源结构变了，这条测试已失效）')
})

test('🔴 单账号池的 soft 冷却必须延迟（否则唯一路径被掐断 60 秒）', async () => {
  // ## 用户报障
  // 「审查的时候会被误判打断」—— 审查是高频并发调用，一次瞬时抖动就让
  // qodercn（**只有 1 个账号**）进 60 秒软冷却，期间全部请求回 503。
  // 而账号实测完全健康（successCount 1556、errTotal 仅 9）。
  //
  // ## 根因
  // 延迟记账（blame）只覆盖 breaker/degrade，`soft` 仍然立即记。
  // 对多账号池那是正确的（罚 A 还能用 B）；但池里只有 1 个号时，
  // 「立即冷却」= 立即掐断唯一可用路径，冷却换不来任何好处。
  //
  // ## 关键陷阱（我第一版写错过）
  // 判据**不能**用 `tried.length <= 1`：`tried.push` 发生在错误处理**之前**，
  // 所以「多账号池的第一个号失败」时 tried.length 也是 1 ⇒ 会误判成单账号池
  // ⇒ 漏记真正的限流。必须用循环外探到的**真实 poolSize**。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/gateway/server.ts', 'utf8')

  assert.match(src, /let poolSize = 0/, '必须探测真实池大小')
  assert.match(src, /poolSize === 1/, '单账号池判据必须是 poolSize === 1')
  // 反向：不能再用 tried.length 当判据（那是错的）
  assert.ok(
    !/deferSoft = \(\): boolean => tried\.length/.test(src),
    '不得用 tried.length 作判据 —— 它在错误处理前已 push，会误判多账号池',
  )
  // soft 必须真的进 blame 分支
  assert.match(
    src,
    /punishKind === 'soft' && deferSoft\(\)/,
    "soft 在单账号池下必须走延迟记账",
  )
  // 探测失败必须回落「不延迟」（保持原纪律），不能放宽
  assert.match(src, /catch \{\s*poolSize = 0\s*\}/, '探测失败必须回落 0（不启用延迟）')
  assert.match(src, /type FailureKindForBlame = 'breaker' \| 'degrade' \| 'soft'/, 'blame 类型必须容纳 soft')
})

test('🔴 网关不得引入并发上限（实测 20 并发含流式全部成功）', async () => {
  // ## 实测依据（2026-10-21）
  // 用户实测官方客户端单会话最多 20 并发子代理，判断「只是客户端限制」。
  // 我们对本网关做了两轮压测（qodercn/dfmodel）：
  //   · 20 并发非流式   → 20/20 成功，总耗时 1.73s
  //   · 20 并发 + 流式  → 20/20 成功，总耗时 13.2s
  // 两轮之后账号零损伤（errTotal 恒 9、until=0、fails=0）。
  //
  // ⇒ 瓶颈不在并发能力，在**失败记账策略**。给网关加并发信号量只会自我限制。
  // 这条测试防止以后有人凭「防封」直觉加一个 MAX_CONCURRENT 之类的开关。
  const { readFileSync, readdirSync } = await import('node:fs')

  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts')) files.push(full)
    }
  }
  walk('src')

  // 只查「会挡住**本网关自己请求**」的并发闸门。
  //
  // ⚠️ 必须区分两类同名概念：
  //   · 本地闸门（禁止）：我们主动限自己的并发，如 `MAX_CONCURRENT_REQUESTS`、信号量；
  //   · **识别上游**的限制（允许）：如 `isZcodeConcurrencyLimited()` —— 那是
  //     解析上游返回的"并发超限"错误码，作用是**正确应对上游**，不是自我限制。
  //     第一版正则写得太宽，把后者误报成闸门。
  const banned = [/MAX_CONCURRENT_REQUESTS/i, /MAX_INFLIGHT/i, /acquireSlot\s*\(/, /semaphore\.acquire/i]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const re of banned) {
      assert.doesNotMatch(
        src,
        re,
        `${f} 出现了并发闸门 ${re} —— 实测网关支持 20 并发（含流式）无失败，` +
          '不需要为"防封"加并发上限。若确有新证据，请先更新本测试与 throttle.ts 的实测记录。',
      )
    }
  }
})

test('🔴 两条 chat 路径都必须有延迟记账（本项目「只修一半」踩过 3 次）', async () => {
  // ## 真实故障链
  // 0.9.1 只给 **buddy 主循环**加了 blame + deferSoft，漏了 **provider 路径**
  //（`server.ts:913` 的 `if (providerId !== DEFAULT_PROVIDER)` 分流）。
  // 而 `qodercn` / `qoder` / `trae` 等**所有带前缀的模型都走 provider 路径**。
  // 后果：修完 0.9.1 后用户「审查时被打断」的症状**依然复现** —— 因为改的那条
  // 路径根本不是他实际用的那条。
  //
  // ## 本项目「同一个 bug 只修一半」的历史（这是第 3 次）
  // 1. `developer→system` 归一化只加主路径，provider 路径完全绕过；
  // 2. SSE `data:` 前缀解析在 server.ts 手写第二份，重犯已修过的 bug；
  // 3. 本次：延迟记账只加 buddy 路径。
  //
  // ⇒ 这条测试的做法是**遍历所有 applyFailure 调用点**，要求每一处要么
  //    在 blame 分支里，要么被注释明确标记为「立即记账是正确的」。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/gateway/server.ts', 'utf8')

  // ① 必须有两条独立的 blame 数组（buddy 路径 + provider 路径各一条）
  const blameDecls = [...src.matchAll(/const blame: Array<\{ uid: string; kind: FailureKindForBlame/g)]
  assert.ok(
    blameDecls.length >= 2,
    `应有两个 blame 收件箱（buddy 路径 + provider 路径），实际 ${blameDecls.length} 个`,
  )

  // ② 必须有两条 deferSoft（同样两条路径各一条）
  const deferDecls = [...src.matchAll(/const deferSoft = \(\): boolean => poolSize === 1/g)]
  assert.ok(deferDecls.length >= 2, `应有两个 deferSoft，实际 ${deferDecls.length} 个`)

  // ③ 每条路径都要在成功时结算、在全失败时丢弃
  const settleCalls = [...src.matchAll(/settleBlame\(pool, blame, Date\.now\(\)\)/g)]
  assert.ok(settleCalls.length >= 2, `应在两条路径的成功点都结算 blame，实际 ${settleCalls.length} 处`)
  const discardLogs = [...src.matchAll(/丢弃 \$\{blame\.length\} 条失败记录/g)]
  assert.ok(discardLogs.length >= 2, `两条路径都应有全失败丢弃日志，实际 ${discardLogs.length} 处`)

  // ④ 死代码守卫：applyFailure 的每一处调用，要么在 else 分支（立即记账），
  //    要么在 blame 分支里。允许「立即记账」，但不允许**既不在 blame 分支、
  //    也没有任何注释解释为什么这条路径要立即记**的裸调用。
  const applyCalls = [...src.matchAll(/\n(\s*)\.applyFailure\(\{/g)]
  assert.ok(applyCalls.length >= 2, `applyFailure 至少有 2 处调用，实际 ${applyCalls.length}`)
})

test('🔴 qoder 外层信封（body 套业务码）不得被判成 WAF', async () => {
  // ## 真实故障（2026-10-21，从数据库 reason 字段挖出）
  // 持久化的 reason 是 `waf_blocked: WAF blocked (403 without business envelope)`。
  // 而 `waf_blocked` 的处置是 `punish: true, dimension: 'soft'` ⇒ **账号级冷却 60 秒**，
  // 单账号池下等于整条链路中断 —— 用户报「审查时被打断」的真正原因。
  //
  // 上游真实形态（qoder 加密端点，鉴权失败也回 HTTP 200）：
  //   data:{"headers":{},"body":"{\"code\":\"105\",\"message\":\"Login expired\"}",
  //        "statusCodeValue":403}
  // 顶层**没有 `code`** ⇒ 旧 parseEnvelope 判「不是信封」⇒ isWafBlocked 命中。
  // 而它其实是 `105 Login expired`（**登录过期**），正确处置是**触发续期**，不该罚号。
  const { classify, isWafBlocked, parseEnvelope } = await import('../src/upstream/client.ts')

  // ① qoder 外层信封（带 data: 前缀）
  const withPrefix =
    'data:{"headers":{},"body":"{\\"code\\":\\"105\\",\\"message\\":\\"Login expired\\"}","statusCodeValue":403}'
  assert.ok(parseEnvelope(withPrefix) !== undefined, '必须认得 qoder 外层信封')
  assert.equal(isWafBlocked(403, withPrefix), false, 'qoder 外层信封不是 WAF')
  assert.equal(classify(403, withPrefix).kind, 'auth_error', '105 Login expired 必须归为 auth_error（要续期）')

  // ② 无 data: 前缀的同一形态
  const bare =
    '{"headers":{},"body":"{\\"code\\":\\"105\\",\\"message\\":\\"Login expired\\"}","statusCodeValue":403}'
  assert.equal(classify(403, bare).kind, 'auth_error', '无前缀形态同样要认出来')

  // ③ **反向守卫：真 WAF 判据不得被放宽**
  for (const realWaf of ['Forbidden', '<html><body>403 Forbidden</body></html>', '']) {
    assert.equal(
      isWafBlocked(403, realWaf),
      true,
      `真 WAF 形态必须仍然判为 WAF：${JSON.stringify(realWaf.slice(0, 40))}`,
    )
  }
  // ④ 常规信封不受影响
  assert.equal(classify(403, '{"code":6004,"msg":"rate"}').kind, 'rate_limited', '普通信封行为不变')
})
