/**
 * 非流式聚合：`refusal` / `function_call` 必须真的被累积（否则判据是死代码）。
 *
 * ## 为什么这些断言重要（2026-10-21 审查发现的「修了等于没修」）
 *
 * `isEmptyAssistantTurn` 的判据里**早就**写上了
 * `if (msg.refusal !== … ) return false` 和 `if (msg.function_call !== … ) return false`
 *（注释还写着「拒答也是产出」「漏掉它们会把合法拒答反向误报成空响应」），
 * 但 `aggregateSse()` **从不累积这两个字段** —— 它只累加
 * content / reasoning_content / tool_calls。
 *
 * 而 `AggregatedCompletion` **只由 `aggregateSse` 生产**（`server.ts` 与
 * `responses.ts` 只是它的消费点）⇒ 那两条判据**永远拿不到非空值**，是不可达的死代码：
 *
 * ```
 * data: {"choices":[{"index":0,"delta":{"refusal":"我不能协助这个请求。"}}]}
 *   ⇒ aggregateSse ⇒ { content: '' } ⇒ 判「空响应」⇒ HTTP 502
 * ```
 *
 * 用户看到的是「上游返回了空响应（既没有正文/思考内容，也没有可识别的错误帧）」，
 * 而真相是**模型明确拒答了** —— 这是合法产出，该采取的行动（换个问法 vs 重试）
 * 完全不同。
 *
 * ⚠️ 这个缺陷最值得记的一点：**修复前后可观察行为完全一致**，所以断言不能只落在
 * 判据函数上（判据函数本来就是对的，`tests/providers.test.ts` 早就钉住它了），
 * 必须落在 `aggregateSse` 的**产物**上 —— 判据「读的字段有没有人生产」才是缺陷本体。
 *
 * ⚠️ 顺带钉住一个不对称：**流式路径从来没这个问题**（`normalizeFrame` 只删空值，
 * 非空 `refusal` 原样透传），于是同一个响应「流式能看、非流式报 502」——
 * 又是本项目最主要的缺陷形态：同一概念两条路径口径漂移。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { aggregateSse, isEmptyAssistantTurn, type AggregatedCompletion } from '../src/gateway/stream.ts'

// ───────────────────────── 工具：造上游 SSE ─────────────────────────

/** 把若干帧对象拼成上游 SSE 原文（`data: {...}`，与真实上游同形）。 */
function sseOf(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n`).join('') + 'data: [DONE]\n'
}

/** 造一个「只有一个 choice」的 chunk 帧（`delta` 是上游真正累积的那一层）。 */
function chunk(delta: Record<string, unknown>, finish = ''): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

// ───────────────────────── refusal ─────────────────────────

test('🔴 只含 refusal 的 SSE 不得被判成「空响应」（判据早就在，生产者此前没有）', () => {
  // 上游真实形态：拒答也是**逐 token 流式**的 ⇒ `refusal` 分片到达。
  const raw = sseOf([
    chunk({ role: 'assistant', content: '' }),
    chunk({ refusal: '我不能' }),
    chunk({ refusal: '协助这个请求。' }),
    chunk({}, 'stop'),
  ])

  const out = aggregateSse(raw, { model: 'm', now: 0 })
  const message = out.choices[0]!.message

  // ① 聚合产物里必须真的有 refusal，且**分片拼接**（只留最后一片会截成半句）
  assert.equal(message.content, '', '拒答响应没有正文 —— 这正是它被判空的直接原因')
  assert.equal(message.refusal, '我不能协助这个请求。', 'refusal 必须按分片拼接')

  // ② 于是共用判据不再把它当空响应（这正是本次修复的目的）
  assert.equal(
    isEmptyAssistantTurn(out.choices[0]),
    false,
    '⚠️ 拒答是产出，判空会把**合法拒答**反向误报成 502',
  )

  // ③ 非流式 Chat 路径是直接把 completion 序列化给客户端的
  //    （`server.ts` 的 `JSON.stringify(completion)`）⇒ 字段必须能原样穿过 JSON，
  //    否则「判据修好了、用户仍看不到拒答原因」。
  const wire = JSON.parse(JSON.stringify(out)) as AggregatedCompletion
  assert.equal(
    wire.choices[0]?.message.refusal,
    '我不能协助这个请求。',
    'refusal 必须能随 JSON 序列化到客户端',
  )
})

test('refusal 与正文并存时，正文不能被拒答吃掉', () => {
  const raw = sseOf([
    chunk({ content: '答案' }),
    chunk({ refusal: '（后半段拒绝展开）' }),
    chunk({}, 'stop'),
  ])
  const out = aggregateSse(raw, { model: 'm', now: 0 })
  assert.equal(out.choices[0]?.message.content, '答案')
  assert.equal(out.choices[0]?.message.refusal, '（后半段拒绝展开）')
})

// ───────────────────────── 旧式 function_call ─────────────────────────

test('🔴 只含旧式 function_call 的 SSE 不得被判成「空响应」', () => {
  // 旧式 `function_call` 的真实形态：`name` 只在首片给全，`arguments` 是分片。
  const raw = sseOf([
    chunk({ function_call: { name: 'get_weather', arguments: '' } }),
    chunk({ function_call: { arguments: '{"city":' } }),
    chunk({ function_call: { arguments: '"北京"}' } }),
    chunk({}, 'function_call'),
  ])

  const out = aggregateSse(raw, { model: 'm', now: 0 })
  const fc = out.choices[0]!.message.function_call

  assert.notEqual(fc, undefined, 'function_call 必须被累积到 message 上')
  assert.equal(fc?.name, 'get_weather', 'name 只在首片给全 —— 不能被后续空 name 覆盖')
  assert.equal(fc?.arguments, '{"city":"北京"}', 'arguments 是分片到达的，必须拼接')
  assert.doesNotThrow(() => JSON.parse(String(fc?.arguments)), '拼接后必须是合法 JSON')

  assert.equal(
    isEmptyAssistantTurn(out.choices[0]),
    false,
    '⚠️ 函数调用是产出，判空会把**合法函数调用**反向误报成 502',
  )
})

test('空壳 function_call 不得被当成「有产出」（与本缺陷相反的假阴性）', () => {
  // ⚠️ 反向防护：buddy 类上游每帧都带 `"function_call":null` 这类占位字段。
  // 若上游发的是**空对象**，把它挂到 message 上会让「上游什么都没给」被判成
  // 「有内容」⇒ 静默 200 空答案 —— 与本缺陷正好相反的假阴性，同样违反
  // 「失败必须显式」。故只在真拿到 name/arguments 时才挂字段。
  const raw = sseOf([
    chunk({ content: '', function_call: {} }),
    chunk({}, 'stop'),
  ])
  const out = aggregateSse(raw, { model: 'm', now: 0 })
  assert.equal(out.choices[0]?.message.function_call, undefined, '空壳不应挂到 message 上')
  assert.equal(isEmptyAssistantTurn(out.choices[0]), true, '空壳不算产出 ⇒ 仍应如实报「空响应」')
})

// ───────────────────────── 对照：判据不能变成恒 false ─────────────────────────

test('对照：真正的空流仍然判「空响应」', () => {
  // 没有这条对照，上面几条断言可能被「把判据改成恒 false」这种假修复蒙过去 ——
  // 那会让整个守卫彻底失效（「永不触发的守卫」比没有守卫更糟）。
  const raw = sseOf([chunk({ role: 'assistant', content: '' }), chunk({}, 'stop')])
  const out = aggregateSse(raw, { model: 'm', now: 0 })

  assert.equal(isEmptyAssistantTurn(out.choices[0]), true, '空流必须仍判空')
  assert.equal(out.choices[0]?.message.refusal, undefined, '没有拒答时不得编造 refusal 字段')
  assert.equal(out.choices[0]?.message.function_call, undefined, '没有函数调用时不得编造字段')
})

test('🔴 纯拒答在 /v1/responses 上必须是「可见文本」，不能变成 200 空答案', async () => {
  // ## 复核发现的**更坏**形态（2026-10-22）
  //
  // 判据修好后，纯拒答不再被判成「空响应」⇒ 不再 502。
  // 但如果 `/v1/responses` 的 `toResponsesObject` 不读 `refusal`，
  // 它就会渲染成 `output_text: ""` —— 从「502 明确报错」翻转成「200 但答案空白」。
  // 按本项目的铁律「空回复比报错更糟」，那是更坏的形态。
  //
  // ⇒ 判据、生产者、出口三处必须同时认 refusal。
  const { toResponsesObject } = await import('../src/gateway/responses.ts')

  const sse = [
    'data: {"choices":[{"delta":{"refusal":"我不能"}}]}',
    '',
    'data: {"choices":[{"delta":{"refusal":"协助这个请求。"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
  const aggregated = aggregateSse(sse, { model: 'm', now: 0 })
  const obj = toResponsesObject(
    { model: 'm', input: 'hi' } as never,
    'm',
    aggregated,
    'resp_1',
  ) as { output?: Array<{ type?: string; content?: Array<{ text?: string }> }> }

  const texts = (obj.output ?? [])
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? '')
    .filter((t) => t !== '')
  assert.deepEqual(
    texts,
    ['我不能协助这个请求。'],
    `⚠️ 拒答没有变成可见文本（output=${JSON.stringify(obj.output)}）—— 用户会收到 200 但空白答案`,
  )
})
