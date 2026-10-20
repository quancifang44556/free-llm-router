/**
 * 模型目录：从上游 `/v3/config` 拉取并转成 OpenAI 兼容形状。
 *
 * ⚠️ 上游**没有** OpenAI 式的 `/v1/models`；目录在 `/v3/config`。
 */

import { resolveUpstream, type Env } from '../env.js'
import { DEFAULT_PROVIDER } from '../providers/index.js'
import { cliChatHeaders, deriveDeviceId } from '../upstream/headers.js'

/** 模型目录单条（OpenAI 兼容形状）。 */
export interface OpenAiModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name?: string
  /**
   * 上下文窗口（上游 `maxInputTokens`）。
   *
   * ⚠️ 之前这里**丢掉了**这个字段（只留 id/name），导致面板显示「—」、
   * 客户端也拿不到真实的上下文预算。上游 `/v3/config` 本来就下发它，
   * 白丢是自己的问题。
   */
  contextWindow?: number
  /** 单次输出上限（上游 `maxOutputTokens`）。 */
  maxOutput?: number
  /** 是否接受图片输入（上游 `supportsImages`）。 */
  supportsImage?: boolean
  /** 是否支持工具调用（上游 `supportsToolCall`）。 */
  supportsToolCall?: boolean
  /** 是否支持推理（上游 `supportsReasoning`）。 */
  supportsReasoning?: boolean
  /**
   * 可选的思考档位（上游 `reasoning.supportedEfforts`，如 `['low','high','max']`）。
   *
   * ⚠️ 只有上游**明确列出**档位的模型才带；只给 `reasoning.effort`/`defaultEffort`
   * 的模型是固定档位，客户端选了也不会改变上游实际跑的档位，故不宣告。
   * DSH 等客户端只给声明了档位的模型开「推理努力」选择器，否则一律报不支持。
   */
  reasoningEfforts?: string[]
  /** 默认思考档位（上游 `reasoning.defaultEffort`，缺省回落 `reasoning.effort`）。 */
  defaultEffort?: string
  /** 能否关闭思考（上游 `reasoning.canDisableThinking`；只认显式布尔）。 */
  canDisableThinking?: boolean
  /** 是否默认模型（上游 `isDefault`）。 */
  isDefault?: boolean
  /** 厂商（上游 `vendor`）。 */
  vendor?: string
  /**
   * **计费倍率**（上游 `credits`，如 `"x0.21"`）。
   *
   * ⚠️⚠️ 这是**上游真实下发**的字段 —— 我一开始不知道它存在，
   * 于是从**模型名**里正则抠 `· x0.05` 这种后缀，结果 46 个模型里
   * **39 个抠不到**（名字里根本没写），面板显示成一片「未标注」。
   * 数据一直都在，只是没人读它。
   */
  credits?: string
}

/** 从账号池取第一个可用账号（1–3 账号场景下够用）。 */
export async function pickCredential(
  env: Env,
  realm: string,
  /**
   * 只要该供应商的账号。
   *
   * ⚠️ 这个过滤是**必须**的（实测踩到）：不带它时，一个「有 cline 账号、
   * 没有 workbuddy 账号」的部署会把 cline 的凭据拿去打 WorkBuddy 的端点，
   * 报的是上游 401 —— 看起来像「凭据坏了」，实际是选错了账号。
   */
  providerId = DEFAULT_PROVIDER,
): Promise<{ uid: string; credential: { accessToken: string } } | undefined> {
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
  const accounts = await pool.listAccounts(realm, Date.now())
  for (const account of accounts) {
    if (account.disabled) continue
    if ((account.provider ?? DEFAULT_PROVIDER) !== providerId) continue
    const credential = (await pool.getCredential(account.uid)) as { accessToken?: string } | undefined
    if (credential !== undefined && typeof credential.accessToken === 'string' && credential.accessToken !== '') {
      return { uid: account.uid, credential: { accessToken: credential.accessToken } }
    }
  }
  return undefined
}

/**
 * 拉取模型目录。
 *
 * 目录响应几十 KB，这里允许整体解析 —— 它是**一次性**调用，
 * 不在流式回答的热路径上（那条路径绝不能缓冲）。
 */
export async function listModels(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<OpenAiModel[]> {
  const bases = resolveUpstream(env)
  const machineId = await deriveDeviceId(ctx.uid, 'machine')
  const sessionId = await deriveDeviceId(ctx.uid, 'session')

  const res = await fetch(`${bases.chat}/v3/config`, {
    method: 'GET',
    headers: cliChatHeaders({
      uid: ctx.uid,
      machineId,
      sessionId,
      accessToken: ctx.accessToken,
      conversationRequestId: crypto.randomUUID().replaceAll('-', ''),
    }),
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) throw new Error(`模型目录拉取失败：http=${res.status}`)
  const payload = (await res.json()) as unknown
  return extractModels(payload)
}

/**
 * 从 `/v3/config` 响应里提取模型（**纯函数**，便于单测）。
 *
 * ## ⚠️ 路径是本文件最容易搞错的地方（已实测踩过一次）
 *
 * CN 域 `/v3/config` 的真实形状是 **`data.models[]`**（单层），
 * 实测返回 **54 个模型**。最初按 `data.data.models`（双层）去取，
 * 线上表现为 `GET /v1/models` **HTTP 200 但 models 为空数组** ——
 * 没有报错、没有提示，只是「看起来这个账号没有模型」，极难排查。
 *
 * 双层形态确实存在于**另一**端点家族（global 域企业端点），
 * 故这里同时兼容两种：先试 `data.models`，没有再看 `data.data.models`。
 */
export function extractModels(payload: unknown): OpenAiModel[] {
  if (payload === null || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  const data = root.data
  if (data === null || typeof data !== 'object') return []
  const outer = data as Record<string, unknown>

  // ① CN 域当前形态：data.models[]（已实测）
  const direct = outer.models
  if (Array.isArray(direct)) return mapModels(direct)

  // ② 兼容双层形态：data.data.models[]
  const inner = outer.data
  if (inner !== null && typeof inner === 'object') {
    const nested = (inner as Record<string, unknown>).models
    if (Array.isArray(nested)) return mapModels(nested)
  }

  return []
}

/** 档位名的合法形态（防止上游脏数据把奇怪的字符串塞进客户端配置）。 */
const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,15}$/

/**
 * 解析上游 `reasoning` 对象（`/v3/config` 的 `data.models[].reasoning`）。
 *
 * 形如 `{"defaultEffort":"high","supportedEfforts":["low","high","max"],"summary":"auto"}`
 *（workbuddy2api-hub 内置目录与官方客户端缓存的同一形状）。
 */
export function parseReasoning(raw: unknown): Pick<OpenAiModel, 'reasoningEfforts' | 'defaultEffort' | 'canDisableThinking'> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: Pick<OpenAiModel, 'reasoningEfforts' | 'defaultEffort' | 'canDisableThinking'> = {}
  if (Array.isArray(r.supportedEfforts)) {
    const efforts: string[] = []
    for (const e of r.supportedEfforts) {
      if (typeof e !== 'string') continue
      const name = e.trim().toLowerCase()
      if (EFFORT_NAME.test(name) && !efforts.includes(name)) efforts.push(name)
    }
    if (efforts.length > 0) out.reasoningEfforts = efforts
  }
  const def = typeof r.defaultEffort === 'string' ? r.defaultEffort : typeof r.effort === 'string' ? r.effort : undefined
  if (def !== undefined && EFFORT_NAME.test(def.trim().toLowerCase())) out.defaultEffort = def.trim().toLowerCase()
  if (typeof r.canDisableThinking === 'boolean') out.canDisableThinking = r.canDisableThinking
  return out
}

/**
 * 思考档位快照（取自 workbuddy2api-hub `wb_catalog.py` 的内置目录，国内/国际两表一致处合并；
 * 只收录明确列出 `supportedEfforts` 的模型，默认档位均为 `high`）。
 *
 * ## 为什么需要快照
 *
 * 上游 `/v3/config` **并不总是**把 `reasoning` 写全：有时整块缺失，有时只给一个裸
 * `effort`（看起来像固定档位）。hub 实测后改成「实时目录为准、缺字段时逐字段回落快照」
 *（`merge_reasoning`）。只信实时数据的话，DSH 片段就生成不出档位，用户照样报
 *「不支持推理努力」。
 *
 * ⚠️ 只用于 WorkBuddy（`extractModels` 只解析 `/v3/config`）；实时目录给了列表就以实时为准。
 */
const REASONING_SNAPSHOT: Readonly<Record<string, string>> = {
  'deepseek-v4.1-flash': 'low,high,max',
  'deepseek-v4-flash': 'high,xhigh',
  'deepseek-v4-pro': 'high,xhigh',
  'glm-5.3': 'low,high,max',
  'glm-5.3-flash': 'low,high,max',
  'glm-5.2': 'high,xhigh',
  'kimi-k3-1': 'low,high,xhigh',
  'kimi-k2.8-preview': 'low,high,max',
  'hy3': 'low,high',
  'hy3-x': 'low,high',
  'hy4-preview': 'high',
  'hy4-preview-dev': 'high',
  'hy4-preview-f': 'high',
  'hy4-preview-x': 'high',
  'primary-model': 'low,high,max',
  'gpt-6-astra': 'low,medium,high,xhigh,max',
  'gpt-5.6-sol': 'low,medium,high,xhigh,max',
  'gpt-5.6-terra': 'low,medium,high,xhigh,max',
  'gpt-5.6-luna': 'low,medium,high,xhigh,max',
  'gpt-5.5': 'low,medium,high,xhigh',
  'gpt-5.4': 'low,medium,high,xhigh',
  'grok-4.7': 'low,medium,high,xhigh',
}

/**
 * 实时 `reasoning` 与快照逐字段合并（口径同 hub `merge_reasoning`）。
 *
 * - 实时给了档位列表 ⇒ 用实时的；
 * - 实时没给列表、快照有 ⇒ 用快照列表；实时的 `effort`/`defaultEffort` 若在列表内则作默认档位
 *  （有列表时它是「默认值」而不是「锁定档位」），否则回落 `high`；
 * - 上游显式 `supportsReasoning: false` ⇒ 不套快照。
 */
export function resolveReasoning(
  id: string,
  rawReasoning: unknown,
  supportsReasoning?: boolean,
): Pick<OpenAiModel, 'reasoningEfforts' | 'defaultEffort' | 'canDisableThinking'> {
  const live = parseReasoning(rawReasoning)
  if (live.reasoningEfforts !== undefined || supportsReasoning === false) return live
  const snap = REASONING_SNAPSHOT[id.trim().toLowerCase()]
  if (snap === undefined) return live
  const efforts = snap.split(',')
  const def = live.defaultEffort !== undefined && efforts.includes(live.defaultEffort)
    ? live.defaultEffort
    : efforts.includes('high') ? 'high' : efforts[0]
  return { ...live, reasoningEfforts: efforts, ...(def === undefined ? {} : { defaultEffort: def }) }
}

/** 把上游模型条目映射成 OpenAI 形状（跳过无 id 的脏数据）。 */
function mapModels(models: unknown[]): OpenAiModel[] {
  const out: OpenAiModel[] = []
  for (const raw of models) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const m = raw as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id : ''
    if (id === '') continue

    const str = (k: string): string | undefined => {
      const v = m[k]
      return typeof v === 'string' && v !== '' ? v : undefined
    }
    const num = (k: string): number | undefined => {
      const v = m[k]
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
    }
    const bool = (k: string): boolean | undefined => (typeof m[k] === 'boolean' ? (m[k] as boolean) : undefined)
    const reasoning = resolveReasoning(id, m.reasoning, bool('supportsReasoning'))

    out.push({
      id,
      object: 'model',
      created: 0,
      owned_by: DEFAULT_PROVIDER,
      ...(str('name') === undefined ? {} : { name: str('name') as string }),
      // ⚠️ 这些字段上游**本来就下发**（实测 `/v3/config` 的 data.models[]），
      // 之前只取 id/name 是白丢信息 —— 面板因此显示不出上下文与图片能力。
      ...(num('maxInputTokens') === undefined ? {} : { contextWindow: num('maxInputTokens') as number }),
      ...(num('maxOutputTokens') === undefined ? {} : { maxOutput: num('maxOutputTokens') as number }),
      ...(bool('supportsImages') === undefined ? {} : { supportsImage: bool('supportsImages') as boolean }),
      ...(bool('supportsToolCall') === undefined ? {} : { supportsToolCall: bool('supportsToolCall') as boolean }),
      ...(bool('supportsReasoning') === undefined ? {} : { supportsReasoning: bool('supportsReasoning') as boolean }),
      ...reasoning,
      ...(bool('isDefault') === undefined ? {} : { isDefault: bool('isDefault') as boolean }),
      ...(str('vendor') === undefined ? {} : { vendor: str('vendor') as string }),
      // ⚠️ 上游把它叫 `credits`，值是 `"x0.21"` 这种**带 x 的字符串**
      //（不是数字）—— 故这里保持字符串，由解析函数统一处理。
      ...(str('credits') === undefined ? {} : { credits: str('credits') as string }),
    })
  }
  return out
}
