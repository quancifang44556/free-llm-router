/**
 * 国际服「渠道指纹」反向约束（**防回退**）。
 *
 * ## 为什么需要这张测试
 *
 * 2026-10-20 的两次故障都是同一个模式：上游换了判据，我方"看起来更干净"的写法
 * 恰好命中了黑名单。
 *
 * 1. 会话头族：**有** → 200；**没有** → 400 `11-128`。所以"精简头字段"是错的。
 * 2. 设备头：**按账号派生**（各不相同） → 200；**不发**或**所有账号发同一个** → 429 `14003`。
 *
 * 故这两条不是风格问题，而是**功能性约束**，必须用测试钉死：
 * - 任何"优化"把某个头去掉，测试立刻变红；
 * - 任何人把设备头改成进程级常量，测试立刻变红。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deriveUuidLike, intlDeviceHeaders } from '../src/upstream/headers.ts'
import { deriveIntlConversationId } from '../src/upstream/conversation.ts'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('🔴 国际服设备头必须按账号派生（不同账号不同值）', () => {
  // 若所有账号共用同一个 machineId，就是把整池账号关联到同一台机器上 ——
  // 实测表现为「第 2 个账号起全 429 14003」。
  const a = intlDeviceHeaders({ uid: 'workbuddy:aaa' })
  const b = intlDeviceHeaders({ uid: 'workbuddy:bbb' })
  assert.notEqual(a['X-Machine-ID'], b['X-Machine-ID'], '不同账号的 machineId 不能相同')
  assert.notEqual(a['X-Session-ID'], b['X-Session-ID'], '不同账号的 sessionId 不能相同')
})

test('🔴 同一账号的设备头必须稳定（不能每请求漂移）', () => {
  // 官方客户端是一台固定设备；每请求换 machineId 比不发更可疑。
  const a = intlDeviceHeaders({ uid: 'workbuddy:aaa' })
  const b = intlDeviceHeaders({ uid: 'workbuddy:aaa' })
  assert.equal(a['X-Machine-ID'], b['X-Machine-ID'])
  assert.equal(a['X-Session-ID'], b['X-Session-ID'])
})

test('⚠️ 设备头必须是带连字符的 UUID 形状（与抓包一致）', () => {
  const h = intlDeviceHeaders({ uid: 'workbuddy:shape' })
  assert.match(String(h['X-Machine-ID']), UUID_SHAPE)
  assert.match(String(h['X-Session-ID']), UUID_SHAPE)
  // 变体位：第 4 段首字符必须是 8/9/a/b（RFC 4122）
  assert.match(String(h['X-Machine-ID']), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/)
})

test('⚠️ 凭据里带真实设备标识时必须优先用它（更贴近真实客户端）', () => {
  const h = intlDeviceHeaders({ uid: 'workbuddy:real', machineId: 'M-REAL', sessionId: 'S-REAL' })
  assert.equal(h['X-Machine-ID'], 'M-REAL')
  assert.equal(h['X-Session-ID'], 'S-REAL')
})

test('⚠️ deriveUuidLike 对相邻种子也不能撞（四路 FNV 的意义）', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 500; i += 1) seen.add(deriveUuidLike(`machine:workbuddy:${i}`))
  assert.equal(seen.size, 500, '500 个相邻种子必须产出 500 个不同的值')
})

test('🔴 会话 ID 必须按「账号 + 会话」派生（换号换 id）', async () => {
  const a = await deriveIntlConversationId('workbuddy:aaa', 'session-1')
  const b = await deriveIntlConversationId('workbuddy:bbb', 'session-1')
  const c = await deriveIntlConversationId('workbuddy:aaa', 'session-2')
  assert.notEqual(a, b, '同一段会话 id 出现在两个账号上 = 跨账号关联键')
  assert.notEqual(a, c, '不同会话必须不同 id')
  // 同一账号同一会话必须稳定（否则多轮对话被拆成上千个「一次性会话」）
  assert.equal(a, await deriveIntlConversationId('workbuddy:aaa', 'session-1'))
  assert.match(a, UUID_SHAPE)
})

test('⚠️ 会话键为空时退回随机（不伪造稳定值）', async () => {
  const a = await deriveIntlConversationId('workbuddy:aaa', '')
  const b = await deriveIntlConversationId('workbuddy:aaa', '')
  assert.notEqual(a, b, '无法判定会话时宁可随机，也不要谎称它们是同一会话')
  assert.match(a, UUID_SHAPE)
})
