/**
 * 请求体协议修复的单测（移植自 ardeyouxipianyi/workbuddy2api-hub 的几处修复）。
 *
 * 每一条都对应上游一个**真实**的 400 业务码：
 * 11148（tool_call 配对/顺序断裂）、11101（字段类型不对）、11129（工具 schema 不合法）、
 * 11155（DeepSeek 思考模式缺 reasoning_content）。这类错误换号重试也不会好，
 * 且客户端每轮都重放同样的历史 ⇒ 整条会话报废，所以必须在出站前修好。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backfillReasoningContent,
  cleanupOrphanToolCalls,
  cleanupToolPairing,
  clampGptMaxTokens,
  isDeepseekThinking,
  mergeAdjacentToolCalls,
  normalizeStop,
  normalizeToolChoice,
  normalizeTools,
  prepareChatBody,
  repackToolResultBlocks,
  scrubFingerprintText,
  scrubFingerprints,
} from '../src/gateway/payload.ts'
import { classify, shouldPunish, shouldRotate } from '../src/upstream/client.ts'
import { clientStatusFor, mapErrorToPunishment, refineModelScoped } from '../src/gateway/server.ts'

type M = Record<string, unknown>
const call = (id: string, name = 'f', args: unknown = '{}'): M => ({ id, type: 'function', function: { name, arguments: args } })

// ─────────────────────── 11148：相邻 assistant 合并 ───────────────────────

test('相邻 assistant 各带一个 tool_call ⇒ 合并成一条（形态 1，保留 reasoning_content）', () => {
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [call('a')], reasoning_content: 'r1' },
    { role: 'assistant', content: '', tool_calls: [call('b')], reasoning_content: 'r2' },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'tool', tool_call_id: 'b', content: 'B' },
  ]
  const out = mergeAdjacentToolCalls(msgs) as M[]
  assert.equal(out.length, 4)
  const merged = out[1]!
  assert.deepEqual((merged.tool_calls as M[]).map((c) => c.id), ['a', 'b'])
  assert.equal(merged.reasoning_content, 'r1\nr2')
  assert.deepEqual((msgs[1] as M).tool_calls, [call('a')], '⚠️ 不得修改入参')
})

test('形态 2：无正文的 tool_calls assistant 后紧跟纯文本 assistant ⇒ 文本并入', () => {
  const msgs = [
    { role: 'assistant', content: [], tool_calls: [call('a')] },
    { role: 'assistant', content: '我来查一下' },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
  ]
  const out = mergeAdjacentToolCalls(msgs) as M[]
  assert.equal(out.length, 2)
  assert.equal(out[0]!.content, '我来查一下')
})

test('条件不满足时不合并（后一条有正文又有调用 / 前一条不是调用）', () => {
  const a = [
    { role: 'assistant', content: 'x', tool_calls: [call('a')] },
    { role: 'assistant', content: 'y', tool_calls: [call('b')] },
  ]
  assert.equal(mergeAdjacentToolCalls(a), a)
  const b = [
    { role: 'assistant', content: 'x' },
    { role: 'assistant', content: 'y' },
  ]
  assert.equal(mergeAdjacentToolCalls(b), b)
})

// ─────────────────────── 11148：结果块重排 ───────────────────────

test('插在两条结果之间的消息挪到整批结果之后（Codex image_resize_notice）', () => {
  const msgs = [
    { role: 'assistant', tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'system', content: 'image resized' },
    { role: 'tool', tool_call_id: 'b', content: 'B' },
    { role: 'user', content: 'next' },
  ]
  const out = repackToolResultBlocks(msgs) as M[]
  assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'tool', 'system', 'user'])
  assert.equal(out[1]!.tool_call_id, 'a')
  assert.equal(out[2]!.tool_call_id, 'b')
})

test('插在第一条结果之前的消息也会被挪走', () => {
  const msgs = [
    { role: 'assistant', tool_calls: [call('a')] },
    { role: 'user', content: 'notice' },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
  ]
  const out = repackToolResultBlocks(msgs) as M[]
  assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'user'])
})

test('配对本就紧凑时原样返回（同一引用）', () => {
  const msgs = [
    { role: 'assistant', tool_calls: [call('a')] },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'user', content: 'ok' },
  ]
  assert.equal(repackToolResultBlocks(msgs), msgs)
})

// ─────────────────────── 11148：两侧剪孤儿 ───────────────────────

test('没有结果的 tool_call 被剪掉（工具失败后客户端永远不会补结果）', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [call('a'), call('lost')] },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'assistant', content: 'done' },
  ]
  const out = cleanupOrphanToolCalls(msgs) as M[]
  assert.deepEqual((out[0]!.tool_calls as M[]).map((c) => c.id), ['a'])
  assert.deepEqual(((msgs[0] as M).tool_calls as M[]).length, 2, '⚠️ 不得修改入参')
})

test('一条调用都不剩时删掉 tool_calls 字段（不留空数组）', () => {
  const out = cleanupOrphanToolCalls([{ role: 'assistant', content: 'x', tool_calls: [call('lost')] }]) as M[]
  assert.equal('tool_calls' in out[0]!, false)
})

test('cleanupToolPairing：空名调用被剔除后，它的结果也成了孤儿、一并删除', () => {
  const msgs = [
    { role: 'assistant', tool_calls: [call('c1', ''), call('c2', 'good')] },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'tool', tool_call_id: 'c2', content: 'r2' },
  ]
  const out = cleanupToolPairing(msgs) as M[]
  assert.equal(out.length, 2)
  assert.equal(out[1]!.tool_call_id, 'c2')
})

test('cleanupToolPairing：arguments 是对象 ⇒ 序列化成字符串；缺省 ⇒ "{}"（否则 11101）', () => {
  const msgs = [
    { role: 'assistant', tool_calls: [call('a', 'f', { q: 1 }), call('b', 'g', null)] },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'tool', tool_call_id: 'b', content: 'B' },
  ]
  const out = cleanupToolPairing(msgs) as M[]
  const calls = out[0]!.tool_calls as M[]
  assert.equal((calls[0]!.function as M).arguments, '{"q":1}')
  assert.equal((calls[1]!.function as M).arguments, '{}')
  assert.deepEqual(((msgs[0] as M).tool_calls as M[])[0], call('a', 'f', { q: 1 }), '⚠️ 不得修改入参')
})

test('cleanupToolPairing：合并 + 重排 + 剪孤儿一次做完', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: null, tool_calls: [call('a')] },
    { role: 'assistant', content: null, tool_calls: [call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'developer', content: 'notice' },
    { role: 'tool', tool_call_id: 'b', content: 'B' },
    { role: 'tool', tool_call_id: 'ghost', content: '?' },
  ]
  const out = cleanupToolPairing(msgs) as M[]
  assert.deepEqual(out.map((m) => m.role), ['system', 'assistant', 'tool', 'tool', 'system'])
  assert.deepEqual((out[1]!.tool_calls as M[]).map((c) => c.id), ['a', 'b'])
})

// ─────────────────────── 11155：DeepSeek 思考回填 ───────────────────────

test('DeepSeek 默认视为思考模式；显式关闭（thinking.disabled / effort=none）则不是', () => {
  assert.equal(isDeepseekThinking({ model: 'deepseek-v4.1-flash' }), true)
  assert.equal(isDeepseekThinking({ model: 'workbuddy/deepseek-v4.1-flash' }), true)
  assert.equal(isDeepseekThinking({ model: 'deepseek-v4', thinking: { type: 'disabled' } }), false)
  assert.equal(isDeepseekThinking({ model: 'deepseek-v4', reasoning_effort: 'none' }), false)
  assert.equal(isDeepseekThinking({ model: 'deepseek-v4', reasoning_effort: 'none', thinking: { type: 'enabled' } }), true)
  assert.equal(isDeepseekThinking({ model: 'glm-5' }), false)
})

test('思考模式下每条 assistant 补 reasoning_content，并镜像非空 reasoning', () => {
  const msgs = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a1' },
    { role: 'assistant', content: 'a2', reasoning: 'thought' },
  ]
  const out = backfillReasoningContent(msgs, 'deepseek-v4.1-flash', true) as M[]
  assert.equal(out[1]!.reasoning_content, '')
  assert.equal(out[1]!.reasoning, ' ', '空思考用一个空格占位（上游校验 len>0）')
  assert.equal(out[2]!.reasoning_content, 'thought')
  assert.equal(out[2]!.reasoning, 'thought')
  assert.equal(out[0], msgs[0], 'user 消息不动')
})

test('非 DeepSeek 模型 / 思考关闭且无痕迹时不回填', () => {
  const msgs = [{ role: 'assistant', content: 'a' }]
  assert.equal(backfillReasoningContent(msgs, 'glm-5', true), msgs)
  assert.equal(backfillReasoningContent(msgs, 'deepseek-v4', false), msgs)
  // 有痕迹时即使思考关闭也回填（与官方客户端 ReasoningContentBackfillRule 同口径）
  const traced = [{ role: 'assistant', content: 'a', reasoning_content: 'x' }, { role: 'assistant', content: 'b' }]
  const out = backfillReasoningContent(traced, 'deepseek-v4', false) as M[]
  assert.equal(out[1]!.reasoning_content, '')
})

// ─────────────────────── 11101：stop / tool_choice ───────────────────────

test('stop 字符串 ⇒ 单元素数组；空值删除；合法数组不动', () => {
  const a: M = { stop: 'END' }
  assert.equal(normalizeStop(a), true)
  assert.deepEqual(a.stop, ['END'])
  const b: M = { stop: '' }
  normalizeStop(b)
  assert.equal('stop' in b, false)
  const c: M = { stop: ['x', '', 3] }
  normalizeStop(c)
  assert.deepEqual(c.stop, ['x'])
  const d: M = { stop: ['x'] }
  assert.equal(normalizeStop(d), false)
})

test('tool_choice 对象 {type:none|required} ⇒ 同名字符串；大小写归一', () => {
  const a: M = { tool_choice: { type: 'none' } }
  normalizeToolChoice(a)
  assert.equal(a.tool_choice, 'none')
  const b: M = { tool_choice: { type: 'required' } }
  normalizeToolChoice(b)
  assert.equal(b.tool_choice, 'required')
  const c: M = { tool_choice: ' AUTO ' }
  normalizeToolChoice(c)
  assert.equal(c.tool_choice, 'auto')
})

// ─────────────────────── 11129：工具 schema ───────────────────────

test('工具 schema 修复：别名类型、null 元数据、缺 properties、脏 required、元组 items', () => {
  const body: M = {
    tools: [{
      type: 'function',
      function: {
        name: 'f',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'str', description: null },
            b: { type: 'list', items: [{ type: 'int' }] },
            c: { type: 'dict' },
          },
          required: ['a', null, ''],
        },
      },
    }],
  }
  const original = JSON.stringify(body)
  assert.equal(normalizeTools(body), true)
  const p = ((body.tools as M[])[0]!.function as M).parameters as M
  const props = p.properties as Record<string, M>
  assert.deepEqual(props.a, { type: 'string' })
  assert.deepEqual(props.b, { type: 'array', items: { type: 'integer' } })
  assert.deepEqual(props.c, { type: 'object', properties: {} })
  assert.deepEqual(p.required, ['a'])
  void original
})

test('顶层 name 写法包成 function；legacy functions → tools；无名内置工具丢弃', () => {
  const a: M = { tools: [{ name: 'f', description: 'd' }, { type: 'web_search' }] }
  normalizeTools(a)
  assert.equal((a.tools as M[]).length, 1)
  assert.deepEqual((a.tools as M[])[0], {
    type: 'function',
    function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } },
  })
  const b: M = { functions: [{ name: 'g', parameters: { type: 'object', properties: {} } }] }
  normalizeTools(b)
  assert.equal('functions' in b, false)
  assert.equal(((b.tools as M[])[0]!.function as M).name, 'g')
  const c: M = { tools: [] }
  normalizeTools(c)
  assert.equal('tools' in c, false, '空 tools 删除')
})

test('合规的工具声明原样保留（同一引用、不报改动）', () => {
  const tool = { type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } }
  const body: M = { tools: [tool] }
  assert.equal(normalizeTools(body), false)
  assert.equal((body.tools as M[])[0], tool)
})

// ─────────────────────── GPT 下限 ───────────────────────

test('gpt-* 的 max_tokens < 16 夹到 16；其他模型不动', () => {
  const a: M = { model: 'gpt-5.3-codex', max_tokens: 1 }
  assert.equal(clampGptMaxTokens(a), true)
  assert.equal(a.max_tokens, 16)
  const b: M = { model: 'deepseek-v4', max_tokens: 1 }
  assert.equal(clampGptMaxTokens(b), false)
  assert.equal(b.max_tokens, 1)
})

// ─────────────────────── 指纹脱敏 ───────────────────────

test('客户端指纹改写：Claude Code / Codex / OmO / billing header', () => {
  assert.equal(
    scrubFingerprintText("You are Claude Code, Anthropic's official CLI for Claude."),
    "You are Claude Code, Anthropic's official CLI tool for Claude.",
  )
  assert.equal(
    scrubFingerprintText('You are a coding agent running in the Codex CLI, a terminal-based coding assistant.'),
    'You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.',
  )
  assert.equal(
    scrubFingerprintText('I am sisyphus-junior - focused executor from ohmyopencode.'),
    'I am Sisyphus-Junior - Focused executor.',
  )
  assert.equal(scrubFingerprintText('x-anthropic-billing-header: cc_version=1.0; cc_entrypoint=cli; hello'), 'hello')
  const plain = 'nothing to see here'
  assert.equal(scrubFingerprintText(plain), plain)
})

test('scrubFingerprints 覆盖文本分段，且无指纹时返回原数组', () => {
  const msgs = [{ role: 'system', content: [{ type: 'text', text: 'Main branch (you will usually use this for PRs)' }] }]
  const out = scrubFingerprints(msgs) as M[]
  assert.equal(((out[0]!.content as M[])[0] as M).text, 'Default branch (you will usually use this for PRs)')
  const clean = [{ role: 'user', content: 'hi' }]
  assert.equal(scrubFingerprints(clean), clean)
})

// ─────────────────────── 完整管线 ───────────────────────

test('prepareChatBody 串起全部修复', () => {
  const r = prepareChatBody({
    model: 'deepseek-v4.1-flash',
    stop: 'END',
    tool_choice: { type: 'function', function: { name: 'f' } },
    tools: [{ type: 'function', function: { name: 'f', parameters: null } }],
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [call('a', 'f', { x: 1 })] },
      { role: 'assistant', content: null, tool_calls: [call('b')] },
      { role: 'tool', tool_call_id: 'a', content: 'A' },
    ],
  })
  const body = JSON.parse(r.body) as M
  assert.deepEqual(body.stop, ['END'])
  assert.equal(body.tool_choice, 'auto')
  const msgs = body.messages as M[]
  assert.equal(msgs.length, 3)
  assert.deepEqual((msgs[1]!.tool_calls as M[]).map((c) => c.id), ['a'], '无结果的 b 被剪掉')
  assert.equal(((msgs[1]!.tool_calls as M[])[0]!.function as M).arguments, '{"x":1}')
  assert.equal(msgs[1]!.reasoning_content, '')
  for (const tag of ['stop[]', 'tool_choice', 'tools', 'tool-pairing', 'reasoning_content']) {
    assert.ok(r.applied.includes(tag), `applied 应含 ${tag}：${r.applied.join(',')}`)
  }
})

// ─────────────────────── 错误分类 ───────────────────────

test('请求形状类业务码 ⇒ bad_request：不罚号、不换号、回 400（即使上游用 5xx 包着）', () => {
  for (const code of [11101, 11129, 11133, 11148, 11150, 11155]) {
    for (const status of [400, 500]) {
      const c = classify(status, JSON.stringify({ code, msg: 'x' }))
      assert.equal(c.kind, 'bad_request', `${code}@${status}`)
      assert.equal(shouldPunish(c.kind), false)
      assert.equal(shouldRotate(c.kind), false)
      assert.equal(mapErrorToPunishment(c.kind).punish, false)
      assert.equal(clientStatusFor(status, c.kind), 400)
    }
  }
})

test('11134（模型供应方暂不可用）⇒ 模型级繁忙，不按账号级熔断', () => {
  const text = JSON.stringify({ code: 11134, msg: 'model provider temporarily unavailable' })
  const c = classify(502, text)
  assert.equal(c.kind, 'rate_limited')
  assert.equal(refineModelScoped(c.kind, text).dimension, 'model')
})
