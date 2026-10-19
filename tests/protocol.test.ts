/**
 * 协议层单测：任务解析、余额双层信封、反探测脱敏、uid 校验。
 *
 * ## 这些用例对应的都是「实测踩过的坑」
 *
 * 每一条断言背后都有一个 Go 侧记录的真实缺陷，不是凭空写的边界。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isMpTask, mergeTaskLists, parseClaim, parseTasks } from '../src/upstream/tasks.ts'
import { parseBalance } from '../src/upstream/checkin.ts'
import { sanitizeFingerprints, withFingerprint } from '../src/upstream/report.ts'
import { classify, parseEnvelope } from '../src/upstream/client.ts'
import { isValidUid, needsRefresh, REFRESH_SKEW_MS } from '../src/upstream/auth.ts'
import { cstDay } from '../src/upstream/travel.ts'

// ─────────────────────────── 任务解析 ───────────────────────────

test('parseTasks：认嵌套 progress 形态', () => {
  const tasks = parseTasks({
    tasks: [
      {
        task_code: 'chat_5',
        title: '对话 5 次',
        reward_credit: 100,
        reward_energy: 5,
        progress: { current: 2, target: 5 },
        accept_status: 'accepted',
      },
    ],
  })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.taskCode, 'chat_5')
  assert.equal(tasks[0]?.current, 2)
  assert.equal(tasks[0]?.target, 5)
  assert.equal(tasks[0]?.credit, 100)
  assert.equal(tasks[0]?.energy, 5)
})

test('parseTasks：也认扁平 progress 形态（上游两种都下发）', () => {
  const tasks = parseTasks({
    tasks: [{ task_code: 'x', current: 3, target: 4, reward_credit: 50 }],
  })
  assert.equal(tasks[0]?.current, 3)
  assert.equal(tasks[0]?.target, 4)
})

test('⚠️ parseTasks：claimable 必须在「达标且未领」时为 true', () => {
  const tasks = parseTasks({
    tasks: [
      { task_code: 'done_not_claimed', progress: { current: 5, target: 5 }, accept_status: 'accepted' },
      { task_code: 'claimed', progress: { current: 5, target: 5 }, accept_status: 'claimed' },
      { task_code: 'not_done', progress: { current: 1, target: 5 }, accept_status: 'accepted' },
    ],
  })
  const byCode = Object.fromEntries(tasks.map((t) => [t.taskCode, t]))
  assert.equal(byCode['done_not_claimed']?.claimable, true)
  assert.equal(byCode['claimed']?.claimable, false, '已领不再可领')
  assert.equal(byCode['claimed']?.claimed, true)
  assert.equal(byCode['not_done']?.claimable, false)
})

test('⚠️ parseTasks：target=0 不算达标（避免把「无进度」误判为已完成）', () => {
  const tasks = parseTasks({ tasks: [{ task_code: 'x', progress: { current: 0, target: 0 } }] })
  assert.equal(tasks[0]?.claimable, false)
})

test('parseTasks：畸形输入返回空数组而不抛错', () => {
  assert.deepEqual(parseTasks(null), [])
  assert.deepEqual(parseTasks({}), [])
  assert.deepEqual(parseTasks({ tasks: 'not-an-array' }), [])
  assert.deepEqual(parseTasks({ tasks: [null] }), [])
})

test('mergeTaskLists：按 taskCode 去重，默认口径优先', () => {
  const base = [{ taskCode: 'a', title: 'from-base' }] as never[]
  const mp = [
    { taskCode: 'a', title: 'from-mp' },
    { taskCode: 'b', title: 'only-mp' },
  ] as never[]
  const merged = mergeTaskLists(base, mp)
  assert.equal(merged.length, 2)
  assert.equal(merged.find((t) => t.taskCode === 'a')?.title, 'from-base', '同码时默认口径优先')
  assert.equal(merged.find((t) => t.taskCode === 'b')?.title, 'only-mp')
})

test('isMpTask：识别 mp 专属任务码', () => {
  assert.equal(isMpTask('Sequential_Tasks_1'), true)
  assert.equal(isMpTask('Sequential_Tasks_7'), true)
  assert.equal(isMpTask('school_season'), true)
  assert.equal(isMpTask('chat_5'), false)
  assert.equal(isMpTask('first_buddy'), false)
})

test('parseClaim：幂等命中识别为 alreadyClaimed 而不是错误', () => {
  assert.deepEqual(parseClaim({ already_claimed: true, credit: 0, energy: 0 }), {
    credit: 0,
    energy: 0,
    alreadyClaimed: true,
  })
  assert.deepEqual(parseClaim({ already_claimed: false, credit: 100, energy: 5 }), {
    credit: 100,
    energy: 5,
    alreadyClaimed: false,
  })
  assert.deepEqual(parseClaim(null), { credit: 0, energy: 0, alreadyClaimed: false })
})

// ─────────────────────────── 余额双层信封 ───────────────────────────

test('⚠️ parseBalance：必须穿透 Response.Data.Accounts 双层嵌套', () => {
  const now = 1_700_000_000_000
  const result = parseBalance(
    {
      Response: {
        Data: {
          Accounts: [
            {
              CycleCapacityRemain: 155,
              CapacityRemain: 655,
              DeductionEndTime: now + 86400_000,
              Status: 1,
            },
          ],
        },
      },
    },
    now,
  )
  assert.equal(result.length, 1)
  // ⚠️ 取本周期口径，不是终身口径（实测两者差异巨大）
  assert.equal(result[0]?.cycleRemain, 155)
  assert.equal(result[0]?.totalRemain, 655)
  assert.equal(result[0]?.expired, false)
})

test('parseBalance：状态 3 或已过期判为失效', () => {
  const now = 1_700_000_000_000
  const result = parseBalance(
    {
      Response: {
        Data: {
          Accounts: [
            { CycleCapacityRemain: 10, Status: 3 },
            { CycleCapacityRemain: 20, DeductionEndTime: now - 1000, Status: 1 },
          ],
        },
      },
    },
    now,
  )
  assert.equal(result[0]?.expired, true, 'Status=3 应判失效')
  assert.equal(result[1]?.expired, true, '已过到期时间应判失效')
})

test('parseBalance：秒级时间戳会转成毫秒', () => {
  const now = 1_700_000_000_000
  const futureSeconds = Math.floor((now + 86400_000) / 1000)
  const result = parseBalance(
    { Response: { Data: { Accounts: [{ CycleCapacityRemain: 1, ExpiredTime: futureSeconds }] } } },
    now,
  )
  // 秒 → 毫秒后仍在未来
  assert.ok((result[0]?.expiresAt ?? 0) > now)
})

test('parseBalance：畸形输入返回空数组', () => {
  assert.deepEqual(parseBalance(null, 0), [])
  assert.deepEqual(parseBalance({}, 0), [])
  assert.deepEqual(parseBalance({ Response: {} }, 0), [])
  assert.deepEqual(parseBalance({ Response: { Data: { Accounts: 'x' } } }, 0), [])
})

// ─────────────── 渠道拦截码（字符串形态） ───────────────

test("🔴 classify：真实渠道拦截码（字符串 11-128）必须归到 channel_blocked，不是 waf_blocked", () => {
  // ## 这条链路此前**整条是断的**（2026-10-19 修复）
  //
  // 上游渠道拦截的报文是：
  //   {"code":"11-128","msg":"Illegal API invocation from an unapproved channel"}
  // 注意 code 是**字符串**，不是数字。
  //
  // 而 parseEnvelope 当时做的是 `Number(raw)` ⇒ `Number("11-128")` = NaN
  // ⇒ `!Number.isFinite(NaN)` ⇒ **判成「不是信封」并返回 undefined**
  // ⇒ 走「无信封 + 403」分支 ⇒ **waf_blocked**。
  //
  // 后果不是分类难看，而是**行为错误**：waf_blocked 会触发 noteWaf() 的
  // **IP 级**判定 —— 凑够 2 个账号就让整个服务停服 60 秒，
  // 而真实原因只是「这次请求的渠道指纹不被认可」。
  //
  // ⚠️ 用码点构造，避免连字符被归一化后本测试静默失效。
  const REAL = String.fromCharCode(0x31, 0x31, 0x2d, 0x31, 0x32, 0x38)
  const body = JSON.stringify({
    code: REAL,
    msg: "Illegal API invocation from an unapproved channel",
  })

  // ① 必须先能认出这个信封
  const env = parseEnvelope(body)
  assert.notEqual(env, undefined, "字符串码的信封必须被认出（否则下游全错）")
  assert.equal(String(env.code), REAL, "必须保留原始字符串码")

  // ② 归类必须是 channel_blocked
  const c = classify(403, body)
  assert.equal(c.kind, "channel_blocked", "渠道拦截必须归到 channel_blocked")
  assert.notEqual(c.kind, "waf_blocked", "绝不能被误判成 WAF（会触发 IP 级封禁）")

  // ③ 回归守卫：真 WAF（403 且无信封）仍然必须是 waf_blocked
  assert.equal(
    classify(403, "<html>blocked by waf</html>").kind,
    "waf_blocked",
    "无业务信封的 403 才是真 WAF",
  )

  // ④ 回归守卫：数字码映射不受影响
  assert.equal(classify(429, JSON.stringify({ code: 6004, msg: "x" })).kind, "rate_limited")
})

// ─────────────────────────── 反探测脱敏 ───────────────────────────

test('⚠️ sanitizeFingerprints：真实错误码必须被改写（它出现在请求里本身就是拦截条件）', () => {
  // ## 🔴 本条断言曾经**两次**是自我实现的空转（2026-10-19 修复）
  //
  // 第一次：原写法是
  //   assert.equal(sanitizeFingerprints('错误码 11-128'), '错误码 11-128')
  //                            ↑ 输入              ↑ 期望值**一模一样**
  // 于是它**永远通过**，哪怕实现是 replaceAll(a, a) 这样的空操作也拦不住 ——
  // 而实现正是那个空操作。
  //
  // 第二次（更隐蔽）：本项目源码**此前把真实错误码写错了一个连字符**
  // （真实是带 ASCII 连字符的 11-128，源码里却大面积写成无连字符形态），
  // 判据与真实报文对不上，而两者渲染出来**肉眼无法分辨**。
  //
  // ⇒ 故这里全部用**码点构造**，不在源码里书写完整字面量：
  //   这样即使源码/编辑器/构建链把连字符归一化，断言也不会跟着静默变成空转。
  const CP = (codes: number[]): string => String.fromCharCode(...codes)
  // 真实错误码：11-128（连字符 = ASCII U+002D）
  const REAL = CP([0x31, 0x31, 0x2d, 0x31, 0x32, 0x38])
  // 曾经的错误写法：少一个连字符
  const NO_HYPHEN = CP([0x31, 0x31, 0x31, 0x32, 0x38])

  // ⓪ 先自证样本本身正确，否则后面的断言全是空转
  assert.equal(REAL.length, 6, '真实错误码应为 6 个字符（11-128）')
  assert.equal(NO_HYPHEN.length, 5, '错误写法应为 5 个字符（11128）')
  assert.notEqual(REAL, NO_HYPHEN, '两个样本必须不同，否则本测试无意义')

  for (const input of ['错误码 ' + REAL, 'code=' + REAL, REAL]) {
    const out = sanitizeFingerprints(input)

    // ① 必须**真的改了**（这条正是原断言缺失的核心）
    assert.notEqual(out, input, `必须发生改写，否则等于没脱敏：${input}`)

    // ② 改写后**不得再含真实错误码** —— 那才是上游的拦截条件
    assert.ok(!out.includes(REAL), `改写后仍含真实错误码（会被上游整单拦截）：${out}`)

    // ③ 数字本体不能丢：只换连字符，不删内容
    assert.ok(out.includes('11'), '不应丢掉 11')
    assert.ok(out.includes('128'), '不应丢掉 128')
  }

  // ④ 无连字符的写法**不应被改写**（它不是拦截条件，改了反而破坏原意）
  assert.equal(
    sanitizeFingerprints(NO_HYPHEN),
    NO_HYPHEN,
    '无连字符形态不是真实错误码，不应被改写',
  )
})


test('sanitizeFingerprints：相邻数字不受影响', () => {
  // Go 侧实测 11148 / 11101 / 11115 均放行
  assert.equal(sanitizeFingerprints('11148'), '11148')
  assert.equal(sanitizeFingerprints('11101'), '11101')
  assert.equal(sanitizeFingerprints('11115'), '11115')
})

test('sanitizeFingerprints：不含 11128 时原样返回', () => {
  assert.equal(sanitizeFingerprints('hello'), 'hello')
  assert.equal(sanitizeFingerprints(''), '')
})

test('withFingerprint：业务字段覆盖指纹字段（顺序纪律）', () => {
  const fp = { machineId: 'from-fp', userId: 'u1', ideType: 'WorkBuddy' }
  const events = [{ eventCode: 'x', machineId: 'from-business' }]
  const out = withFingerprint(events, fp)
  assert.equal(out[0]?.machineId, 'from-business', '业务字段优先')
  assert.equal(out[0]?.userId, 'u1', '指纹补充缺失字段')
})

// ─────────────────────────── uid 校验（安全边界） ───────────────────────────

test('⚠️ isValidUid：拒绝路径穿越字符', () => {
  assert.equal(isValidUid('../../evil'), false)
  assert.equal(isValidUid('a/b'), false)
  assert.equal(isValidUid('a\\b'), false)
  assert.equal(isValidUid('a.b'), false)
})

test('isValidUid：接受 UUID 形态', () => {
  assert.equal(isValidUid('0443bd6c-a2fc-4b0a-960d-1066484a8073'), true)
  assert.equal(isValidUid('abc_123-XYZ'), true)
})

test('isValidUid：拒绝空串与超长串', () => {
  assert.equal(isValidUid(''), false)
  // ⚠️ 上限从 64 放宽到 128：多供应商的存储 key 会带 `provider:` 前缀
  //（如 `qoder:01a0c249-e8f4-76df-a44a-bda7c5120f3b`），
  // 加上前缀后很容易超过 64。
  assert.equal(isValidUid('a'.repeat(129)), false)
  assert.equal(isValidUid('a'.repeat(128)), true)
})

// ─────────────────────────── 续期判据 ───────────────────────────

test('⚠️ needsRefresh：过期时间未知（0）恒为 true —— 宁可多续一次也不要打到 401', () => {
  const now = 1_700_000_000_000
  assert.equal(needsRefresh(0, now), true)
})

test('needsRefresh：距过期不足 10 分钟即需续期', () => {
  const now = 1_700_000_000_000
  assert.equal(needsRefresh(now + REFRESH_SKEW_MS - 1000, now), true, '差 1 秒进入窗口')
  assert.equal(needsRefresh(now + REFRESH_SKEW_MS + 1000, now), false, '窗口外不需续期')
})

// ─────────────────────────── 时区 ───────────────────────────

test('⚠️ cstDay：用固定 +8 偏移，不依赖本机时区', () => {
  // 2023-11-14 22:00:00 UTC = 2023-11-15 06:00 CST → 应算 15 号
  const utc2200 = Date.UTC(2023, 10, 14, 22, 0, 0)
  assert.equal(cstDay(utc2200), '2023-11-15')
  // 2023-11-14 15:00:00 UTC = 2023-11-14 23:00 CST → 仍是 14 号
  const utc1500 = Date.UTC(2023, 10, 14, 15, 0, 0)
  assert.equal(cstDay(utc1500), '2023-11-14')
})
