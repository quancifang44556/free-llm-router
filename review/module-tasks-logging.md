# tasks-logging-auth-ratelimit 模块审查

> 审查基线：`d3aad75` / `package.json` **0.9.31**（工作树干净，仅 `review/*.md` 未跟踪）
> 纪律：**只读**。除本文件外未修改任何源码。
> 结论：**10 条**（高 3 / 中 5 / 低 2）。其中 **3 条是「实现了但从未接线」的死代码**（`settleUsage` / `RunState.plan` / `pruneSessions`），**3 条是对外承诺了却没落地的路径**（子密钥模型白名单、失败请求的记账、`process.env` 映射）。

---

## 〇、先纠正任务书里与代码不符的四处事实

任务书给的范围路径**在本仓库不存在**。核实结果：

| 任务书写的路径 | 实际情况 |
|---|---|
| `src/tasks/*` | ❌ 不存在。后台任务在 **`src/taskrunner/`**（5 文件 / 1644 行）+ `src/upstream/{tasks,checkin,travel}.ts` |
| `src/logging/*`、`src/logs/*` | ❌ 均不存在。日志在 **`src/gateway/server.ts:72 recordLog`** → `AccountPoolDO.appendLog`（`src/pool/AccountPoolDO.ts:1801`）；用量在 **`src/store/usage.ts`** |
| `src/auth/*` | ❌ 不存在。鉴权在 **`src/gateway/authz.ts`**（子密钥）+ `src/index.ts:222 authorized()`（主密钥）+ `src/store/apikeys.ts`（配额判据） |
| `src/ratelimit*` | ❌ 不存在。限速只有 `src/gateway/throttle.ts`（**上游**节奏）+ `src/store/apikeys.ts`（子密钥配额）。**没有**面向客户端的 QPS 限流 |

另外两条前提需修正：

1. **没有 `app_logs` 表**。全库 grep `app_logs` **0 命中**。请求日志是 `system_kv` 里的一个 **200 条环形数组**（`log:ring`，`AccountPoolDO.ts:1801-1810`），用量是 **`usage:state`** 一个 key 装「500 条明细环 + 90 天按天聚合」（`src/store/usage.ts:1-38`）。
   ⇒ 任务书「大表 app_logs 会不会无限增长」**不成立**（无表、有上限）。真正无上限的是 `sessions` 表，见发现 9。
2. **`src/index.ts` 里没有日志代码**。`index.ts` 只做路由与 cron 扇出；记账在 `src/gateway/server.ts`。

> 已按要求跳过所有「已修好」清单项（`parseEnvelope`、`clearCooldowns`、`settleBlame` 四处配对、`refineModelScoped`、provider 两道防封闸门、`10605`、`throttleUpstream`→buddy、`bindSession` 主路径、`conversationId` 重算、`mapErrorToPunishment`、`shouldRotate`、`degradeUntil`、`/admin/cooldowns/clear`）。下文每条都先确认「当前代码里确实还没修」，且给出了未修的证据。

---

## 发现清单

### [高] 子密钥的三维范围限制只接了 IP 一维：模型白名单与 token 配额从未接线

- **位置**：
  - `src/index.ts:1290-1294`（传空模型 + 一句不成立的注释）
  - `src/gateway/authz.ts:170-184`（`settleUsage` 实现了，**全仓库无人调用**）
  - `src/store/apikeys.ts:386-388`（唯一的模型白名单判据）
  - `src/pool/AccountPoolDO.ts:2292-2293, 2321`（`rejected` 计数与 `adjustApiKeyTokens` 同样无人调用）
  - `src/gateway/server.ts:754`（`handleChatCompletions(request, env, realm, ctx)` 根本没有子密钥参数）
  - 面板：`web/src/pages/ApiKeysPage.tsx:102`（token 配额进度条）

- **证据**：

  `src/index.ts:1286-1310`：
  ```ts
  const isV1Path = path.startsWith('/v1/')
  if (!(await authorized(request, env))) {
    if (!isV1Path) { return json({...}, 401) }
    // ⚠️ 此时还不知道模型，先传空串跳过模型检查；真正的模型校验在
    // 拿到请求体之后（见下方 `/v1/chat/completions` 分支）。
    const sub = await authenticate(request, env, '')
    ...
    if (sub.kind === 'subkey') {
      ctx.waitUntil(countUse(env, sub.record, request, ''))   // ← input/output 恒 0
    }
  ```
  - **那句注释承诺的下游校验不存在**：`grep -n "modelAllowed\|sub\.record" src/index.ts src/gateway/server.ts` 只命中 `index.ts:1308` 的 `countUse`。`authenticate()` 全仓库**只有一个调用点**（就是这里，传 `''`），`SubkeyContext`（`authz.ts:199`）导出后**无人 import**，`handleChatCompletions` 也没有接收子密钥的形参 —— 根本没有传下去的通道。
  - `authz.ts:386-388` 的模型判据因此恒被跳过：`if (model !== '' && !modelAllowed(...))`，而 `model` 永远是 `''`。
  - `settleUsage`（`authz.ts:170`）自 `d8547df` 引入起**从未被调用**（`git show d8547df` 显示它是新增代码）。它的唯一下游 `AccountPoolDO.adjustApiKeyTokens`（`2321`）也只有一个调用者 —— 就是 `settleUsage` 自己。⇒ `usage.inputTokens/outputTokens` **永久为 0**。
  - `checkQuota`（`apikeys.ts:392`）的 token 判据是 `usage.inputTokens + usage.outputTokens >= limits.maxTokens`，两个加数恒 0 ⇒ `maxTokens` **永不触发**。
  - `recordApiKeyUse` 支持 `rejected: true`（`AccountPoolDO.ts:2292`），但**没有任何调用点传它** ⇒ `usage.rejected` 恒 0。

- **影响**（三重，全部静默）：
  1. **作用域越权**：一把只允许 `glm-5.3-flash` 的子密钥可以调**任意模型**。用户「一设备一子密钥」的隔离设计里，模型维度实际是空的。
  2. **配额不设限**：只配了 `maxTokens`（`maxRequests=0`）的密钥等于**完全不限**。面板上那条 token 进度条**永远是 0%**（`ApiKeysPage.tsx:102` 用 `inputTokens+outputTokens`），用户看着「0 / 100000」却已经烧掉大量 token。
  3. 对比之下 **IP 维度是真的通的**（`tests/node-runtime.test.ts:296-324` 用真实 HTTP 验证了伪造 `cf-connecting-ip` 被 403、白名单内 200）。⇒ **同一份 `ApiKeyLimits` 里三维限制，只有一维生效**，正是「同一概念两处判据」的教科书形态。

- **建议**：不要走「请求体解析完再补一次校验」那条路（要把 subkey 上下文一路传到网关，改动大且容易漏分支）。最小改法：在 `isV1Path` 分支里**先挑出模型名再鉴权**——
  `/v1/models` 传 `''`；`/v1/chat/completions`、`/v1/responses` 读 `body.model`（`/v1/responses` 是 `input` + `model`），解析失败就按 `''`。同时把 `settleUsage` 接在 `onFinish`（`server.ts:1536 / 2339 / 2631 / 2975` 四处 `recordUsage(ok:true)` 的旁边），`rejected` 在 `subkey-denied` 分支补记。**再加一条单测**：给密钥配 `models:['x']` 后请求模型 `y` 必须 403 —— 现在测试里**一条都没有**（`grep 子密钥 tests/` 只有 IP 那一条集成测试）。

- **工作量**：M（半天）
- **置信度**：确定

---

### [高] alarm 执行中被重启 ⇒ 该账号的任务永久卡死，且产品内没有恢复入口

- **位置**：
  - `src/server/storage.ts:128-131`（执行前先删 alarm 记录）
  - `src/server/storage.ts:96-107, 268-270`（`running` 标志、`__hasPendingAlarm`）
  - `src/server/namespace.ts:104-113`（重启只恢复「还有记录」的实例）
  - `src/taskrunner/TaskRunnerDO.ts:59-63`（`start()` 对未完成运行直接返回既有状态）
  - `src/taskrunner/TaskRunnerDO.ts:91-99`（`cancel()` —— **没有路由，纯死代码**）

- **证据**：

  `storage.ts:128-137`：
  ```ts
  const triggerAlarm = async () => {
    clearTimer()
    // 执行前从数据库清理记录
    db.prepare('DELETE FROM system_alarms WHERE id = ?').run(instanceId)
    ...
    running = true
    try { await onAlarm() } catch (err) { /* 30s 后重排一次 */ }
  ```
  记录在**执行前**就删了。异常路径有 30s 兜底重试，但**进程被杀（SIGKILL / `docker restart` / 容器重建）不经过 catch** ⇒ 记录已删、定时器已丢。重启后：

  `namespace.ts:104-113`：
  ```ts
  restorePendingAlarms(): void {
    const rows = this.db.prepare('SELECT id FROM system_alarms WHERE id LIKE ?').all(pattern)
    for (const row of rows) this.get(key)   // ← 没有记录 = 这个 uid 连实例都不会建
  }
  ```
  `task_progress` 里却仍是 `{queue:[...], finished:false}`。此后每次 cron 扇出：

  `TaskRunnerDO.ts:59-63`：
  ```ts
  async start(uid, steps, context, now) {
    const existing = await this.load(uid)
    if (existing !== undefined && !existing.finished && existing.queue.length > 0) {
      return existing            // ← 直接返回，且**不会**补一次 setAlarm
    }
  ```
  ⇒ **永久死锁**：没有 alarm 会再触发，`start()` 永远拒绝重置，`cancel()` 没有路由（`grep -rn "tasks/cancel" src/ web/src` = 0 命中）。面板（`web/src/pages/TasksPage.tsx:423-436`）一直显示 **「进行中」+ 转圈 + 进度条**，`updatedAt` 停在崩溃那一刻。

  代码自己的注释已经承认这一半（`storage.ts:122-124`）：「因为执行前已删除 `system_alarms` 记录，**服务重启也救不回来**」—— 但只补了「抛异常」那条，**进程死亡那条留成了永久故障**。

  崩溃窗口不小：`storage.ts:104-106` 明确写「TaskRunner 的单个 alarm 内确实会长时间阻塞（`chat5` / `blackCat` 等在一步里循环 + `await setTimeout`，**可轻易超过 5 分钟**）」。

- **影响**：一次在错误时刻的重启，就让该账号**所有**定时任务永久静默停摆（签到、成长、国际版打卡全停），而面板显示「进行中」，点「执行每日任务」返回 `{ok:true, queued:N}`（`start()` 的返回值不变）却什么都不会发生。恢复只能手改 SQLite。任务书里「重启/容器重建很频繁」正好把这个概率放大。

- **建议**：给运行加**租约**而不是靠 alarm 记录：`RunState` 里已有 `updatedAt`，在 `start()` 里加一条 —— `existing` 未完成且 `now - existing.updatedAt > 10min` 且 `getAlarm() === null` ⇒ 视为中断，重排 alarm（或直接重建 queue）。另外把 `cancel()` 挂到 `/admin/tasks/cancel`（做 `finished=true` + `deleteAlarm` 即可），给用户一个手动出口。**这两条都不需要改协议，也不需要新表。**

- **工作量**：S（<1h）
- **置信度**：确定（代码路径完整可推演；未做实际 kill 复现）

---

### [高] 失败路径的记账不完整：首字节前的失败「日志 + 用量」双缺，流内失败只记日志不记用量 ⇒ 面板成功率恒 100%

- **位置**：
  - `src/gateway/server.ts:1168-1174`（全部换号失败，只回 `jsonError`）
  - 四处 `onError`（`1561` / `2315` / `2602` / `2941`）：只 `applyFailure` + `recordLog`，**没有** `recordUsage`
  - 4 处 `recordUsage` 全部 `ok: true`：`1536`、`2339`、`2631`、`2975`
  - 面板：`web/src/pages/UsagePage.tsx:70-77`（「失败」卡片）、`:68`（成功率）、`:126`（失败柱）

- **证据**：

  ① 「失败」这一维**没有生产者**：
  ```bash
  $ grep -n "ok: false" src/gateway/server.ts
  (无输出)
  ```
  四处 `recordUsage` 全是 `ok: true`（例如 `server.ts:1534-1537`、`2974-2976`）。`UsageRecord.errorKind`（`store/usage.ts:55`）全仓库无人赋值。
  ⇒ `UsageSummary.failed` 恒 0、`day.ok === day.count`。面板「失败」卡（`UsagePage.tsx:71`，副标题写着**「含上游报错与超时」**）永远显示 0，**成功率永远 100.0%**（`pct(u.ok,u.total)`），失败柱永远是 0 高。

  ② 首字节前的失败**连 app_logs 也没有**。换号循环里失败只做 `applyFailure`/`blame`（`server.ts:1315`、`1401`）与 `console`，`recordLog` 只在「零输出越墙」这一条支路（`1464`）和流内 `onError` 里出现。全部换号失败时的收尾：
  ```ts
  // server.ts:1168-1174
  if (lastError !== undefined) {
    return { response: jsonError(lastError.status, `所有可用账号均失败…`, lastError.kind) }
  }
  ```
  **没有 `recordLog`**。⇒ 一次 401/429/402/WAF 全灭的请求，在面板「日志」Tab 里**一条都不存在**，只有客户端收到 500/502。

- **影响**：
  - 面板的「成功率」「失败数」「失败趋势」三个数字**全部失真**（恒 100% / 0），而它们正是用户判断「号是不是坏了」的第一入口。
  - app_logs 只记「成功 / 流内错误 / 零输出」三类，**漏掉最常见的一类**（换号前的上游拒绝）。用户排查「为什么这次失败」时日志页是空的，只能看客户端报错。
  - 注意这不影响账号健康度判据（`applyFailure` 是另一条路径，是对的），所以是**纯可观测性缺陷**，但正好命中「静默给出错误结果」。

- **建议**：① 在 `onError` 两处补 `recordUsage({ ok:false, errorKind })`（token 记 0）；② 在「全部换号失败」的 return 前加一次 `recordLog({type:'error', status:lastError.status, error:lastError.message})`；③ 顺手给每条换号失败也记一条（`type:'error'`，带 `uid`/`kind`），这样「是哪几个号被拒」才有据可查。三处都是加调用，不动逻辑。

- **工作量**：S（<1h）
- **置信度**：确定

---

### [中] burn-rate 熔断的窗口长度**恰好等于**采样间隔，自动路径下大概率整小时跳过（静默不判）

- **位置**：`src/pool/burn-rate.ts:78`（默认窗口 1h）、`src/pool/burn-rate.ts:132-137`（`>= cutoff` 过滤）、`src/index.ts:4458` + `4504-4505`（采样时刻用的是 `scheduled()` 入口的 `now`）

- **证据**：

  采样的**唯一生产来源**是整点 cron（`burn-rate.ts:63-77` 自己写明），间隔 = 1 小时；默认窗口也是 1 小时：
  ```ts
  // burn-rate.ts:78
  export const DEFAULT_BURN_RATE_WINDOW_MS = 60 * 60_000
  // burn-rate.ts:135-137
  const cutoff = now - config.windowMs
  const inWindow = samples.filter((s) => s.at >= cutoff && s.at <= now)
  if (inWindow.length < 2) return undefined      // ← 少一个采样就整轮不判
  ```
  采样时刻 `at` 是 `scheduled()` 第 4458 行的 `Date.now()`（**不是** `updateBalance` 执行完的时刻，网络延迟不影响它）。Node 侧 cron 由 `setInterval(30s)` 驱动（`src/server/index.ts:253-255`），30s 整除 3600s ⇒ 每小时落在**同一相位**上，两次采样的间隔 ≈ **3600000ms ± 毫秒级调度抖动**。

  ⇒ `>=` 只在「后一次采样不晚于前一次 + 1h」时成立。抖动方向为「本次比上次晚」时，**窗口内只剩 1 个采样**，该小时直接 `return undefined`（既不判、也不报、也不记日志）。这与 `burn-rate.ts:63-76` 里「设成 1 小时则**恰好**覆盖相邻两个整点采样」的注释是同一句话的两面：`恰好` 意味着零余量。

- **影响**：消耗速率熔断（防「账号被盗用 / 倍率异常」时积分被烧光）在正常路径上**时灵时不灵**，且失效时**完全无声**。用户能观察到的只有「这个号突然没积分了」。手工在面板点两次「刷新余额」可以偶然凑出窗口内两个采样 —— 也就是说这个保护实际依赖人工干预。

- **建议**：窗口取采样间隔的 1.5~2 倍（默认 `2 * 60 * 60_000`），或把过滤改成 `s.at >= cutoff - SLACK`（`SLACK = 5min`）。并补一条单测：采样间隔 3600000+3000ms 时必须仍能判定。**不要**为了这个去加高频采样（`burn-rate.ts:75-76` 已警告过）。

- **工作量**：S（<1h）
- **置信度**：确定（算术确定；具体命中率取决于调度抖动方向，未实测统计）

---

### [中] 国内账号的 cron 扇出没有按日去重，重启即重复执行；国际版同一个函数里却有去重（两套判据）

- **位置**：`src/index.ts:4534-4554`（国内扇出，无去重） vs `src/index.ts:4574-4576`（国际版，有去重）；`src/server/index.ts:226-232`（`lastDispatchedHour` 是进程内变量）

- **证据**：
  ```ts
  // 国内：4534-4540 —— 只跳过 disabled，没有任何「今天跑过」判据
  for (const account of accounts) {
    if (account.disabled) continue
    ...
    await startRun(env, { uid: account.uid, ..., plan: planToRun, includeRealChat })
  }
  // 国际版：4574-4576 —— 有
  for (const account of accounts) {
    if (account.disabled || !isIntlWorkbuddy(account)) continue
    if (account.lastCheckinDay === today) continue      // ← 按北京时间日去重
  ```
  去重的载体在进程内：
  ```ts
  // src/server/index.ts:227-232
  let lastDispatchedHour = -1
  const checkCron = async () => {
    const now = new Date()
    if (now.getMinutes() <= 2 && now.getHours() !== lastDispatchedHour) {
      lastDispatchedHour = now.getHours()
  ```
  重启后 `lastDispatchedHour` 归 `-1`，若重启落在**整点后 2 分钟内**，同一时点会**再扇出一次**。

- **影响**：`daily`（`index.ts:4285-4286` 的 9:00 / 21:00）只有 3 步、通常 2~3 秒跑完；在 9:00-9:02 之间重启 ⇒ 整个 `daily` 再跑一遍（签到 + 余额 + 解冻）。签到上游幂等（业务码 10001），所以**不会重复领奖**，但会**多打一轮上游**。风险更高的是 1:00 的 `growth`：`includeRealChat: true`（`index.ts:4284`），若上一轮已跑完（含 5 个真实对话任务）而重启又落在窗口内，**会再消耗一次真实配额**。国际版路径因为有 `lastCheckinDay` 去重，**不会**有这个问题 —— 同一段扇出逻辑里两套判据。

- **建议**：把国际版那条判据提成统一前置（`lastCheckinDay === today` 对 `daily` 生效；`growth` 用「今天的 `growth` 是否已成功」的标记，或复用一个 `lastTaskRunDay` 字段），并在 `startRun` 层加「同 uid 同 plan 同一天已排队则跳过」。`lastDispatchedHour` 也应落库（`system_kv`）而不是进程内。

- **工作量**：S（<1h）
- **置信度**：确定

---

### [中] `process.env` → `Env` 是手工白名单，漏了 3 个已实现的环境变量（设了不生效、无任何报错）

- **位置**：`src/server/env.ts:108-125`（映射表）；`src/gateway/safety.ts:62-68, 76-81`（读 `RATE_LIMIT_QPS` / `RATE_JITTER_MS`）；`src/taskrunner/actions.ts:218`（读 `WORKBUDDY_DAILY_CHAT_MODEL`）；`src/env.ts:41`（`Env` 声明）

- **证据**：

  `Env` 接口声明 11 个可配置键，Node 侧只搬了 8 个：
  ```bash
  $ grep -oE "process\.env\.[A-Z_]+" src/server/env.ts | sort -u
  API_KEY  BURN_RATE_THRESHOLD_PCT  BURN_RATE_WINDOW_MS  CREDENTIAL_KEY
  DATABASE_PATH  MAX_CONTEXT_MESSAGES  UPSTREAM_BILLING_BASE
  UPSTREAM_CHAT_BASE  UPSTREAM_WEB_BASE
  # 缺：WORKBUDDY_DAILY_CHAT_MODEL   （Env 里声明了，wrangler 部署可用）
  # 缺：RATE_LIMIT_QPS / RATE_JITTER_MS（连 Env 都没声明，靠 as 强转读）
  ```
  ```ts
  // safety.ts:63,77
  const raw = (env as { RATE_LIMIT_QPS?: string }).RATE_LIMIT_QPS
  ```
  而 `AccountPoolDO` 拿到的 `env` 就是 `envObj`（`server/env.ts:131`，`() => envObj as Env`）⇒ 在**生产（Node 单容器）**上这两个键恒 `undefined` ⇒ `resolveRateLimitQps` 恒返回 0 ⇒ **限速永远是关的**，而 `safety.ts:52-54` 的注释明确承诺「补上回落，部署方一个环境变量就能开」。`WORKBUDDY_DAILY_CHAT_MODEL` 同理，国际版打卡永远用硬编码默认模型（`upstream/webagent.ts:39`），且**没有任何面板入口**可以改。

  ⚠️ 这个坑本项目**自己踩过一次并写进了注释**（`server/env.ts:118-123`）：「这个字段曾经漏在这里…漏了它的后果是「文档里写了，Docker 里设了却毫无作用」—— 而且**没有任何报错**」。现在只是换了个字段。

- **影响**：防封的「节奏层」只能靠面板开（面板路径是通的，`AccountPoolDO.ts:912-913` 的 `?? resolveRateLimitQps(this.env)` 在面板没存值时必然落到 0）。用环境变量配置的人会以为限速已开，实际裸奔 —— 与项目「防封是首要风险」的定位冲突。`WORKBUDDY_DAILY_CHAT_MODEL` 则完全无效。

- **建议**：把映射表改成**遍历 `Object.keys(process.env)` 里匹配 `^[A-Z][A-Z0-9_]*$` 的项**（`Env` 全是字符串型，没有 DurableObject 绑定需要排除，只需跳过 `DATABASE_PATH/HOST/PORT/TRUST_PROXY/AUTO_TASK_CRON/PUBLIC_URL` 等宿主专用项），或至少加一条**元测试**：`Object.keys(Env 字符串字段)` ⊆ `process.env.XXX 出现集合`。项目已经写过同类元测试（`tests/state.test.ts` 的「版本号三处必须一致」），这条缺了。

- **工作量**：S（<1h）
- **置信度**：确定

---

### [中] 定时维护任务的失败只进 console，不进面板；任务日志写入失败被空 catch 吞掉

- **位置**：`src/index.ts:4369-4374`（续期失败）、`src/index.ts:4443-4448`（余额刷新失败）、`src/taskrunner/TaskRunnerDO.ts:180-199`（`catch {}`）

- **证据**：
  ```ts
  // index.ts:4369-4374 —— 续期失败
  } catch (error) {
    console.error(`[cron] ${providerId} ${account.uid} 主动续期失败：`, ...)
  }
  // index.ts:4443-4448 —— 余额刷新失败
  } catch (error) {
    failed += 1
    console.warn(`[cron] ${providerId} ${account.uid} 余额刷新失败（保持原值）：`, ...)
  }
  ```
  两个函数都**没有** `pool.appendLog(...)`。⇒ 面板「日志」Tab 里看不到任何一条「续期失败 / 余额查不到」。用户唯一的观察途径是 `docker logs`。

  ```ts
  // TaskRunnerDO.ts:180-199 —— 任务完成后的唯一一条日志
  try {
    const pool = ... 
    await pool.appendLog({ ... status: state.lastError ? 500 : 200, ... })
  } catch {}          // ← 空 catch：写失败完全无痕
  ```
  这是**任务运行唯一**落到 app_logs 的地方（`grep -rn "appendLog" src/` 只有这 1 处 + `recordLog`）。空 `catch {}` 与项目 §7.2「失败必须显式」直接冲突，也与同文件 `alarm()` 里「不吞异常」的注释相反。

- **影响**：① 「账号为什么突然掉线 / 面板为什么显示积分 0」这类问题在面板上无迹可查（而这两个数字正好驱动「永久积分锁」和 `expiry` 路由）；② 若 DO 存储写日志失败（例如单 key 过大），任务结果**静默消失**，用户只会看到「跑完了但日志页没有」。

- **建议**：两条维护任务的 catch 里各加一次 `appendLog({type:'error', model:'cron/refresh-credential' | 'cron/refresh-balance', uid, status:502, error})`；`TaskRunnerDO` 的空 catch 改成 `catch (err) { console.error('[taskrunner] 日志写入失败', err) }`。均为纯增量。

- **工作量**：S（<1h）
- **置信度**：确定

---

### [中] 任务运行日志的计划名恒为 `daily`（`RunState.plan` 从未被写入）

- **位置**：`src/taskrunner/TaskRunnerDO.ts:65-73`（构造 state 时没有 `plan`）、`:183-197`（读 `state.plan`）、`src/taskrunner/steps.ts:35`（字段声明为可选）

- **证据**：
  ```ts
  // steps.ts:32-46
  export interface RunState { uid: string; plan?: string; queue: TaskStep[]; ... }
  // TaskRunnerDO.ts:65-73  —— 建 state 时没给 plan
  const state: RunState = { uid, queue: steps, done: [], finished: false, lastError: '', startedAt: now, updatedAt: now }
  // TaskRunnerDO.ts:183  —— 于是永远走 'daily'
  const planName = state.plan ?? 'daily'
  await pool.appendLog({ model: `TaskRunner/${planName}`, error: `任务计划「${planName}」执行完毕…` })
  ```
  `start(uid, steps, context, now)` 的签名里**没有 plan 参数**，`startRun()`（`index.ts:4238-4266`）也没往下传。⇒ 01:00 那次 `growth`（23+ 步、含 5 个真实对话任务）在日志里被记成 `TaskRunner/daily`、「任务计划「daily」执行完毕」。

- **影响**：面板只能靠步数/耗时猜这次是哪种计划。排查「今天 1 点到底跑了 growth 还是 daily」「真实对话任务有没有被执行」时，日志**给出的是错的答案**（而不是没有答案）。属静默错误数据。

- **建议**：`start()` 加第 5 个参数 `plan: PlanName`，`startRun` 传进去，`state.plan = plan`。3 处改动 + 1 条断言。

- **工作量**：S（<1h）
- **置信度**：确定

---

### [低] `pruneSessions` / `pruneLoginSessions` 实现了但从不调用（`sessions` 表无 GC）

- **位置**：`src/pool/AccountPoolDO.ts:998-1000`、`:1639-1641`；`src/store/db.ts:149-154`、`:233-238`；建表注释 `src/store/db.ts:40`（「带过期时间，由 GC 惰性清理」）

- **证据**：
  ```bash
  $ grep -rn "pruneSessions\|pruneLoginSessions" src/ tests/ | grep -v "store/db.ts" | grep -v AccountPoolDO.ts
  (无输出)
  ```
  DO 上的两个包装方法**没有调用者**，cron（`scheduled()`）里也没有这一步。`readSession` 只是「过期了当不存在」（`db.ts:212`），**从不删除**；`login_sessions` 靠 `readLoginSession` 读时顺手删（`db.ts:136-139`），没被读到的过期行永久留下。

- **影响**：`sessions` 表只增不减。对「本人多设备」量级（每天几十行）**实际无影响**，但建表注释承诺的 GC 并不存在 —— 属于「写了但没接线」。若将来会话键包含更多维度（如带 `model`），增长会加快。

- **建议**：在 `scheduled()` 里加一次 `await pool.pruneSessions(now)` / `pruneLoginSessions(now)`（两个 realm 各一次），或干脆删掉这两个方法并把注释改成实话。

- **工作量**：S（<1h）
- **置信度**：确定

---

### [低] `BURN_RATE_WINDOW_MS` 的注释写「默认 300000 = 5 分钟」，实际默认 1 小时

- **位置**：`src/env.ts:51`（注释）vs `src/pool/burn-rate.ts:78`（真值，`src/env.ts:200` 使用）

- **证据**：
  ```ts
  // src/env.ts:50-52
  /**
   * 消耗速率熔断的**观察窗口**（ms，默认 `300000` = 5 分钟）。
   */
  // src/pool/burn-rate.ts:78
  export const DEFAULT_BURN_RATE_WINDOW_MS = 60 * 60_000
  ```
  而 `burn-rate.ts:63-76` 专门用一整段说明「**为什么不是 5 分钟**」：5 分钟窗口下「检测永远休眠…等于白写」。注释停在改默认值之前。

- **影响**：`src/env.ts` 自称「**唯一的**环境读取入口」，用户按这行注释把窗口设成 `300000`，就会精确复现 `burn-rate.ts` 已经警告过的「检测永远休眠」。即「照着文档配 = 把功能关掉」。

- **建议**：把注释改成 `默认 3600000 = 1 小时（必须 ≥ 采样间隔，见 pool/burn-rate.ts）`。

- **工作量**：S（<1h）
- **置信度**：确定

---

## 后台任务调度表（必须）

> 时点表只有三行（`src/index.ts:4283-4287`）：`1→growth(includeRealChat)`、`9→daily`、`21→daily`。`scheduled()` 由 Node 的 `setInterval(30s)` 每整点前 2 分钟触发（`src/server/index.ts:226-257`），Cloudflare 侧是 `0 * * * *`。

| 任务 | 触发方式 | 开关是否生效 | 幂等 | 失败是否可见 | 结论 |
|---|---|---|---|---|---|
| `checkin`（签到） | cron 09:00 / 21:00（`daily`）+ 01:00（`growth` 内含），每天最多 3 次 | ✅ `AUTO_TASK_CRON`（env）关整条定时器；✅ 面板「自动签到与每日任务」关任务扇出；文案如实（`ConfigPage.tsx:291`「关掉后仍会每小时刷新余额」） | ✅ 上游幂等（业务码 10001）+ `noteCheckinDone` 幂等；⚠️ 重启 2 分钟内会多跑一轮（发现 5） | 部分：成功/失败都写进 `done[]`（可查 `/admin/tasks/status`），但**只在整轮跑完时**落一条 app_logs；跑到一半中断则什么都没有 | 主链路可用，恢复性有洞 |
| `growth`（完整每日任务，含 5 个真实对话） | cron 01:00，`includeRealChat: true`（`index.ts:4284`） | ✅ 同上；非 buddy 账号被降级为 `daily`（`index.ts:4538`） | ⚠️ 步骤级幂等（先读进度补差额）；`start()` 不覆盖未完成运行 ✔️；但中断即永久卡死（发现 2），且重启窗口内可能重跑真实对话（发现 5） | 同 checkin；另：日志里**计划名恒为 daily**（发现 8） | 可跑，恢复性有洞 |
| `intlDaily`（国际版网页活跃打卡） | cron 09:00 / 21:00 内的 `fanOutIntlDailyChat` | ✅ 同上 | ✅ 唯一一处**按北京时间日去重**（`index.ts:4576`，`lastCheckinDay === today`） | 入队失败只 `console.error`（`index.ts:4583`） | 三者中最健壮的一个 |
| 凭据主动续期 | 每整点（`scheduled()` 最前面，**在 `plan===undefined` 的 return 之前**） | ✅ 面板「自动续期登录凭据」（`routing.autoRefreshCredential`，`index.ts:4486`）；`AUTO_TASK_CRON=false` 时整个定时器都不存在，故也一并关掉 | ✅ 幂等（`expiresAt` 重新落库）；只对声明了 `refresh` 的家动手 | ❌ **只有 console**（`index.ts:4369-4374`），面板无痕（发现 7） | 逻辑正确，可观测性缺失 |
| 余额快照刷新 | 每整点（`index.ts:4504-4505`），**没有任何面板开关** | ⚠️ 只受 `AUTO_TASK_CRON` 控制；面板两个开关都关掉后**仍每小时打上游**（面板文案已如实说明，不算缺陷） | ✅ 幂等（只读上游）；失败**不写 0**（`index.ts:4444` 注释 + 代码一致） | ❌ **只有 console**（发现 7） | 行为正确；额度刷新失败**不会**把账号误判为无额度（两个调用点都是异常即跳过，`index.ts:1472-1487` / `4440-4449`），这点是真做对了 |
| 面板「执行每日任务」 | `POST /admin/tasks/start`（`index.ts:3970`） | 不查 `autoTaskCron`（手动触发本就不该受自动开关管） | 同 `growth`；⚠️ 国际版走 `planForProvider` 改 `intlDaily`，国内非 buddy 账号**不降级**（与 cron 的判据不同，实际不可达：面板只列 buddy 账号） | 同 checkin | 可用 |
| 面板「一键签到」 | `POST /admin/checkin/all`（`index.ts:2740` 附近） | 不查开关（手动） | ✅ 上游幂等；也会 `noteCheckinDone`（`index.ts:2756`） | ✅ 逐账号返回 `results[]` | 可用 |
| 面板「刷新余额」 | `POST /admin/accounts/balance`（`index.ts:1443`） | 不查开关（手动） | ✅ | ✅ 逐账号 `results[]` 带 error | 可用 |

**关于「多实例」**：本项目单容器。若真跑两个进程，`restorePendingAlarms()` 会在**两个进程里各挂一个** `setTimeout` 指向同一行 `system_alarms`（`namespace.ts:104-113`），触发时两边都先 `DELETE` 再执行同一步 ⇒ **同一步骤被上游执行两次**，只靠 `task_progress` 后写覆盖掩盖。单容器下不成立，但**不要**把它当「天然安全」—— 滚动重启的重叠窗口就是两进程。置信度：待确认（未实际双进程验证）。

---

## 鉴权/限流对照表（必须）

> `/v1/*` 全量只有 3 个路由：`/v1/models`（`index.ts:4005`）、`/v1/chat/completions`（`4189`）、`/v1/responses`（`4204`）。鉴权闸门在 `index.ts:1277-1310`，**在分发之前**，因此三条都经过它（唯一的免鉴权前置分支是 `/healthz`、`/panel/*` 静态、`/favicon.ico`、两个浏览器登录回调，**都不在 `/v1` 下**）。

| 接口 | 鉴权 | 限流键 | 可否伪造 | 结论 |
|---|---|---|---|---|
| `/v1/models` | 主密钥（常数时间）或子密钥（哈希查表）→ 停用/过期/IP/请求数/token 五项检查 | 子密钥 `id`（请求数配额）；**无 QPS 限制** | ❌ IP 来自 `CF-Connecting-IP`，Node 侧**先丢弃客户端自带值再按 TCP 对端重写**（`server/index.ts:119-129`）；`TRUST_PROXY=true` 只取 `X-Forwarded-For` **最右一项**（`resolveClientIp`，`:72-77`），左侧客户端可写的不采信 | ✅ 正确（模型维度此处不适用，`model=''`） |
| `/v1/chat/completions` | 同上 | 同上（请求数配额生效） | ❌ 同上 | ⚠️ **模型白名单不校验**（`authenticate` 传 `''` 且下游无补检）→ 越权；**`maxTokens` 永不触发**（token 计数恒 0）→ 发现 1 |
| `/v1/responses` | 同上（闸门在分发前，先于它内部 new Request 转发给 chat） | 同上 | ❌ 同上 | ⚠️ 同 chat 两个洞。注意：`authz.ts:186-198` 说明 IP 必须由鉴权处读原始 request 传下去 —— 因为转发时 `CF-Connecting-IP` 不会跟过去 |
| `/admin/*`（54 个分支） | **仅主密钥**（子密钥走不进，`index.ts:1288-1290`） | 无 | — | ✅ 分层正确：子密钥不能改自己的 `limits` |
| 上游请求节奏 | — | **按账号 uid**（`throttle.ts:12-14` 明确「按账号不按全局」） | 键是服务端选的 uid，客户端无法影响 | ✅ 键不可伪造；状态在**进程内存** `Map`（`throttle.ts:51`），**重启清零**、且要从面板/环境变量读一次才生效（`safety.ts:113-115`）。对本人自用可接受，但 `RATE_LIMIT_QPS` 环境变量在生产端**根本读不到**（发现 6） |

**常数时间比较覆盖情况（专项核实）**：
- 主密钥两处都比较过：`index.ts:222-234 authorized()` 用 SHA-256 摘要 + 全字节 XOR（`constantTimeEqual`，`:210-220`）；`authz.ts:99` 用 `constantTimeEqual`（`:31-41`，长度差也走完整循环）。✅
- 子密钥：`findApiKeyByHash` 走 SHA-256 哈希查表（`AccountPoolDO.ts:2356-2359`），注释给了「为什么不需要额外恒定时间比较」的理由（哈希单向、攻击者无法从命中与否反推明文）。这条判断**成立**。✅
- 全库 grep `=== state` / `=== token` / `=== key` **未发现**其它直接比较密钥的地方（命中的都是 `state === ''` 空值判断，登录态本身走 SQLite 主键查找）。✅
- 无 `X-Forwarded-For` 参与**限流计数**；只有 IP 白名单用它，且只取最右一项。✅

---

## 记账一致性表

| 场景 | 是否记账 | 是否计入账号健康 | 结论 |
|---|---|---|---|
| 非流式成功 | usage `ok:true` + app_logs 200 | `noteSuccess` + `settleBlame` | ✅ 两处都记 |
| 流式成功 | `onFinish` → usage `ok:true`（`ctx.waitUntil` 托住，`server.ts:1539-1545` 注释说明为什么必须） | 首帧 `noteSuccess`（`onFirstChunk`） | ✅ 两处都记 |
| 流式**下游取消**（用户点停止/关标签） | ❌ **两条都不记**（`stream.ts` 逻辑：`clientGone` 为真时不调 `onError` 也不调 `onFinish`，`server.ts:1770-1779`） | ✅ **不记失败** —— 这正是要的结果 | ✅ 不会污染健康度（专项核实通过）；副作用是该请求在面板里彻底消失（可接受） |
| 流式**流内错误**（上游中途报错） | app_logs ✅（`onError` → `recordLog`）；usage ❌ | ✅ `applyFailure(punishmentForStreamError(msg))`，按类别分维度 | ⚠️ 用量少记（发现 3） |
| 零输出越墙改道 | app_logs ✅（`server.ts:1464` / `2887`）；usage ❌ | ✅ 罚「模型维度」不罚账号（`kind:'model'` + 显式 `resetAt`） | ⚠️ 用量少记 |
| **首字节前失败、换号后成功** | app_logs ❌（只在 `console`）；usage ❌ | ✅ 延迟记账 + 换号成功才 `settleBlame` | ❌ 面板无痕（发现 3） |
| **首字节前失败、全部换号失败** | ❌ 只有 `jsonError` 返回（`server.ts:1168-1174`），`recordLog`/`recordUsage` 都没有 | ✅ 全失败时**故意丢弃 blame**（`server.ts:1594-1598` 注释：没证据说明是号的问题） | ❌ 面板最该看到的一类失败完全不可见 |
| 任务计划跑完 | app_logs ✅（`TaskRunnerDO.ts:184`，但 `catch{}` 兜底 + 计划名恒 daily） | ✅ 任务失败**不**罚账号（只写 `lastError`） | ⚠️ 见发现 7 / 8 |
| 任务计划中断（进程被杀） | ❌ 什么都没有 | — | ❌ 面板永远「进行中」（发现 2） |
| 续期 / 余额刷新失败 | ❌ 只有 console | ✅ 不惩罚账号（`index.ts:4370` 注释「续期失败可能是网络抖动」） | ❌ 面板无痕（发现 7） |
| 记账写入本身失败 | ✅ 全部 `catch` + `console.error`（`logPoolError`、`server.ts:1536-1543`） | — | ✅ **不影响主流程**；面板日志 Tab 会缺条目但服务端有日志。这条是做对的 |

**关于「账本只增不减的累积效应」**：`usage:state` 一份 key 装 `ring`（500 条，`trimUsageRing` 按 `at` 排序后截尾，`usage.ts:424-427`）+ `days`（90 天，`pruneUsageDays` 每次写入都剪，`usage.ts:181-196`，还会挡掉未来日键）。**没有**只增不减的累加器。`log:ring` 固定 200 条。⇒ 任务书担心的「无限增长」在这两处**不成立**；真正没 GC 的是 `sessions` 表（发现 9）。

---

## 本模块亮点

1. **记账写入的失败处理是分层的、正确的**：所有 DO 写入都 `catch` + 具名日志（`logPoolError`，`server.ts:63-70`），从早期 `.catch(() => {})` 改过来的过程还写在注释里。`ctx.waitUntil` 的必要性（响应结束即取消未完成 promise ⇒ 「对话成功但用量恒 0」）也有明确注释（`server.ts:1524-1526`）。
2. **客户端取消的判别做到了「不罚账号」**，且四个 `streamResponse` 调用点全部传了 `clientGone`（`server.ts:1492 / 2301 / 2601 / 2914`）—— 这是本项目历史上反复踩的坑，现在是对的。
3. **`burn-rate.ts` 全文是纯函数**（`detectBurnRate` 不碰状态），判据保守且每条都有理由（只看下降、分母取窗口起点、`burned<=0` 不判）。`revive()` 还特意清空采样史以防「点了解冻一分钟后又被锁」（`AccountPoolDO.ts:1412-1415`）。
4. **Node 适配层对「DO 必须串行」的理解到位**：`AccountPoolDO` 显式开 `serialize:true` 并给了实测证据（50 并发只记下 1 次，`namespace.ts:154-155`）；`pruneIdle` 用 `running` 标志避免回收正在算的实例（`storage.ts:96-107`）—— 这两处都是真踩过坑后的正确设计。
5. **`serializeCalls` 的死锁分析正确**：方法内部调原始实例、不经过队列，只对「只读写存储、不发外部请求」的类开启（`namespace.ts:157-162`）。`TaskRunnerDO` 没有开是对的（它发上游请求）。
6. **`apikeys.ts` 的 IP/CIDR 实现质量高**：显式拒绝前导零（避免八进制歧义，`:212-233`）、IPv4 不匹配 IPv6 规则（`:275-277`）、`bits===0`/`bits===32` 的边界都单独处理（`:288-291`），且 `ipAllowed([]) === true`（空=不限，与「全禁」相反的正确默认）。
7. **任务计划表与动作注册表完全对齐**：`plans.ts` 的 3 张表用到的 24 个 action 名称与 `ACTIONS` 注册表（`actions.ts:121-897`）**一一对应，没有一个死动作**。`NEEDS_REAL_CHAT` 的「双保险」门禁也放在**入队处**而不是执行处（`actions.ts:886-890` 记录了放错位置的历史教训）。
8. **`AUTO_TASK_CRON` 的解析口径统一**：`envFlag` 认 `false/0/no/off`（`server/index.ts:40-45`，且注释记录了「只认字面量 false」的旧缺陷），与 `env.ts` 的 `FALSY` 集合同一套语义。面板开关的文案也**如实写明**边界（`ConfigPage.tsx:291`「关掉后仍会每小时刷新余额」）—— 这条是「开关只关一半」类缺陷的反面示范。

---

## 测试缺口

| 缺口 | 现状 | 建议 |
|---|---|---|
| **子密钥的模型白名单** | 零测试。`grep -rn "modelAllowed\|checkQuota\|settleUsage" tests/` 只命中一个无关的 yaml fixture | 端到端：建 `models:['x']` 的密钥 → 请求 `y` 必须 403。**这条测试若存在，发现 1 就不会漏** |
| **子密钥的 token 配额** | 零测试 | 设 `maxTokens=100` → 打两次 → 第三次必须 429；并断言 `usage.inputTokens > 0`（现在恒 0，测试会立刻挂） |
| **重启/中断后的任务恢复** | `tests/` 里没有任何 alarm 恢复用例（`grep restorePendingAlarms tests/` = 0） | 单测：写入 `{queue:[...],finished:false}` 但不写 `system_alarms` → `start()` 必须重排 alarm。这条能钉住发现 2 |
| **失败请求的 usage 记账** | 现有测试只验证成功路径的 `recordUsage` | 断言「上游 500 → `usage.failed` 至少 +1」。现在恒 0，会立刻挂 |
| **`Env` 字段与 `process.env` 映射的一致性** | 无。项目已有同类元测试的传统（`tests/state.test.ts`「版本号三处必须一致」） | 断言 `Env` 的每个字符串字段都在 `server/env.ts` 里出现 `process.env.X` |
| **burn-rate 的采样间隔边界** | `tests/burn-rate.test.ts` 只测纯函数，用的采样间隔与窗口无关 | 加一条：间隔 = `windowMs + 3000` 时必须仍能判定 |
| **cron 按日去重** | 无（国际版有代码无测试，国内版既无代码也无测试） | 断言同一时点重启两次只扇出一次 |
| **`settleUsage` / `adjustApiKeyTokens` / `cancel()` / `pruneSessions` 是否被调用** | 无 | 这类「实现了但没接线」只能靠「有没有调用者」的元测试钉住（`assert.match(src, /settleUsage\(/)`）。建议对所有 `export function` 做一次「至少有一个非测试调用点」的扫描 |

---

## 一句话结论

**这个模块的「防封账本」和「鉴权分层」设计是对的，坏在四处「声明了但没接线」：子密钥的模型/配额两维、失败请求的用量与日志、重启后的任务恢复、以及环境变量到 `Env` 的映射。四条都不需要改架构，加起来不到一天。**
