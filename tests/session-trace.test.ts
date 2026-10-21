/**
 * 上游**会话链路 ID**（会话头族 + b3 追踪头）的形状与稳定性。
 *
 * ## 为什么这几条断言重要
 *
 * 同类项目的封禁复盘记录了一条可识别的机器特征：
 * **官方 IDE 的请求是链式的**（跨请求稳定的会话 id + 每请求的 trace/span），
 * 而第三方反代发的是**孤立请求**（既无会话 id、也无 b3）。
 * 上游 2026-10-20 起加的渠道校验（`11‑128`）判的正是「头部身份 + 会话头族」。
 *
 * 这类判据**看不见摸不着**：同一个账号换个头就通，失败文案还伪装成
 * 「安全策略拦截」（用户以为是封号）。故必须用单测把语义钉死：
 *
 * 1. `X-Conversation-ID` 在同一客户端会话内**稳定**（否则等于每轮开新会话）；
 * 2. message-id / request-id **每请求新生成**（相等就等于承认「同一个请求重发了」）；
 * 3. b3 的长度必须精确（trace 32 hex / span 16 hex），采样位恒 `1`；
 * 4. 客户端**没有**显式会话标识时退化为每请求随机，且**不报错**
 *    —— 本项目纪律：宁可「不粘」也不能「错误地粘」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  b3TraceHeaders,
  deriveTraceId32,
  referenceChatHeaders,
  sessionTraceHeaders,
} from '../src/upstream/headers.ts'

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/

test('🔴 同一 conversation_id 的两次请求 ⇒ X-Conversation-ID 相同（链路稳定）', () => {
  // 官方客户端在同一对话里复用同一个会话 id；每请求换一个就是
  // 「把一次多轮对话拆成上千个一次性会话」——反作弊眼里最明显的非人类形态。
  const conversationId = 'conv-abcdef'
  const a = sessionTraceHeaders({ conversationId })
  const b = sessionTraceHeaders({ conversationId })

  assert.equal(a['X-Conversation-ID'], conversationId)
  assert.equal(b['X-Conversation-ID'], conversationId)
  assert.equal(a['X-Conversation-ID'], b['X-Conversation-ID'])
})

test('🔴 message-id / request-id 每请求新生成，且都是 32 位 hex', () => {
  const a = sessionTraceHeaders({ conversationId: 'conv-abcdef' })
  const b = sessionTraceHeaders({ conversationId: 'conv-abcdef' })

  assert.match(a['X-Conversation-Message-ID'] ?? '', HEX32, '消息级 ID 必须是 32 位 hex')
  assert.match(a['X-Conversation-Request-ID'] ?? '', HEX32, '轮级 ID 必须是 32 位 hex')
  assert.notEqual(
    a['X-Conversation-Message-ID'],
    b['X-Conversation-Message-ID'],
    '消息级 ID 必须每请求新生成',
  )
  assert.notEqual(
    a['X-Conversation-Request-ID'],
    b['X-Conversation-Request-ID'],
    '未指定轮级 ID 时，每请求各自新生成',
  )
  // 抓包实测的对应关系：轮级两行同值、消息级两行同值，且两级**不得相等**
  assert.equal(a['X-Root-Request-ID'], a['X-Conversation-Request-ID'])
  assert.equal(a['X-Request-ID'], a['X-Conversation-Message-ID'])
  assert.notEqual(a['X-Conversation-Request-ID'], a['X-Conversation-Message-ID'])
})

test('🔴 b3 格式：traceid 32 hex / spanid 16 hex / sampled 为 1', () => {
  const h = sessionTraceHeaders({ conversationId: 'conv-abcdef' })

  assert.match(h['X-B3-TraceId'] ?? '', HEX32, 'b3 trace id 必须是 32 位 hex')
  assert.match(h['X-B3-SpanId'] ?? '', HEX16, 'b3 span id 必须是 16 位 hex')
  assert.equal(h['X-B3-Sampled'], '1', '官方客户端全量采样')
  // 长度断言单独再钉一次：正则匹配上但长度写错（如 padStart 丢位）是最难发现的一类
  assert.equal((h['X-B3-TraceId'] ?? '').length, 32)
  assert.equal((h['X-B3-SpanId'] ?? '').length, 16)
})

test('⚠️ 一条会话 = 一条 trace（traceid 稳定、spanid 每请求新生成）', () => {
  // b3 语义：trace 是「一条调用链」，span 是链上的一次调用。
  // 每请求换 trace 就退回成「一堆互不相干的单 span 请求」——正是复盘指出的特征。
  const a = b3TraceHeaders({ conversationId: 'conv-abcdef' })
  const b = b3TraceHeaders({ conversationId: 'conv-abcdef' })
  const other = b3TraceHeaders({ conversationId: 'conv-different' })

  assert.equal(a['X-B3-TraceId'], b['X-B3-TraceId'], '同会话 trace 必须稳定')
  assert.notEqual(a['X-B3-TraceId'], other['X-B3-TraceId'], '不同会话必须是不同 trace')
  assert.notEqual(a['X-B3-SpanId'], b['X-B3-SpanId'], 'span 必须每请求新生成')

  // 派生函数本身：确定性 + 长度守恒（曾见过「少一位但不报错」的假 ID）
  assert.equal(deriveTraceId32('conv-abcdef'), deriveTraceId32('conv-abcdef'))
  assert.match(deriveTraceId32('conv-abcdef'), HEX32)
})

test('🔴 客户端没给会话标识 ⇒ 退化为每请求随机，且不抛错', () => {
  // ⚠️ 判据只认客户端**显式**声明的会话标识（`user` / `conversation_id`），
  // 绝不从消息内容推断 —— 「错误地粘」会把独立请求压到一处、被上游踢流。
  // 直接调用即覆盖「不报错」：抛错会让本用例失败（不必包 doesNotThrow）
  const a = sessionTraceHeaders()
  const b = sessionTraceHeaders()

  // 头一个都不能少（缺头的代价是整条请求被 11‑128 拒掉）
  for (const name of [
    'X-Conversation-ID',
    'X-Conversation-Request-ID',
    'X-Conversation-Message-ID',
    'X-Root-Request-ID',
    'X-Request-ID',
    'X-B3-TraceId',
    'X-B3-SpanId',
    'X-B3-Sampled',
  ]) {
    assert.ok(name in a, `无会话标识时也不得缺头：${name}`)
  }
  // 退化为「每请求各自独立」：会话 id 与 trace 都不同（不能是常量）
  assert.notEqual(a['X-Conversation-ID'], b['X-Conversation-ID'], '无会话时必须每请求随机')
  assert.notEqual(a['X-B3-TraceId'], b['X-B3-TraceId'], '无会话时 trace 也必须每请求随机')
  // 但形态仍必须合法：缺头/畸形头比随机更糟
  assert.match(a['X-B3-TraceId'] ?? '', HEX32)
  assert.match(a['X-B3-SpanId'] ?? '', HEX16)
  assert.equal(a['X-B3-Sampled'], '1')
})

test('🔴 重试语义：轮级 ID 显式传入时原样复用，消息级仍新生成', () => {
  // 重试若换轮级 id，上游看到的就是「另一轮」，正是最显眼的非人类特征。
  // 故调用方在重试循环外算一次传进来（gateway 就是这么做的）。
  const turnRequestId = 'b'.repeat(32)
  const first = sessionTraceHeaders({ conversationId: 'conv-abcdef', turnRequestId })
  const retry = sessionTraceHeaders({ conversationId: 'conv-abcdef', turnRequestId })

  assert.equal(first['X-Conversation-Request-ID'], turnRequestId)
  assert.equal(retry['X-Conversation-Request-ID'], turnRequestId)
  assert.equal(retry['X-Root-Request-ID'], turnRequestId)
  assert.notEqual(first['X-Conversation-Message-ID'], retry['X-Conversation-Message-ID'])
  // 同一轮的两次尝试共享同一条 trace（链路不因重试而断）
  assert.equal(first['X-B3-TraceId'], retry['X-B3-TraceId'])
})

test('🔴 出站组装处必须真的带上 b3，且不得污染国内服头族', () => {
  // 生成函数写对了但没接到组装处，是「改了个影子实现」的典型形态 —— 故这里测组装结果。
  const intl = referenceChatHeaders({
    uid: 'workbuddy:u-1',
    accessToken: 'tok',
    variant: 'workbuddy',
    conversationId: 'conv-abcdef',
    turnRequestId: 'c'.repeat(32),
  })
  assert.equal(intl['X-Conversation-ID'], 'conv-abcdef')
  assert.equal(intl['X-Conversation-Request-ID'], 'c'.repeat(32))
  assert.match(intl['X-B3-TraceId'] ?? '', HEX32)
  assert.match(intl['X-B3-SpanId'] ?? '', HEX16)
  assert.equal(intl['X-B3-Sampled'], '1')

  // ⚠️ 国内服（CodeBuddyIDE/1.106.1 那套）实测**仍然 200**，一个字符都不能被污染
  const cn = referenceChatHeaders({ uid: 'u', accessToken: 'tok', variant: 'buddy' })
  for (const name of Object.keys(cn)) {
    assert.ok(!name.startsWith('X-Conversation-'), `国内服不得出现会话头：${name}`)
    assert.ok(!name.startsWith('X-B3-'), `国内服不得出现 b3 头：${name}`)
  }
})
