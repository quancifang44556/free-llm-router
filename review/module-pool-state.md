# pool-state 模块审查

- 审查对象：`src/pool/AccountPoolDO.ts`（**2334** 行）、`src/pool/state.ts`（**622** 行）、`src/pool/burn-rate.ts`（166 行，被前两者调用，一并核实）
- 基线：`git HEAD = 22857c4`（`fix(pool): 分支B 两处成功路径缺 settleBlame`）
- 方式：只读。全部断言用 `grep -n` 定位后 `sed -n` / `awk` 精确读取，未修改任何源文件。
- 结论：**3 高 / 6 中 / 4 低，无「严重」**。没有找到数据丢失、凭据泄漏、或整机不可用的缺陷；本次发现全部落在任务书点名的三类里 ——「静默失效」「双判据」「死代码」。

---

## 0. 任务书事实核对（先纠正 6 处，避免后续按错行号排查）

| # | 任务书说法 | 实际 | 影响 |
|---|---|---|---|
| 1 | `AccountPoolDO.ts` **1512 行** | **2334 行** | 行号体系整体错位约 820 行 |
| 2 | `state.ts` **506 行** | **622 行** | 同上 |
| 3 | `applyFailure` 接受 **5 个** `kind` | **7 个**：`soft`/`hard`/`breaker`/`degrade`/`model` + `restricted`（11140）+ `session_dead`（12153） | 「五维度」漏了两个真实维度，其中 `restricted` 是唯一「上游明说封号」的维度 |
| 4 | `tests/state.test.ts:609` 用 `settleCalls.length >= 2` 全局计数弱断言 | **已被替换**。`:609` 现在是描述旧缺陷的注释；`:620-632` 已改为「每处 `noteSuccess` 之后必须有一次 `settleBlame`」的结构断言 | 该线索**已修**，不要重复报（但新断言仍有洞，见发现 8） |
| 5 | `server.ts` provider 主成功路径缺 `settleBlame` ⇒ breaker/degrade 永不落账 | **已修**（HEAD 提交 22857c4）。全文件 `noteSuccess(` 4 处、`settleBlame(pool, blame, Date.now())` 4 处，`server.ts:1460/2170/2396/2691` 一一配对 | 同上，已修，不重复报 |
| 6 | `blame` / `deferSoft` / `settleBlame` 属于 pool-state 模块 | 三者都定义在 **`src/gateway/server.ts`**（`:196` / `:1088`+`:2069` / `:1272`+`:2325`），pool 侧只提供被调的 `applyFailure` | blame 生命周期表跨了两个模块，已在表中标注位置 |

另有一条**数据完整性异常**需上报：一次 `awk` 输出把 `server.ts:2691` 显示成 `/* MUTATED */const settle = ...`，但同一行用 `grep -c MUTATED src/` = **0**、`sed -n '2691p' | od -c` 确认字节为 `          const settle = settleBlame(pool, blame, Date.now())`（无任何前缀）。源码是干净的；该 token 只出现在一次工具回显里。后续所有结论都基于 `od`/`sed` 复核过的字节，不基于那一次回显。

---

## 发现清单

### [高] `poolSize` 用 `realm` 而不是 `activeRealm` ⇒ workbuddy 单账号池的 `deferSoft` 永不生效

- **位置**：`src/gateway/server.ts:2061-2069`（provider 路径），对照 `:1997` 与 `:2024`
- **证据**：

  ```ts
  // :1997  workbuddy 的规范分片被**强制锁死**为 global
  let activeRealm = providerId === 'workbuddy' ? 'global' : realm
  ...
  // :2024  真正的选号 stub 用的是 activeRealm
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(activeRealm))
  ...
  // :2061-2064  ★ poolSize 却回到 realm 分片去数
  let poolSize = 0
  try {
    const all = await env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm)).listAccounts(realm, Date.now())
    poolSize = all.filter((a) => (a.provider ?? '') === providerId && a.disabled !== true).length
  } catch { poolSize = 0 }
  const deferSoft = (): boolean => poolSize === 1
  ```

  `realm` 的默认值是 `'cn'`（`:754` `realm = 'cn'`）。于是 `providerId === 'workbuddy'` 时：选号在 **global** 分片，`poolSize` 在 **cn** 分片按 `provider === 'workbuddy'` 过滤 —— workbuddy 账号按设计都存放在 global（`:1992-1996` 注释明说），cn 分片里恒为 0 ⇒ `poolSize = 0` ⇒ `deferSoft()` 恒 `false`。

  buddy 路径（`:1040-1048`）用的是 `pool.listAccounts(realm, …)`，而那里的 `pool` 就是 `idFromName(realm)`（`:977`），两者同源 —— **同一份判据两条路径口径不同**，正是「只在一处生效」。

- **影响**：workbuddy 池里只有 1 个账号时，`deferSoft()` 失效 ⇒ 一次瞬时抖动直接 `applyFailure({kind:'soft'})` 把唯一路径锁 60 秒，期间全部请求 503。`server.ts:2052-2054` 与 `:2063` 附近的大段注释声称这条路径「已修」，实际只修了 `providerId !== 'workbuddy'` 的那一半。这与用户报的「审查时被打断」是同一症状。无任何日志、无任何报错 —— 静默。
- **建议**：把 `:2063` 的 `realm` 换成 `activeRealm`（`idFromName(activeRealm)` + `listAccounts(activeRealm, …)`），与 `:2024`/`:2081` 对齐；并在 `state.test.ts` 里加一条「workbuddy 单账号池 `deferSoft()` 必须为真」的断言（现有测试只数 `deferSoft` 声明次数，见发现 8）。
- **工作量**：S（<1h）
- **置信度**：确定

---

### [高] `applyFailure` 对 `resetAt` 没有任何上限钳制 ⇒ 上游一个远期时刻就能把账号/模型锁到任意远

- **位置**：`src/pool/AccountPoolDO.ts:1052-1054`（`soft`）、`:1176-1179`（`model`）
- **证据**：

  ```ts
  // soft
  if (input.resetAt !== undefined && input.resetAt > now) {
    state.until = input.resetAt            // ← 直接采用，无 max/min 钳制
  } else if (!isActive(state.until, now)) { ... 本地指数退避 ... }

  // model
  const until =
    input.resetAt !== undefined && input.resetAt > now
      ? input.resetAt                      // ← 同样无钳制
      : now + fallbackCooldown
  ```

  `resetAt` 来自 `parseResetAt()`（`server.ts:553-576`），而它对上游文案里的 `YYYY-MM-DD HH:MM:SS UTC±N` **只做格式校验、不做合理性校验**：`Date.UTC(...)` 得到什么就返回什么。`:562-563` 的兜底正则「任何 `YYYY-MM-DD HH:MM:SS UTC±N`」匹配面极宽 —— 上游报错正文里出现任意一个日期（配额说明、公告、日志行）都会被当成重置墙钟。

  已核对：只有 `> now` 的下界判断，**没有上界**。`hard` 分支（`:1044`）反而有天然上界（次日 04:00），`soft`/`model` 没有。

- **影响**：上游回一个 `2027-…` 或文案里带错年份的日期 ⇒ 该账号（或该模型）在任意远期之前一直不可选。面板会显示「冷却中，约 N 小时」，用户唯一的出路是手工 `/admin/cooldowns/clear` 或 `/admin/restriction/clear`。这正是任务书点名的「静默给出错误结果」形态：代码「逻辑对」，但一个越界输入就能把号永久钉死。
- **附带**：`soft` 分支的 `resetAt` 判断**写在「已在冷却中不推进不延长」的守卫之前**（`:1053` 在 `:1055` 之前），所以注释 `:1061-1062`「已在冷却中时**不推进不延长**」在有 `resetAt` 时不成立 —— 既可能延长也可能缩短。这条本身是设计取舍（对齐上游墙钟通常更准），但**注释与实现不符**，且与 `hard` 分支「无条件覆盖」叠加后没有任何一处做「取最远者」。
- **建议**：在 `applyFailure` 入口统一钳制，一处覆盖全部路径（这是本项目已验证有效的做法 —— `[punish]` 日志就是靠「放在入口」做到全覆盖）：

  ```ts
  const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000   // 或复用 RESTRICTED_HOLD_MS 的口径
  const resetAt = input.resetAt !== undefined && input.resetAt > now
    ? Math.min(input.resetAt, now + MAX_COOLDOWN_MS) : undefined
  ```

  并在 `parseResetAt` 里对「超过 N 天」的解析结果打一条 warn（可观测），而不是静默采用。
- **工作量**：S（<1h）
- **置信度**：确定

---

### [高] `hard`（402 余额耗尽）宣称的「余额恢复自动解冻」从未实现 —— 两处注释互相打脸

- **位置**：`src/pool/AccountPoolDO.ts:1043`（声明）vs `:1303-1304`（否认）；`src/taskrunner/plans.ts:90`（第二次声明）vs `src/taskrunner/actions.ts:144-155`（实际只读）
- **证据**：

  ```ts
  // :1043-1044
  // 余额耗尽：冷却到次日 04:00（UTC+8）。签到后余额恢复会自动解冻。
  state.until = nextDay4AmUtc8(now)

  // :1303-1304  updateBalance —— 唯一的余额写入路径
  // ⚠️ 只改额度与采样。**绝不动** until / breakerUntil / degradeUntil /
  // modelCooldowns / disabled / fails
  ```

  全仓 `state.until = 0` 只有 3 处：`revive():1366`、`setAccountDisabled(false):1446`、`clearCooldowns():1644` —— **都不是余额恢复路径**。

  签到链路实测：`/admin/checkin/all`（`index.ts:2754-2757`）只调 `noteCheckinDone` + `noteSuccess`；`noteSuccess`（`:1217-1256`）清的是 `fails`/`retryCount`/`breakerUntil`/`softStreak`/`sessionDeadFails`/`consecutiveFails`/`degradeUntil`，**不含 `until`/`coolKind`**。taskrunner 的 `balance` 动作（`actions.ts:145-155`）只 `fetchBalance` 后返回一个字符串，**既不调 `updateBalance` 也不调 `revive`**，尽管它的注释写着「只读，用于签到后解冻冷却账号」。

- **影响**：一个 402（余额耗尽）账号在次日 04:00 之前**永远**不可选，即便用户已经充值/签到、余额早就回来了。最坏情形：04:01 触发 402 ⇒ 锁 23 小时 59 分。用户看到「余额耗尽」而面板 `credits` 是正数 —— 状态自相矛盾且无任何提示。这是本模块里唯一一条「文档承诺了一个功能，全仓没有它的实现」的缺陷。
- **建议**：二选一，不要继续两处矛盾。
  1. 实现它（推荐，成本很低）：在 `enforceBurnRate` 的同一位置加一个前置分支 —— 若 `state.coolKind === 'hard' && isActive(state.until, now) && credits > 0`，则 `state.until = 0; state.coolKind = ''`，并在 `updateBalance` 里落盘（那里本来就有一次读改写）。注意必须在 `enforceBurnRate` 之前，否则会先被 burn-rate 判成 soft。
  2. 或者删掉 `:1043` 与 `plans.ts:90` 的承诺，改成「余额恢复后仍需等到 04:00 或人工解冻」，并把 `actions.ts:144` 的注释同步改掉。
- **工作量**：S（方案 1 约 20 行 + 一条测试）
- **置信度**：确定

---

### [中] blame 通道丢弃 `resetAt` ⇒ 单账号池的 soft 冷却退回「自己猜的退避」

- **位置**：`src/gateway/server.ts:1272`（buddy 路径 push）、`:2325`（provider 路径 push）、`:196-212`（`settleBlame` 的 `applyFailure` 入参）
- **证据**：

  ```ts
  // :1264-1297  同一个 if/else：else 分支传了 resetAt，if 分支（blame）没传
  if (punishKind === 'breaker' || punishKind === 'degrade' || (punishKind === 'soft' && deferSoft())) {
    blame.push({ uid: candidate.uid, kind: punishKind, reason: `${kind}: ${msg}`.slice(0, 200) })
  } else {
    await pool.applyFailure({ ...,
      ...(resetAt !== undefined ? { resetAt } : {}),   // ← 只有这一支带
    })
  }

  // :202-211  settleBlame 结算时只回放 uid/kind/reason
  pool.applyFailure({ uid: b.uid, kind: b.kind, now, reason: b.reason })
  ```

  blame 元素的类型 `FailureKindForBlame = 'breaker' | 'degrade' | 'soft'`（`:194`）也没有 `resetAt` 字段 —— 所以是**结构上不可能传**，不是漏写一处。provider 路径 `:2316-2334` 同形：`pResetAt` 算出来了，`:2325` 的 push 不用它，`:2334` 的 applyFailure 用它。

  讽刺的是 `:2312-2314` 的注释正是在夸「本处照抄同一口径，并**补上 `resetAt`**（另两条都传了）」—— 补的只是 else 分支。

- **影响**：单账号池（`deferSoft() === true`）下，`soft` 走 blame ⇒ 上游明确给的重置墙钟被丢掉 ⇒ 冷却时长退回 `softCooldownSeconds × 2^(streak-1)`（60s 起，封顶 30 分钟）。上游说「5 分钟后重置」我们却 60 秒就回去撞；上游说「2 小时后」我们 30 分钟就回去撞。而 `:1280-1283` 的注释明确写了猜早了的后果是「继续撞限流」—— 对已被风控的号反复撞击正是要避免的。
- **建议**：给 `FailureKindForBlame` 加可选 `resetAt?: number` 与 `modelCause?`，两处 `blame.push` 带上，`settleBlame` 透传。改动 4 行 + 类型 1 行。
- **工作量**：S（<1h）
- **置信度**：确定

---

### [中] `soft` 会把 `hard` 的 `coolKind` 改写成 `'soft'`（作者自己诊断过的「状态自相矛盾」，只在 `enforceBurnRate` 一处挡了）

- **位置**：`src/pool/AccountPoolDO.ts:1049-1063`（soft 分支）对照 `:1332-1335`（唯一有守卫的地方）
- **证据**：

  ```ts
  // :1332-1335  enforceBurnRate —— 挡了
  // ⚠️ 已在**硬冷却**（余额耗尽，直到次日 04:00）时不再判：软冷却分支会把
  // `coolKind` 从 `hard` 改写成 `soft`，等于把「没钱」降级成「被限流」，
  // 而 `until` 仍指向次日 —— 状态自相矛盾。
  if (state.coolKind === 'hard' && isActive(state.until, now)) return

  // :1049-1051  soft 分支 —— 没挡
  case 'soft': {
    state.coolKind = 'soft'          // ← 无条件覆盖，即使当前是 hard
    state.reason = input.reason ?? 'rate limited'
  ```

  因为 `:1055` 的 `!isActive(state.until, now)` 守卫，`until` 不会被改短（这一点是对的），但 `coolKind`/`reason` 已经被覆盖。

- **影响**：一个 402 账号在次日 04:00 前若又吃到一次 429，面板 `diagnoseAccount` 会按 `coolKind` 报「账号冷却中（**限流**）」（`state.ts:573`），而真实原因是「余额耗尽」—— 处置完全不同（一个去充值、一个去等）。同时 `enforceBurnRate` 的守卫因 `coolKind` 已变而失效，该账号在硬冷却期内每次余额刷新都会重新进一遍 burn-rate 判定与日志。
- **建议**：在 `soft` 分支开头加与 `:1335` 同一条守卫（`if (state.coolKind === 'hard' && isActive(state.until, now)) break`）。这样「hard 优先于 soft」的口径就只写在 `applyFailure` 一处，`enforceBurnRate` 的那条可以保留作双保险或删除。
- **工作量**：S（<1h）
- **置信度**：确定

---

### [中] `modelExempt()` 不检查 `restrictedUntil` ⇒ `counts()` 把「被上游封号」统计成「仅模型限流」

- **位置**：`src/pool/state.ts:392-401`，消费处 `src/pool/AccountPoolDO.ts:949-955`
- **证据**：

  ```ts
  // state.ts:392-401
  export function modelExempt(state: AccountState, now: number): boolean {
    if (state.disabled) return false
    if (isActive(state.until, now)) return false
    if (isActive(state.degradeUntil, now)) return false
    if (isActive(state.breakerUntil, now)) return false
    for (const mc of Object.values(state.modelCooldowns)) { ... }
    return false            // ← 五维度里唯独漏了 restrictedUntil
  }
  ```

  对照 `healthy()`（`:359-368`）是**四条 + disabled**，包含 `restrictedUntil`。`state.ts` 文件头 `:22` 还写着「`healthy()` 是**并列或门**」，而 `modelExempt` 的 docstring `:386-391` 自称「账号本身健康，但存在某模型的独立冷却」并声称「供 `/healthz` 探活与选号共用」—— 实际上：① 它不看 `restrictedUntil`，与「账号本身健康」矛盾；② 全仓只有 `counts()` 一个调用点，**没有任何选号路径用它**（`pick` 走的是 `healthyForModel`）。

  `counts()` 的判定顺序（`:949-955`）是 `modelExempt` 优先于 `healthy`，所以「restricted + 有模型冷却」的账号会落进 `modelExempt` 分支。

- **建议**：`modelExempt` 补一条 `if (isActive(state.restrictedUntil, now)) return false`；顺带修 `:386-391` 的 docstring（它不是选号判据），以及 `counts()` 里 `:942-943` 那句「`healthy()` 只看账号级的**四个维度**（until / breakerUntil / degradeUntil / disabled）」—— 那里漏了 `restrictedUntil`，正是这条漏检的注释源头。
- **影响**：面板/`/healthz` 上「有模型限流（账号本身可用）」的计数把完全不可派的号算进去了；运维据此会去清模型冷却而不是清 11140 限制。
- **工作量**：S（<1h）
- **置信度**：确定

---

### [中] 4 处写路径绕过 `normalizeAccountState` ⇒ 与其余写路径口径不一致，新增字段会在这里静默失效

- **位置**：`src/pool/AccountPoolDO.ts:1226`（`noteSuccess`）、`:1364`（`revive`）、`:1464`（`disable`）、`:1410`（`noteCheckinDone`）
- **证据**：其余全部写路径都走归一化 —— `applyFailure:1014`、`updateBalance:1300`、`setAccountDisabled:1438`、`clearCooldowns:1638-1639`、`clearModelCooldowns:1779/1791`、`clearAccountRestriction:1912`、`createAccount:1477`、`getAccount:453`。这 4 处是裸 `JSON.parse(raw) as AccountState`：

  ```ts
  // :1224-1253 noteSuccess —— 在**每一次成功请求**的路径上
  const state = JSON.parse(raw) as AccountState
  state.successCount += 1                 // undefined + 1 → NaN（不抛）
  ...
  state.tokenUsage.input += usage.input    // tokenUsage 缺失 → TypeError
  ...
  const mc = state.modelCooldowns[model]   // 缺失 → TypeError
  delete state.modelConfirm[model]         // 缺失 → TypeError
  ```

- **影响**：`noteSuccess` 抛错时，前面的 `state.fails = 0` / `breakerUntil = 0` 都**不会落盘**（异常发生在 `writeAccount` 之前）⇒ 账号一边持续成功、一边留在熔断里，`successCount` 也不涨。这 4 条路径同时**永远不会自愈**老记录（它们把原始 JSON 形状原样写回，不补默认值）。
- **置信度说明（待确认）**：当前**没有证据**表明存量记录缺 `tokenUsage`/`modelCooldowns` —— 这两个字段自首版 `createAccountState` 就存在，且 `normalizeAccountState` 在其它路径上已把老记录补齐。所以这是**纪律缺口**而非已发生的故障。但本项目已经因为同一形态翻过一次车：`1ae629f`（`fix(ban): 修 restrictedUntil 三处静默失效`）的 Bug 1 就是「逐字段重建漏了一个字段 → `Math.max(undefined,x)=NaN` → 写库读回 0 → 罚了却看不出罚」。下次加字段时，`noteSuccess` 是第一个会静默失效的地方。
- **建议**：这 4 处统一改成 `const state = normalizeAccountState(JSON.parse(raw)); if (state === undefined) return`。`noteCheckinDone` 可保留裸解析（只写一个字符串，无算术），但为了「一处口径」也建议统一。
- **工作量**：S（<1h，4 处各 2 行）
- **置信度**：确定（代码事实）；影响面 待确认

---

### [中] 测试的「每条成功路径都必须结算 blame」是空壳：第 ④ 条断言只数了 `applyFailure` 出现次数

- **位置**：`tests/state.test.ts:636-640`
- **证据**：

  ```ts
  // ④ 死代码守卫：applyFailure 的每一处调用，要么在 else 分支（立即记账），
  //    要么在 blame 分支里。允许「立即记账」，但不允许**既不在 blame 分支、
  //    也没有任何注释解释为什么这条路径要立即记**的裸调用。
  const applyCalls = [...src.matchAll(/\n(\s*)\.applyFailure\(\{/g)]
  assert.ok(applyCalls.length >= 2, `applyFailure 至少有 2 处调用，实际 ${applyCalls.length}`)
  ```

  注释声明的是「逐处检查归属」，代码做的是「至少出现 2 次」—— 全仓实际 14 处（`src/` 内 `grep -c '\.applyFailure({'` = 14，其中 `server.ts` 12 处），这个断言在任何情况下都为真，**不约束任何东西**。这就是任务书问的「死代码：写好但没人调用」在测试里的镜像：写好了采集，没有断言。

- **补充**：第 ③ 条（`:620-632`）虽然改成了结构断言，但仍是**纯文本匹配**：

  ```ts
  const settleIdx = [...src.matchAll(/settleBlame\(pool, blame, Date\.now\(\)\)/g)].map(...)
  const orphans = noteIdx.filter((i) => !settleIdx.some((j) => j > i && j - i < SETTLE_WINDOW))
  ```

  两处可被绕过：① 把某处 `settleBlame(...)` 注释掉（`// const settle = settleBlame(pool, blame, Date.now())`）仍然匹配，断言继续通过；② 它只检查「`noteSuccess` 之后有没有 settle」，不检查「新增的成功路径**压根没有 `noteSuccess`**」—— 那种路径连 `orphans` 都进不去。所以真正会漏的是「新加一条成功 return，既没 `noteSuccess` 也没 `settleBlame`」。
- **建议**：④ 改成真正的归属断言（对每个 `.applyFailure({` 的偏移，检查其所在 `if/else` 分支是否为 blame 分支或带 `立即记账` 标记注释）；③ 改成「剥注释后再匹配」（本仓库注释量极大，任务书也点名了这个坑），并补一条「`return` 出成功响应之前必须出现过 `settleBlame`」的检查。
- **工作量**：M（半天）
- **置信度**：确定

---

### [中] 「解冻」语义碎片化：没有任何一个入口能清掉全部五个维度，且 `revive` 的 docstring 声明的两个调用场景都不存在

- **位置**：`src/pool/AccountPoolDO.ts:1360-1386`（`revive`）、`:1636-1658`（`clearCooldowns`）、`:1909-1919`（`clearAccountRestriction`）；调用方 `src/index.ts:2984`、`:3441`
- **证据**：

  | 入口 | 清 `until`/`coolKind` | 清 `breakerUntil` | 清 `degradeUntil` | 清 `modelCooldowns` | 清 `restrictedUntil` | 清 `disabled` |
  |---|---|---|---|---|---|---|
  | `revive`（`:1361`） | ✅ | ✅ | ✅ | ✅ | ❌ | ❌（刻意） |
  | `clearCooldowns`（`:1636`） | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
  | `clearModelCooldowns`（`:1773`） | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
  | `clearAccountRestriction`（`:1909`） | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

  - `revive` 的 docstring（`:1360`）：「解冻账号（**面板「解冻」**/ **签到后余额恢复**）。清**全部**惩罚态，但不动 `disabled`。」—— 两个场景都不成立：面板「解冻」按钮走的是 `/admin/cooldowns/clear` → `clearModelCooldowns` + `clearCooldowns`（`index.ts:2982-2984`）；签到走 `noteCheckinDone` + `noteSuccess`（`index.ts:2756-2757`），而 `updateBalance` 的注释（`:1263-1265`）明确说「**不能**用 `revive()` 代替」。`revive` 的实际调用点只有两个：登录完成（`index.ts:364`）与导入（`:3536`）。
  - `clearCooldowns` 的门槛条件（`:1643`）是 `until || breakerUntil || degradeUntil || fails`，**漏了** `retryCount` / `softStreak` / `consecutiveFails` / `sessionDeadFails`。于是「只有退避进度残留」的账号（例如 `retryCount = 2`）不会被重置 —— 下一次 `breaker` 直接从 `30min × 2² = 2h` 起步，而面板显示「已清空」。
  - 连带 `disabled`：`revive` 刻意不动 `disabled`，而自动置 `disabled` 的唯一路径是 `session_dead`（12153 ×3，`:1097-1106`）。所以一个因 session 死掉的账号，**重新登录不会复活**（`createAccount` 遇到已存在记录直接原样返回，`:1475-1479`；`revive` 不动 `disabled`），只能人工点「启用」。而 `:1423` 的表格写着 `disable()` 的解除方式是「**重新登录** / 人工清状态」。

- **影响**：运维遇到「明明健康却选不到号」时，需要**两次不同端点**（`/admin/cooldowns/clear` + `/admin/restriction/clear?uid`）才可能清干净，且 `retryCount` 残留无法通过任何入口清掉（只能靠 `noteSuccess`）。这正是本项目反复出现的「状态看着对、行为不对」。
- **建议**：给 DO 加一个 `resetAccount(uid, { keepDisabled })` 作为**唯一**的「把这条记录恢复到出厂惩罚态」入口（五维度 + 全部计数 + `modelConfirm` + `samples`），让 `revive` 与 `/admin/cooldowns/clear` 都调它；`clearCooldowns` 的门槛条件补上 4 个计数字段。同时修正 `:1360` 的 docstring 与 `:1423` 的表格。
- **工作量**：M（半天）
- **置信度**：确定

---

### [低] `disable()` 是死代码：全仓零调用，却被 docstring 当作活入口

- **位置**：`src/pool/AccountPoolDO.ts:1460-1468`（定义）、`:1418-1424`（引用它的表格）
- **证据**：`grep -rn "\.disable(" src/ tests/` → 仅命中定义行本身；`grep -o "\.disable(" dist/server.mjs | wc -l` → **0**；`dist/server.mjs` 与源码同为 2026-10-21，非陈旧产物。同文件 `:1418` 的表格却把它列为三个并列入口之一（「上游强信号（如 11140）判死 | 重新登录 / 人工清状态」），而 11140 实际走的是 `applyFailure({kind:'restricted'})`。
- **影响**：读者会以为「11140 会 `disable()` 账号」并据此推断恢复路径，实际不会。且它绕过了 `normalizeAccountState`（见发现 7）。删掉或补上调用方，不要留着误导。
- **建议**：删除 `disable()`，同时把 `:1418-1424` 的表格改成 `setAccountDisabled` / `applyFailure` 两行（`restricted` 维度单独一行）。
- **工作量**：S（<1h）
- **置信度**：确定

---

### [低] 「全失败 ⇒ 丢弃 blame」只覆盖一个出口，另外三个出口连日志都不打

- **位置**：`src/gateway/server.ts:1545-1550`（buddy 唯一有日志的丢弃点）、`:1148`/`:1152`（早退）、`:1127`/`:2795`（跨渠道容灾）、`:2806-2811`（provider 唯一有日志的丢弃点）
- **证据**：`blame.push` 有 2 处（`:1272`、`:2325`），`settleBlame` 4 处，但「丢弃 + 日志」只有 2 处，且都在**循环自然跑完**的尾部。而循环内还有 4 个 `return` 会在 blame 非空时直接离开函数：

  | 出口 | 行为 |
  |---|---|
  | `:1148` / `:1152`（`pick` 返回 undefined ⇒ 无候选） | blame 静默丢弃，无日志 |
  | `:1127`（buddy → workbuddy 容灾） | buddy 的 blame 丢弃；新函数有自己的空 blame 数组 |
  | `:2795`（provider → buddy 反向容灾） | 同上 |
  | `:1545` / `:2806`（循环跑完） | ✅ 有日志 |

- **影响**：丢弃本身是**正确**的（全失败确实不该记账，`:1541-1544` 的理由成立）。缺的只是可观测性：最常见的「全池都失败」形态（所有号都被 `exclude` 掉 / 全在冷却）走的是 `:1148`，恰好是**没有日志**的那条。排查「为什么没进熔断」时看不到任何痕迹。
- **建议**：把丢弃逻辑抽成一个 `discardBlame(blame, why)` 小函数，在 4 个出口都调（`pick` 返回 undefined 那两处可以只打 debug 级）。
- **工作量**：S（<1h）
- **置信度**：确定

---

### [低] 凭据的两条读路径口径不一致（缓存 vs 直读 DB；抛错 vs 静默 null）

- **位置**：`src/pool/AccountPoolDO.ts:1507-1517`（`getCredential`）、`:1534-1564`（`listCredentialExpiry`）、`:1567-1569`（`removeCredential`）对照 `:528-529`（`removeAccount` 清缓存）
- **证据**：

  ```ts
  // getCredential：优先内存缓存，命中就**不碰 DB**
  const cached = this.credentialCache.get(uid)
  if (cached !== undefined) return cached
  ...
  const key = requireCredentialKey(this.env.CREDENTIAL_KEY)   // 未配 key → 抛
  const cred = await decryptCredential(key, ciphertext)       // 解密失败 → 抛

  // listCredentialExpiry：直读 DB，不查缓存；任何异常 → null
  try { key = requireCredentialKey(...) } catch { return out }   // 未配 key → 全空表
  ... catch { out[uid] = null }                                  // 解密失败 → null

  // removeCredential：只删 DB，**不清 credentialCache**
  async removeCredential(uid: string): Promise<void> {
    deleteCredential(this.ctx.storage.sql, uid)
  }
  ```

- **影响**：`removeCredential` 之后 `getCredential` 仍会返回缓存里的旧凭据（**唯一调用点** `index.ts:1507-1508` 紧接着调了 `removeAccount`，后者 `:529` 会 `credentialCache.delete(uid)`，所以当前线上被兜住了 —— 这是**潜在陷阱**而非已发生的缺陷）。另外「未配 `CREDENTIAL_KEY`」与「密钥轮换导致解密失败」在面板上都只表现为 `expiresAt = null`，无法区分，而 `getCredential` 在同样情况下是抛错 —— 同一概念两种失败语义。
- **建议**：`removeCredential` 补 `this.credentialCache.delete(uid)`（1 行）；`listCredentialExpiry` 的返回值加一个 `reason` 维度（或至少 `console.warn` 一次解密失败计数），让「读不到」可分辨。
- **工作量**：S（<1h）
- **置信度**：确定

---

### [低] 文档/默认值漂移 4 处（都与实际行为不符，且每一处都误导过或可能误导）

- **位置与证据**：

  | # | 位置 | 写的 | 实际 |
  |---|---|---|---|
  | a | `state.ts:14` | `degradeUntil`：连续业务失败 → 「**降权，别当首选**」 | `healthy()`（`:363`）直接 `return false` —— degrade 是**完全排除**，不是降权。名字与表格都承诺了「还能用只是排后面」 |
  | b | `state.ts:121-122` | `provider` 「缺省值 `workbuddy` 是为了兼容升级前已存的账号」 | `normalizeAccountState:302` 的缺省是 **`'buddy'`**（且 `:301` 注释明说「缺省供应商为国内版默认供应商 buddy」）。两者互相矛盾，且 `createAccountState:224` 的缺省确实是 `'workbuddy'` ⇒ 同一概念两个缺省值。当前**无实害**：`createAccount` 的两个调用点（`index.ts:361`、`:3533`）都显式传了 `provider`；但任何新增调用点漏传，新号就会被标成国际版，而 `pick` 按 provider 过滤 ⇒ 该号在 buddy 路径上**永久不可见** |
  | c | `AccountPoolDO.ts:1763` | `clearModelCooldowns` 的 docstring：「模型级冷却的退避是 **6 小时起步、封顶 24 小时**」 | 实际阶梯（`:1157-1170`）是 `2min → 30min → 2h → 6h → 24h`；`busy` 更是 `15s` 起（`:1154`）。这段 docstring 是 2026-10-20 改造前的遗留 |
  | d | `AccountPoolDO.ts:942-943` | 「`healthy()` 只看账号级的**四个维度**（until / breakerUntil / degradeUntil / disabled）」 | `healthy()` 看的是 **5 项**（多了 `restrictedUntil`，`state.ts:366`）。这条漏写正是发现 6 的注释源头 |

- **影响**：纯可维护性。但 (a) 会让人以为 degrade 只是排序、(b) 会在新增调用点时静默产生「看不见的账号」、(d) 直接导致了 `modelExempt` 的漏检。本仓库的注释密度极高、且大量注释承担「防止后人改回去」的职责，因此注释漂移的代价比一般项目更高。
- **建议**：逐条修正；对 (b)，建议把缺省值收敛到 `createAccountState` 一处（或干脆让 `provider` 必填，用类型系统挡住），并把 `state.ts:121-122` 的注释改成指向 `migrateBuddyIds`（`AccountPoolDO.ts:470-498`）—— 兼容升级前数据的地方是那里，不是缺省值。
- **工作量**：S（<1h）
- **置信度**：确定

---

## 五维度对照表（必须）

`applyFailure` 实际有 **7** 个 `kind`。下表按任务书的五个维度 + 两个遗漏维度列出。「读取处」全部落在 `state.ts` 的三个判据函数上，`pick` 通过 `healthyForModel → healthy` 间接承接。

| 维度 | 触发条件 | 冷却时长 | 恢复条件 | 写入字段 | 读取处 | 是否一致 |
|---|---|---|---|---|---|---|
| `soft` | `mapErrorToPunishment('rate_limited')` → `dimension:'soft'`（`server.ts:223`）；含 429、403 无信封、`11-128` 除外 | `resetAt > now` 则**直接用 `resetAt`（无上限）**；否则 `softCooldownSeconds × 2^(softStreak-1)`，60s 起、**封顶 30min**（`DO:1052-1060`） | 到期；`noteSuccess` 只清 `softStreak`（不清 `until`）；**已在冷却中不推进不延长**（`resetAt` 存在时不成立，见发现 2） | `until` + `coolKind='soft'` + `softStreak` | `healthy()` `state.ts:361`；`unavailableReason` `DO:369`；`diagnoseAccount` `state.ts:532`；`enforceBurnRate` 守卫 `DO:1335` | ⚠️ 三处不符：`resetAt` 无钳制；blame 通道丢 `resetAt`（发现 4）；`soft` 会覆盖 `hard` 的 `coolKind`（发现 5） |
| `model` | `modelCauseFor()`：`model_unavailable`→absent、`model_denied`→denied、`rate_limited`→busy；或 `refineModelScoped` 命中 6004/14003/11134/110/中文文案（`server.ts:451-497`） | `resetAt > now` 则直接用（无上限）；否则 `busy`：`15s × 2^min(hits-1,3)`，封顶 90s；`absent`/`denied`：`2min→30min→2h→6h→24h` 阶梯（`DO:1150-1179`） | 到期；`noteSuccess` **只**清 `absent`/`denied`（`busy` 刻意不清，`DO:1247-1252`） | `modelCooldowns[model]` + 账号级 `modelConfirm[model]` | `healthyForModel` `state.ts:376-384`；`unavailableReason` `DO:375-380`；`pruneExpired` `state.ts:412-417`；`modelExempt` `:397-399`；`diagnoseAccount` `:537-550` | ⚠️ `resetAt` 无钳制（同发现 2）；阶梯与 `clearModelCooldowns` 的 docstring 不符（发现 13c）；其余一致 |
| `hard` | `mapErrorToPunishment('credit_exhausted')` → `dimension:'hard'`（`server.ts:234-235`） | 到**次日 04:00（UTC+8）**（`nextDay4AmUtc8` `DO:2327-2334`，已核对：04:00 前返回当日、之后返回次日） | 名义上「到期 **或 余额恢复**」；**余额恢复这条从未实现**（发现 3）。实际只有：到期 / `revive` / `setAccountDisabled(false)` / `clearCooldowns` | `until` + `coolKind='hard'` + `reason` | `healthy()` `state.ts:361`；`enforceBurnRate` 守卫 `DO:1335`；`diagnoseAccount` `:573`（按 `coolKind` 选文案） | ⚠️ 恢复条件与两处注释不符（发现 3）；`until` 被无条件覆盖，可能缩短既有更长冷却 |
| `breaker` | `applyFailure({kind:'breaker'})` 每次 `fails += 1`，**≥3 次**才生效（`DO:1080-1088`）；调用点：5xx/网络失败/流中断（`server.ts:2181`、`:2408`、`:2697`） | `30min × 2^retryCount`，**封顶 6h**（`DO:1083`）；成功后 `retryCount` 归零 | 到期；`noteSuccess` 清 `breakerUntil`+`retryCount`+`fails` | `breakerUntil` + `retryCount` + `fails` | `healthy()` `state.ts:362`；`unavailableReason` `DO:370`；`diagnoseAccount` `:533` | ✅ 一致。注：`retryCount` 只能靠 `noteSuccess` 或 `setAccountDisabled(false)` 清，`clearCooldowns` 的门槛会漏掉它（发现 9） |
| `degrade` | `applyFailure({kind:'degrade'})` 每次 `consecutiveFails += 1`，**≥5 次**才生效（`DO:1089-1096`） | **固定 10 分钟**（`DO:1092`） | 到期；`noteSuccess` 清零并清 `degradeUntil` | `degradeUntil` + `consecutiveFails` | `healthy()` `state.ts:363`；`unavailableReason` `DO:371`；`diagnoseAccount` `:534` | ⚠️ 时长/触发一致，但**语义与文档不符**：`state.ts:14` 说「降权，别当首选」，实际是 `healthy()` 直接排除（发现 13a） |
| `restricted`（任务书未列） | `applyFailure({kind:'restricted'})`，来自 `request_illegal`（11140），**单次即罚**（`DO:1073-1079`） | **固定 2 小时**（`RESTRICTED_HOLD_MS`，`state.ts:109`），取 `max(prev, now+2h)` | 到期；或 `clearAccountRestriction`（`DO:1909`） | `restrictedUntil` | `healthy()` `state.ts:366`；`unavailableReason` `DO:372`；`diagnoseAccount` `:535` | ⚠️ `modelExempt` 漏检（发现 6）；`revive`/`clearCooldowns` 不清（发现 9）；`pick` 本身正确 |
| `session_dead`（任务书未列） | `applyFailure({kind:'session_dead'})`，12153 连续 **≥3** 次（`DO:1097-1106`） | **无时长** —— 直接 `disabled = true`（终态） | 只有 `setAccountDisabled(false)`。`revive` 刻意不动 `disabled` ⇒ **重新登录不复活**（发现 9） | `disabled` + `reason` + `sessionDeadFails` | `healthy()` `state.ts:360`；`counts()` `DO:936`；`pick` 经 `healthyForModel` | ⚠️ 恢复路径与 `DO:1423` 的表格不符（承诺「重新登录」） |

**跨维度结论**：`until` / `breakerUntil` / `degradeUntil` / `restrictedUntil` / `modelCooldowns` 五个字段**都真实参与 `pick` 的过滤**（经 `healthyForModel → healthy`），没有「写一个读另一个」的错配 —— 这一层是干净的。漂移全部出在**写入端的边界条件**（`resetAt` 钳制、`coolKind` 覆盖、恢复条件未实现）和**旁路判据**（`modelExempt`）。

---

## blame 生命周期表（必须）

`blame` 是 `server.ts` 的局部数组，两条 chat 路径各一个（`:1060`、`:2060`）。`push` 2 处、`settleBlame` 4 处、丢弃日志 2 处。

| 路径 | 位置 | push blame | settleBlame | 全失败时丢弃 | 判定 |
|---|---|---|---|---|---|
| buddy 主成功（首帧到达） | `server.ts:1448-1462` | 是（前几轮 `:1272`） | ✅ `:1460` | — | 正确（`onFirstChunk` 对非流式也触发：`nonStreamingResponse` 在**通过空响应守卫之后**的 `:3148` 调 `hooks.onFirstChunk()`，已核对） |
| buddy `pick` 返回 undefined（无候选） | `:1112-1158`（`:1148` / `:1152`） | 可能有（前几轮累积） | ❌ | ❌ **连日志都没有** | 丢弃正确、可观测性缺失（发现 11） |
| buddy → workbuddy 跨渠道容灾 | `:1127` | buddy 的 blame 被遗弃 | ❌ | ❌ | 静默丢弃；新函数有独立空数组。丢弃语义可接受（换渠道后成功并不证明 buddy 号坏了），但无日志 |
| provider 续期重试成功（catch 分支） | `:2161-2172` | 是（`：2325`） | ✅ `:2170` | — | 正确（HEAD 22857c4 补） |
| provider 上游非 ok → 续期重试成功 | `:2386-2398` | 是 | ✅ `:2396` | — | 正确（同上） |
| provider 主成功（含非流式聚合） | `:2669-2693` | 是 | ✅ `:2691` | — | 正确（同上） |
| provider → buddy 反向容灾 | `:2795` | provider 的 blame 被遗弃 | ❌ | ❌ | 同第 4 行 |
| 全部轮转失败（buddy 尾部） | `:1545-1550` | — | — | ✅ 有日志 | 正确 |
| 全部轮转失败（provider 尾部） | `:2806-2811` | — | — | ✅ 有日志 | 正确 |
| 客户端在首帧前断开 | `onFirstChunk` 未触发 | 是 | ❌ | ❌ | 设计取舍（不可归因于账号），但同样无日志 |
| 零输出越墙 ⇒ `continue` | `:1407-1420` / `:2661-2666` | ❌（走 `kind:'model'` 立即记账 + 显式 `resetAt`） | — | — | 正确：不污染 breaker，且注释 `:1408-1409` 明确解释了为什么不能升成 breaker |

> 核对备注（纠正一处常见误解）：**buddy 路径没有「401 → 续期 → 重放」分支**（`grep refresh|401|isAuthLike` 在 `:1090-1448` 区间只命中一句注释），失败一律 `continue` 换号。续期只在 provider 路径（`:2148`、`:2373` 两处）+ 每小时 cron 的主动续期里做。因此本表没有「buddy 续期重试」这一行 —— 它在结构上不存在。这不是 blame 的缺陷，但意味着「buddy 凭据在两次 cron 之间过期」时会直接失败到下一个整点；因 cron 是「提前 1 小时刷新」（`index.ts:4432` 起），实际窗口很窄，故未单列为发现。

**语义差别的处理是否正确**：`blame` 只收 `breaker` / `degrade` / `soft`（类型 `FailureKindForBlame`，`:194`）—— 这三种都是「累加型计数、靠换号成功才反推」；`restricted` / `model` / `hard` / `session_dead` 一律立即记账，因为它们有明确的上游证据或非累加。**这个划分本身是正确的**，`soft` 在 `deferSoft()` 下加入 blame 也有充分理由（`:1062-1087`）。唯一的语义缺陷是 blame 元素丢字段（发现 4）。

**「全部候选失败 ⇒ 丢弃 blame」的判据是否精确**：判据本身（「没有换号后成功这个证据」）是精确的，`blame.length === 0` 早退也对。不精确的是**覆盖度**：丢弃动作只在循环自然结束时执行（`:1545`、`:2806`），4 个早退出口没有（发现 11）。功能上等价（都是丢弃），差别只在日志。

---

## 账号选取过滤表（必须）

`pick()`（`AccountPoolDO.ts:559-760`）的候选过滤顺序：`provider` → `exclude` → `pruneExpired` → `healthyForModel` → 永久积分锁 → （指定账号 / 粘性 / 防惊群 / 策略排序）。

| 字段 | 是否参与过滤 | 读取位置 | 备注 |
|---|---|---|---|
| `disabled` | ✅ 排除 | `state.ts:360`（经 `healthy`） | 也在 `counts():936` 单列 |
| `until` | ✅ 排除 | `state.ts:361` | 五个冷却字段里唯一会被 `soft`/`hard` 两个维度共用的 |
| `breakerUntil` | ✅ 排除 | `state.ts:362` | |
| `degradeUntil` | ✅ 排除 | `state.ts:363` | 名为「降权」，实为排除（发现 13a） |
| `restrictedUntil` | ✅ 排除 | `state.ts:366` | 注释 `:364-365` 明确解释了为什么必须真的不派单。**但 `modelExempt()` 不看它**（发现 6） |
| `modelCooldowns[model]` | ✅ 排除（仅对该 model） | `state.ts:379-383` | `auditOnly` 条目不参与；`model === ''` 时整体短路（`:378`，`PickRequest` 的 docstring 要求「model 必须真的传」） |
| `modelConfirm[model]` | ❌ 不参与 | 只写（`DO:1189`） | 仅驱动阶梯档位 |
| `credits` | ❌ **不参与排除** | 仅两处：`:624` 永久积分锁判据（要求 `credits > 0 && creditsExpiring === 0`）、`:717` `random` 策略权重 `1 + credits/100` | **`credits === 0` 不会误排除健康账号** —— `:622-623` 有显式注释解释「0 = 没钱了，走 402 硬冷却，不是『只剩永久』」。历史缺陷（面板 0 / 上游 2870）的根因是**从未写入**该字段，已由 `updateBalance`（`:1293-1315`）+ 整点 cron（`index.ts:4363-4418`）修复；且「查不到不写 0」（`:1479`、`:4405`）。**本项已修好，不重复报** |
| `creditsExpiring` | ✅ 仅用于永久积分锁判据 | `:624` | |
| `creditsEarliestExpiry` | ✅ 参与排序（`expiry` 策略） | `:739-740` | `0` 或已过期视为 `+∞`（排最后） |
| `provider` | ✅ 排除（`wantProvider` 非空时） | `:598` | 注释 `:257-261` 明确说必须在这里筛，不能在返回后筛 |
| `exclude`（已尝试） | ✅ 排除 | `:606` | |
| `recentlyPicked`（防惊群） | ⚠️ 软过滤 | `:709-710` | 3 秒窗口内刚选中的**优先排除**，排除后为空则回落到全部候选（不报「无可用账号」）。进程内 Map，DO 回收即重置 |
| `preferred`（会话粘性） | ❌ 不排除，仅提前 | `:678-685` | 只在候选集内提权，不绕过任何健康检查；放在防惊群**之前**（有意，`:706-708`） |
| `pinned` / 面板 `pin` | ⚠️ 特殊 | `:583-655` | `only`：命中即用，不可用则返回 `pinnedUnavailable`（**不回落**）；`prefer`：不可用则自然回落 |

**单账号池的特殊处理是否一致**：`pick()` 内部**没有**针对 1 个账号的特殊分支 —— 防惊群在 `fresh` 为空时回落 `candidates`（`:710`），单账号池因此不会「自己把自己排除」，行为正确。单账号池的特殊逻辑全在网关侧的 `deferSoft()`（两条路径各一份，其中 provider 路径那份有分片 bug，见发现 1）。

**确定性**：`roundrobin` / `expiry` 分支用 `notePickedAt` 升序 + `uid.localeCompare` 做二级排序（`:741-747`），在时钟相同时仍然确定 —— 这一点做对了。`random` 分支按设计不确定。`pick` 本身不做「余额排序」，`expiry` 只按 `creditsEarliestExpiry` 排，与 `RoutingConfig.strategy` 默认值 `'expiry'`（`:832`）一致。

---

## 本模块亮点

值得保留、不要在后继重构里改坏的设计：

1. **`state.ts` 的判据收敛做得很好**。`healthy()` / `healthyForModel()` / `isActive()` / `diagnoseAccount()` 全部复用同一个 `isActive()`，`diagnoseAccount` 的 docstring（`:526-528`）明确写了「所有判据都复用 `isActive()`，不另写一套」。除了 `modelExempt`（发现 6）这一处漏检，五个冷却字段的读取口径是**单一来源**的 —— 这在同类项目里很少见。
2. **`degrade` / `breaker` 的「阈值 + 指数退避 + 成功清零」三段式没有互相污染**：`fails`（喂 breaker）与 `consecutiveFails`（喂 degrade）是两个独立计数，`noteSuccess` 一起清零，`softStreak` 又是第三个。三者语义分离，没有复用同一个计数器。
3. **模型级冷却的「验证式阶梯」是正确的方向**（`DO:1121-1175`）。旧策略「一次 `not found` 锁 6 小时」是典型的过宽字符串匹配事故，现在改成「先锁 2 分钟观察窗、失败自然坐实后升级」，并且**刻意不用 `hits` 而用账号级 `modelConfirm`**（`:1116-1119`）—— 因为 `pruneExpired` 会删掉冷却条目、`hits` 随之归零，这个坑抓得很准。
4. **`noteSuccess` 按证据强度分治模型冷却**（`:1200-1253`）：`busy` 不清（成功一次不构成解除限频的证据）、`absent`/`denied` 真实成功即清（成功是最强反证）。这是「正交性」原则的正确落地，注释里保留了旧规则的死锁案例，防后人改回去。
5. **`applyFailure` 入口统一打 `[punish]` 日志**（`:1035-1039`）。这是「一处覆盖全部 14 个调用点」的正确做法 —— 比在每个调用点各打一条可靠得多。本报告里多条建议（`resetAt` 钳制、丢弃 blame）都沿用了同一模式。
6. **独立 storage key 的纪律**（`PERMANENT_LOCKS_KEY` / `ACCOUNT_PINS_KEY` / `API_KEYS_KEY`，`:109-136`）。注释里那起「旧代码整体写入把新字段静默抹掉、继续烧不可撤回的永久积分」的事故链写得非常清楚，是本仓库最有价值的架构约束之一。
7. **`burn-rate.ts` 是纯函数**（`:125-166`），副作用全部留给调用方；`detectBurnRate` 对 `samples.length < 2` / `first.at === last.at` / `first.credits <= 0` / `burned <= 0` 四种退化情形全部显式早退，没有一处会算出 `NaN` 或 `∞`。且 `DEFAULT_BURN_RATE_WINDOW_MS` 的注释（`:60-77`）解释了「为什么不是 5 分钟」—— 因为采样频率只有每小时一次，窗口小于采样间隔会让检测**永远休眠**。这类「参数必须与采样频率匹配」的推理很少见。
8. **`pick` 的 provider 过滤放在候选构造里**（`:598`），而不是「先选后筛」。注释（`:257-261`）记录了「先选后筛会表现为 pick 返回了号、调用方却拿不到人」的实际踩坑。
9. **`normalizeAccountState` 的逐字段重建 + 往返测试**（`tests/state.test.ts:250-297`）是对「加字段忘补」这类 bug 的通用防线，而且它已经被一次真实事故（`1ae629f`）证明有效。

---

## 测试缺口

按「本报告哪条发现没有测试能抓住」组织，而不是罗列测试文件。

| # | 缺口 | 现状 | 后果 |
|---|---|---|---|
| 1 | **`deferSoft()` 在 workbuddy 分片下的行为** | `tests/state.test.ts:604-606` 只数 `deferSoft` 的**声明次数**（`>= 2`），从不验证它在任何场景下为真 | 发现 1（`poolSize` 用错分片）完全无法被抓到。**这是本次最该补的一条**：构造 global 分片 1 个 workbuddy 账号 + 断言 `deferSoft()` 为真，或直接断言 `poolSize` 的来源与 `pick` 的分片一致 |
| 2 | **`resetAt` 的边界** | `grep resetAt tests/` 全部是「显式给一个合理的 `now+cooldown`」或 `resetAt: 0`；**没有一条测「远期 `resetAt`」**，也没有一条测「`resetAt` 与既有 `until` 的大小关系」 | 发现 2（无钳制）与「`soft` 绕过不延长守卫」都没有防线 |
| 3 | **`hard` 的恢复条件** | `tests/balance-refresh.test.ts:78-99` 测的是「soft 冷却下余额刷新不改 `until`」；`tests/burn-rate.test.ts:265-283` 测的是「hard 冷却下 burn-rate 不降级 `coolKind`」。**没有任何测试断言「余额恢复后 hard 冷却会解除」** | 发现 3 的两处矛盾注释没有任何测试对账。补法：`updateBalance(credits=1000)` 后断言 `until === 0`（先按建议 1 实现，再写这条测试，否则它会红） |
| 4 | **`applyFailure({kind:'soft'})` 直接作用在 hard 冷却账号上** | `burn-rate.test.ts:265` 只覆盖 `updateBalance → enforceBurnRate` 这一条（唯一有守卫的）路径 | 发现 5 无防线。补法：直接调 `pool.applyFailure({kind:'soft'})` 后断言 `coolKind` 仍为 `'hard'` |
| 5 | **`modelExempt` 与 `restrictedUntil`** | `tests/state.test.ts:97-103`、`:141-168` 覆盖了 auditOnly / 双真 / 过期三种情形，**没有一条**让 `restrictedUntil` 与 `modelCooldowns` 同时存在 | 发现 6 无防线。补法：`{restrictedUntil: now+2h, modelCooldowns:{x:{until:now+1h}}}` ⇒ `modelExempt` 必须为 `false` |
| 6 | **blame 的字段完整性** | `tests/state.test.ts:579-641` 全是**源码文本断言**，没有一条验证「blame 结算后 `until` 是否对齐了上游 `resetAt`」 | 发现 4 无防线。补法：给 `settleBlame` 加一个「结算后 `until` 必须等于 resetAt」的集成断言（或单元测 `FailureKindForBlame` 的元素类型含 `resetAt`） |
| 7 | **`applyFailure` 调用点的归属（第 ④ 条断言）** | 见发现 8：只断言 `applyCalls.length >= 2`，14 处调用全部「通过」 | 任何新增的「裸立即记账」调用都不会被抓到，而这正是本项目「只修一半」的高发形态 |
| 8 | **`settleBlame` 文本匹配可被注释满足** | `:621` 的正则对注释行同样匹配；`:625` 的 1200 字符窗口是按当前注释长度调出来的（注释里自己写了「实测最长间距 754 字符」） | 把 settle 注释掉 ⇒ 测试仍绿。补法：匹配前先剥注释（本仓库注释量极大，这是通用要求） |
| 9 | **「解冻」入口的完备性** | 没有任何测试断言「清完之后 `healthy()` 必须为真」 | 发现 9（三处入口各清一部分、`retryCount` 无处可清）无防线。补法：一条表驱动测试 —— 造一个五维度全中的账号，逐个入口清，断言哪个入口能让 `healthy()` 变真 |
| 10 | **`session_dead` → `disabled` → 重新登录** | `grep sessionDeadFails tests/` 只有 2 处，都是字段名而非行为断言：`tests/state.test.ts:131`（`noteSuccess` 清零的循环）与 `tests/accounts-diagnose.test.ts:34`（夹具）。**没有一条测试 `applyFailure({kind:'session_dead'})` 的「3 次 ⇒ `disabled`」迁移**，也没有一条测「重新登录后 `disabled` 是否解除」 | 「重新登录不复活」这条只能靠人工发现 |
| 11 | **`normalizeAccountState` 的嵌套字段** | `tests/state.test.ts:250-297` 的往返测试只比对**顶层数值字段**；`modelCooldowns` / `modelConfirm` / `tokenUsage` / `samples` 用的是 `obj()` 直接透传，**不校验内层** | `modelCooldowns[x] = {until: undefined}` 这类坏数据会让 `isActive(undefined, now) === false` ⇒ 静默解锁。`tests/account-pins.test.ts:141` 自己就构造了 `{until} as never` 这种残缺条目，说明残缺条目在生产里是可能的 |
| 12 | **`pick` 对 `breakerUntil` / `degradeUntil` / `restrictedUntil` 的排除** | `tests/account-pins.test.ts:124-146` 覆盖了 `disabled` / `until` / `modelCooldowns`；另外三个维度只有 `healthy()` 的单元测试（`state.test.ts`），没有一条「经 `pick` 端到端排除」 | 因为 `pick` 确实走 `healthyForModel → healthy`，风险低；但若有人把 `pick` 的过滤改成「自己写一份」，这三条就没人守。建议补一条表驱动 |

**另外两条方法论建议**（不是缺陷，是防止本次发现复发）：

- 本仓库的注释承载了「防止后人改回去」的职责，因此**注释里的旧缺陷描述会污染 grep 结果**（任务书已点名）。本报告所有「零调用」结论都用了三种独立手段交叉验证（`grep src/` + `grep tests/` + `grep dist/server.mjs` 计数），建议把这条写进 AGENTS.md。
- `dist/server.mjs` 与 `src/` 同为 2026-10-21，可用于交叉验证「是否真的没人调用」。但它是构建产物，**不能作为唯一证据**。
