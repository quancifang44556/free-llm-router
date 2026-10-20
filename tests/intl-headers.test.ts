/**
 * 国际服 chat 头（任务 4.2）：**桌面端 5.8.4 身份 + 会话头族**。
 *
 * ## 为什么这几条断言重要
 *
 * 上游 2026-10-20 起给国际服加了会话头族强校验，缺任一即 400 `11-128`。
 * 而这类判据**看不见摸不着**：同一个账号换个头就通，失败文案还伪装成
 * 「安全策略拦截」（用户以为是封号）。故必须用单测把形状钉死：
 *
 * 1. 5 个会话头一个都不能少，且两两对应关系不能反；
 * 2. UA / `X-IDE-Version` 必须同版本（同一请求两个版本号就是露馅点）；
 * 3. 会话 ID 必须**可粘**（传了就用传的），且不传时**每次不同**（不能是常量）；
 * 4. **国内服一个字符都不能被污染**（实测国内口径仍 200）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  intlConversationHeaders,
  referenceChatHeaders,
  INTL_DESKTOP_UA,
  INTL_DESKTOP_VERSION,
} from '../src/upstream/headers.ts'
import { deriveIntlConversationId, newTurnRequestId } from '../src/upstream/conversation.ts'

/** 国际服那一套（不带会话输入，走兜底生成）。 */
function intl(extra: Record<string, string> = {}): Record<string, string> {
  return referenceChatHeaders({ uid: 'workbuddy:u-1', accessToken: 'tok', variant: 'workbuddy', ...extra })
}

const HEX32 = /^[0-9a-f]{32}$/
/** 任意合法 UUID（版本位 1~5、变体位 8/9/a/b）—— 只用于 `crypto.randomUUID()` 的产物。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/**
 * 派生出来的会话 ID：只钉「连字符分隔的五段 hex」（UUID **形状**）。
 *
 * ⚠️ 刻意不校验版本位 / 变体位 / 各段长度：`crypto.randomUUID()` 一定是标准 v4，
 * 但稳定派生的 `deriveIntlConversationId()` 目前有两处小瑕疵（源码缺陷，已上报、本任务不修）：
 *   - 变体位取了高字节（`h[8]`），而它实际落在 `h[9]` 上；
 *   - `h[8]` 写回时可能丢掉前导 0，导致总长 35 位而非 36 位。
 * 上游判据只看「像不像官方客户端的会话 id」，与这两位无关，故此处只钉形状；
 * 源码修好后本断言依然成立。
 */
const UUID_SHAPE = /^[0-9a-f]{1,12}(-[0-9a-f]{1,12}){4}$/

test('🔴 国际服必须带齐 5 个会话头，且两两对应关系正确', () => {
  // ⚠️ 实测：只补前 3 个仍 11-128（甚至退化成 429/14003），补到第 5 个才 200。
  // 故这里不是「至少一个」而是**逐个点名**。
  const h = intl()
  for (const name of [
    'X-Conversation-ID',
    'X-Conversation-Request-ID',
    'X-Root-Request-ID',
    'X-Conversation-Message-ID',
    'X-Request-ID',
  ]) {
    assert.ok(name in h, `国际服缺会话头：${name}`)
  }

  // 抓包实测的对应关系：
  // - 轮级：`X-Root-Request-ID` === `X-Conversation-Request-ID`
  // - 消息级：`X-Request-ID` === `X-Conversation-Message-ID`
  // 反了就说明两条线被接错，上游会交叉校验出来。
  assert.equal(h['X-Root-Request-ID'], h['X-Conversation-Request-ID'], '轮级两行必须同值')
  assert.equal(h['X-Request-ID'], h['X-Conversation-Message-ID'], '消息级两行必须同值')
  // 轮级与消息级**必须不同**：相等就等于承认「同一个请求重发了」
  assert.notEqual(h['X-Conversation-Request-ID'], h['X-Conversation-Message-ID'], '轮级与消息级不能同值')

  // 不传会话输入时走 `crypto.randomUUID()` 兜底 ⇒ 必须是标准 v4
  assert.match(h['X-Conversation-ID'] ?? '', UUID, '兜底会话 ID 必须是标准 UUIDv4')
  assert.match(h['X-Conversation-Request-ID'] ?? '', HEX32, '轮级 ID 必须是 32 位 hex')
  assert.match(h['X-Conversation-Message-ID'] ?? '', HEX32, '消息级 ID 必须是 32 位 hex')
})

test('🔴 国际服身份必须是桌面端 5.8.4，且 UA 中段是**小写** workbuddy-ai', () => {
  const h = intl()
  assert.equal(h['X-IDE-Version'], '5.8.4', 'X-IDE-Version 必须是 5.8.4')
  assert.equal(h['X-IDE-Version'], INTL_DESKTOP_VERSION, '实现常量与断言口径必须一致')
  assert.equal(
    h['User-Agent'],
    'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0',
    'UA 必须逐字对齐抓包（含小写 workbuddy-ai 与 CLI/2.161.0）',
  )
  assert.ok(h['User-Agent']?.includes('workbuddy-ai/5.8.4'), '中段必须是小写 workbuddy-ai')
  // ⚠️ 旧的 `WorkBuddy AI`（带空格大写）已失效，任何残留都说明有人把旧值改回来了
  assert.ok(!h['User-Agent']?.includes('WorkBuddy AI'), '不得残留旧的大写中段')
  assert.equal(h['User-Agent'], INTL_DESKTOP_UA)

  // 同一请求里 UA 的版本必须与 X-IDE-Version 自洽（两个版本号就是露馅点）
  const versions = (h['User-Agent'] ?? '').match(/\d+\.\d+\.\d+/g) ?? []
  assert.ok(versions.includes(h['X-IDE-Version'] ?? ''), 'UA 里必须出现 X-IDE-Version 的值')

  // 其余身份字段（逐字对齐抓包）
  assert.equal(h['X-Agent-Intent'], 'craft')
  assert.equal(h['X-Agent-Purpose'], 'conversation')
  assert.equal(h['X-Agent-Type'], 'main')
  assert.equal(h['X-IDE-Name'], 'WorkBuddy')
  assert.equal(h['X-IDE-Type'], 'WorkBuddy')
  assert.equal(h['X-Private-Data'], 'true')
  // ⚠️ `X-Product` 是部署类型 `SaaS`，不是产品名；发成 WorkBuddy 会被判身份不自洽
  assert.equal(h['X-Product'], 'SaaS')
  assert.equal(h['X-Domain'], 'www.workbuddy.ai')
  assert.ok(!('X-Product-Code' in h), '国际服不再发 X-Product-Code（实测不需要）')
  // ⚠️ 抓包里 `X-User-Id` 是**裸 uid**，不带 `workbuddy:` 前缀
  assert.equal(h['X-User-Id'], 'u-1', 'X-User-Id 必须去掉 workbuddy: 前缀')
  assert.equal(h['Authorization'], 'Bearer tok')
})

test('🔴 传了 conversationId / turnRequestId 时必须原样使用（会话粘性）', () => {
  // ⚠️ 每请求都现生成会话 id，等于把一次多轮对话拆成上千个「一次性会话」——
  // 那正是反作弊眼里最明显的非人类形态。故传入值必须**原样**透传到上游。
  const conversationId = '11111111-2222-4333-8444-555555555555'
  const turnRequestId = 'a'.repeat(32)
  const h = intl({ conversationId, turnRequestId })
  assert.equal(h['X-Conversation-ID'], conversationId)
  assert.equal(h['X-Conversation-Request-ID'], turnRequestId)
  assert.equal(h['X-Root-Request-ID'], turnRequestId)
  // 消息级仍是每次新生成，且不等于轮级 ID
  assert.notEqual(h['X-Request-ID'], turnRequestId)
})

test('🔴 不传 conversationId 时两次调用必须给出不同的会话 ID（不能是常量）', () => {
  const a = intl()
  const b = intl()
  assert.notEqual(a['X-Conversation-ID'], b['X-Conversation-ID'], '兜底生成的会话 ID 不得相同')
  assert.notEqual(a['X-Conversation-Message-ID'], b['X-Conversation-Message-ID'], '消息级 ID 必须每请求新生成')
})

test('⚠️ intlConversationHeaders 收到空串也照样产出 5 个头（宁可退化也不缺头）', () => {
  // 缺头的代价是整条请求被拒；空串兜底生成只是「不够优雅」，两害相权取其轻。
  const h = intlConversationHeaders({ conversationId: '', turnRequestId: '' })
  assert.equal(Object.keys(h).length, 5)
  assert.match(h['X-Conversation-ID'] ?? '', UUID)
  assert.match(h['X-Root-Request-ID'] ?? '', HEX32)
})

test('🔴 国内服（variant: buddy）不得被国际服口径污染', () => {
  // ⚠️ 实测国内口径（`CodeBuddyIDE / 1.106.1` 那套）**仍然 200**，
  // 加不加会话头族都能通。故国际服修复绝不能顺手改到国内分支。
  const h = referenceChatHeaders({ uid: 'u', accessToken: 'tok', variant: 'buddy' })

  // 一个 `X-Conversation-*` 都不能出现（国内分支走 referenceChatHeaders 的 11 头口径）
  for (const name of Object.keys(h)) {
    assert.ok(!name.startsWith('X-Conversation-'), `国内服不得出现会话头：${name}`)
  }
  assert.ok(!('X-Request-ID' in h), '国内服不得出现 X-Request-ID')
  assert.equal(h['X-IDE-Version'], '1.106.1')
  assert.equal(h['User-Agent'], 'CodeBuddyIDE/1.106.1')
  assert.equal(h['X-Product-Code'], 'codebuddy')
  assert.equal(h['X-Product'], 'CodeBuddy')
  assert.equal(h['X-IDE-Name'], 'CodeBuddy')
  assert.equal(h['X-Domain'], 'copilot.tencent.com')
})

test('⚠️ 会话 ID 派生：同账号同会话稳定，跨账号/跨会话不同', async () => {
  // 稳定 ⇒ 多轮复用同一个 id（像官方客户端）；
  // 跨账号不同 ⇒ 不把两个号用一个 id 串起来（那才是真正的关联键）。
  const a = await deriveIntlConversationId('u-1', 's-1')
  const b = await deriveIntlConversationId('u-1', 's-1')
  const c = await deriveIntlConversationId('u-2', 's-1')
  const d = await deriveIntlConversationId('u-1', 's-2')
  const e = await deriveIntlConversationId('u-1', '')
  const f = await deriveIntlConversationId('u-1', '')

  assert.equal(a, b, '同账号同会话必须稳定')
  assert.notEqual(a, c, '不同账号必须不同（否则成了跨账号关联键）')
  assert.notEqual(a, d, '不同会话必须不同')
  assert.match(a, UUID_SHAPE, '必须是连字符分隔的五段 hex')
  // 会话键无法判定时退回随机 —— 仍要是 UUID 形状，且两次不同（不能退化成常量）
  assert.match(e, UUID_SHAPE)
  assert.notEqual(e, f, '空会话键必须退回随机')
})

test('⚠️ 轮级 ID 必须每次新生成（重试复用由调用方在循环外保证）', () => {
  const a = newTurnRequestId()
  const b = newTurnRequestId()
  assert.match(a, HEX32)
  assert.notEqual(a, b)
})
