# providers-a 模块审查

审查对象（**只读，未修改任何源码**）：

| 任务书写的 | 实际文件 | 行数 | `git log --follow` 提交数 |
|---|---|---:|---:|
| `src/providers/workbuddy.ts`（996 行 / 35 次 fix） | **不存在**；腾讯双变体在 `src/providers/buddy.ts` | 523 | 12 |
| `src/providers/qoder.ts`（874 行 / 27 次 fix） | `src/providers/qoder.ts` | **2476** | 15 |

基线：`v0.9.24`，**`HEAD=e3286da`**。审查期间仓库被并发提交四次：
`b7383f4` → `83a5b15`（补 provider 路径的 WAF 闸门）→ `b385b3d`（修 qoder 排队 10605）→
`e3286da`（补 buddy 的节流 + 三条主路径的会话粘性）。其中 **`b385b3d` 与 `e3286da` 修掉的正是本报告的发现 4 / 发现 1+3**，
各条已标注状态并复测。
**本文所有行号已按 `e3286da` 重算**（`server.ts` 3684 行 / `qoder.ts` 2476 行 / `client.ts` 659 行），
每条都附可检索的代码锚点，若仓库继续前进请按锚点定位。
`buddy.ts` 全程未被改动；`qoder.ts` / `client.ts` / `server.ts` 的改动均来自上述三次修复。

## 先纠正任务书里与代码不符的几处事实

1. **`src/providers/workbuddy.ts` 已不存在**。它历史上存在过（`38be175` 时 201 行），
   后来并入 `src/providers/buddy.ts` —— 一个工厂 `buildBuddyProvider(config)` 产出两个变体：
   `buddyProvider`（国内 `copilot.tencent.com`）与 `workbuddyProvider`（国际 `www.workbuddy.ai`）。
   故「workbuddy 的 996 行」在任何快照里都对不上（我抽查了 `38be175` / `2f1fb48`）。
2. **`qoder.ts` 是 2463 行（审查末次提交后 2476），不是 874 行**（`2f1fb48` 时是 1429 行，也不是 874）。
3. **提交次数是 12 / 15，不是 35 / 27**。任务书可能统计了「含 workbuddy 字样的全部提交」或更早的仓库。
4. 任务书里**成立**的线索：`bindSession` 只在两处续期重试分支（见发现 1）；
   `isWafBlocked` 的 CJK 判据（见下）；`parseEnvelope` 双层嵌套与 `{"code":"110"}` 已修（不重复报）。
5. **「这两个 provider 的所有错误文案都含中文」不成立**，但**结论仍然安全**：
   我逐条核过 37 处 `new ProviderError`（buddy 4 / qoder 33），只有 `buddy.ts:196` 与 `buddy.ts:310`
   是**纯英文透传**（`message: error instanceof Error ? error.message : String(error)`）——
   但这两处**都没有传 `httpStatus`**（= 0），而 `isWafBlocked` 写死 `httpStatus !== 403 ⇒ false`，
   故不会误判成 WAF。qoder 的 33 处全部含 CJK。

---

## 发现清单

### [高] 1. 会话粘性**只在续期重试分支**建立，两条主成功路径一次都不绑（**审查期间已修**：`e3286da`）

- **状态**：审查开始时（`83a5b15`）成立；`e3286da` 已修 —— 修复后共四处 `bindSession`：
  `:1492`（分支A 主路径）、`:2270` / `:2528`（两条续期重试）、`:2824`（分支B 主路径）。
  并新增**结构断言**（`tests/state.test.ts`：每处 `noteSuccess` 之后 1500 字符内必须有
  `pool.bindSession(sessionKey`，附变异测试）。保留此条是为了记录坑，以及「弱断言为什么没抓住它」。
- **位置（当前）**：`:1492` / `:2270` / `:2528` / `:2824` 四处。**修复前**只有 `:2270` / `:2528` 两处
  （都在续期重试分支），主成功路径 `:1463`（分支A）与 `:2797`（分支B）无绑定。
- **证据（修复前）**：两处 `bindSession` 都落在 `streamResponse(retry.body, …)` 的 `onFirstChunk` 里 ——
  即「401 → `provider.refresh()` → 重放成功」那条路径：

  ```ts
  // server.ts:2260-2271（分支B 的续期重试分支）
  const settle = settleBlame(pool, blame, Date.now())
  ...
  if (sessionKey !== '' && ctx !== undefined) {
    ctx.waitUntil(pool.bindSession(sessionKey, picked.uid, Date.now()).catch(logPoolError('bindSession')))
  }
  ```

  而两条主成功路径的 `onFirstChunk` 只有 `noteSuccess` + `settleBlame`，没有 `bindSession`（修复前）：

  ```ts
  // server.ts:2801-2805（分支B 主成功路径，逐字）
  onFirstChunk: () => {
    const t = pool.noteSuccess(picked.uid, Date.now(), undefined, model).catch(logPoolError('noteSuccess'))
    if (ctx !== undefined) ctx.waitUntil(t)
    // → 直接接 settleBlame 的注释块，没有 bindSession
  ```

  `getSession` 的唯一写入者就是 `bindSession`（`AccountPoolDO.ts:988-992`），
  故**修复前**正常流量下 `server.ts:1099` / `:2173` 的 `preferred` **恒为 `''`**。
- **影响（修复前）**：**「会话粘性」这个功能对绝大多数请求等于不存在**，只有恰好触发过一次令牌续期的会话才粘住。
  后果有两层：① 同一 `sessionKey` 每轮被随机换号 ⇒ 上游 prompt cache 全失效（本模块注释承诺的「更快、更省」落空）；
  ② 换号会让 `X-Conversation-ID` 每轮都变（见发现 2 的连锁），而上游反作弊眼里「一个会话被拆成上千个一次性会话」
  正是 `src/upstream/conversation.ts:8-13` 明文点名的「最明显的非人类形态」。
- **建议**：已按「与 `noteSuccess` 并列」落地（`e3286da`）。仍建议进一步抽一个 `onSuccess(uid)` 回调
  让四条路径共用，避免第 5 次「只在一处生效」。
- **工作量**：S
- **置信度**：确定

### [高] 2. 换号时 `conversationId` **不重算**，同一段会话 id 会被发给多个账号

- **位置**：`src/gateway/server.ts:1030` + `:1168`（分支A）、`src/gateway/server.ts:2070` + `:2202`（分支B）
- **证据**：变量在**循环外**声明，循环内只在「为空」时算一次：

  ```ts
  // server.ts:2070（循环外）
  let providerConversationId = sessionKey === '' ? crypto.randomUUID() : ''
  // server.ts:2200-2204（循环内，第 N 轮）
  // ⚠️ 换号必须换会话 id（同一段会话发给两个账号就是跨账号关联键）
  if (providerConversationId === '') {
    providerConversationId = await deriveIntlConversationId(picked.uid, sessionKey)
  }
  ```

  注释写着「换号必须换 id」，但守卫是 `=== ''` —— 第 1 个账号赋值后它永不为空，
  第 2..N 个账号拿到的都是**由第 1 个账号 uid 派生**的 id。分支A 是同一份写法（`:1165-1170`）。
- **影响**：一次请求内换号（限流/5xx 很常见）就把同一个 `X-Conversation-ID` 打给两个账号 ——
  `conversation.ts:18-21` 明确写「那才是真正的关联键，上游立刻能把两个号串起来」。
  对 `workbuddy`（国际服会话头族是**必需头**，必然发出）影响最大；对 `qoder` 不发会话头，无影响。
- **建议**：改成每轮按 `picked.uid` 重新派生（`providerConversationId = await deriveIntlConversationId(picked.uid, sessionKey)`），
  只把 `turnRequestId` 保留在循环外（那个语义确实是「一轮内恒定」）。
- **工作量**：S
- **置信度**：确定

### [高] 3. `throttleUpstream` 只接在 provider 分支，**buddy 主分支完全没接**（**审查期间已修**：`e3286da`）

- **状态**：审查开始时（`83a5b15`）成立；`e3286da` 已在 buddy 的 `fetch` 前补
  `await throttleUpstream(candidate.uid)`（`:1189`）。修复后调用点：`:1189`（buddy）+ `:2226` / `:2248`（provider）。
- **位置（当前）**：`:1189`（buddy）+ `:2226` / `:2248`（provider）。**修复前**只有后两处，
  而 buddy 的 `fetch` 在 `:1190` 之前**没有任何节流调用**。
- **证据（修复前）**：`grep -rn "throttleUpstream" src/` 只有 `throttle.ts` 自身 + 上面两处；
  而路由在 `server.ts:951` 就分流了：

  ```ts
  // server.ts:951-952
  if (providerId !== DEFAULT_PROVIDER) {
    return await handleProviderChat({ providerId, model, ... })
  }
  ```

  `DEFAULT_PROVIDER = PROVIDERS[0]`（`providers/index.ts:65`）且 `PROVIDERS[0] = buddyProvider`（`:44`）。
  ⇒ 裸模型名（buddy 的常规用法）走分支A，**一次 `throttleUpstream` 都不会调**。
- **影响（修复前）**：面板「防封 → 每账号 QPS 上限 / 请求前随机抖动」（`gateway/safety.ts:115` → `configureThrottle`）
  对**默认供应商、绝大多数流量**静默失效，只有带前缀的 `workbuddy/…`、`qoder/…` 生效。
  这正是本项目反复出现的「开关只在一条路径生效」；而 buddy 是腾讯系，恰是最该节流的那家。
  （默认值 `RATE_LIMIT_QPS`/`RATE_JITTER_MS` 均为 0 = 关闭，故只有用户开启后才暴露。）
- **建议**：已按此落地（`e3286da`）。仍建议补一条「两条 chat 路径都必须调用 `throttleUpstream`」的**结构断言**
  —— 本次只给 `bindSession` 补了结构断言，`throttleUpstream` 仍无测试守卫。
- **工作量**：S
- **置信度**：确定

### [高] 4. qoder 排队耗尽抛 **503** ⇒ `classify` 判 `server` ⇒ **breaker 罚健康号**（比修复前更重）

- **状态（必读）**：**审查开始时（HEAD `83a5b15`）成立；审查过程中已被修复并提交（`b385b3d`，注释署 `M3`）**。
  三处同批落地：`qoder.ts:1539-1543` 文案带上 `{"code":10605}`、`client.ts:127-144` 登记 `10605: 'rate_limited'`、
  `server.ts:478-481` 让 `refineModelScoped` 认 10605 → `model`。我复测过新文案：
  `new queue 503 -> rate_limited code=10605`（旧文案仍是 `server`）。
  **保留此条是为了记录这个坑与「三处必须同批」**：只改文案不改 `CODE_KIND` ⇒ 仍落 `server`；
  只改 `CODE_KIND` 不改 `refineModelScoped` ⇒ 落 `soft`（账号级 60 秒）而不是 `model`。
- **位置**：`src/providers/qoder.ts:1523-1544`（`httpStatus: 503`）→ `src/upstream/client.ts:455-461`
  （5xx 且无信封 ⇒ `server`）→ `src/gateway/server.ts:303-305`（`server` ⇒ `breaker`）
  → `src/pool/AccountPoolDO.ts:1112-1119`（3 次 ⇒ 30 分钟起、指数翻倍）
- **证据**（用 esbuild 打包真实模块后跑出来的实测，非推断）：

  ```
  qoder 排队耗尽(503)   -> kind=server       code=undefined
  qoder 排队耗尽(旧403) -> kind=auth_error   code=undefined
  ```

  也就是说：同一段中文文案，`403` 落 `auth_error`（`mapErrorToPunishment` = `punish:false, rotate:true`），
  `503` 落 `server`（`punish:true, dimension:'breaker'`）。`qoder.ts:1503-1522` 的注释只推演到
  「503 不会被判成 WAF」，**漏了 5xx 会落 `server`=breaker** —— 而 CJK 判据（`client.ts:421`）
  早已让 403 不再是 WAF，所以这次改写实际把「不罚号」改成了「熔断」。
- **影响（修复前）**：排队是上游容量问题、账号完全健康。多账号池（≥2 个 qoder/qodercn）里，
  排队耗尽 → breaker 进 `blame`，后续换号成功 → `settleBlame` 落账（`server.ts:196-212`）；
  3 次就把健康号熔断 30 分钟。单账号池因为「全失败则丢弃 blame」暂时不罚 —— 这条**如实说明**，
  但它只是被另一条机制偶然挡住，不是设计。
- **建议（已按此落地）**：给「排队耗尽」一个**不罚号**的出口，别再借 5xx。最省事的是让 `ProviderError` 带上业务码
  `10605` 并把 `10605 → rate_limited` 登记进 `CODE_KIND`（`client.ts:122-212`），
  同时把它加进 `refineModelScoped` 的模型级判据（`server.ts:451-502`）；
  或新增 `upstream_busy` kind 显式映射 `{punish:false, rotate:true}`。
- **工作量**：S
- **置信度**：确定

### [中] 5. qoder 的 `110` 专用分支对**中文 message** 不可达（`looksLikeQoderBillingError` 字符串分支不解析 JSON）

- **位置**：`src/providers/qoder.ts:995-1009`（函数）、`:1560`（唯一调用点，传的是 `text` 字符串）
- **证据**：函数支持对象形态（`:1004` 认 `code === '110'` / `110`），但调用点只给字符串，
  而字符串分支只做关键词匹配、**从不 `JSON.parse`**：

  ```ts
  // qoder.ts:996-1001
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    return lower.includes('billing daily count exceeded') || lower.includes('daily count exceeded') || ...
  }
  ```

  实测：

  ```
  billing(110 英文 message) = true
  billing(110 中文 message) = false      // {"code":"110","message":"今日调用次数已达上限"}
  ```

- **影响**：上游若用中文 message（阿里系常见）或改了措辞，`110` 专用分支不触发 ⇒
  用户看到的是通用 `Qoder 推理失败：http=… {json}`，丢掉「这是日调用次数上限、**不是余额耗尽**」的解释
  与 `retryable:false`（这段解释是 2026-10-21 花了一次 10.3 小时误锁换来的，见 `client.ts:146-170`）。
  **分类本身不受影响**：`classify` 从 JSON 抠出 110 → `rate_limited` → `refineModelScoped` → `model`
  （实测 `qoder 403 110 -> rate_limited code=110`），故冷却维度仍然正确。
- **建议**：字符串分支先尝试 `JSON.parse` 再递归（与 `parseQoderQueueError:916-926` 同一套做法），
  让「字符串/对象」两个入口收敛成一条判据。
- **工作量**：S
- **置信度**：确定

### [中] 6. qoder 的两处「错误契约」**从未被消费**：`retryable` 与 `shouldRotate`

- **位置**：`src/providers/qoder.ts:2293-2299`（`shouldRotate`）、`qoder.ts:1482-1489` / `:1523-1544`（`retryable: true`）
- **证据**：
  ① `shouldRotate` 只在 `server.ts:2615` 的 `!upstream.ok` 分支被调用；而 `qoder.chat` 的所有失败路径
  都是 `throw`（`qoder.ts:1441`/`1476`/`1482`/`1523`/`1574`/`1588`/`1596`），唯一的 `return` 是 `:1446`
  的 200 流 ⇒ 该分支对 qoder **不可达**。
  ② `retryable` 全仓只有 `src/index.ts:737`、`:1010` 读 —— 而那是 **codearts / trae** 的登录流程，
  **buddy / qoder 的 chat 路径一次都不读**（网关只看 `classify()` 的 kind 与 `mapErrorToPunishment().rotate`）。
- **影响**：
  - `shouldRotate` 是 `110 / 429 / 402` 的**第二套判据**，与 `classify` 口径不同（它对 401 返回 false，
    而 `classify` 给 `auth_error`、`rotate:true`）。今天不执行，一旦有人把 `chat()` 改成返回 `Response`
    就静默换一套行为 —— 典型的「双判据埋雷」。
  - `retryable: true` 写在「首帧超时」上（注释承诺「换号或稍后重试确实有效」），但超时被 `classify(0, …)`
    判成 `unknown`（`punish:false, rotate:false`）⇒ **既不换号也不重试**，注释承诺落空。
- **建议**：二选一 —— 要么让 `ProviderError` 分支消费 `retryable`（`rotate = pm.rotate || pe.retryable`），
  要么删掉 `shouldRotate` 与这两处 `retryable`，只保留 `classify` 单一判据。
- **工作量**：S
- **置信度**：确定（不可达性）／待确认（是否打算将来消费）

### [中] 7. 同一账号在**两个端点呈现两个不同的设备 ID**；分支A 还算了三个从不使用的变量

- **位置**：`src/providers/buddy.ts:265-266` + `:270-279`（`listModels` → `cliChatHeaders`，`X-Machine-ID` = sha256 36 hex）
  vs `buddy.ts:327-337`（`chat` → `referenceChatHeaders` → `intlDeviceHeaders`，`X-Machine-ID` = UUID 形态）；
  死变量在 `src/gateway/server.ts:1173-1175`。
- **证据**：
  - `deriveDeviceId`（`headers.ts:383-391`）= `sha256(salt:uid)` 取前 18 字节 → **36 个 hex 字符**；
  - `deriveUuidLike`（`headers.ts:346-357`）= FNV-1a 四段 → **8-4-4-4-12 的 UUID**；
  - `intlDeviceHeaders`（`headers.ts:331-336`）在没传 `machineId` 时用后者，而 `buddy.ts:327-337`
    **从不传** `machineId`/`sessionId`。
  - 分支A 每次请求都算：
    ```ts
    // server.ts:1173-1175
    const machineId = await deriveDeviceId(candidate.uid, 'machine')
    const sessionId = await deriveDeviceId(candidate.uid, 'session')
    const conversationRequestId = crypto.randomUUID().replaceAll('-', '')
    ```
    这三个变量在后续 `referenceChatHeaders({ uid, accessToken, variant, conversationId, turnRequestId })`
    （`server.ts:1194-1203`）里**一个都没传**，全文再无第二次出现。
- **影响**：`workbuddy` 同一账号在 `/v3/config`（36-hex）与 `/v2/chat/completions`（UUID）上声称是两台不同设备 ——
  「同一 token 换设备」正是防封最忌的画像矛盾。分支A 的两个 `await crypto.subtle.digest` 是纯浪费（热路径）。
- **建议**：设备 ID 收敛到**一个派生函数 + 一个形态**（建议统一成 UUID 形态，因为它与官方桌面端抓包一致），
  `cliChatHeaders` 与 `intlDeviceHeaders` 共用；真实设备值优先从凭据 `extras` 透传；
  删掉 `server.ts:1173-1175` 三个死变量。
- **工作量**：M（改头有上游风险，需单变量实测）
- **置信度**：确定（两值不同）／待确认（上游是否跨端点比对）

### [中] 8. `buddy.chat` **没有首帧超时**（qoder 有），上游黑洞时请求无限挂起

- **位置**：`src/providers/buddy.ts:315-341`（`fetch` 只挂 `request.signal`）；
  对照 `src/providers/qoder.ts:1419-1427`（`INFER_TIMEOUT_MS = 30_000` 首帧超时 + `release()`）
- **证据**：`grep "AbortSignal.timeout" src/gateway/server.ts` 只有 refresh(30s)/listModels(20s)/balance(15s)，
  chat 路径**没有任何超时**；`buddy.ts` 的 `listModels` 有 20s（`:280`），`chat` 没有。
- **影响**：上游接受连接但不回首帧（TCP 黑洞 / 排队）时，请求会一直挂到**客户端自己断开**；
  buddy 是默认供应商，并发下会持续占住请求上下文，且用户侧看不到任何可读原因（只是「一直在跑」）。
  账号不会被误罚（没有 `classify` 参与），所以这是可用性问题而非正确性问题。
- **建议**：照 qoder 的做法加**首帧超时**，**不要**在 `fetch` 上挂 `AbortSignal.timeout` ——
  qoder 的注释（`qoder.ts:1273-1276`、`:1417-1418`）已记录过「挂 fetch 会把正在输出的长回答拦腰截断」这个坑。
- **工作量**：S
- **置信度**：确定（缺超时）／待确认（实际发生频率）

### [低] 9. `migrateBuddyProviderId` 是**第二份**迁移实现，且从未被调用

- **位置**：`src/providers/buddy.ts:518-523`；真正生效的是 `src/pool/AccountPoolDO.ts:491-519`（+ `:526-529` 的 `buddyIdMigrated` 标志）
- **证据**：`grep -rn "migrateBuddyProviderId"` 全仓只有 `buddy.ts` 自身与文件头注释（`buddy.ts:23`）；
  两份判据目前等价（`provider === 'workbuddy'` 且 `domain` 不含 `workbuddy.ai`）。
- **影响**：同一迁移两份实现、其中一份永不执行；而 `buddy.ts` 的文件头把读者**指向死的那份**，
  将来只改一处就会出现「注释说迁了、实际没迁」。
- **建议**：删掉 `buddy.ts` 的导出（或让 `AccountPoolDO` 复用它），并把文件头的指引改到 `AccountPoolDO.migrateBuddyIds`。
- **工作量**：S
- **置信度**：确定

---

## 错误映射对照表

### A. `buddy` / `workbuddy`（腾讯双变体）

> **前提**：这两家的 `chat()` **不包装 `ProviderError`**（`buddy.ts:315` 直接 `return await fetch(...)`），
> 所以 `httpStatus` 恒为**上游真实状态码**，业务码由 `classify()` 从原始响应体解析 ——
> 这一层没有「被包装成 502/403」的问题。下表是 esbuild 打包真实模块后的实测输出。

| 上游形态 | httpStatus | 业务码 | ProviderError 形态 | classify 判出 | 期望 | 是否一致 |
|---|---|---|---|---|---|---|
| `401` 无信封 | 401 | — | 不抛（原样返回 `Response`） | `auth_error` | 续期并重放一次 | ✅ |
| `403` 英文拦截页（无信封） | 403 | — | 同上 | `waf_blocked` | WAF + 软冷却 + IP 级判定 | ✅ |
| `400` `{"code":"11‑128"}`（U+2011） | 400 | `-108128` | 同上 | `channel_blocked` | 不罚号、不换号、直出原因 | ✅ |
| `403` `{"code":11140}` | 403 | 11140 | 同上 | `request_illegal` | `restricted` 2h + **不换号** | ⚠️ 与 `AGENTS.md §6.7`「Disable 账号」表述不同（代码有意放宽，注释已说明理由） |
| `429` `{"error":{"data":{"code":14018}}}` | 429 | 14018 | 同上 | `credit_exhausted` | 硬冷却到次日 04:00 | ✅（双层嵌套已修，实测命中） |
| `502` `{"code":11158}` | 502 | 11158 | 同上 | `model_denied` | (账号,模型) 负缓存 | ✅（已知码越过 5xx） |
| `200` SSE `{"code":6004}` | 200 | 6004 | 同上 | `rate_limited` | `model` 级冷却 | ✅ |
| `400` `{"code":11115}` | 400 | 11115 | 同上 | `context_exceeded` | 不罚号、不轮转 | ✅ |
| `12153` 会话死亡 | 任意 | 12153 | 同上 | `session_dead` | 连续 3 次才禁用 | ✅ |
| `403` **中文**错误页（非信封） | 403 | — | 同上 | `auth_error`（被 CJK 判据放过） | 不判 WAF | ✅（反向代价见「测试缺口 7」） |

### B. `qoder` / `qodercn`

> **前提**：加密端点在鉴权失败时也回 **HTTP 200**，错误装在第一帧
> （`{"body":"{\"code\":\"105\"…}","statusCodeValue":403}`）。
> `peekQoderFirstFrame` 窥探首帧、把 `statusCodeValue` 当作真实状态码（`qoder.ts:1333-1359`、`:1453`），
> 再按「排队 → 110 → 105 → 通用」四段分派。**业务码本身在 `ProviderError.message` 里被完整保留**
> （`qoder.ts:1579`/`:1592`/`:1601` 都带 `text.slice(...)`），`classify` 再从中文包装里抠 JSON。

| 上游形态 | httpStatus | 业务码 | ProviderError 形态 | classify 判出 | 期望 | 是否一致 |
|---|---|---|---|---|---|---|
| `200` 首帧 `{"code":"105"}` + `statusCodeValue:403` | 401（`qoder.ts:1590` 改写） | 105 | `ProviderError{401, "Qoder 登录态已过期（Login expired，需要续期）…"}` | `auth_error` | 续期并重放一次 | ✅（`isAuthLikeFailure` 认 `expired`） |
| `403` `{"code":"105"}` | 401 | 105 | 同上 | `auth_error` | 同上 | ✅ |
| `200` 首帧 `{"code":"10605"}`（预算内） | — | 10605 | 不抛，`sleep` 后重试（20s/次、4 次、60s 总预算） | — | 等待后重试 | ✅ |
| `10605` **预算耗尽** | **503**（`qoder.ts:1525`） | 10605 | `ProviderError{503, "Qoder 服务繁忙：…上游业务码：{\"code\":10605}…"}` | `rate_limited` → `model`（**修复前**是 `server`） | 不罚号、只冷该模型 | ✅（审查期间已修，见发现 4） |
| `403` `{"code":"110"}`（英文 message） | 403 | 110 | `ProviderError{403, "Qoder 返回业务码 110（403）：…"}` | `rate_limited` → `model` | 只冷该模型 | ✅ |
| `403` `{"code":"110"}`（中文 message） | 403 | 110 | 落到**通用**分支 `"Qoder 推理失败：http=403 …"` | `rate_limited`（从 JSON 抠出 110）→ `model` | 只冷该模型 + 诚实文案 | ⚠️ 分类对、**文案降级**（见发现 5） |
| `403` `{"code":"99999"}` 未知码 | 403 | 99999 | `ProviderError{403, "Qoder 推理失败…"}` | `auth_error` | 未知业务码应如实上报 | ⚠️ 会引导用户「重新登录」，待确认 |
| 首帧超时（30s 无响应） | **0** | — | `ProviderError{0, retryable:true, "Qoder 单次请求超过 30 秒…"}` | `unknown` | 换号重试 | ⚠️ `retryable` 无人消费 ⇒ 不换号（见发现 6） |
| `5xx` 无信封 | 502 | — | `ProviderError{502, …}` | `server` | 喂熔断 | ✅ |
| `500` 读体超时（非流式） | 502 | — | `ProviderError{502, "…读体失败…"}` | `server` | 上游问题，可重试 | ✅ |

---

## 凭据生命周期表

| 阶段 | 入口 | 失败如何分类 | 是否罚号 | 是否正确 |
|---|---|---|---|---|
| buddy/workbuddy 设备码登录 | `src/upstream/auth.ts:129-197`（`pollLogin`） | 业务码非 0 / 网络抖动 ⇒ 返回 `undefined`（**继续轮询**）；只有「拿到 token 却拿不到 uid」才抛 `LoginError` | 否（账号尚未入池） | ✅ |
| buddy 续期（网关被动，401/403） | `server.ts:2217` / `:2475` → `buddy.ts:394-413` | 失败进 `catch`（`server.ts:2585-2598`）→ 只记 `refreshFailure`，**随后仍按原错误分类**（`auth_error` = `punish:false`） | **否** | ✅（原因会附给用户） |
| buddy 续期（cron 主动） | `src/index.ts:4432-4455` | 逐账号 `try`，失败只记日志 | 否 | ✅ |
| buddy 续期：上游不返新 `refresh_token` | `buddy.ts:409` | 保留旧值 | — | ✅（否则下一次必失败） |
| qoder 105（首帧或裸 403） | `qoder.ts:1587-1594` → 401 | `auth_error` → 网关续期一次 | 否 | ✅（实测用例 `tests/qoder-chat.test.ts:138`） |
| qoder 续期 | `qoder.ts:2039-2152` | 401/403/200-无令牌 = 终态；网络/5xx/429 = `retryable` | 否（网关 `catch` 里只记原因） | ✅ |
| qoder 续期：缺 `machine_id` | `qoder.ts:2054-2059` | 显式报「请重新走设备码登录」，**不编造随机值** | 否 | ✅ |
| qoder 排队耗尽 | `qoder.ts:1523` | `rate_limited` → `model`（**修复前** `server`） | 否（只冷该模型） | ✅（审查期间已修，见发现 4） |
| qoder 110（日次数上限） | `qoder.ts:1573` / `classify` | `rate_limited` → `model` | 否（只冷模型） | ✅（但文案有断点，见发现 5） |
| 12153 `session_dead`（buddy） | `classify` → `AccountPoolDO.ts:1129-1139` | 连续 3 次才 `disabled` | 是（第 3 次起） | ✅ 与文档一致 |
| **续期成功后的凭据缓存** | `AccountPoolDO.ts:1528-1533` | `putCredential` **先写内存缓存再落盘** | — | ✅ 旧 token 不会继续被 `getCredential`（`:1543-1544`）取到 |
| 主动续期提前量 | `src/index.ts:4266`、`:4432` | 距过期 < 1h 就刷新（`expiresAt===0` 视为未知、跳过） | 否 | ✅ |

---

## 本模块亮点

1. **`parseEnvelope` 的多形态识别已经正确**（`client.ts:215-388`）。实测：`error.data.code` 双层（14018）、
   `{"code":"110"}` 带引号、`body` 字符串内嵌（qoder 105）、`11‑128` 的 **U+2011 / U+2010 / ASCII** 三种连字符
   全部命中，`-108128` 归一值不会与真实业务码冲突。
2. **`isWafBlocked` 的 CJK 加固是有效的**（`client.ts:421`）。37 处 `ProviderError` 逐条核过：
   qoder 33/33 含 CJK；buddy 仅 2 处纯英文透传，但都不带 `httpStatus`（=0），不满足 403 前提。
3. **qoder 的首帧窥探 + 105→401 链路是完整闭环**：`peekQoderFirstFrame`（`qoder.ts:1302-1391`）
   读首帧判错、`reader.cancel()` 主动断开（上游发完错误帧不关流），正常帧则 `replay()` **一个字节不丢**；
   `tests/qoder-chat.test.ts:107-162` 用分片到达 + 不关流的真实形态钉住了它。
4. **`unwrapQoderEnvelopeStream` 保真转发错误帧**（`qoder.ts:1065-1090`）：`code` 独立、`message` 原样、
   另加 `type`，不像参考实现那样降级重组（那会丢 `code` 并污染内层 JSON）。
5. **排队三常量自洽**（`qoder.ts:1122/1132/1157`）：4 × 20s = 80s > 60s 预算 ⇒ **预算先触发**，
   语义正确；`sleep` 监听 `signal`，客户端取消能立刻退出（`qoder.ts:1173-1189`）。
6. **`withSystemFirst` 只在缺失时补**（`buddy.ts:122-158`）：尊重用户自己的 system，空内容也补，
   且明确区分 `system`/`developer` —— 这正是国际版 11‑128 的正确解法。
7. **`intlDeviceHeaders` 按账号稳定派生**（`headers.ts:323-338`）：同账号恒定、跨账号不撞，
   避免「整池共用一台设备」（比不发更糟）；b3 `traceId` 由 `conversationId` 稳定派生、`spanId` 随机，
   符合 Zipkin 语义。
8. **qoder 110 的语义纠正记录得很完整**（`client.ts:146-170` + `qoder.ts:1553-1572`）：
   把「额度耗尽」改判为「日次数上限」，并保留「映射到最重处置代价远大于收益」的教训。
9. **零输出越墙在两条路径都接了**（`server.ts:1417`、`:2746`），罚 `model` 维度而非 `breaker`，
   并双写日志（`console.warn` + `recordLog`）—— 与 buddy 口径一致，无「只接一处」。
10. **`e3286da` 新增的结构断言值得当范式**（`tests/state.test.ts`）：不是数调用次数，而是断言
    「每处 `noteSuccess` 之后 1500 字符内必须有 `pool.bindSession(sessionKey`」，并做了**变异测试**
    验证它真的会失败。这正好补上了发现 1 当年被弱断言（`tests/gateway.test.ts:725-736` 的 `binds >= 2`）
    掩盖的那个洞 —— 旧的计数断言仍在，但已被更强的结构断言覆盖。

---

## 测试缺口

1. **排队只有 classify 级用例，没有「生产者 + 罚号链路」的用例**：`b385b3d` 新增的
   `tests/classify.test.ts:320-338` 钉住了「503 + `{"code":10605}` ⇒ `rate_limited` + `model`」，这很好；
   但它把**文案硬编码在测试里**，所以：① 若有人改回 `qoder.ts` 的文案（删掉 `{"code":10605}`），
   这条测试**照样通过**，回归无人拦截；② `qoder.chat()` 的排队循环（20s/4 次/60s 预算、超预算才抛）
   没有任何用例；③ 网关的罚号分支（`ProviderError` → `blame` / `applyFailure`）没有集成用例。
   建议补一条「从 `qoder.ts` 源码里取文案」的断言（`tests/providers.test.ts` 已有这种源码断言的先例）。
2. **`retryable` 被测试「钉住存在」却无人消费**：`tests/providers.test.ts:852` 断言 `retryable: true` 字面量存在，
   等于把发现 6 的死字段固化成了「预期行为」。
3. **无「换号后 `conversationId` 必须变」的用例**（`tests/intl-headers.test.ts` / `session-trace.test.ts`
   只测单次生成，不测轮换）。
4. **无「两条 chat 路径都调用 `throttleUpstream`」的结构断言**：`e3286da` 只给 `bindSession` 补了结构断言
   （`tests/state.test.ts` 的 `noteSuccess` → `bindSession` 窗口检查），节流仍只靠人肉审查 ——
   本次发现 3 正是这样漏了整整一个分支。
5. **无 `buddy.chat` 首帧超时的用例**（qoder 有 `tests/qoder-chat.test.ts:107`，buddy 没有对应物）。
6. **110 的用例只覆盖英文 message**（`tests/qoder-chat.test.ts` 无 110 断言）——
   发现 5 的中文 message 断点没有测试。
7. **没有「中文 WAF 拦截页」的用例**。CJK 判据（`client.ts:421`）是**双向**的：
   它救了我们自己的中文错误文案，但也意味着「上游若回中文拦截页」会被判成 `auth_error`
   （既不触发 IP 级闸门 `noteWaf`，又会白白续期一次）。目前没有证据表明 EdgeOne/APISIX 会回中文页
   （**待确认**），但这条反向代价没有任何测试钉住。
---

### 附：本次审查用到的一次性验证手段

用仓库自带的 esbuild（`node_modules/.bin/esbuild`）把 `src/upstream/client.ts` 与
`src/providers/qoder.ts` 打包到 `/tmp/pr-a/*.mjs` 后直接调用 `classify` / `parseEnvelope` /
`isWafBlocked` / `parseQoderQueueError` / `looksLikeQoderBillingError` 跑真实入参，
**未修改仓库内任何文件**。上面所有「实测」结论都来自这段可复现的调用，而不是读代码推断。
