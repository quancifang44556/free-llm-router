/**
 * B4 / B5 / B6：provider 层的三个缺陷。
 *
 * ## B4 —— 业务码在进 `ProviderError.message` 之前就被丢了
 * `detailOf()` 只取 `error`/`message` 字段的**字符串**，于是上游信封里的
 * `{"code":11134,…}` 在抛错前被拆掉。而网关正是拿整条 message 去
 * `classify()` / `refineModelScoped()`（靠 `parseBusinessCode()` 找 `"code": 数字`）。
 * ⇒ 业务码丢失后只能退化成通用分类：本该「只冷却这个模型」的 11134
 * 变成「锁住整个账号」。
 *
 * ## B5 —— trae 的模型→通道映射在 chat 路径上写死
 * 映射表只在 `listModels()` 里填，没跑过它的进程（冷启动 / 新号）走 chat 时
 * 所有模型都被当成同一通道，多模型路由失效。
 *
 * ## B6 —— 四家 chat() 没有「首帧超时」
 * 只传 `request.signal`（只在客户端断开时触发）⇒ 上游接了连接却永不回响应头时，
 * 请求无限挂起：用户看到「一直转圈」，网关既不换号也不报错。
 * `buddy.chat` 早已用 `AbortController + setTimeout` 修过同一形态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { findProvider } from '../src/providers/index.js'

const read = (f: string) => fs.readFileSync(f, 'utf8')

test('🔴 B4：上游业务码必须原样进 ProviderError.message（否则网关判不出模型级）', async () => {
  const provider = findProvider('cline')
  assert.ok(provider !== undefined)

  const originalFetch = globalThis.fetch
  // 上游用「非 OpenAI 信封」报错：业务码在 code 字段里
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ code: 11134, msg: 'model not allowed for this account' }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )) as never

  try {
    let caught: unknown
    try {
      await provider.chat(
        { accessToken: 'tok' } as never,
        { model: 'm', body: {}, signal: new AbortController().signal } as never,
      )
    } catch (error) {
      caught = error
    }
    assert.ok(caught !== undefined, '403 必须抛错')
    const message = (caught as Error).message
    assert.match(
      message,
      /11134/,
      `⚠️ 业务码 11134 丢了（message=${message.slice(0, 200)}）—— 网关会把模型级限流误判成账号级，锁掉整个号`,
    )
    assert.match(message, /model not allowed/, '可读文案仍要保留（不能只剩一串 JSON）')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('🔴 B6：四家 chat() 都必须有「首帧超时」守卫', () => {
  // ## 为什么用结构断言而不是跑一次真超时
  //
  // 超时阈值是 120 秒 —— 单测里等不起；用假定时器又要把整个 fetch 链路 mock 掉，
  // 测出来的东西与真实行为关系不大。这里守的是**接线**：四家的 chat 都必须
  // 经过 `withFirstFrameTimeout`，且不得把 `request.signal` 直接交给 fetch
  //（那正是缺陷本身）。
  for (const [file, label] of [
    ['src/providers/cline.ts', 'cline'],
    ['src/providers/minimax.ts', 'minimax'],
    ['src/providers/trae.ts', 'trae'],
    ['src/providers/opencode.ts', 'opencode'],
  ] as const) {
    const src = read(file)
    assert.match(src, /withFirstFrameTimeout\(/, `${label}：缺首帧超时守卫（上游不响应会无限挂起）`)
    // chat 里不得再把客户端 signal 直接交给 fetch
    const chatStart = src.indexOf('async function chat(')
    assert.ok(chatStart > 0, `${label}：应有 chat()`)
    const chatBody = src.slice(chatStart, chatStart + 4000)
    assert.ok(
      !/signal:\s*request\.signal/.test(chatBody),
      `${label}：chat() 仍把 request.signal 直接交给 fetch —— 那只在客户端断开时触发，上游黑洞时会无限挂起`,
    )
    // 计时器必须能撤掉，否则会掐断正常的长回答
    assert.match(src, /clearTimeout\(/, `${label}：超时计时器必须 clearTimeout（否则长回答被拦腰截断）`)
  }
})

test('🔴 B5：trae 的 chat 不得把通道写死（必须按模型解析）', () => {
  const src = read('src/providers/trae.ts')
  const chatStart = src.indexOf('async function chat(')
  assert.ok(chatStart > 0)
  const chatBody = src.slice(chatStart, chatStart + 4000)
  assert.ok(
    !/\?\?\s*TRAE_FUNCTION/.test(chatBody),
    '⚠️ chat() 仍在用 `?? TRAE_FUNCTION` 写死通道 —— 冷启动时所有模型会挤进同一通道',
  )
  assert.match(src, /function resolveChannel\(/, '应有 resolveChannel()：按模型解析通道，未知时惰性学习')
  // 未知通道必须与「就是 TRAE_FUNCTION」区分开
  assert.match(src, /UNKNOWN_CHANNEL/, '未知通道要用独立常量表示，不能拿 TRAE_FUNCTION 兜底')
})
