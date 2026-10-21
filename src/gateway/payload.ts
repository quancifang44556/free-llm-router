
/**
 * 上游渠道拦截码的两种书写形态（**码点构造**，源码里不写裸字面量）。
 *
 * - `FP_BARE`：不带连字符的 5 位裸码 —— 反探测的**触发串**（请求里出现即整单拦截，
 *   Go 侧 `sanitize.go` 与 workbuddy2api-hub 都按它改写），也是参考实现记录的数字 `code`。
 * - `FP`：带 ASCII 连字符的 6 字符形态 —— workbuddy2api-hub 把裸码改写成的样子，
 *   本仓库也有样本记录它出现在错误信封里。2026-10-19 曾把它当成「唯一真实码」，
 *   导致裸码不再被改写（2026-10-21 纠正）。两种都改写成 `FP_SAFE`，不赌哪一种。
 *
 * ⚠️ 写字面量**不安全**：ASCII 连字符与 U+2011 等渲染一模一样，
 * 编辑器/构建链任一处归一化都会让判据与替身同形，函数静默变成空操作。
 */
const FP_BARE = String.fromCharCode(0x31, 0x31, 0x31, 0x32, 0x38)
const FP = String.fromCharCode(0x31, 0x31, 0x2d, 0x31, 0x32, 0x38)

/**
 * 脱敏后的替身：中间放 U+2011（NON-BREAKING HYPHEN）。
 *
 * ⚠️ 必须与 `FP` / `FP_BARE` 都是**不同码点序列**，否则 `replaceAll` 就是空操作
 * （本项目真实发生过，且单测写成「输入 === 期望值」而永远通过）。
 * NFKC 归一化会把 U+2011 变成 U+2010，仍不会还原成裸码。
 */
const FP_SAFE = String.fromCharCode(0x31, 0x31, 0x2011, 0x31, 0x32, 0x38)

/**
 * 出站请求体准备（**纯函数**）。
 *
 * ## 为什么需要这一层
 *
 * OpenAI 客户端发的请求体**不能原样**转给 WorkBuddy 上游，有四处硬性差异
 * （逐条来自 Go 侧实测，AGENTS.md §6）：
 *
 * | 差异 | 后果（若不处理） |
 * |---|---|
 * | 上游**只认 `max_tokens`**，不认 `max_completion_tokens` | 别名被忽略 → 回落默认输出上限（实测 32000）→ **长流被截断** |
 * | 上游要求 **`stream: true`** | 非流式请求被上游按流式处理不当 |
 * | `tool_choice` 只认**字符串** | 对象形式 → **400 code=11101** |
 * | `stream_options.include_usage` 缺省需补 | 末帧不返回 usage → 用量统计恒为 0 |
 *
 * ## 分层纪律
 *
 * 纯函数、无网络、无存储 —— 上游改判据时**只改这个文件**，网关逻辑不动。
 */

/** 需要翻译的字段名（OpenAI 新字段 → 上游认的旧字段）。 */
export function translateMaxCompletionTokens(body: Record<string, unknown>): void {
  const alias = body.max_completion_tokens
  delete body.max_completion_tokens

  // ⚠️ 显式 max_tokens 优先：别名只删不译（避免把别名值覆盖掉用户显式给的值）
  if (body.max_tokens !== undefined) return

  // 只有正整数才翻译。0/null 是「未设置」语义，负数是非法值 —— 都不该变成 max_tokens
  if (typeof alias === 'number' && Number.isSafeInteger(alias) && alias > 0) {
    body.max_tokens = alias
  }
}

/**
 * 归一化 `tool_choice`：上游该字段是 **string**，对象形式会 400 `code=11101`。
 *
 * - `'auto'` / `'none'` / `'required'`（大小写/空白不敏感）→ 规范小写透传；
 * - 对象 `{type:'none'|'auto'|'required'}` → 同名字符串（Responses / 部分 SDK 的写法）；
 * - 其余对象形式（含具名函数 `{type:'function', function:{name}}`）→ 降级为 `'auto'`
 *  （**不是**报错：降级能让请求成功，报错会让整个对话失败。而具名选择在多数客户端里只影响
 *   偏好，不影响正确性）；
 * - 其他未知形态 → 删除该字段（缺省即 `auto`）。
 *
 * ⚠️ `none` **只改 tool_choice，不删 tools**：删掉工具声明会让模型拿不到函数签名、
 * 把调用降级成伪 JSON 文本塞进正文，agent 原地空转（workbuddy2api-hub 踩过的坑）。
 */
export function normalizeToolChoice(body: Record<string, unknown>): void {
  const choice = body.tool_choice
  if (choice === undefined) return

  if (typeof choice === 'string') {
    const v = choice.trim().toLowerCase()
    if (v === 'auto' || v === 'none' || v === 'required') {
      if (v !== choice) body.tool_choice = v
      return
    }
    // 未知字符串：删掉（缺省即 auto），比传给上游被拒好
    delete body.tool_choice
    return
  }

  if (choice !== null && typeof choice === 'object' && !Array.isArray(choice)) {
    const t = (choice as Record<string, unknown>).type
    const v = typeof t === 'string' ? t.trim().toLowerCase() : ''
    body.tool_choice = v === 'none' || v === 'required' ? v : 'auto'
    return
  }

  delete body.tool_choice
}

/**
 * 补齐 `stream_options.include_usage`。
 *
 * 只有**显式没带**时才补：用户显式设了 `include_usage: false` 就尊重它。
 */
export function ensureStreamOptions(body: Record<string, unknown>): void {
  if (body.stream_options !== undefined) return
  body.stream_options = { include_usage: true }
}

type Msg = Record<string, unknown>

function isObj(v: unknown): v is Msg {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** assistant 消息「没有正文」：`undefined` / `null` / `''` / `[]` 都算（各家客户端写法不一）。 */
function isEmptyContent(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** 把 `src.reasoning_content` 并进 `dst`（两边都有时换行拼接）。就地改 `dst`（调用方保证它是副本）。 */
function mergeReasoningContent(dst: Msg, src: Msg): void {
  const rc = src.reasoning_content
  if (typeof rc !== 'string' || rc === '') return
  const prev = dst.reasoning_content
  dst.reasoning_content = typeof prev === 'string' && prev !== '' ? `${prev}\n${rc}` : rc
}

/**
 * 单个 assistant 的 `tool_calls` 逐项修整：
 * - 剔除**名字为空**的调用（Go 侧记录过它跨 provider 传染，上游报 11133 且不指出字段）；
 * - `function.arguments` 不是字符串时序列化成 JSON 字符串，缺省补 `"{}"`
 *  （上游 Go 结构体把它定死为 string，传对象/数组/数字会 400 `code=11101`）。
 *
 * @returns 修整后的数组；无改动时返回 `undefined`
 */
function fixToolCalls(calls: unknown[]): unknown[] | undefined {
  let changed = false
  const out: unknown[] = []
  for (const call of calls) {
    if (!isObj(call)) {
      changed = true
      continue
    }
    const fn = call.function
    if (!isObj(fn)) {
      changed = true
      continue
    }
    const name = fn.name
    if (typeof name !== 'string' || name === '') {
      changed = true
      continue
    }
    const args = fn.arguments
    if (typeof args === 'string') {
      out.push(call)
      continue
    }
    let text: string
    if (args === undefined || args === null) {
      text = '{}'
    } else {
      try {
        text = JSON.stringify(args) ?? '{}'
      } catch {
        text = String(args)
      }
    }
    changed = true
    out.push({ ...call, function: { ...fn, arguments: text } })
  }
  return changed ? out : undefined
}

/**
 * 合并**相邻**的 assistant `tool_calls` 消息（移植自 workbuddy2api-hub `merge_adjacent_tool_calls`）。
 *
 * 部分 agent 客户端把一批并行调用回放成**多条相邻 assistant**、每条只带一个 tool_call。
 * DeepSeek 系上游对这种形状回 400 `code=11148`（tool_call_sequence_broken），
 * 且每次重试都回放同样的历史 ⇒ 整条会话报废，换号也没用。
 *
 * 条件刻意收得很窄（不发明语义）：
 * - 形态 1：本条带 tool_calls 且**无正文**，前一条是带 tool_calls 的 assistant ⇒ 调用并入前一条；
 * - 形态 2：本条**不带** tool_calls、正文是非空字符串，前一条是带 tool_calls 且**无正文**的 assistant
 *   ⇒ 正文并入前一条（同一批被按另一种顺序拆开回放）。
 * 两种形态都保留 `reasoning_content`（DeepSeek 多轮思考要求原样带回）。
 */
export function mergeAdjacentToolCalls(messages: unknown[]): unknown[] {
  if (messages.length < 2) return messages
  const out: unknown[] = []
  let changed = false
  for (const m of messages) {
    const prev = out.length > 0 ? out[out.length - 1] : undefined
    if (isObj(m) && m.role === 'assistant' && isObj(prev) && prev.role === 'assistant') {
      const calls = m.tool_calls
      const prevCalls = prev.tool_calls
      // 形态 1
      if (Array.isArray(calls) && calls.length > 0 && isEmptyContent(m.content)
        && Array.isArray(prevCalls) && prevCalls.length > 0) {
        const merged: Msg = { ...prev, tool_calls: [...prevCalls, ...calls] }
        mergeReasoningContent(merged, m)
        out[out.length - 1] = merged
        changed = true
        continue
      }
      // 形态 2
      if (!('tool_calls' in m) && typeof m.content === 'string' && m.content !== ''
        && Array.isArray(prevCalls) && prevCalls.length > 0 && isEmptyContent(prev.content)) {
        const merged: Msg = { ...prev, content: m.content }
        mergeReasoningContent(merged, m)
        out[out.length - 1] = merged
        changed = true
        continue
      }
    }
    out.push(m)
  }
  return changed ? out : messages
}

/**
 * 让一批 tool 结果**紧跟**发起它的 assistant（移植自 workbuddy2api-hub `repack_tool_result_blocks`）。
 *
 * 上游要求 `role:'tool'` 结果紧跟请求它们的 assistant，中间不能夹别的消息。
 * 典型反例：Codex 的 `image_resize_notice` 以 developer 消息插在工具输出之后 ——
 * 并行调用时它落在两条结果之间 ⇒ 上游判配对断裂 ⇒ 400 `code=11148`，整条会话报废。
 *
 * 只**重排**：结果原样、相对顺序不变，插队的消息挪到整批结果之后。
 */
export function repackToolResultBlocks(messages: unknown[]): unknown[] {
  if (messages.length < 3) return messages
  const out: unknown[] = []
  let changed = false
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (!isObj(m) || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
      out.push(m)
      i += 1
      continue
    }
    const want = new Set<string>()
    for (const tc of m.tool_calls as unknown[]) {
      if (isObj(tc) && typeof tc.id === 'string' && tc.id !== '') want.add(tc.id)
    }
    out.push(m)
    i += 1
    const results: unknown[] = []
    const between: unknown[] = []
    while (i < messages.length) {
      const mm = messages[i]
      if (!isObj(mm)) break
      if (mm.role === 'tool') {
        const id = mm.tool_call_id
        if (!(typeof id === 'string' && want.has(id))) break
        results.push(mm)
        i += 1
        continue
      }
      // 任何 assistant 都结束这一批
      if (mm.role === 'assistant') break
      // 非结果消息只有在**后面还有本批结果**时才算「插队者」（挪到整批之后）；
      // 否则是正常的后续消息，原样留给外层循环
      let j = i
      while (j < messages.length) {
        const nx = messages[j]
        if (!isObj(nx) || nx.role === 'tool' || nx.role === 'assistant') break
        j += 1
      }
      const nx = messages[j]
      const moreResults =
        isObj(nx) && nx.role === 'tool' && typeof nx.tool_call_id === 'string' && want.has(nx.tool_call_id)
      if (!moreResults) break
      for (; i < j; i += 1) between.push(messages[i])
    }
    if (results.length > 0) {
      out.push(...results, ...between)
      if (between.length > 0) changed = true
    } else {
      out.push(...between)
    }
  }
  return changed ? out : messages
}

/**
 * 两侧同时剪孤儿（移植自 workbuddy2api-hub `cleanup_orphan_tool_calls`）：
 * - 没有结果的 tool_call 删掉（工具调用失败/超时后客户端**永远不会**补结果，
 *   但这条声明会跟着历史每轮重发，上游每轮都 400 `code=11148`）；
 * - 没有声明的 tool 结果删掉。
 *
 * 两侧按**同一个 id 交集**修剪，不会留下半个配对。
 */
export function cleanupOrphanToolCalls(messages: unknown[]): unknown[] {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  let sawTool = false
  for (const m of messages) {
    if (!isObj(m)) continue
    if (m.role === 'tool') {
      sawTool = true
      const id = m.tool_call_id
      if (typeof id === 'string' && id !== '') resultIds.add(id)
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as unknown[]) {
        if (isObj(tc) && typeof tc.id === 'string' && tc.id !== '') callIds.add(tc.id)
      }
    }
  }
  if (!sawTool && callIds.size === 0) return messages

  let changed = false
  const out: unknown[] = []
  for (const m of messages) {
    if (!isObj(m)) {
      out.push(m)
      continue
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id
      if (typeof id === 'string' && callIds.has(id) && resultIds.has(id)) {
        out.push(m)
      } else {
        changed = true
      }
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const calls = m.tool_calls as unknown[]
      const kept = calls.filter((tc) => isObj(tc) && typeof tc.id === 'string' && resultIds.has(tc.id))
      if (kept.length !== calls.length) {
        changed = true
        const copy: Msg = { ...m }
        if (kept.length > 0) copy.tool_calls = kept
        else delete copy.tool_calls
        out.push(copy)
        continue
      }
    }
    out.push(m)
  }
  return changed ? out : messages
}

/** 消息裁剪结果。 */
export interface TrimMessagesResult {
  /**
   * 裁剪后的消息数组。
   *
   * ⚠️ **未超限时返回的就是入参本身**（同一个引用），调用方靠 `result.messages !== messages`
   * 就能判断「有没有动过」—— 与 `cleanupToolPairing` / `scrubFingerprints` 的口径一致。
   */
  messages: unknown[]
  /** 被省略的**更早**消息条数（0 = 未裁剪）。供日志用，不含任何消息内容。 */
  dropped: number
}

/** 摘要提示消息的抬头（日志与测试都按它识别，改文案时先看这里）。 */
export const CONTEXT_TRIM_NOTE_PREFIX = '（系统提示·上下文压缩）'

/**
 * 构造一条「更早的消息已省略」的提示消息。
 *
 * ⚠️ 刻意用 `role: 'system'` 而不是 `user`：
 * - 用 `user` 会在「上一条恰好也是 user」时形成**连续两条 user**，Gemini 系要求
 *   user/model 交替，会被判非法请求（本项目的 gemini provider 也按 `role` 分流）；
 * - 用 `user` 还会让模型把这段提示当成**用户真的说过的话**，进而顺着它回答。
 *   而 `system` 在 gemini provider 里被并进 `systemInstruction`（见 `gemini.ts`），
 *   在 OpenAI 兼容上游里也是合法位置。
 *
 * ⚠️ **不得**把被省略的消息内容摘进这条提示：那等于把隐私写进日志/上下文，
 * 也失去「压缩」的意义。
 *
 * ⚠️ **文案必须与当轮条数无关**（这条踩过）：
 * 早先写的是「更早的 619 条消息…最近 101 条」，而这两个数字**每一轮都在变**
 *（窗口随对话滑动）。于是 [首条 system + 摘要] 这一段前缀**每轮都不同** ⇒
 * 上游 prefix cache 在摘要处就断掉，整段历史每轮全价重算。
 * 现在只描述「发生过截断」这个事实，数字只进日志（日志不进上下文、不影响缓存）。
 * 换来的收益：首条 system + 摘要 成为稳定前缀，可被缓存命中。
 */
function buildTrimNote(): Msg {
  return {
    role: 'system',
    content:
      `${CONTEXT_TRIM_NOTE_PREFIX} 更早的消息因超出单请求消息数上限已被省略，`
      + '下面紧接的是保留的最近原文。省略的只是历史长度，不影响当前任务的上下文；'
      + '若确实需要其中某个细节，请向用户确认后重新索取。',
  }
}

/**
 * 单请求消息数**硬上限**：超出就把更早的历史折叠成一条「已省略 X 条」的提示。
 *
 * ## 为什么必须做（真实依据，不是预防性设计）
 *
 * 同类项目 workbuddy2api 的封禁复盘记录：三次账号封禁前，**最后一次成功请求都是超大消息数**
 * —— 2552 条、428→434 条、987~993 条连发。上游腾讯云风控把「超大上下文 + 高频」识别为
 * 机器行为。本项目此前**原样转发**上千条消息，这是最明确的危险信号。
 *
 * ## 保留规则
 *
 * - **首条 system（含 `developer`）恒保留**：身份/规则丢了这个会话就废了；
 *   只认**数组开头那一条** —— 不去别处搜 system（把中间的 system 提到最前面会改变语义，
 *   上游对 system 的位置也敏感）。
 * - **保留最近 `limit` 条**。
 * - 中间插一条摘要提示（`buildTrimNote`）。
 *
 * ⇒ 结果条数最多为 `1（system，若有）+ 1（摘要）+ limit`。`limit` 定义的是
 *   「保留的最近历史条数」，与 `MAX_CONTEXT_MESSAGES` 的语义一致（默认 100）。
 *
 * ## ⚠️ 绝不能把 tool_calls 与对应 tool_result 拆散
 *
 * 上游要求每个 `role:'tool'` 结果都有**前序** assistant 的 `tool_calls` 与之配对，
 * 否则对之后每条消息都回 400 `code=11148`（整条会话报废、换号也没用，见
 * `cleanupToolPairing` 的说明）。裁剪窗口的左边界最容易制造这种孤儿：
 * 起点若落在一条 `role:'tool'` 上，它对应的 assistant 声明已经在被丢掉的那一段里。
 *
 * 处置：把左边界**向后**推进到第一条非 tool 消息（宁可少留几条，也不留半个配对）。
 * 最后再复用 `cleanupOrphanToolCalls` 按**同一套 id 交集判据**兜一遍 ——
 * 正常情况下它是空操作（返回同一引用），只在入参本身就带着破损历史时才真删东西。
 *
 * 兜底：若整个窗口都是 tool 结果（并行批次长到占满窗口），向后让位会**一条都不剩**，
 * 只留 `[system, 摘要]` 的请求在部分上游会被判「缺少 user 消息」400 ⇒ 此时改为
 * 向**前回溯**到发起这批调用的 assistant，把「声明 + 全部结果」整批留下。
 * 即边界修复只允许**扩张**窗口，绝不拆散配对、也不留空尾巴。
 *
 * @param limit ≤ 0 表示**显式不限制**（`0` 是合法配置值，绝不能用 `limit || 默认值` 判）
 */
export function trimMessagesByLimit(messages: unknown[], limit: number): TrimMessagesResult {
  // ⚠️ 判据用 `!(limit > 0)` 而不是 `!limit`：`NaN` 同样该被当成「不限制」的非法输入，
  // 而 `limit === 0` 是**用户显式要求放开**的合法值。
  if (!(limit > 0) || messages.length <= limit) return { messages, dropped: 0 }

  const head = messages[0]
  const keepHead = isObj(head) && (head.role === 'system' || head.role === 'developer')
  const reserved = keepHead ? 1 : 0

  // 最近 limit 条的左边界。
  const naiveStart = messages.length - limit
  if (naiveStart < reserved) return { messages, dropped: 0 } // 防御：窗口与首条重叠 ⇒ 没得剪
  let start = naiveStart

  // 左边界**向后**推到第一条非 tool 消息（见函数头「绝不能拆散配对」）。
  while (start < messages.length) {
    const m = messages[start]
    if (isObj(m) && m.role === 'tool') start += 1
    else break
  }

  // 兜底：窗口整段都是 tool 结果 ⇒ 向后让位会一条不剩，改为回溯到发起这批调用的 assistant。
  if (start >= messages.length) {
    for (let back = naiveStart; back > reserved; back -= 1) {
      const m = messages[back]
      if (isObj(m) && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        start = back
        break
      }
    }
  }

  const dropped = start - reserved
  if (dropped <= 0) return { messages, dropped: 0 }

  const out: unknown[] = []
  if (keepHead) out.push(head)
  const kept = messages.length - start
  out.push(buildTrimNote())
  for (let i = start; i < messages.length; i += 1) out.push(messages[i])

  // 兜底：同一套「id 交集」判据（与出站前的配对修复**共用**一个实现，不重写一遍）。
  return { messages: cleanupOrphanToolCalls(out), dropped }
}

/**
 * 工具配对修复：developer 角色处理 + tool_call 修整 + 相邻合并 + 结果重排 + 两侧剪孤儿。
 *
 * ## 为什么必须做（Go 侧 `tool_pairing.go` 记录的严重缺陷）
 *
 * OpenAI 规范要求每个 `role:'tool'` 消息都有一个**前序** assistant 消息里的
 * `tool_calls` 与之配对（靠 `tool_call_id`），且结果紧跟调用。
 *
 * 若配对不完整，上游会**对之后每条消息都返 400**（`code=11148`）——
 * 也就是整条会话报废，且错误信息不指出是哪个字段。
 *
 * 客户端在中断/重试/切模型/工具失败时很容易产生这类历史，故必须先行修复。
 * 合并 / 重排 / 两侧剪孤儿三步移植自 ardeyouxipianyi/workbuddy2api-hub（MIT）。
 *
 * ⚠️ **不修改入参**：要改的消息一律复制后再改（重试会复用同一份请求体）。
 *
 * @returns 清理后的消息数组（无改动时返回原数组）
 */
export function cleanupToolPairing(messages: unknown[]): unknown[] {
  // ⚡ 性能快判：如果消息历史中完全没有 developer、tool 角色，也没有任何 tool_calls，
  // 直接原样返回，彻底免除双重扫描与新数组内存分配（长对话省下数毫秒 CPU）。
  let needsScan = false
  for (const raw of messages) {
    if (raw !== null && typeof raw === 'object') {
      const msg = raw as Record<string, unknown>
      if (msg.role === 'developer' || msg.role === 'tool' || msg.tool_calls !== undefined) {
        needsScan = true
        break
      }
    }
  }
  if (!needsScan) return messages

  let out: unknown[] = []
  let changed = false

  for (const raw of messages) {
    if (!isObj(raw)) {
      out.push(raw)
      continue
    }
    const msg = raw

    // ⚠️ **处理 `role: 'developer'` 消息**（实测缺陷，用户报两处 11128）。
    //
    // OpenAI 的**新**规范引入了 `developer` 角色，而**上游只认**
    // `system` / `user` / `assistant` / `tool`。
    // 实测：pi（`pi-coding-agent`）把系统提示词放在
    // `{role:'developer', content:'You are an expert coding assistant…'}` 里，
    // 原样转发 ⇒ 上游判定「首条不是 system」⇒ 国际版回
    // `11128 Illegal API invocation from an unapproved channel`。
    //
    // 内容非空时**降级为 `system`**（保住提示词语义），只有空内容（纯元数据，如
    // `tool-addition` / `tool-removal`）才真正丢弃。
    if (msg.role === 'developer') {
      const content = msg.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('')
          : ''
      changed = true
      if (text.trim() === '') continue // 纯元数据 ⇒ 丢弃
      out.push({ role: 'system', content: msg.content })
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const fixed = fixToolCalls(msg.tool_calls as unknown[])
      if (fixed !== undefined) {
        changed = true
        const copy: Msg = { ...msg }
        if (fixed.length > 0) copy.tool_calls = fixed
        else delete copy.tool_calls
        out.push(copy)
        continue
      }
    }

    out.push(msg)
  }

  // ⚠️ 顺序即语义：先合并拆开的声明（重排才看得到完整的一批），再重排，最后剪孤儿。
  for (const step of [mergeAdjacentToolCalls, repackToolResultBlocks, cleanupOrphanToolCalls]) {
    const next = step(out)
    if (next !== out) {
      changed = true
      out = next
    }
  }

  return changed ? out : messages
}

/** 模型裸名（去掉 `provider/` 前缀，小写）。 */
function bareModel(model: unknown): string {
  if (typeof model !== 'string') return ''
  const i = model.lastIndexOf('/')
  return (i >= 0 ? model.slice(i + 1) : model).trim().toLowerCase()
}

/**
 * DeepSeek 本轮是否处于**思考模式**（口径同 workbuddy2api-hub `build_upstream_body`）：
 * `thinking.type === 'enabled'`，或没有显式关闭（`type !== 'disabled'` 且 `reasoning_effort !== 'none'`）。
 */
export function isDeepseekThinking(body: Record<string, unknown>): boolean {
  if (!bareModel(body.model).startsWith('deepseek')) return false
  const thinking = body.thinking
  const type = isObj(thinking) && typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : ''
  if (type === 'enabled') return true
  const effort = body.reasoning_effort ?? body.reasoningEffort
  const effortText = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  return type !== 'disabled' && effortText !== 'none'
}

/**
 * DeepSeek：客户端**显式开了思考**（`thinking.type === 'enabled'`）却没给档位时补 `high`。
 *
 * 上游只认档位：workbuddy2api-hub 实测 deepseek-v4.1-flash 同一提示词下，
 * `thinking.enabled` 不带档位 ⇒ reasoning_tokens 0；带 `reasoning_effort=high` ⇒ 正常思考。
 * 只补「明确要思考却没说多深」这一种；没开思考、显式关闭或客户端自己给了档位都不碰
 *（hub 默认对所有 DeepSeek 请求强补 high，曾导致整轮都在思考、没有正文，hub #508）。
 *
 * @returns 是否改动
 */
export function fillDeepseekEffort(body: Record<string, unknown>): boolean {
  if (!bareModel(body.model).startsWith('deepseek')) return false
  const thinking = body.thinking
  if (!isObj(thinking) || typeof thinking.type !== 'string' || thinking.type.trim().toLowerCase() !== 'enabled') return false
  const effort = body.reasoning_effort ?? body.reasoningEffort
  if (typeof effort === 'string' ? effort.trim() !== '' : effort !== undefined && effort !== null) return false
  body.reasoning_effort = 'high'
  delete body.reasoningEffort
  return true
}

/**
 * DeepSeek 多轮一致性：给每条 assistant 补 `reasoning_content`（移植自 workbuddy2api-hub）。
 *
 * 上游在思考模式下要求每条 assistant 都带回 `reasoning_content` 字符串，否则 400
 * `code=11155`（the reasoning content from the previous turn must be passed back in thinking mode）。
 * 第三方客户端普遍**不回传**思考内容（本项目的 Responses 转换也刻意丢弃 reasoning 项）。
 *
 * - 触发：DeepSeek 模型，且思考模式开启**或**历史里已有思考痕迹；
 * - `reasoning_content` 不是字符串时补成 `reasoning`（若有）或 `''`；
 * - 上游还校验 `reasoning` 非空 ⇒ 镜像到 `reasoning`，空时用一个空格占位（不带任何语义）。
 */
export function backfillReasoningContent(messages: unknown[], model: unknown, thinkingEnabled: boolean): unknown[] {
  if (!bareModel(model).startsWith('deepseek')) return messages
  let hasTrace = false
  for (const m of messages) {
    if (!isObj(m)) continue
    if ((typeof m.reasoning === 'string' && m.reasoning !== '') || 'reasoning_content' in m) {
      hasTrace = true
      break
    }
  }
  if (!thinkingEnabled && !hasTrace) return messages

  let changed = false
  const out = messages.map((m) => {
    if (!isObj(m) || m.role !== 'assistant') return m
    let rc = m.reasoning_content
    const needRc = typeof rc !== 'string'
    if (needRc) rc = typeof m.reasoning === 'string' ? m.reasoning : ''
    const needMirror = !(typeof m.reasoning === 'string' && m.reasoning !== '')
    if (!needRc && !needMirror) return m
    changed = true
    const item: Msg = { ...m, reasoning_content: rc }
    if (needMirror) item.reasoning = rc !== '' ? rc : ' '
    return item
  })
  return changed ? out : messages
}

/**
 * `stop` 归一化：字符串 → 单元素数组（移植自 workbuddy2api-hub `normalize_stop`）。
 *
 * OpenAI 允许 `string | string[]`，上游 Go 端却定死为 `[]string`：
 * `"stop":"END"` ⇒ 400 `code=11101`，`"stop":["END"]` ⇒ 200。语义完全等价。
 * 空串 / 空数组 / null / 非法类型一律删字段（含义都是「没有停止序列」）。
 *
 * @returns 是否改动
 */
export function normalizeStop(body: Record<string, unknown>): boolean {
  if (!('stop' in body)) return false
  const val = body.stop
  if (Array.isArray(val) && val.length > 0 && val.every((s) => typeof s === 'string' && s !== '')) return false
  const list = typeof val === 'string'
    ? (val === '' ? [] : [val])
    : Array.isArray(val)
      ? val.filter((s): s is string => typeof s === 'string' && s !== '')
      : []
  if (list.length > 0) body.stop = list
  else delete body.stop
  return true
}

/**
 * GPT 系上游要求输出上限 ≥ 16，更小（探针常用 `max_tokens:1`）会 400 `integer_below_min_value`。
 *
 * @returns 是否改动
 */
export function clampGptMaxTokens(body: Record<string, unknown>): boolean {
  if (!bareModel(body.model).startsWith('gpt-')) return false
  const mt = body.max_tokens
  if (typeof mt !== 'number' || !Number.isFinite(mt) || mt >= 16) return false
  body.max_tokens = 16
  return true
}

const SCHEMA_TYPE_ALIAS: Record<string, string> = {
  str: 'string',
  text: 'string',
  int: 'integer',
  bool: 'boolean',
  dict: 'object',
  list: 'array',
  float: 'number',
}
const SCHEMA_VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])
const SCHEMA_NULLABLE_META = ['description', 'title', 'format', 'pattern', 'items', 'default']

/**
 * 递归修 JSON Schema（就地；调用方传入的是副本）。上游 Go 校验器很严：
 * `null` 的 description/title、`str`/`int` 这类别名类型、缺 `properties` 的 object、
 * 含 null 的 `required`、元组形式的 `items` 都会 400 `code=11129`。
 *
 * 只修**不合法**的部分，合规字段原样保留。
 */
function normalizeSchema(s: Msg, mark: () => void): void {
  for (const k of SCHEMA_NULLABLE_META) {
    if (k in s && s[k] === null) {
      delete s[k]
      mark()
    }
  }

  if ('type' in s) {
    const typ = s.type
    if (typeof typ === 'string') {
      const lower = typ.trim().toLowerCase()
      const alias = SCHEMA_TYPE_ALIAS[lower]
      const next = alias ?? (SCHEMA_VALID_TYPES.has(lower) ? lower : undefined)
      if (next === undefined) {
        mark()
        if ('properties' in s) s.type = 'object'
        else if ('items' in s) s.type = 'array'
        else delete s.type
      } else if (next !== typ) {
        s.type = next
        mark()
      }
    } else if (Array.isArray(typ)) {
      const list = typ.filter((t) => t !== null && t !== undefined && t !== '').map((t) => {
        const lower = String(t).toLowerCase()
        return SCHEMA_TYPE_ALIAS[lower] ?? lower
      })
      if (list.length !== typ.length || list.some((t, i) => t !== typ[i])) {
        s.type = list
        mark()
      }
    }
  }

  if (s.type === 'object' || ('properties' in s && s.type === undefined)) {
    if (s.type === undefined) {
      s.type = 'object'
      mark()
    }
    if (!isObj(s.properties)) {
      s.properties = {}
      mark()
    }
  }

  if ('required' in s) {
    const req = s.required
    if (Array.isArray(req)) {
      const cleaned = req.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      if (cleaned.length === 0) {
        delete s.required
        mark()
      } else if (cleaned.length !== req.length) {
        s.required = cleaned
        mark()
      }
    } else if (typeof req === 'string' && req.trim() !== '') {
      s.required = [req.trim()]
      mark()
    } else {
      delete s.required
      mark()
    }
  }

  if ('items' in s) {
    const items = s.items
    if (Array.isArray(items)) {
      const first = items.find(isObj)
      s.items = first !== undefined ? { ...first } : { type: 'string' }
      mark()
      if (isObj(s.items)) normalizeSchema(s.items, mark)
    } else if (isObj(items)) {
      normalizeSchema(items, mark)
    }
  }

  if (isObj(s.properties)) {
    for (const v of Object.values(s.properties)) if (isObj(v)) normalizeSchema(v, mark)
  }
  for (const key of ['$defs', 'definitions']) {
    const defs = s[key]
    if (isObj(defs)) for (const v of Object.values(defs)) if (isObj(v)) normalizeSchema(v, mark)
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const list = s[key]
    if (Array.isArray(list)) for (const v of list) if (isObj(v)) normalizeSchema(v, mark)
  }
}

/** 修一个 function 定义的 `parameters`（返回新对象；无改动返回原对象）。 */
function normalizeFunctionDef(fn: Msg): Msg {
  const params = fn.parameters
  if (!isObj(params)) return { ...fn, parameters: { type: 'object', properties: {} } }
  let changed = false
  const mark = (): void => {
    changed = true
  }
  const p = structuredClone(params) as Msg
  if (p.type !== 'object') {
    p.type = 'object'
    mark()
  }
  if (!isObj(p.properties)) {
    p.properties = {}
    mark()
  }
  normalizeSchema(p, mark)
  return changed ? { ...fn, parameters: p } : fn
}

/**
 * 工具声明归一化（移植自 workbuddy2api-hub `normalize_tools`，避免 400 `code=11129`）：
 * - 老客户端的根级 `functions` → `tools`；
 * - 顶层 `{name, description, parameters}` 写法包成 `{type:'function', function:{…}}`；
 * - `parameters` 缺失/非对象 → 空 object schema；不合法的 schema 递归修复；
 * - 既无 `function` 也无 `name` 的条目（如 Responses 的内置工具）丢弃 —— 上游只认 function 工具；
 * - 修完为空则删掉 `tools`。
 *
 * @returns 是否改动
 */
export function normalizeTools(body: Record<string, unknown>): boolean {
  let changed = false
  if ('functions' in body && !('tools' in body)) {
    const funcs = body.functions
    delete body.functions
    changed = true
    if (Array.isArray(funcs)) body.tools = funcs.filter(isObj).map((f) => ({ type: 'function', function: f }))
  }
  if (!('tools' in body)) return changed
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    delete body.tools
    return true
  }
  const norm: unknown[] = []
  for (const t of tools) {
    if (!isObj(t)) {
      changed = true
      continue
    }
    if (!isObj(t.function)) {
      if (typeof t.name !== 'string' || t.name === '') {
        changed = true
        continue
      }
      const fn: Msg = {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        parameters: t.parameters ?? {},
      }
      if ('strict' in t) fn.strict = t.strict
      norm.push({ type: 'function', function: normalizeFunctionDef(fn) })
      changed = true
      continue
    }
    const fn = normalizeFunctionDef(t.function)
    if (fn !== t.function || t.type !== 'function') {
      norm.push({ ...t, type: 'function', function: fn })
      changed = true
    } else {
      norm.push(t)
    }
  }
  if (norm.length > 0) body.tools = norm
  else delete body.tools
  return changed
}

// ── 客户端指纹脱敏（移植自 workbuddy2api-hub `sanitize_text` / `sanitize_messages`） ──
//
// 上游 WAF 对几段**特定客户端**的系统提示词原文回 `11128`（unapproved channel）。
// 改写刻意收得很窄：只动已确认的指纹短语，不删 agent 身份与行为约束。
const FINGERPRINT_LITERALS = [
  'x-anthropic-billing-header',
  'cc_entrypoint=',
  'You are Claude Code',
  'Main branch (',
  'You are a coding agent running in the Codex CLI',
  'github.com/anthropics/',
]
const FINGERPRINT_CI = /x-anthropic-billing-header|Sisyphus-Junior - Focused executor from OhMyOpenCode/i
const FINGERPRINT_REWRITES: ReadonlyArray<readonly [string, string]> = [
  ["You are Claude Code, Anthropic's official CLI for Claude", "You are Claude Code, Anthropic's official CLI tool for Claude"],
  ['Main branch (you will usually use this for PRs)', 'Default branch (you will usually use this for PRs)'],
  [
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.',
    'You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.',
  ],
  [
    'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
    'To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
  ],
]
const OMO_JUNIOR_RE = /Sisyphus-Junior - Focused executor from OhMyOpenCode/gi
const BILLING_HDR_RE = /x-anthropic-billing-header:[^;\r\n]*;?\s*/gi
const BARE_BILLING_HDR_RE = /x-anthropic-billing-header/gi
const CC_KV_RE = /\bcc_[a-z0-9_]+=[^;\r\n]*;?\s*/gi


/**
 * 「客户端自我介绍句式 + 品牌」组合指纹（hub #533 / #537 / #539，2026-10-21）。
 *
 * 上游对这类整句做**大小写不敏感的连续子串匹配**，命中即 400 + 渠道拦截码：
 * - `You are an AI agent powered by DeepSeek Harness.`（DSH 系统提示首句）
 * - `You are a coding agent powered by the deepseek-v4.1-flash model.`
 * - `You are an AI assistant built on DeepSeek.`
 *
 * 单独的品牌词、拆开的词组都放行，所以只把**整句**换成中性句，不依赖具体品牌。
 * 表现是「同一账号官方客户端正常、经网关换号/换身份都失败、短请求却正常」。
 *
 * ⚠️ 只作用于 system / developer（见 `scrubFingerprints`）：user / assistant / tool
 * 里的同名文本是用户数据，改写会让模型看到与磁盘不一致的内容（hub #537）。
 */
const IDENTITY_RE =
  /You are an?(?:\s+AI)?(?:\s+coding)?\s+(?:agent\s+powered by|assistant\s+built on)[^\n]*?(?:\.(?=\s|$)|(?=\n|$))/gi
const IDENTITY_PROBE = /agent\s+powered by|assistant\s+built on/i
const IDENTITY_REPLACEMENT = 'You are a helpful AI assistant.'

function hasFingerprint(text: string, identity: boolean): boolean {
  for (const f of FINGERPRINT_LITERALS) if (text.includes(f)) return true
  if (text.includes(FP_BARE)) return true
  if (FINGERPRINT_CI.test(text)) return true
  return identity && IDENTITY_PROBE.test(text)
}

/**
 * 改写一段文本里的客户端指纹（无指纹时原样返回同一字符串）。
 *
 * @param identity 是否同时改写「自我介绍句 + 品牌」（只对 system / developer 开）。
 */
export function scrubFingerprintText(text: string, identity = false, trim = true): string {
  if (text === '' || !hasFingerprint(text, identity)) return text
  let out = text.replace(OMO_JUNIOR_RE, 'Sisyphus-Junior - Focused executor')
  if (identity) out = out.replace(IDENTITY_RE, IDENTITY_REPLACEMENT)
  for (const [from, to] of FINGERPRINT_REWRITES) out = out.replaceAll(from, to)
  out = out.replaceAll(FP_BARE, FP_SAFE)
  out = out.replace(BILLING_HDR_RE, '')
  if (out.includes('cc_')) {
    for (let prev = ''; prev !== out;) {
      prev = out
      out = out.replace(CC_KV_RE, '')
    }
  }
  out = out.replace(BARE_BILLING_HDR_RE, 'x-anthropic-billing-hdr')
  return trim ? out.trim() : out
}

/**
 * 工具调用参数（JSON 字符串）的指纹脱敏：**只改 JSON 里的字符串值**。
 *
 * 直接按文本替换会把 `{"line":` + 裸码 + `}` 这种数字改成非法 JSON；
 * 这里先解析，逐个字符串值脱敏（不 trim —— 文件内容的首尾空白有意义），
 * 有改动才重新序列化。数字里的裸码无法在不改语义的前提下处理，保持原样。
 * 解析失败（流式残片等）才退回整段文本改写。
 */
export function scrubToolArguments(args: string): string {
  if (args === '' || !hasFingerprint(args, false)) return args
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return scrubFingerprintText(args)
  }
  if (parsed === null || typeof parsed !== 'object') {
    return typeof parsed === 'string' ? JSON.stringify(scrubFingerprintText(parsed, false, false)) : args
  }
  let changed = false
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const s = scrubFingerprintText(v, false, false)
      if (s !== v) changed = true
      return s
    }
    if (Array.isArray(v)) return v.map(walk)
    // fromEntries 走 CreateDataProperty：`__proto__` 键仍是普通自有属性，不会改原型
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const next = walk(parsed)
  return changed ? JSON.stringify(next) : args
}

function scrubContent(content: unknown, identity: boolean): unknown {
  if (typeof content === 'string') return scrubFingerprintText(content, identity)
  if (!Array.isArray(content)) return content
  let changed = false
  const out = content.map((part) => {
    if (!isObj(part) || part.type !== 'text' || typeof part.text !== 'string') return part
    const text = scrubFingerprintText(part.text, identity)
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? out : content
}

/**
 * 对整段消息历史做指纹脱敏（正文 / 文本分段 / reasoning_content / 工具参数）。无改动返回原数组。
 *
 * 身份句改写只对 system / developer 生效；其余规则（已确认的固定指纹与裸拦截码）全角色生效。
 */
export function scrubFingerprints(messages: unknown[]): unknown[] {
  let changed = false
  const out = messages.map((m) => {
    if (!isObj(m)) return m
    let item: Msg | undefined
    const identity = m.role === 'system' || m.role === 'developer'
    const content = scrubContent(m.content, identity)
    if (content !== m.content) (item ??= { ...m }).content = content
    if (typeof m.reasoning_content === 'string') {
      const rc = scrubFingerprintText(m.reasoning_content)
      if (rc !== m.reasoning_content) (item ??= { ...m }).reasoning_content = rc
    }
    if (Array.isArray(m.tool_calls)) {
      let callsChanged = false
      const calls = (m.tool_calls as unknown[]).map((tc) => {
        if (!isObj(tc) || !isObj(tc.function) || typeof tc.function.arguments !== 'string') return tc
        const args = scrubToolArguments(tc.function.arguments)
        if (args === tc.function.arguments) return tc
        callsChanged = true
        return { ...tc, function: { ...tc.function, arguments: args } }
      })
      if (callsChanged) (item ??= { ...m }).tool_calls = calls
    }
    if (item === undefined) return m
    changed = true
    return item
  })
  return changed ? out : messages
}

/** 准备结果。 */
export interface PrepareResult {
  body: string
  /** 做过的改写（供日志与排查）。 */
  applied: string[]
}

/**
 * 完整准备管线。
 *
 * ⚠️ 顺序即语义：先翻译字段名（影响后续判断），再修消息历史
 * （配对错误会让整个请求失败，必须修好内容）。
 */
export function prepareChatBody(input: unknown): PrepareResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const body = { ...(input as Record<string, unknown>) }
  const applied: string[] = []

  // ① 强制 stream（上游要求）
  if (body.stream !== true) {
    body.stream = true
    applied.push('stream=true')
  }

  // ② max_completion_tokens → max_tokens
  if (body.max_completion_tokens !== undefined) {
    translateMaxCompletionTokens(body)
    applied.push('max_completion_tokens→max_tokens')
  }
  if (clampGptMaxTokens(body)) applied.push('max_tokens≥16')

  // ③ stream_options 补默认
  if (body.stream_options === undefined) {
    ensureStreamOptions(body)
    applied.push('stream_options.include_usage')
  }

  // ④ tool_choice 归一化（对象形式会 400）
  if (body.tool_choice !== undefined) {
    const before = body.tool_choice
    normalizeToolChoice(body)
    if (body.tool_choice !== before) applied.push('tool_choice')
  }

  // ⑤ tools / stop 归一化（schema 不合法 11129、stop 字符串 11101）
  if (normalizeTools(body)) applied.push('tools')
  if (normalizeStop(body)) applied.push('stop[]')
  if (fillDeepseekEffort(body)) applied.push('reasoning_effort=high')

  // ⑥ 消息历史：指纹脱敏 → 工具配对修复 → DeepSeek 思考回填
  if (!Array.isArray(body.messages)) throw new Error('messages 必须是数组')
  let messages = body.messages as unknown[]
  const scrubbed = scrubFingerprints(messages)
  if (scrubbed !== messages) {
    messages = scrubbed
    applied.push('fingerprint')
  }
  const cleaned = cleanupToolPairing(messages)
  if (cleaned !== messages) {
    messages = cleaned
    applied.push('tool-pairing')
  }
  const backfilled = backfillReasoningContent(messages, body.model, isDeepseekThinking(body))
  if (backfilled !== messages) {
    messages = backfilled
    applied.push('reasoning_content')
  }
  body.messages = messages

  return { body: JSON.stringify(body), applied }
}

/**
 * 反探测脱敏（AGENTS.md §6.6）—— 整体请求体上的兜底一遍。
 *
 * 裸 5 位拦截码已在 `scrubFingerprintText` 里按**文本字段**改写（正文 / 推理 / 工具参数，
 * 与参考实现同口径）；这里不对整串做裸码替换：请求体里的 base64 图片、数字字段都可能
 * 碰巧含这 5 位，整串替换会改坏图片或把数字变成非法 JSON。
 * 带连字符的形态不可能出现在数字与标准 base64 里，故仍在整串上改写。
 * 零宽空格无效（上游会归一化），故替身用 U+2011。
 */
export function sanitizeChatBody(body: string): string {
  if (!body.includes(FP)) return body
  return body.replaceAll(FP, FP_SAFE)
}
