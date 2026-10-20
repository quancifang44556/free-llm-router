/**
 * DSH「不支持推理努力」与 WorkBuddy 思考档位（2026-10-21）。
 *
 * 用户现象：DSH 选 `Workbuddy/DeepSeek-v4.1-Flash` + 推理努力「高」⇒ 本地报
 * 「不支持推理努力」，官方 WorkBuddy 同模型深度思考正常。
 *
 * 根因：dsh-llm-pi-ai 对自定义提供商的模型发现只读 id / 名称 / 容量，不读推理字段；
 * 没在配置里声明 `reasoningEfforts` 的模型在**客户端本地**就被拒（请求到不了网关）。
 * ⇒ 网关把上游 `reasoning.supportedEfforts` 透出为 `reasoning_efforts`，
 *    面板据此生成 DSH 配置片段。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { extractModels, parseReasoning, resolveReasoning } from '../src/gateway/models.ts'
import { toProviderModels } from '../src/providers/buddy.ts'
import { splitModelName } from '../src/providers/types.ts'
import { annotateModelEntry } from '../src/index.ts'
import { dshEfforts, dshSnippet } from '../web/src/lib/dsh.ts'

const WB_FLASH = {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek-V4.1-Flash',
  supportsReasoning: true,
  supportsImages: true,
  reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'], summary: 'auto' },
}

test('parseReasoning：读 supportedEfforts / defaultEffort / canDisableThinking', () => {
  assert.deepEqual(parseReasoning(WB_FLASH.reasoning), { reasoningEfforts: ['low', 'high', 'max'], defaultEffort: 'high' })
  // 去重、小写、丢弃脏值
  assert.deepEqual(parseReasoning({ supportedEfforts: ['High', 'high', ' LOW ', 3, '', 'a b', 'x'.repeat(20)] }), {
    reasoningEfforts: ['high', 'low'],
  })
  // defaultEffort 缺省回落 effort；canDisableThinking 只认布尔
  assert.deepEqual(parseReasoning({ effort: 'medium', canDisableThinking: 'yes' }), { defaultEffort: 'medium' })
  assert.deepEqual(parseReasoning({ canDisableThinking: false }), { canDisableThinking: false })
  // 只有固定档位、没有列表 ⇒ 不宣告可选档位
  assert.equal(parseReasoning({ effort: 'high' }).reasoningEfforts, undefined)
  for (const bad of [undefined, null, 'high', ['low'], 1]) assert.deepEqual(parseReasoning(bad), {})
})

test('🔴 /v1/models 透出 reasoning_efforts（/v3/config → ProviderModel → annotate）', () => {
  const [m] = extractModels({ data: { data: { models: [WB_FLASH, { id: 'glm-4.6' }] } } })
  assert.deepEqual(m?.reasoningEfforts, ['low', 'high', 'max'])
  assert.equal(m?.defaultEffort, 'high')

  const pm = toProviderModels(extractModels({ data: { data: { models: [WB_FLASH, { id: 'glm-4.6' }] } } }))
  assert.deepEqual(pm[0]?.reasoningEfforts, ['low', 'high', 'max'])
  assert.equal('reasoningEfforts' in (pm[1] ?? {}), false, '上游没给档位、快照也没有的模型不该凭空多出字段')

  const out = annotateModelEntry({ ...pm[0], id: `workbuddy/${pm[0]?.id}` } as Record<string, unknown>, 'workbuddy')
  assert.deepEqual(out.reasoning_efforts, ['low', 'high', 'max'])
  assert.equal(out.reasoning_default_effort, 'high')
  assert.equal('reasoning_can_disable' in out, false)
  const plain = annotateModelEntry({ id: 'workbuddy/glm-5.3', name: 'GLM' }, 'workbuddy')
  assert.equal('reasoning_efforts' in plain, false)
})

test('resolveReasoning：实时目录缺档位时按快照逐字段回落（口径同 hub merge_reasoning）', () => {
  // 实时给了列表 ⇒ 以实时为准（即使和快照不同）
  assert.deepEqual(resolveReasoning('deepseek-v4.1-flash', { supportedEfforts: ['high'], defaultEffort: 'high' }), {
    reasoningEfforts: ['high'],
    defaultEffort: 'high',
  })
  // 整块缺失 ⇒ 快照列表，默认 high
  assert.deepEqual(resolveReasoning('deepseek-v4.1-flash', undefined), {
    reasoningEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  })
  // 只给裸 effort ⇒ 列表取快照，effort 在列表内就当默认档位；不在列表内回落 high
  assert.deepEqual(resolveReasoning('DeepSeek-V4.1-Flash', { effort: 'low' }), {
    reasoningEfforts: ['low', 'high', 'max'],
    defaultEffort: 'low',
  })
  assert.equal(resolveReasoning('deepseek-v4.1-flash', { effort: 'medium' }).defaultEffort, 'high')
  // 快照里没有 high 的模型 ⇒ 取第一档
  assert.deepEqual(resolveReasoning('hy4-preview', null), { reasoningEfforts: ['high'], defaultEffort: 'high' })
  // canDisableThinking 等实时字段保留
  assert.equal(resolveReasoning('glm-5.3', { canDisableThinking: true }).canDisableThinking, true)
  // 上游明确说不支持思考 ⇒ 不套快照；未知 id ⇒ 不套
  assert.deepEqual(resolveReasoning('deepseek-v4.1-flash', undefined, false), {})
  assert.deepEqual(resolveReasoning('glm-4.6', undefined, true), {})
  // 经 extractModels 端到端：缺 reasoning 块的已知模型也能拿到档位
  const [m] = extractModels({ data: { data: { models: [{ id: 'glm-5.3', supportsReasoning: true }] } } })
  assert.deepEqual(m?.reasoningEfforts, ['low', 'high', 'max'])
})

test('splitModelName：供应商前缀大小写不敏感，返回规范 id', () => {
  const ids = ['buddy', 'workbuddy', 'cline']
  assert.deepEqual(splitModelName('Workbuddy/DeepSeek-v4.1-Flash', ids, 'buddy'), {
    provider: 'workbuddy',
    model: 'DeepSeek-v4.1-Flash',
  })
  assert.deepEqual(splitModelName('WORKBUDDY/x', ids, 'buddy'), { provider: 'workbuddy', model: 'x' })
  // 未知前缀仍按原约定回落（聚合在 splitModelName 之前单独处理）
  assert.equal(splitModelName('Aggregate/auto', ids, 'buddy').model, 'Aggregate/auto')
})

test('🔴 WorkBuddy 两个渠道的模型名统一小写后再上送（手填大小写会 11102 ⇒ 6 小时模型冷却）', () => {
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  assert.ok(
    /const model = providerId === 'buddy' \|\| providerId === 'workbuddy' \? routed\.model\.toLowerCase\(\) : routed\.model/.test(src),
    '只对 buddy / workbuddy 小写；其他家的 id 可能区分大小写',
  )
})

test('dshEfforts：只留 DSH 认识的档位键，按强度排序，不声明 off', () => {
  assert.deepEqual(dshEfforts(['max', 'low', 'high']), [
    ['low', 'low'],
    ['high', 'high'],
    ['max', 'max'],
  ])
  assert.deepEqual(dshEfforts(['none', 'off', 'ultra', 'medium']), [['medium', 'medium']])
  assert.equal(dshEfforts(['none', 'off']), undefined)
  assert.equal(dshEfforts(undefined), undefined)
  assert.equal(dshEfforts('high'), undefined)
})

test('🔴 dshSnippet：生成 DSH profile 片段（档位、视觉、容量、凭据引用）', () => {
  const s = dshSnippet('https://gw.example.com:10443/v1', 'YOUR_API_KEY', [
    {
      id: 'workbuddy/deepseek-v4.1-flash',
      name: 'WorkBuddy · DeepSeek-V4.1-Flash · ×0.21',
      owned_by: 'workbuddy',
      context_length: 1_000_000,
      top_provider: { context_length: 1_000_000, max_completion_tokens: 65_536 },
      architecture: { input_modalities: ['text', 'image'] },
      reasoning_efforts: ['low', 'high', 'max'],
    },
    { id: 'aggregate/auto', owned_by: 'aggregate' },
    { id: 'qoder/glm', name: 'GLM: "x" #y', owned_by: 'qoder', architecture: { input_modalities: ['text'] } },
  ])
  const lines = s.split('\n')
  for (const want of [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '      flr:',
    '        apiKeyEnv: FLR_API_KEY',
    '        api: openai-completions',
    '        baseURL: "https://gw.example.com:10443/v1"',
    '          thinkingFormat: openai',
    '          supportsReasoningEffort: true',
    '          - id: "workbuddy/deepseek-v4.1-flash"',
    '            contextWindow: 1000000',
    '            maxTokens: 65536',
    '            input: [text, image]',
    '            reasoningEfforts:',
    '              low: "low"',
    '              max: "max"',
    '            name: "GLM: \\"x\\" #y"',
    'refs:',
    '  FLR_API_KEY: "YOUR_API_KEY"',
  ]) {
    assert.ok(lines.includes(want), `缺少：${want}\n${s}`)
  }
  // 纯文本模型不写 input；聚合排在真实模型之后
  assert.ok(s.indexOf('"qoder/glm"') < s.indexOf('"aggregate/auto"'))
  const glmBlock = s.slice(s.indexOf('"qoder/glm"'), s.indexOf('"aggregate/auto"'))
  assert.ok(!glmBlock.includes('input:'))
  // 空目录也要给出非空 models（DSH 拒绝空列表）
  assert.ok(dshSnippet('https://x/v1', 'k', []).includes('- id: "aggregate/auto"'))
})
