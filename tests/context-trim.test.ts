/**
 * 单请求消息数硬上限（超限摘要压缩）的单测。
 *
 * ## 为什么要有这个能力（依据不是推测）
 *
 * 同类项目 workbuddy2api 的封禁复盘：三次账号封禁前，**最后一次成功请求都是超大消息数**
 * —— 2552 条、428→434 条、987~993 条连发。上游风控把「超大上下文 + 高频」判成机器行为。
 * 本项目此前原样转发上千条消息。
 *
 * ## 这里钉住的是四条**不能破**的性质
 *
 * 1. 未超限 ⇒ **零改动**（同一个数组引用，不是拷贝）—— 否则每一轮请求都白跑一遍重排；
 * 2. 首条 system 恒保留（身份/规则丢了会话就废了）；
 * 3. `tool_calls` 与对应 `tool_result` **绝不被拆散**（孤儿 tool 消息 ⇒ 上游 400 `11148`
 *    ⇒ 整条会话报废、换号也没用）；
 * 4. `limit = 0` / 负数 ⇒ 真的不限制（`0` 是合法值却是 falsy，`parseInt(x) || 默认` 会把它静默换掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { CONTEXT_TRIM_NOTE_PREFIX, trimMessagesByLimit } from '../src/gateway/payload.ts'
import {
  DEFAULT_MAX_CONTEXT_MESSAGES,
  parseMaxContextMessages,
} from '../src/env.ts'

type M = Record<string, unknown>

const sys = (text = '你是助手'): M => ({ role: 'system', content: text })
const user = (text: string): M => ({ role: 'user', content: text })
const assistant = (text: string): M => ({ role: 'assistant', content: text })
const call = (id: string, name = 'f'): M => ({ id, type: 'function', function: { name, arguments: '{}' } })
const toolResult = (id: string): M => ({ role: 'tool', tool_call_id: id, content: 'ok' })

/**
 * 断言「没有孤儿 tool 配对」——判据与 `cleanupOrphanToolCalls` 同源：
 * 每个 `role:'tool'` 的 `tool_call_id` 必须能在**它之前**的 assistant `tool_calls` 里找到。
 */
function assertNoOrphanToolPair(messages: unknown[]): void {
  const declared = new Set<string>()
  for (const m of messages) {
    if (m === null || typeof m !== 'object') continue
    const msg = m as M
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as M[]) {
        if (typeof tc.id === 'string') declared.add(tc.id)
      }
      continue
    }
    if (msg.role === 'tool') {
      const id = msg.tool_call_id
      assert.ok(
        typeof id === 'string' && declared.has(id),
        `孤儿 tool 消息（tool_call_id=${String(id)}）会让上游回 400 11148`,
      )
    }
  }
}

/** 造一条 n 条消息的普通历史：[system, u1, a1, u2, a2, …]。 */
function plainHistory(n: number): M[] {
  const out: M[] = [sys()]
  for (let i = 1; out.length < n; i += 1) {
    out.push(user(`u${i}`))
    if (out.length < n) out.push(assistant(`a${i}`))
  }
  return out
}

// ───────────────────── ① 未超限：零改动 ─────────────────────

test('未超限（等号边界）⇒ 原样返回同一个数组，dropped=0', () => {
  const msgs = plainHistory(10)
  const result = trimMessagesByLimit(msgs, 10)
  assert.equal(result.messages, msgs, '必须返回入参本身（同一引用），否则每轮都白拷贝一遍')
  assert.equal(result.dropped, 0)
})

test('未超限（远小于上限）⇒ 零改动', () => {
  const msgs = plainHistory(4)
  const result = trimMessagesByLimit(msgs, 100)
  assert.equal(result.messages, msgs)
  assert.equal(result.dropped, 0)
})

// ───────────────────── ② 超限：保留 system + 最近 N 条 ─────────────────────

test('超限 ⇒ 保留首条 system + 最近 N 条，中间插一条摘要提示', () => {
  const msgs = plainHistory(51) // [system, u1, a1, …, u25, a25]
  const result = trimMessagesByLimit(msgs, 10)

  // 结构：[system, 摘要, …最近 10 条…]
  assert.equal(result.messages.length, 12)
  assert.deepEqual(result.messages[0], msgs[0], '首条 system 必须原样保留')
  const note = result.messages[1] as M
  assert.equal(note.role, 'system', '摘要用 system：用 user 会形成连续两条 user，Gemini 系判非法')
  assert.match(String(note.content), /更早的消息[^。]*省略/)
  assert.ok(String(note.content).startsWith(CONTEXT_TRIM_NOTE_PREFIX))
  // 🔴 摘要文案**必须与当轮条数无关**：嵌了数字就会让 [首条 system + 摘要] 这个
  // 前缀每轮都变，上游 prefix cache 在摘要处断掉、整段历史每轮全价重算。
  assert.ok(
    !/[0-9]/.test(String(note.content)),
    '摘要文案不得出现任何数字（条数会逐轮变化，破坏 prefix cache）',
  )

  // 最近的 10 条必须逐条相同、且顺序不变
  assert.deepEqual(result.messages.slice(2), msgs.slice(-10))
  // dropped = 51 - 1（system）- 10（保留）= 40
  assert.equal(result.dropped, 40)
})

test('裁剪不改入参（不就地修改/不就地裁掉原数组）', () => {
  const msgs = plainHistory(30)
  const snapshot = JSON.stringify(msgs)
  trimMessagesByLimit(msgs, 5)
  assert.equal(JSON.stringify(msgs), snapshot)
})

test('摘要里**不得**出现被省略消息的内容（压缩 + 隐私）', () => {
  const msgs = [sys(), user('机密：工号 12345'), assistant('收到'), user('继续')]
  const result = trimMessagesByLimit(msgs, 1)
  const note = String((result.messages[1] as M).content)
  assert.ok(!note.includes('12345'), '省略的内容不能出现在摘要里')
  assert.ok(!note.includes('工号'), '省略的内容不能出现在摘要里')
})

// ───────────────────── ③ tool_calls / tool_result 不被拆散 ─────────────────────

test('左边界落在 tool 结果上 ⇒ 向后让位，绝不产生孤儿', () => {
  // 历史：[system, user, assistant(A), tool(A), assistant(B), tool(B), user, assistant]
  // limit=3 ⇒ 朴素窗口从下标 5（tool(B)）开始 ⇒ 会留下孤儿 ⇒ 必须整体让开
  const msgs = [
    sys(),
    user('开始'),
    { role: 'assistant', content: null, tool_calls: [call('A')] },
    toolResult('A'),
    { role: 'assistant', content: null, tool_calls: [call('B')] },
    toolResult('B'),
    user('继续'),
    assistant('好了'),
  ]
  const result = trimMessagesByLimit(msgs, 3)
  assertNoOrphanToolPair(result.messages)
  assert.deepEqual(result.messages[0], msgs[0])
  // 第一条非 tool 的候选是下标 6（user）⇒ 保留 user + assistant
  assert.deepEqual(result.messages.slice(2), [msgs[6], msgs[7]])
  assert.equal(result.dropped, 5) // u1,a(A),t(A),a(B),t(B)
})

test('左边界落在「带 tool_calls 的 assistant」上 ⇒ 调用与全部结果一起保留', () => {
  // 并行两个调用，窗口正好从 assistant 开始 ⇒ 两条结果都必须在
  const msgs = [
    sys(),
    user('旧'),
    assistant('旧回答'),
    { role: 'assistant', content: null, tool_calls: [call('X'), call('Y')] },
    toolResult('X'),
    toolResult('Y'),
  ]
  const result = trimMessagesByLimit(msgs, 3)
  assertNoOrphanToolPair(result.messages)
  assert.deepEqual(result.messages.slice(2), [msgs[3], msgs[4], msgs[5]])
  // 保留的 3 条里必须同时有 X 与 Y 的声明与结果，不能只剩一个
  const kept = result.messages as M[]
  const keptToolIds = kept.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
  assert.deepEqual(keptToolIds, ['X', 'Y'])
})

test('极端：limit=1 且末尾是 tool 结果 ⇒ 回溯保住整批配对，不留空尾巴也不留孤儿', () => {
  const msgs = [
    sys(),
    user('u'),
    { role: 'assistant', content: null, tool_calls: [call('Z')] },
    toolResult('Z'),
  ]
  const result = trimMessagesByLimit(msgs, 1)
  assertNoOrphanToolPair(result.messages)
  // 向后让位会一条不剩，而 [system, 摘要] 这种请求在部分上游被判「缺 user 消息」400
  // ⇒ 必须回溯到发起调用的 assistant，把声明与结果一起留住。
  assert.equal(result.messages.length, 4)
  assert.deepEqual(result.messages.slice(2), [msgs[2], msgs[3]])
  assert.equal(result.dropped, 1)
})

test('窗口整段都是 tool 结果（长并行批次）⇒ 回溯到发起方，整批留下', () => {
  const msgs = [
    sys(),
    user('并行'),
    { role: 'assistant', content: null, tool_calls: [call('X'), call('Y'), call('Z')] },
    toolResult('X'),
    toolResult('Y'),
    toolResult('Z'),
  ]
  const result = trimMessagesByLimit(msgs, 2) // 朴素窗口 = [tool(Y), tool(Z)]
  assertNoOrphanToolPair(result.messages)
  assert.deepEqual(result.messages.slice(2), [msgs[2], msgs[3], msgs[4], msgs[5]])
  assert.equal(result.dropped, 1)
})

test('上千条真实形状的历史 ⇒ 结果是 limit+2 以内且零孤儿（对应封禁复盘的 2552 条）', () => {
  const msgs: M[] = [sys()]
  while (msgs.length < 2552) {
    const id = `c${msgs.length}`
    msgs.push(user(`u${msgs.length}`))
    msgs.push({ role: 'assistant', content: null, tool_calls: [call(id)] })
    msgs.push(toolResult(id))
    msgs.push(assistant(`a${msgs.length}`))
  }
  const result = trimMessagesByLimit(msgs, 100)
  assert.ok(result.messages.length <= 102, `实际 ${result.messages.length} 条`)
  assertNoOrphanToolPair(result.messages)
  assert.deepEqual(result.messages[0], msgs[0])
})

// ───────────────────── ④ limit=0 / 负数 ⇒ 不限制 ─────────────────────

test('limit=0 ⇒ 不限制（0 是合法值，绝不能被 || 换成默认值）', () => {
  const msgs = plainHistory(500)
  const result = trimMessagesByLimit(msgs, 0)
  assert.equal(result.messages, msgs)
  assert.equal(result.dropped, 0)
})

test('limit 为负数 ⇒ 不限制', () => {
  const msgs = plainHistory(50)
  const result = trimMessagesByLimit(msgs, -1)
  assert.equal(result.messages, msgs)
  assert.equal(result.dropped, 0)
})

// ───────────────────── ⑤ 边界形状 ─────────────────────

test('只有 system 一条 ⇒ 零改动', () => {
  const msgs = [sys()]
  const result = trimMessagesByLimit(msgs, 1)
  assert.equal(result.messages, msgs)
  assert.equal(result.dropped, 0)
})

test('没有 system、只有 user/assistant ⇒ 不强行造 system 头，摘要直接排最前', () => {
  const msgs: M[] = []
  for (let i = 1; i <= 12; i += 1) msgs.push(i % 2 === 1 ? user(`u${i}`) : assistant(`a${i}`))
  const result = trimMessagesByLimit(msgs, 4)
  const first = result.messages[0] as M
  assert.equal(first.role, 'system')
  assert.ok(String(first.content).startsWith(CONTEXT_TRIM_NOTE_PREFIX))
  assert.deepEqual(result.messages.slice(1), msgs.slice(-4))
  assert.equal(result.dropped, 8)
})

test('首条是 developer（OpenAI 新规范）同样算身份消息，必须保留', () => {
  const msgs: M[] = [{ role: 'developer', content: 'You are a coding agent' }, user('u1'), assistant('a1')]
  for (let i = 2; i <= 10; i += 1) msgs.push(user(`u${i}`))
  const result = trimMessagesByLimit(msgs, 3)
  assert.deepEqual(result.messages[0], msgs[0])
  assert.deepEqual(result.messages.slice(2), msgs.slice(-3))
  assert.equal(result.dropped, msgs.length - 1 - 3)
})

// ───────────────────── ⑥ dropped 计数 ─────────────────────

test('dropped 恒定等于「原条数 - 保留的 system - 保留的尾部条数」', () => {
  for (const [total, limit] of [[12, 10], [40, 5], [102, 100], [300, 7]] as const) {
    const msgs = plainHistory(total)
    const result = trimMessagesByLimit(msgs, limit)
    const keptTail = result.messages.length - 1 /* system */ - 1 /* 摘要 */
    assert.equal(keptTail, limit)
    assert.equal(result.dropped, total - 1 - limit)
    assert.equal(
      result.dropped + 1 + keptTail,
      total,
      '守恒：被省略 + 保留的 system + 保留的尾部 = 原条数（不含摘要）',
    )
  }
})

test('`limit` 定义的是「保留的最近条数」：最终条数上限为 limit + 2（system + 摘要）', () => {
  // ⚠️ 这是刻意口径：`limit` 与 MAX_CONTEXT_MESSAGES 都指「保留的历史条数」，
  // system 与那条摘要不计入 —— 但两者都是**固定 2 条**，故实际上限可算可断言。
  const msgs = plainHistory(500)
  const result = trimMessagesByLimit(msgs, 100)
  assert.equal(result.messages.length, 102)
  assert.equal(result.dropped, 399)
})

// ───────────────────── ⑦ 配置解析（`||` 陷阱） ─────────────────────

test('MAX_CONTEXT_MESSAGES 未设置 / 空串 ⇒ 默认 0（不截断）', () => {
  assert.equal(parseMaxContextMessages(undefined), DEFAULT_MAX_CONTEXT_MESSAGES)
  assert.equal(parseMaxContextMessages(''), DEFAULT_MAX_CONTEXT_MESSAGES)
  assert.equal(parseMaxContextMessages('   '), DEFAULT_MAX_CONTEXT_MESSAGES)
  /**
   * ⚠️ 默认值 2026-10-22 由 `300` 改为 `0`。
   *
   * 原来的 300 出自封号复盘（「大上下文」被列为嫌疑），但实测反证：
   * 同账号用官方客户端 50 并发正常，官方同样发大上下文 ⇒「大」不是判据，
   * 请求**形态不完整**才是（设备指纹/会话链，已在本轮补齐）。
   *
   * 而截断是**静默改写用户请求**：agent 会话实测 `1767 条 → 301 条`，
   * 一次丢掉 1466 条历史（系统提示与早期工具结果），模型会重复调工具、
   * 基于不存在的上下文编造 —— 表现为「上游异常」，真因在我们自己。
   */
  assert.equal(DEFAULT_MAX_CONTEXT_MESSAGES, 0)
})

test("MAX_CONTEXT_MESSAGES='0' ⇒ 0（不限制），不是默认值", () => {
  assert.equal(parseMaxContextMessages('0'), 0)
  assert.equal(parseMaxContextMessages(' -5 '), 0)
})

test('MAX_CONTEXT_MESSAGES 非法值 ⇒ 回落到默认（失败方向必须是「收紧」）', () => {
  // ⚠️ 写错配置时绝不能静默变成「不限制」，否则继续原样转发上千条
  for (const bad of ['abc', '12abc', '1.5', '0x10', '1000000000']) {
    assert.equal(parseMaxContextMessages(bad), DEFAULT_MAX_CONTEXT_MESSAGES, `bad=${bad}`)
  }
})

test('MAX_CONTEXT_MESSAGES 正整数 ⇒ 该值', () => {
  assert.equal(parseMaxContextMessages('40'), 40)
  assert.equal(parseMaxContextMessages(' 1 '), 1)
})

// ───────────────────── ⑧ 接线：全链路只有一处，且日志不含内容 ─────────────────────

/** 剥掉注释再做源码断言（本仓库注释大量引用反例，不剥会误报）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const SOURCE_FILES = (readdirSync('src', { recursive: true }) as string[]).filter((p) => p.endsWith('.ts'))

test('🔴 裁剪只在 handleChatCompletions 接线一次（本项目吃过「同一个 bug 只修一半」的亏）', () => {
  // 除定义所在的 payload.ts 外，全仓库只能有一处调用点。
  const callSites: string[] = []
  for (const rel of SOURCE_FILES) {
    const text = stripComments(readFileSync(`src/${rel}`, 'utf8'))
    if (/trimMessagesByLimit\s*\(/.test(text) && !rel.endsWith('gateway/payload.ts')) callSites.push(rel)
  }
  assert.deepEqual(callSites, ['gateway/server.ts'], '裁剪的调用点必须唯一')

  const server = stripComments(readFileSync('src/gateway/server.ts', 'utf8'))
  // ⚠️ 2026-10-22 修正：**不能再要求「只有一处」**。
  //
  // `DEFAULT_PROVIDER === 'buddy'`，而 workbuddy 在
  // `if (providerId !== DEFAULT_PROVIDER)` 处被分流进 handleProviderChat ——
  // 两条路径是两个互斥的循环，**各自都需要裁剪**。
  // 强行「只留一处」正是上一版引入回归的原因：把它挪进了 workbuddy 走不到的分支。
  // ⇒ 现在守的是「最多两处，且分别落在两条路径里」（见文件末尾的分路径断言）。
  const trimCalls = [...server.matchAll(/trimMessagesByLimit\s*\(/g)].length
  assert.ok(
    trimCalls >= 1 && trimCalls <= 2,
    `server.ts 里最多两处裁剪调用（两条路径各一处），实际 ${trimCalls}`,
  )

  // ── 位置：仍然在 handleChatCompletions 内，但**必须在选号之后** ──
  //
  // ⚠️ 2026-10-22 第二次语义变更：上限改成**按账号**（`safetyOverride`），
  // 而账号要选号之后才知道 ⇒ 裁剪从「选号前」挪到「选号后」。
  // 原断言要求 `callAt > routeAt`（providerId 确定之后）—— 那在
  // 「全局按供应商收窄」时期是对的，如今不足够：还必须晚于 `pickCandidate`。
  const fnAt = server.indexOf('export async function handleChatCompletions')
  // ⚠️ 注意定位的是**调用处**（`rebuildPreparedForLimit(...)`），不是
  // `trimMessagesByLimit` 的定义位置 —— 后者在函数体内，早于选号。
  const callAt = server.indexOf('rebuildPreparedForLimit(')
  const routeAt = server.indexOf('const providerId = routed.provider')
  // 取**最后一次**出现：`pickCandidate` 在函数定义处也出现过一次。
  const pickAt = server.lastIndexOf('const candidate = await pickCandidate')
  const providerFnAt = server.indexOf('export async function handleProviderChat')

  assert.ok(fnAt >= 0 && callAt > fnAt, '裁剪必须在 handleChatCompletions 内')
  assert.ok(callAt > routeAt, '裁剪必须在 providerId 确定之后（否则判不出供应商）')
  assert.ok(
    callAt > pickAt,
    '⚠️ 裁剪必须在**选号之后** —— 上限是按账号的，选号前拿不到该账号的覆盖值',
  )
  assert.ok(providerFnAt > callAt, 'handleProviderChat 的派发必须拿到裁剪后的 rawBody')

  // 🔴 防封措施必须按供应商收窄：裁剪只对 workbuddy 生效。
  //
  // 理由：上下文裁剪来自封号复盘，它要解决的是「伪装得像官方客户端」。
  // 而 qodercn/cline 等用的是它们自己的官方凭据，本来无需伪装 ——
  // 给它们裁只是白白损坏用户请求（实测 agent 会话 1767 → 301 条）。
  // ⚠️ 判据在 `rebuildPreparedForLimit` **函数体内**（真正的裁剪处），
  // 不在调用处附近 —— 故要单独定位那个函数体来断言。
  const rebuildAt = server.indexOf('const rebuildPreparedForLimit')
  assert.ok(rebuildAt > 0, '应能找到 rebuildPreparedForLimit')
  const rebuildBody = server.slice(rebuildAt, rebuildAt + 2000)
  assert.ok(
    /provider === 'workbuddy'/.test(rebuildBody),
    '⚠️ 裁剪没有按供应商收窄 —— 会把 qodercn 等自家凭据的对话也腰斩',
  )

  // 🔴 上限必须按账号取（合并全局 + 覆盖），不能直接用全局值。
  assert.ok(
    /acctSafety\.maxContextMessages/.test(server),
    '裁剪上限必须来自「该账号实际生效」的配置，而不是全局值 —— '
      + '否则「只给 qodercn 放开」这个需求无法实现',
  )

  // ⚠️ 2026-10-22 撤销「handleProviderChat 内不得裁剪」这条反向断言。
  //
  // 它当时的前提是「裁剪只属于 buddy 路径」。那个前提**是错的**：
  // `DEFAULT_PROVIDER === 'buddy'`，workbuddy 恰恰走 handleProviderChat ——
  // 而 workbuddy 是**唯一**需要裁剪的供应商。这条断言等于把功能锁在走不到的路径上，
  // 也是我上一版引入回归时「测试全绿」的原因之一。
  //
  // ⇒ 现在只保留真正的重复实现检查：`prepareChatBody` 内部不得再裁一次
  //（那会导致「裁两遍」，且第二遍拿不到正确的上限语义）。
  const payload = stripComments(readFileSync('src/gateway/payload.ts', 'utf8'))
  const prepareAt = payload.indexOf('export function prepareChatBody')
  assert.ok(!/trimMessagesByLimit/.test(payload.slice(prepareAt)), 'prepareChatBody 内不得再裁一次')

  // 上限的**解析入口**必须唯一：面板配置（`SafetyConfig`）优先，
  // 而它的默认值由 `resolveMaxContextMessages` 在 DO 内解析。
  //
  // ⚠️ 这条断言随架构改过一次：早先要求 server.ts 直接调 `resolveMaxContextMessages(env)`，
  // 但那样「面板改了上限」就永远不生效（server 读 env、面板写 DO，两条路）。
  // 现在 server.ts 只能读 `safety.maxContextMessages`，解析入口移到
  // AccountPoolDO.getSafetyConfig —— 断言跟着钉住「唯一的解析入口」这个**意图**，
  // 而不是钉住某个具体函数名出现在某个具体文件里。
  assert.ok(server.includes('safety.maxContextMessages'), '上限必须来自面板配置')
  assert.ok(
    !/resolveMaxContextMessages/.test(server),
    'server.ts 不得再直接解析环境变量（否则面板开关失效）',
  )
  const poolSrc = stripComments(readFileSync('src/pool/AccountPoolDO.ts', 'utf8'))
  assert.ok(
    /resolveMaxContextMessages\(this\.env\)/.test(poolSrc),
    '解析入口必须仍走 env.ts（只在 DO 一处）',
  )
})

test('裁剪日志只打条数与模型名，绝不打任何消息内容（隐私红线）', () => {
  const server = stripComments(readFileSync('src/gateway/server.ts', 'utf8'))
  const at = server.indexOf('[context-trim]')
  assert.ok(at > 0, '裁剪时必须打日志')
  const window = server.slice(at, at + 320)
  // ⚠️ 上限变量名以 `limit` 为准（2026-10-22 改成按账号后，全局值叫 `maxContextMessages`、
  // 实际应用的值叫 `limit`；日志打的是后者，因为它才是本次真正生效的）。
  for (const need of ['beforeTrim.length', 'trimmed.messages.length', 'trimmed.dropped', 'rawModel', 'limit']) {
    assert.ok(window.includes(need), `日志必须包含 ${need}`)
  }
  for (const forbidden of ['.content', 'JSON.stringify', 'messages[0]']) {
    assert.ok(!window.includes(forbidden), `日志不得包含消息内容（出现 ${forbidden}）`)
  }
})

test('🔴 裁剪必须覆盖 **两条** chat 路径（workbuddy 走的是 provider 路径）', () => {
  // ## 这条测试的来历：我自己引入的回归，而且原有断言没抓到
  //
  // 为了支持「按账号的裁剪上限」，我把裁剪从「分流点之前」挪到「选号之后」。
  // 但 `DEFAULT_PROVIDER === 'buddy'`，而 `providerId === 'workbuddy'`
  // 在 `if (providerId !== DEFAULT_PROVIDER)` 处就被分流进 **handleProviderChat** ——
  // 于是裁剪落进了 buddy 的循环里，**workbuddy 永远走不到**。
  //
  // 实测证据：给 workbuddy 设 `maxContextMessages: 50` 后发 401 条消息，
  // 日志里 `context-trim` 出现 **0 次**（改动前是正常的）。
  //
  // ## 为什么原有断言没抓到
  //
  // 原断言只检查「唯一调用点 + 在 handleChatCompletions 内 + 晚于 pickCandidate」——
  // 它全部满足，因为裁剪**确实**在分支 A 里。它守的是「接线了一次」，
  // 而**不是**「唯一需要它的那条路径上也接上了」。
  // ⇒ 断言必须分别钉住两条路径各自都有裁剪。
  const server = stripComments(readFileSync('src/gateway/server.ts', 'utf8'))

  const buddyAt = server.indexOf('export async function handleChatCompletions')
  const providerAt = server.indexOf('export async function handleProviderChat')
  assert.ok(buddyAt >= 0 && providerAt > buddyAt, '两条路径的边界应能定位')

  const buddyBody = server.slice(buddyAt, providerAt)
  const providerBody = server.slice(providerAt)

  // 分支 A：通过 `rebuildPreparedForLimit`（间接调用 trimMessagesByLimit）
  assert.ok(
    /trimMessagesByLimit\s*\(/.test(buddyBody),
    '分支 A（buddy/默认）必须裁剪',
  )

  // 分支 B：必须**直接**裁剪 —— 这是 workbuddy 唯一的路径
  assert.ok(
    /trimMessagesByLimit\s*\(/.test(providerBody),
    '⚠️ 分支 B（provider，workbuddy 走这里）必须裁剪 —— '
      + '缺了它，裁剪对唯一需要它的供应商完全失效',
  )

  // 分支 B 的裁剪必须也按供应商收窄（不能给 qodercn 等也裁）
  const provTrimAt = providerBody.indexOf('trimMessagesByLimit(')
  const provSeg = providerBody.slice(Math.max(0, provTrimAt - 700), provTrimAt + 200)
  assert.ok(
    /providerId === 'workbuddy'/.test(provSeg),
    '⚠️ 分支 B 的裁剪必须只对 workbuddy 生效，否则会损坏 qodercn 等自家凭据的对话',
  )

  // 分支 B 的裁剪必须用**按账号**的上限
  assert.ok(
    /acctSafety\.maxContextMessages/.test(provSeg),
    '分支 B 的裁剪上限必须来自「该账号实际生效」的配置',
  )
})
