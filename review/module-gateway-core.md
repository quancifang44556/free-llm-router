# gateway-core 模块审查

审查对象：`src/gateway/server.ts`(3478) / `payload.ts`(1125) / `responses.ts`(948)，v0.9.18。
只读审查，未修改任何源码。文中行号均为当前工作树实测（`awk NR` 逐行核对，非 grep 估算）。

**路径命名**：分支A = `handleChatCompletions`（`server.ts:751-1564`，buddy 主循环）；
分支B = `handleProviderChat`（`server.ts:1952-2755`，所有带前缀模型）。

**先说一个与任务书不一致的事实**：`server.ts` 里真实 `applyFailure` 调用点是 **12 处**，不是 13 处。
（用「剥注释后全文正则」实测：`12`；`AccountPoolDO.ts:1022` 的注释也写 12。）
第 13 处是 `src/pool/AccountPoolDO.ts:1352`（burn-rate 软冷却，DO 内部），不属于两条 chat 路径。
下表按 12 处穷举，另附该第 13 处。

---

## 发现清单

### [严重] `/v1/responses` 非流式把上游错误帧吞成 HTTP 200 空输出

- **位置**：`src/gateway/responses.ts:924-942`（非流式读体 + 聚合 + 返回 200）
- **证据**：同一文件里**流式**路径是识别错误帧的：

  ```ts
  // responses.ts:787-793（流式）
  const errMsg = detectErrorFrame(parsed)
  if (errMsg !== undefined) {
    controller.enqueue(encoder.encode(emit('response.failed', {
      response: snapshot('failed', { code: 'upstream_error', message: errMsg }),
  ```

  而**非流式**路径读完流后直接聚合、直接 200，全程没有一次 `detectErrorFrame`：

  ```ts
  // responses.ts:924-941
  const reader = inner.response.body.getReader()
  ... // 只读，不判错
  const aggregated = aggregateSse(raw, { model, now: Date.now() })
  return { response: Response.json(toResponsesObject(body, model, aggregated, responseId), {...}) }
  ```

  链路可复现性：`handleResponses` 把 `chatBody.stream = true`（`responses.ts:871`）交给
  `handleChatCompletions`，拿到的是 SSE 流；上游错误帧被 `streamResponse` 转成
  `data: {"error":{"message":…}}`（`server.ts:1649`）。`aggregateSse`（`stream.ts:657-658`）
  对该帧 `choices` 非数组 ⇒ `continue` ⇒ `content:''`。`toResponsesObject`
  （`responses.ts:416-418`）于是产出一个 `text:''` 的 message 项，`status:'completed'`、`error:null`。
  客户端看到「成功、但模型什么都没说」。
- **影响**：`/v1/responses` 非流式（客户端传 `stream:false` 时）遇到上游拒绝/限流时**静默返回成功空答案**。
  `server.ts:2975` 那条「空响应必须报错」的守卫只在 `nonStreamingResponse` 里，
  这条路径根本不经过它 —— 而它的注释（`server.ts:3057`）写的正是「空回复比报错更糟」。
  同一文件流式路径报 `response.failed`、非流式路径报成功，属**同一概念两套判据**。
- **建议**：把「空响应/错误帧」判据抽成一个共用函数（入参 `raw: string`，出参
  `{ok} | {error,message}`），`nonStreamingResponse` 与 `handleResponses` 非流式分支都调它；
  错误时返回 `errorJson(msg, 502)`。
- **工作量**：S（抽函数 + 一处调用）
- **置信度**：确定

### [高] 分支B 主成功路径缺 `settleBlame` ⇒ 该路径的 breaker/degrade 失败**永不落账且无日志**

- **位置**：`src/gateway/server.ts:2634-2637`（对比 `server.ts:1455-1465`、`server.ts:2167-2176`）
- **证据**：三条成功回调的实际内容差异：

  ```ts
  // 分支A 主路径（1455-1465）：noteSuccess + settleBlame
  const okTask = pool.noteSuccess(candidate.uid, …)
  const settle = settleBlame(pool, blame, Date.now())
  if (ctx !== undefined) ctx.waitUntil(settle)

  // 分支B 续期重试路径（2167-2176）：noteSuccess + settleBlame + bindSession
  // 分支B **主路径**（2634-2637）：只有 noteSuccess
  onFirstChunk: () => {
    const t = pool.noteSuccess(picked.uid, Date.now(), undefined, model).catch(logPoolError('noteSuccess'))
    if (ctx !== undefined) ctx.waitUntil(t)
  },
  ```

  `settleBlame` 全文只有两个调用点（`grep -n settleBlame`：1460、2170），**都不在分支B 主路径上**。
  而分支B 会往 `blame` 里塞记录（`server.ts:2293-2294` 的 ProviderError 分支：
  `pPunishKind === 'breaker' || 'degrade' || (soft && deferSoft())`）。
  一旦下一轮换号成功，函数在 2629 直接 `return`，既没结算也没走到
  `server.ts:2737` 的「丢弃」日志 —— **静默蒸发**。
- **影响**：provider 路径（qodercn / qoder / trae / cline…，即用户实际在用的全部带前缀模型）上，
  一个持续 5xx 的账号**永远不会进熔断**：每次请求撞它 → 失败 → 换号成功 → 记账丢失。
  表现为「每次请求都白打一次上游、延迟多一跳」，而面板上该账号 `fails` 恒为 0，无从发现。
- **建议**：把 `server.ts:2634` 的 `onFirstChunk` 补齐为与 2167 完全一致的三件套
  （`noteSuccess` + `settleBlame` + `bindSession`）。**顺带**：这三处成功回调应抽成一个
  工厂函数（`successHooks(pool, uid, model, sessionKey, blame, ctx)`），从根上消灭第四次「只修一半」。
- **工作量**：S（补 4 行）/ M（抽工厂）
- **置信度**：确定

### [高] ProviderError 分支不做 `refineModelScoped` ⇒ 110/6004/14003/11134 全部退化成**账号级** soft

- **位置**：`src/gateway/server.ts:2283-2306`
- **证据**：该分支的维度只来自 `mapErrorToPunishment`：

  ```ts
  const pm = mapErrorToPunishment(c.kind)      // rate_limited ⇒ dimension:'soft'
  const pcause = modelCauseFor(c.kind)
  const pPunishKind = pm.dimension             // ← 没有 refineModelScoped
  ```

  对比另两处都做了细分：`server.ts:1276-1279`（分支A）与 `server.ts:2534`（分支B 首帧预检）
  都是 `kind === 'rate_limited' ? dimension : …`，其中 `dimension` 来自
  `refineModelScoped`（`server.ts:451-497`，把 6004/14003/11134/110 归到 `model`）。

  而 qoder 的 `110` **恰恰走这条路径**：`providers/qoder.ts:1560-1570` 把它包成
  `ProviderError{httpStatus, message:'Qoder 返回业务码 110（…）'}` 抛出，
  网关 `classify()`（`upstream/client.ts:363`，经 `parseEnvelope` 从中文包装里抠出 JSON）
  判出 `rate_limited`，然后落在 `pm.dimension = 'soft'`。
  ⇒ `refineModelScoped` 里那段「`110` 必须归 model，否则短暂锁住整个账号」（`server.ts:477-489`）
  **在唯一真正产生 110 的路径上不生效**。
  同时该处**没有传 `resetAt`**（对比 1275-1287 与 2538-2549 都传），
  于是软冷却走 `AccountPoolDO.ts:1055-1059` 的指数退避，而不是上游给的墙钟。
- **影响**：单账号 provider（`qodercn`）遇到 110/6004 时**整个账号被锁 60s 起**，
  而正确处置是「只冷却这个模型，换个模型立刻可用」。这正是 0.9.18 提交
  `a98a3cb fix(classify): 110 = 模型级日次数上限` 想修的三处连带缺陷之一，漏了这条路径。
  另：`upstream/client.ts:140-149` 的注释仍写着「`deferSoft()` 在 `poolSize===1` 时把它压进 blame」
  —— 那句话在 `refineModelScoped` 把 110 判成 model 之后已不成立，属过期论证。
- **建议**：在该分支加 `const refined = refineModelScoped(c.kind, message)`，
  `pPunishKind = c.kind === 'rate_limited' ? refined.dimension : pm.dimension`，
  并把 `refined.resetAt` 传进 `applyFailure`。
- **工作量**：S
- **置信度**：确定

### [高] `/v1/responses` 与 workbuddy 反向容灾重建 Request 时**丢掉 `signal`** ⇒ 客户端取消被记成账号失败

- **位置**：`src/gateway/responses.ts:880-887`、`src/gateway/server.ts:2721-2725`
- **证据**：两处都用无 `signal` 的合成 Request 再进网关：

  ```ts
  // responses.ts:880-887
  const chatRequest = new Request(new URL('/v1/chat/completions', request.url), {
    method: 'POST',
    headers: {...},
    body: JSON.stringify(chatBody),      // ← 没有 signal
  })
  // server.ts:2721-2725（workbuddy → buddy 反向容灾）
  const fallbackRequest = new Request(request.url, {
    method: 'POST', headers: {...}, body: JSON.stringify(fallbackBody),   // ← 没有 signal
  })
  ```

  下游所有「客户端是否走了」的判据都读 `request.signal.aborted`
  （`server.ts:1713` 的 `clientGone`、`server.ts:2909` 的非流式判据、`server.ts:2134` 的 fetch signal）。
  合成 Request 的 `signal` 永不 abort。
- **影响**：走 `/v1/responses`（Codex CLI / DSH 新协议）或 workbuddy 容灾时，
  用户在流式过程中点停止/关标签 ⇒ `clientGone()` 恒为 `false` ⇒ `streamResponse` 的
  `catch`（`server.ts:1708-1721`）把它当**上游中断**：`hooks.onError(msg)` ⇒
  `punishmentForStreamError` ⇒ 非 11‑128 一律 `'breaker'` ⇒ **3 次取消熔断一个健康号 30 分钟**。
  这正是任务书里「AbortError 被记成账号失败」那条已知缺陷 —— 在 `server.ts` 的两条主路径上
  已用 `clientGone` 修好（`1718-1721`、`2910-2924`），但**这两个合成 Request 入口又把判据废掉了**。
- **建议**：两处都补 `signal: request.signal`（合成 Request 支持 `signal` 选项）。
  更稳的做法：在 `handleChatCompletions` 入口加一条断言式兜底 —— 若 `request.signal` 与
  `request.headers` 都来自内部转发，则显式传一个 `clientSignal` 字段，不依赖 Request 自带 signal。
- **工作量**：S
- **置信度**：确定（合成 Request 的 signal 不随连接 abort 是 Fetch 规范行为；两处均未传 `signal`）

### [高] IP-WAF / 11140 波次两道全局闸门只在分支A 接线，provider 路径既不查询也不喂数据

- **位置**：`server.ts:987`（`wafGateActive`）、`server.ts:1005-1009`（`restrictionGateActive`）、
  `server.ts:1248`（`noteRestriction`）、`server.ts:1252`（`noteWaf`）—— 四处全在 `handleChatCompletions` 内
- **证据**：`grep -n "noteWaf|noteRestriction|wafGateActive|restrictionGateActive" src/gateway/server.ts`
  只有上述 4 个命中，全部落在 751-1564 区间；`handleProviderChat`（1952-2755）内**零命中**。
- **影响**：这两道闸门的设计意图是「短时间内多个账号接连 403 / 被 11140 标记 ⇒ 一个上游请求都不发，
  直接返回可读原因」（`server.ts:984-1020` 的注释：`连一个号都不试`、`看到 11140 立即停手`）。
  但 provider 路径既不读闸门、也不产生闸门数据：
  - 用户在 qodercn / qoder / trae 上撞到 11‑128 或 403 时，`noteWaf` 从不被调用 ⇒
    `WAF_IP_THRESHOLD` 永远凑不满 ⇒ **IP 级保护形同不存在**；
  - 反过来，闸门只由 buddy 账号的失败喂出来，一旦被触发，provider 路径也**不受它约束**，
    继续往同一出口打。
- **建议**：把「分类 → 喂闸门 → 查闸门」抽成一对函数（`feedGates(pool, kind, uid)` /
  `gateBlocked(pool)`），在两条路径的 `!ok`、`peeked.error`、ProviderError 三处出口统一调用；
  或在 `handleProviderChat` 开头补同样的前置检查（两行）。
- **工作量**：M
- **置信度**：确定

### [中] 分支B `!upstream.ok` 的惩罚维度只看状态码，`classify()` 的结论被算完即弃

- **位置**：`src/gateway/server.ts:2483-2501`（`classified` 在 `2444` 计算，之后只在 `2445` 用了 `.kind === 'channel_blocked'`）
- **证据**：

  ```ts
  const classified = classify(upstream.status, text)      // 2444：算出了完整 kind
  const isChannelBlocked = classified.kind === 'channel_blocked'
  ...
  const failureKind: 'soft' | 'hard' | 'model' | 'breaker' =
    upstream.status === 402 ? 'hard'
      : upstream.status === 429 ? refined.dimension
        : 'breaker'                                      // ← 其余一律 breaker
  ```

  于是 `400 + {"code":11158}`（`model_denied`）与 `400 + 11102`（`model_unavailable`）都被记成
  `breaker`，而不是 `model`；`403 + 无信封`（`waf_blocked`）也被记成 `breaker` 而不是 `soft`，
  且这里**没有 `[waf-403]` 留证日志**（分支A 在 `1228-1231` 有，分支B 只在 ProviderError 分支
  `2276-2281` 有）。同一段还没有传 `modelCause`，`kind:'model'` 时 `AccountPoolDO.ts:1149`
  会退化成 `cause='busy'`（15s）而不是 `absent` 阶梯。
  可达性：`provider.chat()` 返回 Response（不抛）的只有 `opencode`（`opencode.ts:809-815` 直接 return）
  与 `buddy`（`buddy.ts:315` 直接 return，经聚合路径可达）。
- **影响**：这两家的业务错误仍会「按状态码一刀切」—— 正是 `server.ts:2436-2443` 那段注释
  声称已修好的缺陷，实际只修了 `channel_blocked` 一条支路。11158 会被记成账号熔断（3 次 30 分钟），
  与「档位不支持应只锁模型」的既定口径相反。
- **建议**：改成与分支A 同构：`const pm = mapErrorToPunishment(classified.kind)`，
  维度取 `classified.kind === 'rate_limited' ? refined.dimension : pm.dimension`，
  并补 `modelCause`、`resetAt`、以及 `waf_blocked` 的留证日志。
- **工作量**：S
- **置信度**：确定（代码路径确定；opencode/buddy 之外是否还有 provider 返回 Response，未逐个核完）

### [中] 分支B `peekStreamForError` 分支仍不延迟记账 —— 注释声称的「三处一致」实际只有两处

- **位置**：`src/gateway/server.ts:2538-2551`
- **证据**：

  ```ts
  if (mapped.punish) {
    const cause = modelCauseFor(kind)
    await pool
      .applyFailure({                    // ← 直接记账，没有 blame 判断
        uid: picked.uid,
        kind: kind === 'rate_limited' ? refined.dimension : …,
  ```

  对比分支A 的同一分支（`server.ts:1357-1371`）有完整的
  `if (punishKind === 'breaker' || 'degrade' || (soft && deferSoft())) blame.push(...)`。
  而 `server.ts:2287-2290` 的注释写着：
  「这是「延迟记账」的第 3 条路径（前两条：buddy 主循环、provider 的 `peekStreamForError` 分支）。
  三处必须一致」—— 描述与实际相反（`peekStreamForError` 那条才是缺的）。
- **影响**：provider 路径上「HTTP 200 + 流内错误帧」（qoder/codearts 的主要报错形态）仍会
  立即给每个候选记一次 breaker ⇒ 一个请求遍历 N 个号就记 N 次 ⇒ 3 个请求后全池熔断，
  且熔断期内没有成功请求复位。这就是 blame 机制存在的**全部理由**（`server.ts:179-203` 的注释）。
- **建议**：补 blame 分支；并把「是否延迟」的判据抽成 `shouldDefer(punishKind, deferSoft())`，
  四处调用同一函数。
- **工作量**：S
- **置信度**：确定

### [中] `bindSession` 只在两个「续期重试」分支被调用 ⇒ 会话粘性在主路径永不建立

- **位置**：`server.ts:2176`、`server.ts:2361`（仅此两处）；读取方 `server.ts:1096`、`server.ts:2079`
- **证据**：`grep -n "bindSession" src/gateway/server.ts` 只有 2176 / 2361，
  两者都在「401/403 → `provider.refresh()` → 重放」的**罕见**分支里。
  `AccountPoolDO.ts:967` 的 `bindSession` 也没有被 `pick`/`noteSuccess` 内部调用
  （`grep -rn bindSession src/` 仅这三个命中：定义 + 上述两处调用）。
  而 `getSession` 在两条路径的**每次**请求首轮都会调用（`server.ts:1096`、`2079`）。
- **影响**：`deriveSessionKey`（`server.ts:616-643`，每请求一次 SHA-256）算出的 key
  永远查不到绑定 ⇒ 会话粘性（命中上游 prompt cache）**从未生效**；
  只有恰好发生过一次 token 续期的会话才会粘住。
  同理 `clearSessionBinding`（`server.ts:730-742`，每个失败分支都调）几乎恒为空操作。
  这是「功能写好、开关也在、但只在一条罕见路径上生效」的典型形态。
- **建议**：把 `bindSession` 并入上面建议的 `successHooks()` 工厂，两条路径的主成功点都调用。
- **工作量**：S
- **置信度**：确定

### [中] `throttleUpstream` 只在 provider 路径调用 ⇒ 面板「防封·节奏」对 buddy 主路径静默无效

- **位置**：调用点 `server.ts:2132`、`server.ts:2154`（均在 `handleProviderChat`）；
  配置注入点 `safety.ts:115`（`configureThrottle`，由 `handleChatCompletions:787` 的
  `safetyConfigFor` 触发）
- **证据**：`grep -n throttleUpstream src/gateway/server.ts` 只有 33（import）、2132、2154。
  `throttle.ts` 文件头（`throttle.ts:5-14`）明确说这层的目的是「按账号整形节奏，
  因为上游风控看到的是单个账号的节奏」。
- **影响**：用户在面板里配 `rateLimitQps` / `rateJitterMs` 后，**默认供应商（buddy/workbuddy）
  完全不受限速**——而 `server.ts:1401` 的注释自己说「buddy/workbuddy 是默认供应商，
  绝大多数流量走这里」。配置被读取、被写进模块全局、然后对主路径不产生任何作用。
- **建议**：在分支A 的 `fetch` 前补 `await throttleUpstream(candidate.uid)`（与 2132 同位置语义）。
- **工作量**：S
- **置信度**：确定

### [中] 空响应判据漏 `refusal` 与 `function_call` ⇒ 合法响应被报成「上游返回空响应」502

- **位置**：`src/gateway/server.ts:2973-2980`
- **证据**：

  ```ts
  const toolCalls = (choice?.message as { tool_calls?: unknown[] } | undefined)?.tool_calls
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0
  if (choice !== undefined && !hasToolCalls
    && choice.message.content === ''
    && (choice.message.reasoning_content ?? '') === '') { … 502 … }
  ```

  只排除了 `tool_calls`。而 `aggregateSse`（`stream.ts:663-693`）只累积
  `content` / `reasoning_content` / `tool_calls` 三项，**不累积 `refusal`，也不累积旧式
  `delta.function_call`**（`stream.ts:209/218/237` 的注释确认这两个字段存在于上游帧里，
  只是净化阶段被删空值，没有内容时也不会保留）。
- **影响**：两类**合法**响应会被判成空响应并返回 502：
  ① 模型拒答（OpenAI `refusal` 字段，安全策略触发时的标准形态）；
  ② 旧式函数调用（`function_call`，非 `tool_calls`）。
  客户端拿到「上游返回了空响应（既没有正文/思考内容…）」—— 与真实原因完全无关，
  且这条路径**不换号、不重试**（`3064-3071` 直接 return），用户只能干等。
  这是把「空响应守卫」写成了「只认一种形态」的反向误伤。
- **建议**：判据改成「三个字段全空」：`content === '' && (reasoning_content ?? '') === ''
  && !hasToolCalls && (message.refusal ?? '') === '' && message.function_call == null`；
  若要支持旧式函数调用，还需在 `aggregateSse` 里累积 `function_call`。
- **工作量**：S（仅判据）/ M（含 aggregateSse 支持 function_call）
- **置信度**：确定（判据漏项确定；实际触发频率取决于客户端/上游是否用 refusal，待确认）

### [中] `11‑128` 的三种字节形态只认两种：`CHANNEL_BLOCK_RE` 与 `isChannelBlockedText` 都用了 ASCII 连字符

- **位置**：`server.ts:391-397`（`CHANNEL_BLOCK_RE`）、`server.ts:462`（`isChannelBlockedText`）
- **证据**：实测（脚本 `/tmp/re-test.mjs`，直接构造该正则）：

  | 输入形态 | 字节 | `CHANNEL_BLOCK_RE.test()` |
  |---|---|---|
  | 裸 5 位 `11128` | `3131313238` | **true** ✅ |
  | ASCII `11-128` | `31312d313238` | **true** ✅ |
  | 真实上游 `11‑128`（U+2011） | `3131e28091313238` | **false** ❌ |
  | `Illegal API invocation from an unapproved channel` | — | true（靠文案）✅ |

  正则里第二个备选是 `String.fromCharCode(0x31,0x31,0x2d,0x31,0x32,0x38)` = ASCII `-`；
  而 `upstream/client.ts:289-290` 明确记录「真实字节是 `31 31 E2 80 91 31 32 38`，
  中间那个不是 `-`，而是 U+2011」。`isChannelBlockedText`（`server.ts:462`）
  的 `/"code"\s*:\s*"11‑128"/` 同样是 ASCII 形态。
  测试也没覆盖：`tests/channel-blocked.test.ts:118-121` 只测了裸 5 位与数字边界。
- **影响**：`punishmentForStreamError`（`server.ts:399-401`）的注释写「拦截码有裸 5 位数字与
  带连字符两种记录形态，**两种都认**」—— 实际只认两种 ASCII 形态。当流内错误文本里
  只有 U+2011 形态的码、且不含 `unapproved channel` / `security policy` 文案时，
  渠道拦截会被判成 `'breaker'` ⇒ 3 次熔断健康账号 30 分钟，正是该函数要防的那个缺陷。
- **影响面（收敛）**：多数真实报文同时带英文文案（此时靠文案命中），故属「判据不完整」
  而非「必然误判」。`isChannelBlockedText` 失效的后果更轻（落回 `soft`，与预期同向）。
- **建议**：两个正则都补 U+2011 备选（`\u2011`），并加一条 `punishmentForStreamError` 的
  U+2011 用例。
- **工作量**：S
- **置信度**：确定（正则行为已实测）；触发频率待确认

### [中] `detectErrorFrame` 只认**数字** `code`，与已修好的 `parseBusinessCode` 形成两套形态判据

- **位置**：`src/gateway/stream.ts:88-92`
- **证据**：

  ```ts
  // stream.ts:88-92
  const code = chunk.code
  if (typeof code === 'number' && code !== 0) { … return `上游业务错误 code=${code}…` }
  ```

  而 `server.ts:500-530` 的 `parseBusinessCode` 已经为「`{"code":"110"}` 带引号」专门加了分支，
  注释（`server.ts:503-511`）写着旧正则「只认未加引号的数字」是实测缺陷。
  `detectErrorFrame` 是同一语义的另一处实现，**没有跟着改**：
  `{"code":"110"}` 在这里 `typeof code === 'string'` ⇒ 不命中 ⇒ 整帧被当普通帧。
- **影响**：字符串形态的业务码错误帧在三个消费点上全部隐形：
  `peekStreamForError`（`server.ts:1852` 的 `tryDetectError`）、
  `streamResponse` 的流内检查（`server.ts:1646`）、
  `toResponsesSse` 的错误帧识别（`responses.ts:787`）。
  后果不是崩溃，而是**错误分类丢失**：HTTP 200 + 字符串码错误帧会一路走到
  `server.ts:3064` 的通用兜底「上游返回了空响应…」，真实原因只以原文片段形式出现，
  且不写模型负缓存、不触发换号。
- **建议**：`detectErrorFrame` 的 `code` 判据改成
  `const code = typeof chunk.code === 'number' ? chunk.code : (typeof chunk.code === 'string' && /^\d+$/.test(chunk.code.trim()) ? Number(chunk.code) : undefined)`
  —— 与 `parseEnvelope`（`client.ts:300-306`）口径一致。
- **工作量**：S
- **置信度**：确定（判据差异确定）；实际触发频率待确认（qoder 在 provider 层已 unwrap，
  其余上游是否用字符串码未逐个验证）

### [中] `poolSize` 用 `realm` 而非 `activeRealm` ⇒ `deferSoft` 对 workbuddy 永不生效

- **位置**：`src/gateway/server.ts:2061-2065`（`activeRealm` 在 `1997` 已算出）
- **证据**：

  ```ts
  let poolSize = 0
  try {
    const all = await env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm)).listAccounts(realm, Date.now())
    poolSize = all.filter((a) => (a.provider ?? '') === providerId && a.disabled !== true).length
  ```

  用的是入参 `realm`（默认 `'cn'`），而不是下面循环实际使用的 `activeRealm`。
  而 `providerId === 'workbuddy'` 时 `activeRealm` **恒为 `'global'`**（`server.ts:1997`）。
- **影响**：`poolSize` 恒为 0 ⇒ `deferSoft()` 恒 `false`（`server.ts:2069`）⇒
  单账号 workbuddy 池的 soft 冷却**立即记账**，60 秒内整条链路 503。
  这正是 `deferSoft` 要治的症状（`server.ts:2046-2058` 的注释：「单账号池下等于整条链路断 60 秒」），
  而它偏偏在最需要它的那个供应商上不生效。
  `server.ts:2043` 的 `maxRotateFor(…idFromName('cn'))` 同样硬编码 `'cn'`，
  与分支A 的 `maxRotateFor(pool)`（`1029`，用当前 realm）口径不一致。
- **建议**：两处都改成 `activeRealm`。
- **工作量**：S
- **置信度**：确定

### [中] 上游 `resetAt` 无上限钳制，可越过退避阶梯把账号/模型锁到任意远期

- **位置**：`server.ts:553-575`（`parseResetAt` 返回原始墙钟）→ `AccountPoolDO.ts:1053-1054`（soft）、
  `AccountPoolDO.ts:1176-1179`（model）
- **证据**：

  ```ts
  // AccountPoolDO.ts:1053-1054（soft）
  if (input.resetAt !== undefined && input.resetAt > now) { state.until = input.resetAt }
  // AccountPoolDO.ts:1176-1179（model）
  const until = input.resetAt !== undefined && input.resetAt > now ? input.resetAt : now + fallbackCooldown
  ```

  两条都是「上游给了就完全采信」，没有 `Math.min(resetAt, now + MAX)`。
  而 `parseResetAt`（`server.ts:553-575`）的兜底正则
  `/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC([+-])(\d{1,2})/`
  接受**任意**年份的日期串。
- **影响**：只要上游（或上游某条被误分类的文案）里出现一个远期 `… UTC+8` 时间，
  该账号的 `until` / 该模型的 `modelCooldowns` 就会被设到那个时刻，**完全绕过**
  `soft` 的指数退避与 `model` 的 2min→30min→2h→6h→24h 阶梯。
  项目已有同类事故先例：`client.ts:135-138` 记录「把语义未明的 110 映射到 hard
  ⇒ 账号被锁 619 分钟」。这里的风险方向相同，只是触发源换成了报文里的日期。
- **建议**：在 `applyFailure` 的两处 `resetAt` 上各加一个上限
  （soft ≤ 2h、model ≤ 24h），超出则回落阶梯并打一条 `[punish] resetAt clamped` 日志。
- **工作量**：S
- **置信度**：待确认（钳制缺失确定；上游是否真会下发远期 resetAt 未实测）

### [低] 永久积分锁在分支A 抛裸 `Error` ⇒ 500 `internal_error`；分支B 返回 429

- **位置**：`server.ts:716-722`（`pickCandidate` 内 throw）vs `server.ts:2096-2105`（分支B 内联，`break` + 429）
- **证据**：`pickCandidate` 里 `throw new Error('该供应商的 N 个账号只剩永久积分…')`；
  `handleChatCompletions` 对该调用（`server.ts:1097`）没有 try/catch，
  异常一路到 `index.ts:1170` 的兜底，返回
  `500 {"message":"服务内部错误：该供应商的 N 个账号只剩永久积分…"}`。
  分支B 同样场景是 `lastError = { status: 429, message: … }` + `break`。
- **影响**：同一业务状态两种状态码（500 vs 429）。500 会被客户端判成「网关故障」并可能重试，
  而这是**需要用户去面板操作**的确定性状态。文案虽被带出，但被 `服务内部错误：` 前缀污染。
- **建议**：`pickCandidate` 不要 throw，改成返回 `{ locked: true, skipped }` 判别式
  （与 `PinBlocked` 同构），两条路径共用同一段 429 响应。
- **工作量**：S
- **置信度**：确定

### [低] `describeNoAccount` 的 provider 默认值 `'workbuddy'` 与全文 `DEFAULT_PROVIDER` 不一致

- **位置**：`src/gateway/server.ts:2795`
- **证据**：`(a.provider ?? 'workbuddy') === provider`；而同一文件其它所有过滤点都是
  `(a.provider ?? DEFAULT_PROVIDER)`（`1044`、`1123`、`2001`、`2007`、`2713`、`3323` 等），
  `DEFAULT_PROVIDER` 是 `'buddy'`。
- **影响**：若存在 `provider` 字段缺失的旧账号，查 buddy 的「无可用账号」说明时会被算成
  workbuddy ⇒ 可能输出「供应商「buddy」没有账号（请先在面板导入该凭据）」，
  而账号其实存在、只是缺字段。仅影响文案，不影响路由。
- **建议**：改成 `DEFAULT_PROVIDER`。
- **工作量**：S
- **置信度**：确定（是否有缺字段的历史账号：待确认）

---

## 双路径一致性对照表

| 操作 | 分支A（`handleChatCompletions`） | 分支B（`handleProviderChat`） | 是否一致 | 风险 |
|---|---|---|---|---|
| 会话 key 派生 | 入口统一 `deriveSessionKey`（781） | 复用入参 `sessionKey` | ✅ | — |
| 消息归一（`developer→system`、工具配对） | 入口统一 `cleanupToolPairing`（832-844） | 同左 | ✅ | — |
| 消息数裁剪 | 入口统一 `trimMessagesByLimit`（845-862） | 同左 | ✅ | — |
| 请求体其余准备（字段翻译/schema/stop/指纹脱敏/思考回填） | `prepareChatBody`+`sanitizeChatBody`（969） | **完全不过**（`body` 只换 model，2028-2032） | ❌ | 中：见下「静默失效」汇总 |
| 出站头 | `referenceChatHeaders`（1180） | `provider.chat` 内部各自构造 | ⚠️ 按 provider | 设计使然（协议差异） |
| 防封限速 `throttleUpstream` | **无** | 2132、2154 | ❌ | 中（见发现） |
| 选号 | `pickCandidate`（1097）→ 永久锁 **throw** | 内联 `pool.pick`（2092）→ 永久锁 **429** | ❌ | 低（见发现） |
| `poolSize`（deferSoft 判据） | `pool.listAccounts(realm)`（1040-1045） | `listAccounts(realm)` 而非 `activeRealm`（2063） | ❌ | 中（见发现） |
| `maxRotate` 来源 | `maxRotateFor(pool)`（1029） | `maxRotateFor(idFromName('cn'))` 硬编码（2043） | ❌ | 低：global 分片的路由配置不生效 |
| WAF / 11140 前置闸门 | 987、1005-1009 | **无** | ❌ | 高（见发现） |
| 非 2xx 分类 | `classify(status,text)` 全量使用（1235-1236） | `classify` 只取 `channel_blocked`（2444-2445），维度按状态码（2483-2488） | ❌ | 中（见发现） |
| 非 2xx 维度细分 | `refineModelScoped`（1236） | `!ok`：`refineModelScoped`（2468）；ProviderError：**无**（2283） | ❌ | 高（见发现） |
| `Retry-After` 头兜底 | **无**（1236 只读文案） | 两处都有（2478-2482、2535-2536） | ❌ | 中：buddy 路径在「上游只给标准头」时只能猜退避 |
| `resetAt` 传入 `applyFailure` | 有（1283、1366、1417） | ProviderError 分支**无**（2297-2303）；其余有 | ❌ | 中（见发现） |
| `modelCause` 传入 | 有（1286、1368） | `!ok` 分支**无**（2490-2500）；其余有 | ❌ | 中（退化 busy 15s） |
| 延迟记账 `blame` | `!ok`（1279）、`peek`（1357）都有 | ProviderError 有（2293）；**`peek` 无**（2538）；**`!ok` 无**（2489） | ❌ | 高/中（见两条发现） |
| 成功时结算 `blame` | `onFirstChunk`（1460） | 仅续期重试分支（2170）；**主路径无**（2634） | ❌ | 高（见发现） |
| 会话粘性写入 `bindSession` | **无** | 仅续期重试分支（2176、2361） | ❌ | 中（见发现，两边都缺） |
| 首帧 `noteSuccess` | 1455 | 2167、2357、2635 | ✅ | — |
| 零输出越墙守卫 | `screenZeroOutputStream`（1403）+ `model` 维度（1411）+ `recordLog` | 2579 + 2590 + `recordLog` | ✅ | 口径一致，值得保留 |
| 流内错误维度 | `punishmentForStreamError`（1515） | 主路径 `punishmentForStreamError`（2642）；**续期重试路径硬编码 `'breaker'`**（2181） | ❌ | 中：11‑128 在该路径会被熔断 |
| 客户端取消判别 | `clientGone`（1452、2909） | `clientGone`（2165、2365、2633） | ✅ | 但 `/v1/responses`、workbuddy 容灾入口丢 `signal`（见发现） |
| 非流式读体异常 | 502 + 499 语义（2887-2950） | 复用同一函数 | ✅ | 但 `responses.ts:924` 自行读体、无 catch/无 499 |
| 错误状态码映射 | `clientStatusFor(status, kind)`（1300） | ProviderError 用 `kind`（2309）；`!ok` 用 `'unknown'`（2504） | ❌ | 中：`context_exceeded`/`bad_request` 在 `!ok` 路径退化成 502 而非 400 |
| `[waf-403]` 留证 | 1228-1231 | ProviderError 有（2276-2281）；**`!ok` 无** | ❌ | 中（见发现） |
| `noteWaf` / `noteRestriction` | 1252 / 1248 | **无** | ❌ | 高（见发现） |
| 跨渠道容灾 | buddy→workbuddy（1119-1146） | workbuddy→buddy（2708-2731） | ⚠️ 语义对称，但后者丢 `signal` | 中 |
| 用量记录 | `buddy/${model}`（1493） | `${providerId}/${model}`（2668） | ✅ | 前缀口径一致，值得保留 |
| 面板日志 `recordLog` | 成功/失败/零输出都有 | 同左 | ✅ | — |

### 「静默失效」汇总：只在分支A 生效的配置与字段

`payload.ts` 全量管线只在 buddy 路径生效（`server.ts:969` 是唯一调用点，`buddy.ts:307` 是
`provider.chat` 内部的第二次调用）。因此下列**全部**改写只对默认供应商生效，
对 `qodercn/…` 等带前缀模型**一律不生效**：

| 函数 | 作用 | 定义 | 是否只在 buddy 生效 |
|---|---|---|---|
| `translateMaxCompletionTokens` | `max_completion_tokens`→`max_tokens` | payload.ts:47 | ✅ 是 |
| `clampGptMaxTokens` | `max_tokens≥16` | payload.ts:679 | ✅ 是 |
| `ensureStreamOptions` | 补 `include_usage`（否则拿不到 usage） | payload.ts:103 | ✅ 是 |
| `normalizeToolChoice` | 对象形式 `tool_choice` 会 400 | payload.ts:73 | ✅ 是 |
| `normalizeTools` | 非法 JSON-Schema 会 11129 | payload.ts:828 | ✅ 是 |
| `normalizeStop` | 字符串 stop 会 11101 | payload.ts:660 | ✅ 是 |
| `fillDeepseekEffort` | 显式开思考却无档位 | payload.ts:601 | ✅ 是 |
| `backfillReasoningContent` | 思考模式缺上轮 reasoning 会 11155 | payload.ts:623 | ✅ 是 |
| `scrubFingerprints` / `scrubFingerprintText` / `scrubToolArguments` | 反指纹脱敏 | payload.ts:1009/938/963 | ✅ 是（`grep -rn` 在 payload.ts 外**零命中**） |
| `sanitizeChatBody`（整串 11‑128 兜底） | 防触发上游反探测 | payload.ts:1122 | ✅ 是 |

**其中最值得单独看的一条**：`scrubFingerprints` 系列（含 `x-anthropic-billing-hdr`、
`Sisyphus-Junior - Focused executor` 等字面量，`payload.ts:880-924`）只跑在 buddy 路径。
而 `CHANNEL_BLOCKED_HINT`（`server.ts:382`）对用户承诺的是
「**网关已内置常见客户端的清洗**，若仍复现请提供触发的系统提示首句」——
在 provider 路径上这句承诺不成立。这不是「设计选择」：同一个 hint 在两条路径上都被返回
（`server.ts:1303`、`1378`、`2453`；**分支B 的 `peeked` 分支漏了**，见 `2557`），但清洗只有一条路径做。
（是否要把整条 `prepareChatBody` 也套到 provider 路径属架构决策，不在此建议；
但 hint 文案与清洗范围至少要对齐。）

---

## applyFailure 调用点归属表（穷举 12 处 + 1 处 DO 内部）

「有日志」列区分三种：**池内** = `AccountPoolDO.ts:1035` 的统一 `[punish]` 日志（每次调用必有，
一处覆盖全部路径）；**catch** = 调用点的 `.catch(logPoolError(...))` / 内联 `console.warn`（只记写入失败）；
**留证** = 该分支特有的诊断日志（`[waf-403]` / `[zero-output]` / `[stream-error]`）。

| 行号 | 所属路径 | 延迟记账(blame) | 有日志 | 维度正确 | 判定 |
|---|---|---|---|---|---|
| 204 | `settleBlame`（两条路径共用的**结算执行点**） | —（它本身就是结算动作） | 池内 + catch（`console.warn` 结算失败） | 取决于入队时的 `kind`（类型被限为 `breaker\|degrade\|soft`） | ✅ 设计正确；问题在调用方（2634 缺调用） |
| 1275 | 分支A `!upstream.ok` | ✅ 是（1279：breaker/degrade/soft&&deferSoft） | 池内 + catch（内联 `console.warn`） | ✅ `rate_limited→refined.dimension`；`model→model`；带 `modelCause`/`resetAt` | ✅ 最完整的一处，可作基准 |
| 1361 | 分支A `peekStreamForError`（HTTP 200 错误帧） | ✅ 是（1357） | 池内 + catch(`logPoolError`) | ✅ 同 1275 | ✅ |
| 1411 | 分支A 零输出越墙 | ❌ 否（`model` 维度，立即） | 池内 + catch + **留证**（`[zero-output]`+`recordLog`） | ✅ `model` + 显式 `resetAt`（不走 6h 阶梯） | ✅ 正确 |
| 1513 | 分支A 流内 `onError` | ❌ 否（流已交付客户端，无法延迟） | 池内 + catch + `recordLog`（**无 console**） | ⚠️ `punishmentForStreamError` 的 U+2011 漏认（见发现）⇒ 渠道拦截可能落 breaker | ⚠️ 判据需补 |
| 2181 | 分支B **续期重试成功**后的 `onError` | ❌ 否 | 池内 + catch + `recordLog` | ❌ **硬编码 `kind:'breaker'`**，未走 `punishmentForStreamError` | ❌ 应改为 2642 的写法 |
| 2297 | 分支B `ProviderError` | ✅ 是（2293） | 池内 + catch + **留证**（`[waf-403]`） | ❌ 未 `refineModelScoped`（110/6004 退化成账号级 soft）；**未传 `resetAt`** | ❌ 见高优先级发现 |
| 2368 | 分支B `!upstream.ok` → 续期重试成功后的 `onError` | ❌ 否 | 池内 + catch + `recordLog` | ✅ `punishmentForStreamError` | ✅（但 blame 不结算的问题仍存在） |
| 2490 | 分支B `!upstream.ok` | ❌ 否 | 池内 + catch | ❌ `failureKind` 只看状态码（丢弃 `classified.kind`）；无 `modelCause`；无 `[waf-403]` | ❌ 见发现 |
| 2541 | 分支B `peekStreamForError` | ❌ **否**（同分支A 的 1361 是「是」） | 池内 + catch | ✅ 维度/`modelCause`/`resetAt` 都对 | ❌ 缺 blame（见发现） |
| 2590 | 分支B 零输出越墙 | ❌ 否（`model`，立即） | 池内 + catch + **留证** | ✅ `model` + 显式 `resetAt` | ✅ 与 1411 一致 |
| 2640 | 分支B 主流 `onError` | ❌ 否 | 池内 + catch + `recordLog` | ✅ `punishmentForStreamError` | ✅（同上，blame 结算缺失） |
| — | **`AccountPoolDO.ts:1352`**（burn-rate 软冷却，DO 内部） | 不适用（无请求上下文） | 池内 + 专用 `[burn]` 日志（1344-1347） | ✅ `soft` | ✅ 属另一层，不计入两条 chat 路径 |

**横向结论**（三条，全部可从表内直接读出）：

1. **blame 覆盖 3/12**（1275、1361、2297 是「是」），而 `server.ts:2287-2290` 的注释声称
   「三处必须一致」—— 实际缺 2541，且 2489/2490 也没进 blame。
2. **维度判定有 5 套写法**：1276-1279（A-`!ok`）、1355-1358（A-`peek`）、2292（B-ProviderError，
   无 refine）、2483-2488（B-`!ok`，只看状态码）、2543（B-`peek`）。
   其中 2292 与 2488 是错的。
3. **只有 3 处有自己的专用日志**：1275（内联 `.catch` 里 `console.warn`）、1411 与 2590（
   独立的 `[zero-output]` + `recordLog`）。其余 9 处只靠池内统一 `[punish]`（`AccountPoolDO.ts:1035`）
   兜住 —— 这是好设计（`AccountPoolDO.ts:1018-1034` 的注释说明了理由），也是为什么这次
   没把「无日志」列为独立缺陷。

---

## 本模块亮点（值得保留的设计）

1. **延迟记账的判据设计**（`server.ts:179-203`）：用「换号后成功了」而不是「这个号失败了」
   作为记账证据，把「上游整体故障 / 本机断网」与「单个号坏了」区分开。
   连带熔断的推理（每请求 N 个号各记 1 次 ⇒ 3 请求全池 breaker 30 分钟 ⇒ 熔断期内无成功请求复位）
   是本项目里最扎实的一段因果分析。**机制正确，只是接线漏了一处**（2634）。

2. **零输出越墙守卫的双路径一致性**：`screenZeroOutputStream` 在 1403 与 2579 各接一次，
   且两处都用 `kind:'model'` + 显式 `resetAt`（1411、2590），并都在注释里明确禁止升成 `breaker`
   （「3 次熔断账号 30 分钟，误杀健康号」）。这是全模块唯一一条**两条路径完全对齐**的记账逻辑，
   可以作为「如何避免只修一半」的范本。

3. **集中式 `[punish]` 日志**（`AccountPoolDO.ts:1035-1039`）：放在 `applyFailure` 内部而不是各调用点，
   一处覆盖全部 12 条路径，且日志格式刻意设计成可判读（`kind=soft` + `model=` 空 ⇒ 账号级误判）。
   这直接解决了该注释记录的「12 处调用只有 3 处带日志」的可观测性问题。

4. **业务码归一化的边界处理**：`parseEnvelope`（`client.ts:197-315`）同时处理
   「外层信封套内层 `body` 字符串」、「数字码 / 字符串码」、「`NN-NNN` 归一成负值 `-108128`」
   三种形态，且注释解释了为什么不用 `-139`（会被 JS 求值成 `-11 - 128`，日后撞码）。
   `parseBusinessCode`（`server.ts:500-530`）对带引号码的修复也保留了「必须成对闭合引号」的边界说明。

5. **`refineModelScoped` 的「两条腿」判据**（`server.ts:451-497`）：码值（6004/14003/11134/110）
   + 中英文文案（`model busy` / `切换其他模型`），并显式排除 `"code":"11‑128"` 不被文案规则劫持。
   注释里对 110 的降级推理（从 `credit_exhausted` 硬冷却 10.3 小时回退到 `rate_limited`）
   记录了「把语义未明的码映射到最重处置，代价远大于收益」这条教训。

6. **`peekStreamForError` 的工程细节**（`server.ts:1772-1950`）：64 KiB 上限、只喂第一行给
   `detectSseLine`（避免跨帧边界把正常流误判成错误）、`replay()` 原样归还预读字节、
   `candidate` 形态识别（json/sse/plain）。注释还记录了「整段喂进去会 `slice(5)` 得到
   `{...}\ndata: {...}` ⇒ 正常流在结束边界被误拦成 502」这个真实踩坑。

7. **`nonStreamingResponse` 的 499/502 语义分离**（`server.ts:2887-2950`）：
   客户端取消 → 499 + `client_closed_request` 且**不调 `hooks.onError`**；
   上游超时 → 502 + `upstream_error` 且明确「这是上游问题，不是我们的内部故障」。
   并把「原先没有 catch，`TimeoutError` 穿透成 500」的原因写在注释里。

8. **模型维度「验证式冷却」阶梯**（`AccountPoolDO.ts:1121-1175`）：一次失败只锁 2 分钟观察窗，
   靠「再次失败」自然坐实升级（30min→2h→6h→24h），并用账号级 `modelConfirm` 而不是
   冷却条目里的 `hits` 作为次数来源（因为 `pruneExpired` 会把 `hits` 清零）。
   这条设计把「11102 一次锁 6 小时」的误杀面从 5.56 小时压到 2 分钟。

---

## 测试缺口

1. **双路径一致性没有任何行为级测试**。`tests/state.test.ts:579-619` 是**源码正则 + 计数**断言：

   ```ts
   // state.test.ts:609-610
   const settleCalls = [...src.matchAll(/settleBlame\(pool, blame, Date\.now\(\)\)/g)]
   assert.ok(settleCalls.length >= 2, `应在两条路径的成功点都结算 blame，实际 ${settleCalls.length} 处`)
   ```

   实测 `settleCalls.length === 2`（1460 与 2170）—— **恰好被「分支A + 分支B 续期重试」满足**，
   于是测试通过，而分支B 的**主**成功点（2634）缺失不被发现。
   `>= 2` 这种全局计数断言无法表达「哪条路径的哪个点」，是本类缺陷反复复发的直接原因。
   同类断言还有 617-618（`applyCalls.length >= 2`，对 12 处调用形同虚设）。
   **建议**：改为按路径切片后再断言（例如按 `function handleProviderChat` 与
   `function handleChatCompletions` 切段，各自要求 `settleBlame` 至少 1 次），
   或直接对两条路径跑同一组行为用例（可注入 `pool` 桩，`pickCandidate` 已支持传入 stub）。

2. **`/v1/responses` 非流式没有任何错误路径用例**。`tests/responses.test.ts` 只测纯函数
   （`toChatBody` / `toResponsesObject` / `usageOf`），没有一条「上游错误帧 → 期望非 200」。
   本文档第一条「严重」发现完全落在这个空白里。

3. **客户端取消只有「管道接上了」的源码断言，没有「水真的流了」的行为测试**。
   `tests/providers.test.ts:1374-1386` 遍历 `await streamResponse(` 的 4 个调用点，
   要求每个调用点后 1200 字符内出现 `clientGone` —— 这条**通过**（4 处都传了）。
   但它检查的是**接线**，不是**信号活性**：`/v1/responses`（`responses.ts:880`）与
   workbuddy 反向容灾（`server.ts:2721`）传进去的 `request` 是**合成 Request**，
   `request.signal` 永不 abort ⇒ `clientGone()` 恒 `false`，而调用点**确实传了**参数。
   同理 1371-1372 只断言类型里有 `clientGone?` 字段。
   ⇒ 这类「参数在、判据死」的缺陷只能靠行为测试（真发请求再断连）或
   一条「转发时必须带上游 signal」的断言来发现，当前两者都没有。

4. **`CHANNEL_BLOCK_RE` 缺 U+2011 用例**。`tests/channel-blocked.test.ts:118-121` 覆盖了
   裸 5 位码与数字边界，但没有 U+2011 形态；而 `upstream/client.ts:289-290` 已经写明
   真实字节就是 U+2011。补一条 `punishmentForStreamError('…11\u2011128…') === 'soft'`
   即可把这个洞堵住（当前会返回 `'breaker'`，测试会红）。

5. **`refineModelScoped` 的模型级码表缺「走 ProviderError 路径」的用例**。
   `tests/channel-blocked.test.ts` 与 `tests/reset-at-zh.test.ts` 测的都是
   `refineModelScoped` 本身，而「网关是否在每条路径上都调用了它」没有测试。
   建议补一条：构造 `ProviderError{httpStatus:429, message:'{"code":"110",…}'}`，
   断言最终落到 `kind:'model'`（当前会落到 `'soft'`）。

6. **无 `payload.ts` 管线的作用域测试**。没有任何用例断言
   「provider 路径的请求体也应经过 `scrubFingerprints` / `normalizeTools`」，
   所以「管线只在 buddy 生效」这件事既没被测试固定，也没被测试发现。
