/**
 * 「目标收下了请求却零输出」——**越墙熔断**的判据与目标级冷却。
 *
 * ## 它治的是什么病
 *
 * 部分上游**虚报上下文窗口**（声明的比真实的大）。后果链：
 *
 * 1. 我们按虚高的窗口打包请求；
 * 2. 实际越过上游的真实墙；
 * 3. 上游**收下请求但吐 0 个字符**，回 `finish_reason=length`；
 * 4. 网关把它映射成「撞到输出上限」（`max-tokens` 语义）；
 * 5. **整轮静默失败**，用户以为模型不行。
 *
 * ⇒ 本模块提供一层与「哪一家虚报」无关的运行时兜底：识别这个失败形态，
 * 把该（账号, 模型）目标临时冷却，由调用方改道下一个候选重发。
 *
 * ## ⚠️ 判据为什么必须**同时**要求「零输出」
 *
 * `finish_reason=length` 有两种**相反**的语义，混为一谈会**丢内容**：
 *
 * | 形态 | 含义 | 正确处置 |
 * |---|---|---|
 * | `length` + **有输出** | 模型正常答到半截，撞的是**输出上限** | **原地续写**；换目标会丢掉已产出的正文 |
 * | `length` + **零输出** | 输入本身被上游拒了（越墙 / 请求过大） | 换目标重发是**安全**的 —— 什么都没产出，没东西可丢 |
 *
 * 这与 `aggregate.ts` 里那条「一旦开始流式输出就不再切换」是**同一个安全方向**：
 * 宁可少改道，不可丢内容。
 *
 * ## ⚠️ 为什么**不能**把它归成 `context_exceeded` 了事
 *
 * 归成「上下文超限」看起来更省事（可以走压缩链），但**做不到**：越墙这次的真实
 * 报文是 `finish_reason=length` + **零输出**，与「连接被上游掐断」在 **chunk 层完全同形**
 * —— 后者是网络故障，把它归成溢出会**掩盖真实的网络故障**，而且压缩对它毫无帮助。
 *
 * ⇒ 判据放在**输出侧**（到底产出了什么）比放在**错误码侧**可靠：不猜上游的措辞。
 *
 * ## ⚠️ 必须排除 `tool_calls`（本项目文档明令：假阳性比原缺陷更糟）
 *
 * 只调用工具时 `content` 也是 `''`。若不把 `delta.tool_calls` 算作「有输出」，
 * 一次**成功**的工具调用会被误判成「零输出越墙」⇒ 健康账号被冷却 + 请求被改道
 * ⇒ 客户端看到工具调用凭空消失。**工具调用是 agent 场景的主路径**。
 *
 * ## ⚠️ 客户端主动取消不算失败
 *
 * 用户点停止 / 关标签页 / 客户端超时都会让上游流提前结束。本项目为此**踩过坑**
 *（健康的账号因用户点停止被熔断 3 次）。故取消态**一律不改道**、不冷却。
 *
 * ## 与既有机制的关系（项目红线：同一语义不得两套实现）
 *
 * - **冷却**复用账号池既有的 `model` 维度（`applyFailure({kind:'model'})`）——
 *   不新造「不可用」概念，也不新增池方法；
 * - **改道**复用各路径既有的轮转循环（`continue` 下一个候选），不新造路由；
 * - **不做持久化**：这是「本次运行内别再撞同一堵墙」的优化，重启即重新试探是
 *   正确行为（用户可能已升级账号 / 上游可能已扩容）。
 *
 * @module src/gateway/zero-output.ts
 */

import { detectErrorFrame } from './stream.js'

/**
 * 目标级冷却时长：10 分钟。
 *
 * ⚠️ 取值理由：**必须显著小于会话的典型跨度**，否则一次误判会让一个可用渠道
 * 在整个会话里消失。10 分钟足以覆盖「三连重试撞同一堵墙」那个窗口，
 * 又短到用户几乎无感。
 */
export const ZERO_OUTPUT_COOLDOWN_MS = 10 * 60 * 1000

/**
 * 预读的**字节**上限（超过即放弃判定，原样透传）。
 *
 * ⚠️ 为什么必须有上限：本判定要在**首帧可见内容之前**把整段前缀缓冲下来，
 * 而 Free 计划只有 10ms CPU/次调用。正常情况下「首帧之前」只有 1~3 帧
 *（role 帧 / 思考帧），几十字节；上限只是防御「上游发了几百个心跳」这种
 * 异常形态，**不能**让它变成无界缓冲。
 */
export const ZERO_OUTPUT_PEEK_MAX_BYTES = 64 * 1024

/**
 * 预读的**帧**上限（超过即放弃判定）。
 *
 * ⚠️ 每帧要 `JSON.parse` 一次，而 CPU 预算只有 10ms。64 帧约 0.3ms，
 * 留足余量；真实场景首帧之前远到不了这个数。
 */
export const ZERO_OUTPUT_PEEK_MAX_FRAMES = 64

/** 一次流的判定累加结果。 */
export interface ZeroOutputProbe {
  /** 是否见到 `finish_reason` 为长度截断（`length` / `max_tokens`）。 */
  sawLength: boolean
  /** 是否产出过任何**对用户可见**的内容（含思考与工具调用）。 */
  sawOutput: boolean
  /** 是否见到过错误帧（那种情况走既有的错误分类，不走本判据）。 */
  sawError: boolean
  /** 是否见到过 `[DONE]` 终止标记。 */
  sawDone: boolean
  /** 是否因客户端取消而中止（取消 ⇒ 一律不改道）。 */
  sawAborted: boolean
  /** 已解析的上游数据帧数（诊断用）。 */
  frames: number
}

/** 一个空的探测累加器。 */
export function emptyZeroOutputProbe(): ZeroOutputProbe {
  return { sawLength: false, sawOutput: false, sawError: false, sawDone: false, sawAborted: false, frames: 0 }
}

/** 该 `finish_reason` 是否表示「输入/输出被长度截断」。 */
export function isLengthFinishReason(reason: unknown): boolean {
  // ⚠️ `length` 是 OpenAI 规范的写法；`max_tokens` 是部分上游（以及本项目内部
  // 词汇）的等价写法。两种都认 —— 认错了方向是安全的：**只有同时零输出**
  // 才会触发改道，而「有输出 + max_tokens」照样不满足判据。
  return reason === 'length' || reason === 'max_tokens'
}

/** 非空字符串判据（`content` / `reasoning_content` 这类字段）。 */
function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

/** 非空数组判据（`tool_calls`）。 */
function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

/**
 * 这一帧是否**产出了对用户可见的内容**。
 *
 * 判定口径（刻意保守：**宁可漏判改道，不可把有内容的一轮当成空轮重发**）：
 *
 * | 字段 | 算产出？ | 理由 |
 * |---|---|---|
 * | `delta.content` 非空 | ✅ | 正文 |
 * | `delta.reasoning_content` 非空 | ✅ | 思考也是用户可见内容（多数客户端会折叠而非丢弃） |
 * | `delta.tool_calls` 非空 | ✅ | ⚠️ **必须算**：只调工具时 `content` 也是 `''` |
 * | `delta.function_call` / `delta.refusal` 非空 | ✅ | 历史字段，同上 |
 * | `message.*`（非流式形状） | ✅ | 同口径 |
 * | `usage.completion_tokens > 0` | ✅ | 上游说它真生成了 token ⇒ 保守不算空轮 |
 * | `choices: []`（纯 usage 帧） | ❌ | 计量元数据，不是内容 |
 * | 没有 `choices` 也没有 `usage` | ✅（未知一律算产出） | 保守方向：不认识的帧绝不当作「空」 |
 */
export function producedVisibleOutput(frame: unknown): boolean {
  if (frame === null || typeof frame !== 'object') return true
  const f = frame as Record<string, unknown>

  const usage = f['usage']
  if (usage !== null && typeof usage === 'object') {
    const completion = (usage as Record<string, unknown>)['completion_tokens']
    if (typeof completion === 'number' && completion > 0) return true
  }

  const choices = f['choices']
  if (!Array.isArray(choices)) {
    // ⚠️ 没有 `choices` 的帧：只有「带 usage 的计量帧」可以确定不是内容，
    // 其余一律按「未知 ⇒ 算产出」处理（保守）。
    return !(usage !== null && typeof usage === 'object')
  }
  if (choices.length === 0) return false // 纯 usage 帧 / 空选择

  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') return true // 未知形状 ⇒ 保守
    const c = choice as Record<string, unknown>
    const delta = c['delta']
    const message = c['message']

    const carrier = delta !== null && typeof delta === 'object'
      ? (delta as Record<string, unknown>)
      : message !== null && typeof message === 'object'
        ? (message as Record<string, unknown>)
        : undefined
    if (carrier === undefined) {
      // 既没有 delta 也没有 message：可能是只有 finish_reason 的终止帧。
      // ⚠️ 终止帧**不算内容**（否则每个结束帧都会把 `sawOutput` 置真，
      // 判据恒为 false，整个守卫静默失效 —— 「永不触发的守卫」比没有守卫更糟）。
      if (c['finish_reason'] !== undefined && c['finish_reason'] !== null) continue
      return true
    }
    if (nonEmptyString(carrier['content'])) return true
    if (nonEmptyString(carrier['reasoning_content'])) return true
    if (nonEmptyString(carrier['reasoning'])) return true
    if (nonEmptyArray(carrier['tool_calls'])) return true
    if (carrier['function_call'] !== undefined && carrier['function_call'] !== null) return true
    if (nonEmptyString(carrier['refusal'])) return true
  }
  // 所有 choice 都是空内容帧（`content: ''` 这类）⇒ 还没产出
  return false
}

/** 这一帧是否声明了长度截断（任一 choice 的 `finish_reason`）。 */
export function declaresLengthTruncation(frame: unknown): boolean {
  if (frame === null || typeof frame !== 'object') return false
  const choices = (frame as Record<string, unknown>)['choices']
  if (!Array.isArray(choices)) return false
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') continue
    if (isLengthFinishReason((choice as Record<string, unknown>)['finish_reason'])) return true
  }
  return false
}

/**
 * 把一个已解析的上游帧累加进探测结果（**纯函数**：返回新对象，不改入参）。
 *
 * ⚠️ 用返回新对象而不是原地改：调用方在循环里累积，原地改会让
 * 「判定时的快照」与后续状态共享同一个对象，排查时读到脏值。
 */
export function noteUpstreamFrame(probe: ZeroOutputProbe, frame: unknown): ZeroOutputProbe {
  const next: ZeroOutputProbe = { ...probe, frames: probe.frames + 1 }
  if (producedVisibleOutput(frame)) next.sawOutput = true
  if (declaresLengthTruncation(frame)) next.sawLength = true
  if (frame !== null && typeof frame === 'object' && detectErrorFrame(frame as Record<string, unknown>) !== undefined) {
    next.sawError = true
  }
  return next
}

/**
 * 该轮是否属于「目标收下了请求却零输出」——即本模块要拦截并改道的失败形态。
 *
 * 四条**同时**成立：
 * 1. 见到长度截断（越墙时上游回 `finish_reason=length`）；
 * 2. **没有任何可见输出**（这是与「正常答到半截」的分水岭）；
 * 3. 没有错误帧（那种情况有明确的错误码，走既有分类，别抢它的活）；
 * 4. 不是客户端取消（取消 ⇒ 绝不改道、绝不冷却）。
 */
export function isZeroOutputWallHit(probe: ZeroOutputProbe): boolean {
  return probe.sawLength && !probe.sawOutput && !probe.sawError && !probe.sawAborted
}

/** 预读判定的结果。 */
export interface ZeroOutputScreen {
  /** 原样还原的上游流（**一个字节都不会丢**，可直接交给下游）。 */
  stream: ReadableStream<Uint8Array>
  /** 判定依据。 */
  probe: ZeroOutputProbe
  /**
   * 判定是否**可信**。
   *
   * `false` = 因预算超限 / 客户端取消 / 读流异常而提前放弃 ⇒ 调用方
   * **不得**据此改道。宁可漏判，不可误伤。
   */
  decided: boolean
  /** 是否命中「零输出 + 长度截断」。仅在 `decided` 为真时才有意义。 */
  hit: boolean
}

/**
 * 把「已缓冲的前缀 + 剩余的上游流」还原成一条完整的流。
 *
 * ⚠️ 与 `server.ts` 的 `peekStreamForError` 同款做法：先吐缓冲的原始字节，
 * 再继续从原 reader 读。**不得**重新编码/切片 —— 上游可能把一个多字节字符
 * 或一帧 JSON 拆在两个 chunk 里。
 */
function replayStream(
  prefix: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ended: boolean,
): ReadableStream<Uint8Array> {
  let index = 0
  let released = ended
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefix.length) {
        controller.enqueue(prefix[index++]!)
        return
      }
      if (ended) {
        controller.close()
        return
      }
      const { done, value } = await reader.read()
      if (done) {
        released = true
        controller.close()
        return
      }
      if (value !== undefined) controller.enqueue(value)
    },
    async cancel(reason) {
      if (released) return
      try {
        await reader.cancel(reason)
      } catch {
        // 上游已关闭：忽略
      }
    },
  })
}

/**
 * 预读上游流、判定是否为「零输出 + 长度截断」，并返回**可原样使用**的流。
 *
 * ## 为什么必须**先预读再决定**（而不是边转发边判定）
 *
 * 只有在**还没往客户端写任何字节**时，改道才是安全的：一旦把
 * `finish_reason=length` 的终止帧转发出去，客户端就把这一轮当结束了，
 * 之后即便换了目标重发也已经晚了。故本函数把「首帧可见内容之前」的字节
 * 缓冲在内存里（正常只有 1~3 帧），判定完再原样放行 —— 命中则调用方改道，
 * 不命中则无缝继续，客户端**感知不到**这层预读。
 *
 * ## 提前收手（都不算命中）
 *
 * - 出现可见内容（含思考、工具调用）⇒ 立刻停止预读并放行；
 * - 见到错误帧 ⇒ 交给既有错误分类；
 * - 超过字节/帧预算 ⇒ `decided=false`，原样放行；
 * - 客户端取消 ⇒ `decided=false`、`sawAborted=true`，绝不冷却。
 *
 * @param body 上游响应体
 * @param options.isCancelled 客户端是否已断开（判「主动取消」用）
 */
export async function screenZeroOutputStream(
  body: ReadableStream<Uint8Array>,
  options?: {
    isCancelled?: () => boolean
    maxBytes?: number
    maxFrames?: number
  },
): Promise<ZeroOutputScreen> {
  const isCancelled = options?.isCancelled ?? ((): boolean => false)
  const maxBytes = options?.maxBytes ?? ZERO_OUTPUT_PEEK_MAX_BYTES
  const maxFrames = options?.maxFrames ?? ZERO_OUTPUT_PEEK_MAX_FRAMES

  const reader = body.getReader()
  const decoder = new TextDecoder()
  const prefix: Uint8Array[] = []
  let bytes = 0
  let text = ''
  let probe = emptyZeroOutputProbe()
  let decided = false
  let ended = false

  /** 处理一行（可能来自分帧，也可能是 EOF 时的残余）。 */
  const consumeLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') {
      probe = { ...probe, sawDone: true }
      return
    }
    // ⚠️ 必须容忍 `data:` **不带空格**（本项目实测过的真实形态：
    // codearts 经华为 APIG 回的 `data:{"error_code":...}`）。
    // 也容忍整段就是一个裸 JSON（部分上游在 HTTP 200 下直接回 JSON）。
    // 其余（`event:` / `id:` / 以 `:` 开头的心跳）一律忽略。
    const payload = (trimmed.startsWith('data:') ? trimmed.slice(5) : trimmed).trim()
    if (!payload.startsWith('{')) return
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      // ⚠️ 分包可能把一帧 JSON 截断（`peekStreamForError` 的注释记录过这条）。
      // 解析失败**不得**据此判定，直接当作「未知帧」放过（保守方向）。
      return
    }
    probe = noteUpstreamFrame(probe, parsed)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        ended = true
        break
      }
      if (value === undefined) continue
      prefix.push(value)
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })

      let start = 0
      let nl = text.indexOf('\n', start)
      while (nl >= 0) {
        consumeLine(text.slice(start, nl))
        start = nl + 1
        nl = text.indexOf('\n', start)
      }
      text = start > 0 ? text.slice(start) : text

      // 三个收手条件：已能定论 / 已看到内容 / 超预算
      if (probe.sawLength || probe.sawOutput || probe.sawError) {
        decided = true
        break
      }
      if (bytes >= maxBytes || probe.frames >= maxFrames) break
    }

    // EOF 时残余可能是一整段裸 JSON（无换行）或最后一帧
    if (ended && !decided) {
      const tail = (text + decoder.decode()).trim()
      if (tail !== '') consumeLine(tail)
      decided = true
    }
  } catch {
    // 读取中断（上游掉线 / 客户端取消）：判定不可信，原样放行剩余部分
    decided = false
  }

  if (isCancelled()) {
    // ⚠️ 用户点停止不算失败：不改道、不冷却（项目为此踩过坑）
    probe = { ...probe, sawAborted: true }
    decided = false
  }

  return {
    stream: replayStream(prefix, reader, ended),
    probe,
    decided,
    hit: decided && isZeroOutputWallHit(probe),
  }
}

/**
 * 命中后给用户/日志看的一句话。
 *
 * ⚠️ 必须**说清是「零输出改道」**，不能只说「上游失败」：否则排查时无法把它与
 * 网络故障区分开（两者 chunk 层同形，见文件头）。
 */
export function describeZeroOutputHit(provider: string, model: string, probe: ZeroOutputProbe): string {
  const mins = Math.round(ZERO_OUTPUT_COOLDOWN_MS / 60_000)
  return `零输出越墙：目标「${provider}/${model}」收下请求但 0 输出（finish_reason=length，`
    + `已解析 ${probe.frames} 帧）。已临时冷却该（账号, 模型）目标 ${mins} 分钟并改道下一个候选重发。`
}
