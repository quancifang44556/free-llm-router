/**
 * A7：同一账号在两个端点必须呈现成**同一台设备**。
 *
 * ## 缺陷
 * `handleChatCompletions` 里算出 `machineId` / `sessionId` 后**再也没用过** ——
 * 纯死变量。于是：
 * - `listModels()`（`/v3/config`）→ `cliChatHeaders` → 发 `deriveDeviceId()` 的 **36 位 hex**；
 * - `chat`（`/v2/chat/completions`）→ `referenceChatHeaders` →
 *   国内版**一个都不发**，国际版发 `deriveUuidLike()` 的 **UUID 形态**。
 *
 * 对上游风控来说这是「一个账号、两台机器、三种身份」。
 * 而 `intlDeviceHeaders` 的注释早写明「缺 `X-Machine-ID` 会回 14003 Model busy」——
 * 我们自己把这条已验证的结论只用在了 config 一条路径上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { cliChatHeaders, deriveDeviceId, referenceChatHeaders } from '../src/upstream/headers.js'

const UID = 'e3f1c2a4-5b6d-4e8f-9a0b-1c2d3e4f5a6b'

test('🔴 两个端点的 X-Machine-ID 必须逐字相同（同一账号 = 同一台设备）', async () => {
  const machineId = await deriveDeviceId(UID, 'machine')
  const sessionId = await deriveDeviceId(UID, 'session')

  // `/v3/config` 那条路径
  const configHeaders = cliChatHeaders({
    uid: UID,
    machineId,
    sessionId,
    accessToken: 'tok',
    conversationRequestId: 'rid',
  })
  // `chat` 那条路径（国内版）
  const chatHeaders = referenceChatHeaders({
    uid: UID,
    accessToken: 'tok',
    variant: 'buddy',
    machineId,
    sessionId,
  })

  assert.equal(configHeaders['X-Machine-ID'], machineId)
  assert.equal(
    chatHeaders['X-Machine-ID'],
    machineId,
    '⚠️ chat 没发 X-Machine-ID（或缺它会让上游按设备维度 429 14003）',
  )
  assert.equal(chatHeaders['X-Session-ID'], sessionId, '⚠️ chat 没发 X-Session-ID')
})

test('🔴 国际版 chat 也必须用同一个值（不得再走 deriveUuidLike 的另一套形态）', async () => {
  const machineId = await deriveDeviceId(UID, 'machine')
  const sessionId = await deriveDeviceId(UID, 'session')
  const headers = referenceChatHeaders({
    uid: UID,
    accessToken: 'tok',
    variant: 'workbuddy',
    machineId,
    sessionId,
  })
  assert.equal(headers['X-Machine-ID'], machineId, '⚠️ 国际版没优先用传入的 machineId')
  assert.equal(headers['X-Session-ID'], sessionId, '⚠️ 国际版没优先用传入的 sessionId')
})

test('设备标识形态是 36 位 hex（参考实现 desktop.go:51-53 的口径）', async () => {
  const machineId = await deriveDeviceId(UID, 'machine')
  assert.match(machineId, /^[0-9a-f]{36}$/, `形态不对：${machineId}`)
  // 同账号恒同值（否则每次请求都像一台新机器，本身就是风控信号）
  assert.equal(await deriveDeviceId(UID, 'machine'), machineId)
  // 不同账号不同值（不能把整池关联到同一台机器）
  assert.notEqual(await deriveDeviceId('other-uid', 'machine'), machineId)
})

test('🔴 chat 路径必须真的把派生值传下去（禁止「算了不用」的死变量）', () => {
  const src = fs.readFileSync('src/gateway/server.ts', 'utf8')
  // 取 chat 的 header 构造段：从 referenceChatHeaders( 到其后的 }) 
  const i = src.indexOf('referenceChatHeaders({')
  assert.ok(i > 0, '应有 referenceChatHeaders 调用')
  const block = src.slice(i, i + 700)
  assert.match(block, /machineId,/, '⚠️ 派生的 machineId 没有传进 chat 头（死变量复现）')
  assert.match(block, /sessionId,/, '⚠️ 派生的 sessionId 没有传进 chat 头（死变量复现）')
})

test('未提供设备标识时不得凭空编造（避免静默把整池关联成同一台机器）', () => {
  const headers = referenceChatHeaders({ uid: UID, accessToken: 'tok', variant: 'buddy' })
  assert.equal(headers['X-Machine-ID'], undefined, '国内版不该在没传值时臆造设备头')
  assert.equal(headers['X-Session-ID'], undefined)
})
