import type { GatewayModel } from './models'

// ⚠️ 只做类型导入：本文件要能被网关单测直接打包（models.ts 会拉起 react-query 与浏览器 API）。
const isAggregate = (id: string) => id.startsWith('aggregate/')

/**
 * DSH（DeepSeek Harness）`@deepseek-ai/dsh-llm-pi-ai` 的自定义提供商片段生成。
 *
 * ## 为什么需要它
 *
 * DSH 对自定义提供商的模型发现（`GET {baseURL}/models`）**只读** id / 名称 / 上下文 /
 * 输出上限，不读任何推理字段；手工声明的路由没有内置目录可继承，于是没声明
 * `reasoningEfforts` 的模型一选「推理努力」就在**客户端本地**报
 * 「不支持推理努力」—— 请求根本到不了网关。
 *
 * ## 契约（对照 dsh-llm-pi-ai 0.2.x 的 profile schema）
 *
 * - `reasoningEfforts` 的键只能是 DSH 的档位名（`off/minimal/low/medium/high/xhigh/max`，
 *   其他键整份 profile 会被拒绝），值是线上发送的拼写；按强度从低到高排列。
 *   `off` 不声明：以省略字段表达的协议会沿用上游默认（仍会思考），声明了反而误导。
 * - 图片输入只认 `input: [text, image]`，不认 `supportsVision`。
 * - 字符串一律用 JSON 双引号写法（YAML 合法子集），避免 `:`、`#`、`·` 等字符出问题。
 */

const DSH_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const DSH_PROVIDER_KEY = 'flr'
export const DSH_CREDENTIAL_REF = 'FLR_API_KEY'

/** 网关宣告的档位 → DSH 的 `reasoningEfforts`（只留 DSH 认识的键；无可用档位返回 undefined）。 */
export function dshEfforts(list: unknown): [string, string][] | undefined {
  if (!Array.isArray(list)) return undefined
  const picked = new Map<string, string>()
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const wire = raw.trim()
    const key = wire.toLowerCase()
    if ((DSH_LEVELS as readonly string[]).includes(key) && !picked.has(key)) picked.set(key, wire)
  }
  if (picked.size === 0) return undefined
  return DSH_LEVELS.filter((l) => picked.has(l)).map((l) => [l, picked.get(l) as string])
}

const q = (s: string) => JSON.stringify(s)
const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined

/** 生成 `cordis.patch.yml` 片段 + `.credentials.yaml` 片段。 */
export function dshSnippet(base: string, apiKey: string, models: GatewayModel[]): string {
  const lines: string[] = [
    '# ① ~/.dsh/profiles/<profile>/cordis.patch.yml —— 追加到列表末尾。',
    '#    已有 `id: llm-pi-ai` 条目时，只把下面 `flr:` 这一段并进它的 config.providers。',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    `      ${DSH_PROVIDER_KEY}:`,
    '        displayName: FLR',
    `        apiKeyEnv: ${DSH_CREDENTIAL_REF}`,
    '        api: openai-completions',
    `        baseURL: ${q(base)}`,
    '        compat:',
    '          thinkingFormat: openai',
    '          supportsReasoningEffort: true',
    '        models:',
  ]
  const real = models.filter((m) => !isAggregate(m.id))
  // 聚合条目放最后：它们没有上游档位，但 auto 路由常被当默认模型
  const list = [...real, ...models.filter((m) => isAggregate(m.id))]
  if (list.length === 0) lines.push(`          - id: ${q('aggregate/auto')}`)
  for (const m of list) {
    lines.push(`          - id: ${q(m.id)}`)
    if (m.name && m.name !== m.id) lines.push(`            name: ${q(m.name)}`)
    const ctx = posInt(m.context_length) ?? posInt(m.top_provider?.context_length)
    if (ctx !== undefined) lines.push(`            contextWindow: ${ctx}`)
    const maxOut = posInt(m.top_provider?.max_completion_tokens)
    if (maxOut !== undefined) lines.push(`            maxTokens: ${maxOut}`)
    if (m.architecture?.input_modalities?.includes('image')) lines.push('            input: [text, image]')
    const efforts = dshEfforts(m.reasoning_efforts)
    if (efforts !== undefined) {
      lines.push('            reasoningEfforts:')
      for (const [k, v] of efforts) lines.push(`              ${k}: ${q(v)}`)
    }
  }
  lines.push(
    '',
    '# ② ~/.dsh/.credentials.yaml（建议 chmod 600）—— 已有 refs: 时只加这一行。',
    'refs:',
    `  ${DSH_CREDENTIAL_REF}: ${q(apiKey)}`,
  )
  return lines.join('\n')
}
