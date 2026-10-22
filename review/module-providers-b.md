# providers-b 模块审查

审查对象（**只读，未修改任何源码**）。基线：`HEAD=e3286da`（`fix(gateway): 防封节奏与会话粘性「只在一处生效」`），
审查期间工作区干净（仅 `review/module-providers-a.md` 未跟踪），无并发提交。

## 先纠正任务书里与代码不符的四点

| 任务书写 | 实际 | 说明 |
|---|---|---|
| `cline.ts` 755 行 | **1662 行** | |
| `minimax.ts` 683 行 | **1839 行** | |
| `opencode.ts` 655 行 | **888 行** | |
| `trae.ts` 229 行 | **2524 行** | |
| `qwen-code.ts` 400 行 | **该文件不存在，从未存在过** | `git log --all -- src/providers/qwen-code.ts` 为空；`src/providers/` 无 qwen 专属供应商（qwen 只作为 **模型名** 出现在 `lobsterai` / `meoo` / `opencode` / `trae` / `qoder` 的目录里）。故本模块实际是 **4 家**，不是 5 家 |

**另外两处事实性纠正**（直接影响是否要报缺陷）：

1. **「`ProviderError` 有两个字段从未被网关消费：`retryable` / `shouldRotate`」——只有前半句成立，后半句不成立**。
   `ProviderError` 上**根本没有 `shouldRotate` 字段**（`src/providers/types.ts:278-295` 只有 `provider` / `httpStatus` / `retryable`）。
   `shouldRotate` 是 `Provider` 接口上的一个**方法**（`types.ts:274`），与 `ProviderError` 无关。两者是不同概念，混在一起会误判。
   另外 `retryable` **并非全死**：`src/index.ts:737`（codearts 登录轮询）与 `src/index.ts:1010`（trae 登录回调）在读它。
   死的是**对话路径**上的消费（见发现 3）。
2. **「`opencode` 是『返回非 2xx Response』而不是抛异常的那家（风格不同）」——不成立，是两家**。
   `trae.chat()` 同样返回上游 `Response`（`src/providers/trae.ts:1083`：`if (!upstream.ok || upstream.body === null) return upstream`）。
   这条线索的真正价值在于：**两条风格走的是网关里两套完全不同的罚/换号逻辑**，而 `trae` 恰好站在了缺陷更多的那一套上（发现 1）。

---

## 发现清单

### [严重] 1. 非 2xx `Response` 路径把 `classify()` 的结论丢掉了：除 402/429 外**一律判 `breaker`**（`opencode` / `trae` 全中）

- **位置**：`src/gateway/server.ts:2611-2660`（消费端）；受影响的生产者：`src/providers/trae.ts:1083`、`src/providers/opencode.ts:815`。
- **证据**：这段注释自称「先按响应体分类，再决定怎么罚」，但分类结果只被用在一个 kind 上：

  ```ts
  // server.ts:2611
  const classified = classify(upstream.status, text)
  const isChannelBlocked = classified.kind === 'channel_blocked'   // ← 唯一的用途
  const rotate = isChannelBlocked ? false : (provider.shouldRotate?.(…) ?? …)
  …
  // server.ts:2635  只有 429 才把 refine 的维度当真
  const refined = refineModelScoped(upstream.status === 429 ? 'rate_limited' : 'unknown', text)
  …
  // server.ts:2650-2656  ← 判决表
  const failureKind: 'soft' | 'hard' | 'model' | 'breaker' =
    upstream.status === 402 ? 'hard'
      : upstream.status === 429 ? refined.dimension
        : 'breaker'
  ```

  即：**除 402 / 429 之外的所有状态码，一律 `breaker`**（`classified.kind` 是 `auth_error` / `server` / `unknown` / `credit_exhausted` 都不影响结论）。
  而 `breaker` 是 `fails++ ≥ 3 → 熔断 30 分钟，且按 `2^retryCount` 递增到 6 小时`（`src/pool/AccountPoolDO.ts:1113-1120`）。

  具体命中场景（都能从代码推出来）：
  - `opencode`：`classifyOpencodeError` 明写「额度错误可能带 400/401/403/429 任一状态码」（`opencode.ts:678-682`）。
    其中 `FreeUsageLimitError` + **HTTP 400** ⇒ `failureKind='breaker'` ⇒ 三次免费额度用尽就把**健康账号**锁 30 分钟起。
    `FreeTierError`（403）同理。
  - `opencode` 401（key 写错/被撤销）：`isAuthLikeFailure` 先试续期，但 opencode **没有 `refresh` 方法**（`opencode.ts:818-884` 未实现），
    于是直接落到 `breaker` ⇒ **明明只是 key 错了，却按账号故障熔断**。
  - `trae`：1005（Plan 权益不足）/ 4008（积分耗尽）/ 4001（通道不匹配）都以 **HTTP 400 + 流内/体内容业务码** 下发
    （`trae.ts:1031-1045` 的三条 hint 就是这三类），全部 ⇒ `breaker`。
- **影响**：与 HEAD 刚刚修掉的 `b385b3d`（qoder 10605 排队被判 breaker）**是同一类缺陷，只是修在了另一条路径上**。
  对单账号 provider（一个 trae 账号 / 一个 opencode key）等价于「一次模型不匹配 → 30 分钟后整个 provider 不可用 → 再犯 1 小时 → 2 小时」。
  而且过程**静默**：用户只看到 `4001 参数无效`，看不到账号正在被熔断。
- **建议**：把 `failureKind` 的默认支路换成 `mapErrorToPunishment(classified.kind).dimension`，并像 ProviderError 分支那样调用
  `refineModelScoped(classified.kind, text)`；`auth_error` 必须走「不罚号 + 换号」而不是 breaker。
  最小改动：`const kind = classified.kind; const mapped = mapErrorToPunishment(kind)` 之后 `failureKind = mapped.punish ? mapped.dimension : …`。
  **同步加一条结构断言**：`failureKind` 的三种以上取值不得只由状态码决定（本仓库对 `bindSession` 就是这么防回归的）。
- **工作量**：M（半天，含两条路径对齐 + 回归测试）
- **置信度**：确定（代码路径闭合；上游状态码分布属实测范畴，但 400/401/403 的存在已由 `opencode.ts:678-682` 的注释自证）

### [高] 2. `cline` / `minimax` 的 `shouldRotate` 是**死路径**——它们精心写的换号判据 100% 不生效

- **位置**：`src/providers/cline.ts:991-997`（实现）→ `src/providers/cline.ts:1661`（挂到 Provider）；
  `src/providers/minimax.ts:1816-1822`；唯一消费点 `src/gateway/server.ts:2615`。
- **证据**：`provider.shouldRotate?.(…)` 全仓**只出现一次**，在 `server.ts:2615` 的 `if (!upstream.ok)` 分支里。
  而 cline / minimax 的 `chat()` 在非 2xx 时**抛异常**（`cline.ts:950-958`、`minimax.ts:1329-1336`），永远走不到那个分支。
  ⇒ 两家挂上去的 `shouldRotate` 是**不可达代码**，`minimax` 的 `CREDIT_MARKERS` 也随之成为不可达常量（`minimax.ts:1825-1838`，唯一读点 1820）。

  cline 那份判据写了三条**网关并不知道**的领域知识，全部白写：

  ```ts
  // cline.ts:991-997
  function shouldRotate(status: number, bodyText: string): boolean {
    if (status === 401) return true
    if (status === 403) return !isRegionForbidden(bodyText)   // ← 地域封锁：换号无用
    if (status === 429 || status === 402) return true
    return CREDIT_MARKERS.some((marker) => lower.includes(marker))
  }
  ```

- **影响**（两条实测可推的后果）：
  1. **cline 403 地域封锁 ⇒ 整池轮转**。实际判决走 `classify(403, msg)`：因为 message 是中文（`Cline 对话失败（http=403）：…`），
     `isWafBlocked` 的 CJK 判据（`src/upstream/client.ts:415`）会把它排除出 WAF，落到 `auth_error`
     ⇒ `mapErrorToPunishment('auth_error')` = `{punish:false, rotate:true}`（`server.ts:308-309`）
     ⇒ **同一请求内把所有账号挨个撞一遍地域墙**，正是本仓库别处反复警告的「放大风控」。
  2. **cline 5xx ⇒ 熔断健康号**。`classify(5xx)` = `server` ⇒ `{punish:true, dimension:'breaker', rotate:true}`（`server.ts:305-306`）。
     而 cline 自己的注释明写「5xx 是所有账号共用的服务端问题，换号无用」——**判断被丢弃，且反向执行**。
     注：`httpStatus` 由 provider 如实传出（`cline.ts:954` `httpStatus: res.status`），所以这不是状态码丢失，是**判据没接上**。
- **建议**：二选一，别两边都留 ——
  (a) **在 `chat()` 里对可判定的 4xx 不改风格**，而是把领域判据通过**错误消息**或**新字段**传给网关（见发现 3 建议）；
  (b) 更彻底：让网关的 ProviderError 分支在 `classify()` 之后，**再给 provider 一次机会**：
  `const providerSays = provider.shouldRotate?.(peStatus, message)`，非 `undefined` 时覆盖 `pm.rotate`。
  后者改动小、且立刻让三家（cline/minimax/trae）现存的判据全部生效。
- **工作量**：S（<1h，改动 ≤10 行 + 一条断言）；若要重排错误契约则 M
- **置信度**：确定

### [高] 3. `ProviderError.retryable` 在**对话路径**无人消费，且与网关实际判决**口径不一致**

- **位置**：声明 `src/providers/types.ts:278-295`；生产 `cline.ts:956` / `minimax.ts:1335` / `trae.ts:1080`；消费 `src/index.ts:737`、`src/index.ts:1010`（**仅登录轮询**）。
- **证据**：对话路径的判决完全由 `classify()` + `mapErrorToPunishment()` 重新算出（`server.ts:2323-2500`），
  从头到尾没有读过 `error.retryable`：

  ```ts
  // server.ts:2347  ← 只取 httpStatus，刻意没有取 retryable
  const pe = error as { name?: string; httpStatus?: number; code?: unknown }
  ```

  于是同一个概念存在**两套独立判据**，且两套的口径已经分叉：

  | provider | `retryable` 的算法（provider 侧） | 网关实际用的 `pm.rotate`（按 `classify` 的 kind） |
  |---|---|---|
  | cline | 401 / 429 / 402 / 文案含 credit；**403 视地域而定；5xx 恒 false** | `auth_error`→rotate、`rate_limited`→rotate、`server`→rotate（**与 provider 相反**） |
  | minimax | **只看状态码** `429 || 402`（`minimax.ts:1335`） | 同上；另外 minimax 自己的 `shouldRotate` 还多认一整套中英文文案（`minimax.ts:1816`）——**同一家三个口径** |
  | trae | 网络层恒 `true`（`trae.ts:1080`）；非 2xx 不走这里 | `shouldRotate(400/401/402/403/429)`（`trae.ts:2521`） |
  | opencode | 从不抛错 ⇒ 恒不产生 | `shouldRotateForKind`（`opencode.ts:880`） |

  minimax 一家就有三套：`retryable`（状态码）、`shouldRotate` 方法（状态码+文案）、网关 `classify`（业务码+文案）。
- **影响**：provider 侧写下的判据，写对了也不生效、写错了也不会被抓到——**典型的「逻辑对但只在一处生效」**。
  本仓库已经因为同类问题复发过（`AGENTS.md` 记录了 4 次「记录点在 A 路径、故障发生在 B 路径」）。
  目前没有造成线上故障，只因为网关那张表恰好把 429/402 判对了。
- **建议**：把 `retryable` 的语义收敛成**单一来源**：要么删掉字段（承认网关的表是唯一判据，并把 `shouldRotate` 方法一起删掉 ——
  它现在也基本是死的，见发现 2），要么在 `server.ts:2347` 之后加一句
  `const pm = mapErrorToPunishment(c.kind); const rotate = pe.retryable ?? pm.rotate`。
  **不要两个都留**：那正是下一轮漂移的起点。
- **工作量**：S（<1h，接线或删除，二选一）
- **置信度**：确定

### [中] 4. 错误消息在 provider 层被「人性化」重写 ⇒ 机器可读的业务码在到达 `classify()` 前就已丢失

- **位置**：`src/providers/cline.ts:963-989`（`detailOf`）、`src/providers/minimax.ts:1376-1396`（`anthropicErrorText`）；消费端 `src/gateway/server.ts:2323`。
- **证据**：网关把 `ProviderError` 的**整条 message 字符串**当作 `classify()` 的 `bodyText`：

  ```ts
  // server.ts:2323
  const c = classify(peStatus, message)
  ```

  而两家的 message 是**只剩人类可读短语**的重构串：
  - cline：`Cline 对话失败（http=429）：` + `detailOf(text)`，而 `detailOf` 只从 `error` / `message` / `msg` / `detail` 里取**字符串**
    （`cline.ts:966-985`）——上游信封里的 `{"code":…}` 结构在进入 message 前就被拆掉了。
  - minimax：`MiniMax 对话失败（http=400）：` + `anthropicErrorText(text)`，后者返回 `"${type}: ${message}"`
    （`minimax.ts:1385-1393`）——业务码 2013 只以 `(2013)` 的形式**嵌在自然语言里**，
    而 `parseBusinessCode` 的正则是 `/"code"\s*:\s*"?(\d+)"?/`（`server.ts:521-527`），匹配不到 `(2013)`。

  ⇒ `refineModelScoped` 的模型级细分（6004 / 14003 / 11134 / **110** / **10605**，`server.ts:487-489`）对 cline / minimax **永远不触发**。
- **影响**：这两家一旦出现「模型级限流」，只能落到状态码兜底：
  400 → `unknown` → 不罚不换（快）；429 → `soft`（账号级，锁整个账号）。
  即 HEAD 刚补的 10605 模型级判据**在 cline / minimax 上不可能生效**——修的位置对，但输入被上游层吃掉了。
- **建议**：`ProviderError` 增加**可选的结构化字段**（`businessCode?: number` + `upstreamBody?: string`），
  `classify()` 优先用它；或最低成本：message 里**保留原始 body 片段**（例如 `…：（http=400）{"type":"error",…(2013)}`），
  让现有正则能命中。前者干净，后者一行。
- **工作量**：M（前者半天）/ S（后者 <1h）
- **置信度**：确定（码必然丢失）。**待确认**：cline 上游是否真的下发数字业务码（我没有该家的真实错误样本，
  只有 `cline.ts` 自己的注释提到 `failover`/`channel` 之类的文案）；minimax 那条有 `(2013)` 实证。

### [中] 5. `trae`：模型 → 通道映射表**只在 `listModels` 里填充**，`chat()` 的兜底是写死的 `solo_work_lite`

- **位置**：`src/providers/trae.ts:1057`（读）、`:1101`（表）、`:1171`（唯一的写点）、`:128`（兜底常量）。
- **证据**：

  ```ts
  // trae.ts:1057
  const channel = cachedModelChannels.get(request.model) ?? TRAE_FUNCTION   // TRAE_FUNCTION = 'solo_work_lite'
  ```

  `cachedModelChannels` 的**唯一写点**在 `listModels()` 内（`:1171`）；而 `listModels` 的失败分支 `fallbackModels()`（`:1183`、`:1197`）
  **不填这张表**。同一文件自己写着：

  > 「⚠️ **同一模型只在列出它的通道里可调用**：实测 `glm-5.1` 在 `solo_agent_remote` 正常出流、在 `solo_work_lite` 回 `4001`」（`:150-152`）

- **影响**：只要「进程起来后第一次对话请求先于一次成功的 `/v1/models`」，**所有模型都会用 `solo_work_lite` 发**，
  凡不属于该通道的模型一律 `4001`（参数无效）。而 `4001` 到达网关时是流内错误 ⇒ `classify(200, text)` = `unknown`
  ⇒ 不罚不换（`server.ts:308-312`），于是**不会被熔断掩盖，但也不会自愈**：用户只能看到一串「参数无效」，
  直到某次 `/v1/models` 把表填上。容器重启后每个新进程都会经历这个窗口。
- **建议**：把 `FALLBACK_MODELS` 里的 id 也映射到通道（`fallbackModels()` 里顺手 `cachedModelChannels.set(id, TRAE_FUNCTION)` 是不够的——
  需要为每个兜底 id 标注它实际所属通道）；或更稳：`chat()` 在表未命中时**同步等一次** `listModels`（有 30 分钟缓存，代价可接受）。
- **工作量**：S（<1h）
- **置信度**：代码路径确定。**待确认**：实际命中率（取决于调用方是否总先拉目录——DSH 客户端会，裸 `curl` 不会）

### [中] 6. 四家的 `chat()` 都**没有首帧/空闲超时**（其它端点都有）

- **位置**：`cline.ts:939`、`minimax.ts:1322`、`trae.ts:1067`、`opencode.ts:809`。
- **证据**：四处 `fetch(...)` 的 `signal` 都只传了 `request.signal`，没有 `AbortSignal.timeout` / `AbortSignal.any`。
  同文件里**其它**端点都加了：`cline.ts:858/876/1070/1188`、`minimax.ts:871/1413/1475/1583`、`trae.ts:1147/1439/2227`。
  网关侧也没有补：`server.ts` 里 `AbortSignal.timeout` 只出现在 `provider.refresh`（`:2245`、`:2503`）与模型/余额端点（`:3557`、`:3666`）。
- **影响**：上游接受 TCP 连接但永不发首帧时，请求会挂到**客户端自己断开**为止（DSH 侧是分钟级）。
  与任务书给的 `buddy.chat` 已知线索**同型**，且这是 4/4 家全中，不是个例。
  ⚠️ 不要加「整轮超时」（长回答会被掐断，本仓库有过误杀长任务的教训）；要加的是**首帧超时**（收到第一帧即解除）。
- **建议**：网关统一包一层 `raceWithFirstFrameTimeout(provider.chat(...), 45_000)`——一处修四家，
  也和零输出预检（`server.ts:2745`）共用同一次「首帧前」窗口。
- **工作量**：M（半天，含流式解除逻辑与测试）
- **置信度**：确定（无超时是代码事实）。阈值需实测，标 45s 仅为建议

### [中] 7. `opencode`：注入的免费通道门禁工具，在「用户自带工具」时**变成可调用**（`tool_choice` 没钉住）

- **位置**：`src/providers/opencode.ts:622-647`。
- **证据**：

  ```ts
  const missing = FREE_LANE_GATE_TOOLS.filter((name) => !names.has(name))
  if (missing.length === 0) return payload
  return {
    ...payload,
    tools: [...tools, ...missing.map((name) => gateTool(name))],
    ...(tools.length === 0 ? { tool_choice: 'none' } : {}),   // ← 只在「原本没有工具」时钉死
  }
  ```

- **影响**：调用方声明了 3 个工具、其中没有 `bash`/`read` 时，请求体里会凭空多出两个**可被模型调用**的工具。
  模型若真的调 `bash`，调用方收到一个自己从未声明的工具名（DSH 侧会报未知工具）。
  该函数的注释解释了「为什么必须注入」（不变的话匿名通道 403 `FreeTierError`），也解释了「为什么不覆盖用户的 `tool_choice`」，
  但**没有处理「注入后它们可被调用」这一格**。
- **建议**：注入时给门禁工具加 `tool_choice` 的等价约束不可行（OpenAI 无 per-tool 禁用），
  可行做法是**只在匿名槽（`api_key === 'public'`）注入**，认证槽不注入；或注入后由网关在出站流里把 name ∈ {bash,read} 且非用户声明过的 `tool_call` 丢弃。
  最小成本：保存 `originalToolNames`，在响应侧过滤。
- **工作量**：S（<1h，过滤）/ M（分槽注入）
- **置信度**：代码事实确定。**待确认**：模型实际被诱导调用这两个桩工具的概率（描述写的是 `Reserved for the host runtime; do not call it.`，实测未观察到）

### [低] 8. 网关对 `ProviderError` 的类型断言里有个**不存在的 `code` 字段**

- **位置**：`src/gateway/server.ts:2347`。
- **证据**：`const pe = error as { name?: string; httpStatus?: number; code?: unknown }` —
  `ProviderError` 类（`types.ts:278-295`）没有 `code`；全仓 5 家 provider 的 30+ 处 `new ProviderError` 也没有任何一处传 `code`
  （TS 的对象字面量超额属性检查也会拦住）；断言后**从未读取** `pe.code`。
- **影响**：读代码的人会以为「业务码已被 provider 带出」，从而在排查时找错方向；也掩盖了发现 4 的真实原因（码在 message 里，不在字段里）。
- **建议**：删掉 `code?: unknown`，或按发现 4 的建议**真正加上** `businessCode` 字段并接进 `classify()`。
- **工作量**：S（<10 分钟）
- **置信度**：确定

### [低] 9. JWT 辅助函数在 `cline` / `minimax` 之间**逐字重复**（当前一致，无共享）

- **位置**：`src/providers/cline.ts:281-338`（`base64UrlToText` / `decodeJwtClaims` / `stableKeyOf`）
  与 `src/providers/minimax.ts:286-322` + `:739-752`。
- **证据**：三段实现体逐字相同，只有 `stableKeyOf` 的前缀不同（`cline-` / `minimax-`）。
  `exp` 的用法也一致：`expiresAt ?? parseClineTimestamp(jwtExp)`（`cline.ts:598`）/ `expiresAt ?? parseTimestamp(jwtExp)`（`minimax.ts:720`），
  两个 `parse*Timestamp` 也几乎是同一函数（`:259-279` vs `:268-284`）。
  唯一刻意的差异是 cline 先剥 `workos:` 前缀再解（`cline.ts:568`），minimax 直接解（`minimax.ts:709`，其注释说明 `mmoat_` 令牌不是 JWT）。
- **影响**：**当前没有行为缺陷**（口径一致）。风险在于这是本仓库已复发多次的「两份实现改一处漏一处」结构；
  且 `expiresAt` 目前**只被面板展示用**（全仓没有一处按 `expiresAt` 提前续期：`src/pool/AccountPoolDO.ts:1590` 是唯一读点，用于状态展示），
  续期完全是 401 触发的被动式。
- **建议**：抽 `src/upstream/jwt.ts` 共享（三家含 zcode 都用得上，`zcode.ts` 有同名函数）。
  **不要**为了「提前续期」而引入主动刷新——轮换型 refresh token（本仓库已知：raccoon / codearts / trae / **cline 的一次性轮换**）下，
  主动续期与失败重试叠加会加速消耗令牌。
- **工作量**：S（<1h）
- **置信度**：确定

---

## 错误契约消费表

> 说明：`code` 列指 `ProviderError` 上的**结构化业务码字段**（非 message 文本）。

| provider | httpStatus 是否如实 | code 是否带出 | retryable | shouldRotate | 网关是否消费 |
|---|---|---|---|---|---|
| `cline` | ✅ 如实（`cline.ts:954` 等 8 处全是 `res.status`） | ❌ 字段不存在（`types.ts` 无此字段）；业务码在 message 里被 `detailOf` 拆掉 | 传了（`:956`），**对话路径无人读**；仅登录判定会读 | ❌ 死路径（`chat` 抛异常，走不到 `server.ts:2615`） | 部分：`httpStatus` → `classify()`；`retryable` / `shouldRotate` **都不消费** |
| `minimax` | ✅ 如实（`minimax.ts:1333` 是 `res.status`）；⚠️ `balance`/`checkin` 传的是 `result.code`（`:1654`/`:1732`，命名混淆但语义是该端点的 HTTP 码） | ❌ 同上；`(2013)` 之类只以自然语言出现 | 传了（`:1335`，**只看 429/402**），与自家 `shouldRotate` 的口径不一致，**均无人读** | ❌ 死路径（`:1816`） | 部分：仅 `httpStatus` |
| `opencode` | ✅ 如实（不抛错，上游 `Response` 原样返回，`opencode.ts:815`） | ➖ 不适用 | ➖ 从不产生（不抛 `ProviderError`） | ✅ **唯一真正生效的一家**（`:880` → `server.ts:2615`） | 是，但只影响「换不换号」；**不影响罚哪个维度**（发现 1） |
| `trae` | ✅ 如实（`chat` 返回上游 `Response`，`:1083`；其余 12 处 `res.status`） | ➖ 不适用（`chat` 不抛错）；`refresh` 等路径有 `result.status` | 仅网络层那一条（`:1080` `retryable:true`），**无人读** | ✅ 生效（`:2521`，但**忽略 bodyText**，只看状态码） | 是；同样只影响换号，罚维度仍是 `breaker`（发现 1） |
| `qwen-code` | — | — | — | — | **文件不存在，本行不成立** |

**表外但同等重要的两件事**（都在 `providers-b` 之外，却是本表能成立的前提）：

1. `httpStatus` **本身**是干净的，全模块没有一处把业务码塞进 `httpStatus` 的写法（对比 `minimax.ts:1654` 那个 `result.code` 只是命名问题）。
   所以任务书担心的「一律 502/500」在本模块**不成立**。
2. 但 `httpStatus` 生效的**方式**对 4 家抛异常的 provider 是「`classify(peStatus, message)`」，**message 是重构过的人类文案**（发现 4）。
   所以「状态码如实」换来的也只是粗分（401/403→auth、5xx→server、429→rate_limited），业务码那一层已经丢了。

---

## SSE 健壮性对照表

| provider | 半帧（跨 chunk） | 无空格 `data:{…}` | `[DONE]` | 首帧错误（HTTP 200 + 错误） | 结论 |
|---|---|---|---|---|---|
| `cline` | ➖ 不解析（直通上游 `Response`，`cline.ts:959`）；由 `gateway/stream.ts` 逐行解析 | ✅ `parseSseLine` 用 `slice(5).trim()`（`stream.ts:52`） | ✅ `payload === '[DONE]'`（`stream.ts:54`） | ✅ `peekStreamForError` 预读 64 KiB + SSE 行缓冲（`server.ts:1803-1830`） | 正常。provider 层无解析逻辑，故不存在「只有这一家处理了半帧」的风险 |
| `minimax` | ✅ 有 buffer + `decoder.decode(chunk,{stream:true})`（`anthropic.ts:846-857`） | ✅ `line.slice(5).replace(/^ /,'')`（`anthropic.ts:384`） | ✅ 转换器自己发 `[DONE]`（`anthropic.ts:811` 一带） | ✅ `event: error` 与 `type:'error'` 双形态都降级成 `{error:{message}}` 帧（`anthropic.ts:588-612`），再被 `peekStreamForError` 识别 | **最完备的一家**。CRLF（`\r\n\r\n`）、多行 `data:`（`dataLines.join('\n')`）、尾帧无空行（`flush`）全部覆盖 |
| `opencode` | ➖ 不解析（直通，`opencode.ts:815`） | ✅ 同上（网关） | ✅ 同上 | ✅ 同上 | 正常。上游就是标准 OpenAI SSE（`opencode.ts:645-647` 注释自证） |
| `trae` | ✅ 有 buffer（`trae.ts:968-1000`），且 `decoder.decode(chunk,{stream:true})` 处理多字节 | ✅ `trimmed.slice(5)`（`:993`） | ➖ 上游不发 `[DONE]`，由转换器补（`:1003`、`:1030`） | ✅ 流内 `event:error` → OpenAI 错误帧（`:1006-1016`）；**且「一个事件都没收到就结束」会显式报错**（`:1023-1029`） | 正常，且空响应保护是 4 家里唯一显式做的。次要瑕疵：`finished` 后 `transform` 直接 `return`，后续 chunk 被静默丢弃（`:971`）——但此时 `[DONE]` 已发，无影响 |
| `qwen-code` | — | — | — | — | **不存在** |

**跨 4 家的共同结论**：半帧、无空格、`[DONE]`、首帧错误**四项全部有处理**，本模块**没有**可报的 SSE 解析缺陷。
原因很一致：凡是需要解析的（minimax / trae）都复用了已经加固过的 `findFrameBoundary` / `parseSseFrame` 或自建了等价的行缓冲；
凡是直通的（cline / opencode）把解析交给了 `gateway/stream.ts` 与 `peekStreamForError`。

---

## 其他已知线索的核实结果（逐条，含「不成立」的）

| 线索 | 结论 |
|---|---|
| 模型名映射（对外 id ↔ 上游 id）会因上游改名静默失效 | **cline 做得最好**：`isFreeModel` 用「远端 free 集合 ∪ `:free` 后缀 ∪ `cline-free/` 前缀 ∪ 兜底表」的并集，且注释明令禁止用名字模糊匹配（`cline.ts:724-730`）。**trae 有真缺陷**（发现 5）。opencode 是「目录只暴露兜底表」，是**刻意的**安全选择（`opencode.ts:744-760`），不算缺陷。minimax 走远端 + 兜底合并且无硬编码名字（`minimax.ts:860-916`） |
| `zero-output.ts` 在这 5 家的接线与 buddy 一致 | ✅ **一致**。provider 路径在 `server.ts:2745` 无条件调用 `screenZeroOutputStream`，与 `finish_reason` 判定无关地覆盖所有 provider；判定后按 `kind:'model'` 冷却并改道，不罚账号。**无缺陷** |
| `throttleUpstream`（防封节奏）是否对这 5 家生效 | ✅ **生效**。`server.ts:2226` 在 `provider.chat()` 之前无条件调用（续期重试分支 `:2248` 也调了一次）。这正是 `e3286da` 刚修好的那条（此前只接在别处）。**无缺陷** |
| 设备指纹（`deriveDeviceId` / `referenceChatHeaders`）输入是否对同一账号稳定 | ⚠️ **这两函数不由本模块使用**（只被 buddy / taskrunner / realtime 用），任务书把它们当成本模块判据是误置。本模块各自的指纹：`trae` machine_id 来自凭据且**拒绝自动生成**（`trae.ts:481-489`，理由写得很清楚）、`device_id` 缺失时才随机（`:511`，重导入会变值，注释声明安全）、session 由 uid 确定性派生（`:259`）；`opencode` projectId 在 `parseCredential` 时生成并持久化（稳定）、sessionId 每请求新值（`:549-560`，注释说明与官方 CLI 语义一致）；`cline` / `minimax` 不带设备头。**同一账号维度均稳定**，无缺陷 |
| token 刷新时机 / 失败行为 | ✅ 三家都**只在 401/403（或内容像鉴权失败）时被动续期**，每家每次请求最多一次（`refreshed` 标记在候选循环内，`server.ts:2217`）。续期失败**不会**被记成账号失败（只写 `refreshFailure` 字符串，`server.ts:2604`），符合任务书期待。`cline.refresh` 的终态/瞬时判定（`cline.ts:1190-1240`）与「新 refresh_token 为空则保留旧值」（`:1236-1239`）都正确，**无限重试与误记账号失败两种病症都不存在** |
| 凭据缺失/格式错误是否给可读原因 | ✅ **普遍合格**，且质量高于平均：`trae.ts:470-500` 三条拒绝都写明「缺什么 + 从哪拿 + 为什么不能自动生成」；`cline.ts:1169` 的缺少 refresh_token 也写了「请重新登录」。**唯一可挑**：`opencode` 的 `accessToken` 为空时的报错我没在 `chat()` 里找到显式守卫（`opencode.ts:795-806` 直接用 `credential.accessToken` 拼头），但 `parseCredential` 阶段已拒（`:427-437`），属可接受 |

---

## 本模块亮点

1. **`trae` 的 `parseCredential` 是本仓库「失败必须显式」的范本**（`trae.ts:457-521`）：
   拒绝自动生成 `machine_id`（并解释「补一个随机值会让请求被判为异常设备」）、拒绝随机 `uid`（并解释「等于每次都在新设备上签到」），
   只在**明确安全**的 `device_id` 上兜底。三个字段三种处置，各有理由 —— 这是「不假装支持」的正确形态。
2. **`minimax` 的 Anthropic→OpenAI SSE 转换器链路（`anthropic.ts`）是四家里最稳的**：
   终止帧判据优先认 `event:` 行而非扫字符串（`anthropic.ts:403-413`，注释记录了「正文复述 `message_stop` 会被误判」的真实坑）、
   `findFrameBoundary` 先比 `\r\n\r\n` 与 `\n\n` 的偏移（`:422-429`，注释解释了「先查 LF 会切错位」）、
   `flush` 里显式避免重复发 `[DONE]`（`:859-878`）。三处都是「已经踩过并写下来」的痕迹。
3. **`opencode` 把「免费通道形状门禁」这件事的**因果**写进了代码**（`opencode.ts:586-647`）：
   为什么必须注入 `bash`/`read`、为什么 `stream:true` 恒置、为什么不覆盖用户的 `tool_choice` —— 三条都有实测出处。
   这是我读到的唯一一处「删了它线上就挂、但删的人不会知道」的开关，且注释明确标注了这一点。
4. **`cline` 的续期实现**（`cline.ts:1165-1284`）把「终态 vs 瞬时」判得很干净：
   401/403 与 `invalid_grant`/`expired` 优先于一切（终态），5xx/429/网络失败才是可重试；
   「拿到 2xx 但没令牌」被判成**终态**而不是「稍后重试」。这正是任务书担心的「无限重试」的反面。
5. **`trae` 的 `createSoloToOpenAiTransform`** 是四家里唯一同时做到「纯流式（不整包缓冲）」+「空响应显式报错」+「错误帧带原始 code 与处置提示」的
   （`trae.ts:904-1045`），且 `4001`/`1005`/`4008` 三类错误各给了不同的用户动作（`:1031-1045`）。

---

## 测试缺口

现状：`tests/` 40 个文件里，本模块只有 **3 个登录相关**的（`cline-login` / `minimax-login` / `trae-login`），
**`opencode` 一个专属测试都没有**（只有 `providers.test.ts:578` 的两条 `matchesShape` 断言、`meoo.test.ts:200` 的一条归属断言）。
`providers.test.ts` 通篇是**源码文本断言**（`readFileSync` + 正则），跑不出行为。

按发现排序的缺口：

1. **（发现 1）没有一条测试覆盖「非 2xx `Response` → 罚哪个维度」**。
   全仓 `grep failureKind tests/` 为空。这是本模块唯一能达到「服务不可用」的缺陷，却零覆盖。
   最小补丁：构造一个返回 400 的 `fetch` 桩，断言 `pool.applyFailure` 收到的 `kind !== 'breaker'`（对 `trae` / `opencode` 各一条）。
2. **（发现 2 / 3）没有「错误契约一致性」测试**。可加一条结构性断言：
   凡实现 `Provider.shouldRotate` 且 `chat()` 会抛 `ProviderError` 的 provider，必须在 `server.ts` 的错误分支被调用一次 ——
   这条断言今天会**立刻失败**，正好暴露两家的死路径。
3. **（发现 4）没有「业务码能活着到达 `classify()`」的测试**。
   `tests/classify.test.ts` 覆盖的是 `classify()` 本身，没有一条从 provider 的 message 出发。
   建议每条发现 4 加一条：`classify(400, new ProviderError({…}).message).code !== undefined`。
4. **（发现 5）`trae` 通道选择零覆盖**。可直接断言：`cachedModelChannels` 为空时 `chat()` 发出的 body 里
   `function` 不得是硬编码的 `solo_work_lite`（或反过来，断言 `fallbackModels()` 之后表被填满）。
5. **（发现 6）无首帧超时的回归测试**：用一个永不 resolve 的 `fetch` 桩，断言 45s 内必然返回可读错误而不是挂住。
6. **（发现 7）`opencode` 门禁形状**：断言「用户自带 2 个工具时，注入后 `tool_choice` 不得让未知工具可调用」，
   或断言注入工具的 `name` 集合 ⊆ 用户已声明集合（若采纳过滤方案）。
7. **`trae` 的 SSE 转换器一条单测都没有**（`parseTraeSSELine` / `createSoloToOpenAiTransform` 都是 `export` 的，好测）：
   值得补的最小四条 —— 半帧切分、`data:{` 无空格、`error` 事件降级、空流报错。
