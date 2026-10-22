/**
 * T3：三条流式路径的 `onError` 都必须记**用量**（不只是日志）。
 *
 * ## 缺陷（2026-10-22 核查确认）
 * `onError` 里只有 `recordLog()`，没有 `recordUsage()`。
 * 面板「成功率」按 `recordUsage.ok` 统计 ⇒「已经 200 开流、推到一半上游断了」
 * 这类请求既不算成功也不算失败，直接从统计里消失，成功率虚高。
 *
 * ## 为什么这条测试查源码结构，而不是跑一次真流
 * 网关在把流交给客户端**之前**会先 `peekStreamForError` 预读首块，
 * 错误帧若落在预读窗内，请求根本走不到 `streamResponse`（那条是另一套记账，
 * 已有 `recordRequestFailure` 覆盖）。要让 `onError` 真正触发，
 * 需要构造「预读窗内干净、之后才出错」的流 —— 在单测里极不稳定。
 *
 * 故这里锁定**接线**（与 `providers.test.ts` 对 `hooks.onError(message)` 的
 * 结构断言同一手法）：三处 `onError` 都必须调用 `recordStreamFailure`。
 * 行为层面由线上日志 `[usage]` 与面板成功率复核。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync('src/gateway/server.ts', 'utf8')

test('🔴 三处流式 onError 都必须调用 recordStreamFailure（否则成功率虚高）', () => {
  // 逐个取出 onError 回调块（从 `onError:` 到下一个同缩进的 `},` 之前）
  const blocks: string[] = []
  const re = /\n(\s*)onError: \(([^)]*)\) => \{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const start = m.index
    const end = src.indexOf('\n' + m[1] + '},', start)
    blocks.push(src.slice(start, end === -1 ? start + 2000 : end))
  }

  // 只关心「流式回调」那几处（带 applyFailure 的），类型声明里的是空壳
  const streamBlocks = blocks.filter((b) => b.includes('applyFailure'))
  assert.ok(streamBlocks.length >= 3, `应至少识别出 3 处流式 onError（实际 ${streamBlocks.length}）`)

  const missing = streamBlocks.filter((b) => !b.includes('recordStreamFailure'))
  assert.equal(
    missing.length,
    0,
    `⚠️ 有 ${missing.length} 处 onError 只记了日志、没记用量：\n${missing.map((b) => b.slice(0, 120)).join('\n---\n')}`,
  )
})

test('🔴 recordStreamFailure 必须写 ok:false 且带 errorKind', () => {
  const i = src.indexOf('function recordStreamFailure')
  assert.ok(i > 0, '应存在 recordStreamFailure')
  const body = src.slice(i, i + 900)
  assert.match(body, /ok:\s*false/, '必须标成失败，否则面板仍按成功统计')
  assert.match(body, /errorKind/, '必须带 errorKind，便于按原因归类')
  assert.match(body, /ctx\.waitUntil|waitUntil/, '必须挂到 ctx.waitUntil，否则 Worker 可能提前回收')
})
