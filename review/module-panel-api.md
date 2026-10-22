# panel-server-api / panel-ui 模块审查

> 审查基线：工作区当前 `HEAD=cb6e586`，`package.json` 版本 **0.9.29**
> 纪律：**只读**。本次除本文件外未修改任何文件（`git status` 仅原有 `M src/gateway/server.ts` 与 `review/` 下的未跟踪文件）。
> 已读：`src/index.ts`（admin 全部 54 个分支）、`src/pool/{state,AccountPoolDO}.ts`、`src/gateway/{safety,server,http}.ts`、`src/panel/{index.ts,web/manifest.ts}`、`web/src/**`（40 个文件）、`src/panel/web/assets/*`、`tests/panel.test.ts`、`README.md`。

## 0. 先纠正任务书里的三处事实错误（否则会照错的路径去审）

| 任务书写法 | 实际 |
|---|---|
| `src/server/routes/admin.ts`（2049 行） | **不存在**。`src/server/` 只有 5 个文件 957 行（`index.ts`/`env.ts`/`storage.ts`/`namespace.ts`/`cf-shim.ts`），**不含任何路由**。全部 `/admin/*` 分支都在 **`src/index.ts`（4559 行）**：54 处 `path === '/admin/...'` 判断，**49 个唯一路径**。 |
| `src/server/routes/admin/*.ts`（7 个文件） | **不存在**（无 `routes/` 目录）。 |
| `src/panel-web/`（面板源码） | **不存在**。面板源码在仓库根的 **`web/`**（React + Vite，`web/src/**` 40 个文件）；`src/panel/` 是预编译产物落点（`src/panel/web/assets/*.js.txt` + 自动生成的 `manifest.ts`）。 |
| `resetAllCooldowns`、`killSession` | **不存在**。语义最接近的是 `POST /admin/cooldowns/clear`（index.ts:2978）与 `POST /admin/accounts/remove`（index.ts:1493）。下文按真实存在的危险接口审。 |

另：任务书提到的两条「已知线索」已在 `e3286da`（throttle 只接 provider 分支）与 `b7383f4`（`clearCooldowns` 漏 `modelCooldowns`/`restrictedUntil`）修好，本文**不重复报**；下面 F3 是**与 b7383f4 正交的第三层状态**（区域波次暂停），不在那次修复范围内。

---

## 发现清单

### [高] F1 线上服务的前端产物，仓库里没有任何源码能重建
- **位置**：`src/panel/web/assets/index-Dg0M0nJm.js.txt`（单行、503,302 B；对应 `web/dist/assets/index-Dg0M0nJm.js`，501,835 B）
- **证据**：
  - 7 个资产逐一 `md5sum` 比对，**只有 index 这一个不同**：`6328018b…`（仓库/线上）vs `8698d3f9…`（`web/dist`）；mtime `20:27` vs `12:42`，且 `src/panel/web/assets/index-*.js.txt` 比 `web/dist` **晚 7h45m、大 1,467 B**。其余 6 个（ConfigPage / ModelsPage / TasksPage / UsagePage / clock / css）字节级一致。
  - `difflib` 逐字符对齐后共 **17 处差异**，其中 15 处是**源码里根本不存在的功能**：
    ```
    A(dist): [...`控制台 · v`,`0.8.0`]        B(仓库): [...`控制台 · v`,`0.9.29`]
    + wbProbeHook(){... await L(`/admin/accounts/probe`,{json:{uid:v.uid}}) ... }
    + function wbRemain(e,t){...}   // "还剩 X 分钟"
    + wbUntil=(function(){let n=Math.max(e.until||0,e.breakerUntil||0,e.restrictedUntil||0); ... modelCooldowns ...})()
    + restricted:{label:`上游封号`,tone:`danger`}
    + wbProbe&&(0,h.jsx)(`button`,{...children:`探测`})
    ```
  - 而 `web/src` 侧：`grep -rn "probe" web/src` 只有**模型**探针（`web/src/lib/models.ts:124` `/admin/models/probe`），**没有**账号探测；`web/src/lib/status.ts:4-12` 只有 5 态（`ok/cooling/breaker/model/disabled`），**不看 `restrictedUntil`**；`web/src/lib/types.ts:21-39` 的 `Account` 也**没有** `restrictedUntil`（所以源码即使想渲染也编译不过）。
  - 唯一覆盖产物的测试只校验版本号：`tests/panel.test.ts:256-262` 断言"嵌入产物里能找到 `package.json` 的 version"。这次恰好因为有人把 `0.8.0` 手改成 `0.9.29` 才通过。
- **影响**：`web/src` 不是当前产物的源码，而是它的**退化前身**。任何人按 `scripts/embed-web.mjs` 的标准流程跑 `npm run build:web`（或 `npm ci && npm run build`），会**静默**删掉线上正在生效的三样东西：① 账号「探测」按钮（打一次真实上游判断号是否可用，后端 `index.ts:3635` 早已就绪）；② `restrictedUntil` → 「上游封号」状态列；③ 那段把 5 个维度取 max 的「还剩多久」倒计时。测试不会红（版本号仍对），控制台不会报错，只有用户发现"被封的号又显示正常了"。这正是本项目反复吃亏的**静默回退**形态。
- **建议**：把两处改动回写进 `web/src`（`status.ts` 加 `restricted` 态 + `types.ts` 加 `restrictedUntil/softStreak/lastCheckinDay` + `ProvidersPage` 加 probe 按钮），重跑 `build:web`；在 `tests/panel.test.ts` 加一条双向不变量（产物含 `restricted`/`/admin/accounts/probe` ⇒ `web/src` 必含对应标识；反之亦然），把"产物漂移"变成红灯。
- **工作量**：M（回写 3 处 + 重建 + 一条测试）
- **置信度**：确定

### [高] F2 `degradeUntil`：网关据它拒发，面板永远看不到 ⇒ 显示"正常"
- **位置**：`src/index.ts:3843-3880`（`/admin/accounts` 的字段白名单）
- **证据**：
  - 权威判据有 5 个维度：`src/pool/state.ts:367-375`
    ```ts
    export function healthy(state, now) {
      if (state.disabled) return false
      if (isActive(state.until, now)) return false
      if (isActive(state.breakerUntil, now)) return false
      if (isActive(state.degradeUntil, now)) return false
      if (isActive(state.restrictedUntil, now)) return false
    ```
  - 它真的会被置位：`src/pool/AccountPoolDO.ts:1122`（连续 5 次业务失败）`state.degradeUntil = now + 10 * 60 * 1000`
  - 但响应白名单里**没有** `degradeUntil`（`grep -n degradeUntil src/index.ts` → 0 命中）：`:3863 breakerUntil` / `:3868 restrictedUntil` / `:3869 softStreak` / `:3873 modelCooldowns`，**跳过 degrade**。
  - 面板判据同样缺：`web/src/lib/status.ts:6-12`（产物版 `lg()` 也一样，只多了 `restrictedUntil`）。
- **影响**：号被降权的那 10 分钟里，网关**选不中它**，而面板该行显示「正常」、没有任何"还剩 10 分钟"。更糟的是两处判据会当场打架：侧栏角标与"可用"数走 `counts()`（`AccountPoolDO.ts:945-981`，内部用 `healthy()`，降权算 `cooling`），于是出现**「角标：3 个账号在冷却 / 列表：3 行全部正常」**——用户无法解释这个 3 从哪来，也没有任何字段可查。这是本模块最典型的「双判据 + 静默给出错误结果」。
- **建议**：① `:3873` 之后补 `degradeUntil: a.degradeUntil`；② `status.ts` 加 `degrade` 态（label「降权中」）+ `Account` 类型补字段；③ 更彻底的做法：面板状态列直接消费 `GET /admin/accounts/diagnose`（已有 `blockedBy`/`reason`/`remainingMs`，且 `state.ts:537` 起复用 `healthy()`），不要在前端再实现第六套判据。
- **工作量**：S（① ② ）／M（③）
- **置信度**：确定

### [高] F3 账号级限制的「波次暂停」（整分片停派 30 分钟）面板看不见、也清不掉
- **位置**：`src/pool/AccountPoolDO.ts:254-262`（常量）、`:1906-1944`（触发）、`src/index.ts:3426-3459`（两个端点）、面板侧**零调用**
- **证据**：
  ```ts
  // AccountPoolDO.ts:254
  const RESTRICTION_WAVE_WINDOW_MS = 15 * 60 * 1000
  const RESTRICTION_WAVE_THRESHOLD = 2          // 15 分钟内 2 个不同账号被 11140 打标
  const RESTRICTION_POOL_HOLD_MS = 30 * 60 * 1000   // 整个区域 30 分钟不发任何上游请求
  ```
  ```ts
  // AccountPoolDO.ts:1915-1921  noteRestriction()
  if (Object.keys(gate.hits).length >= RESTRICTION_WAVE_THRESHOLD) {
    gate.until = now + RESTRICTION_POOL_HOLD_MS     // ← 整池暂停
  ```
  派单前会真的查它：`src/gateway/server.ts:1008-1013`、`:2188-2193`（`restrictionGateActive()` ⇒ 直接不派单）。
  而面板：`grep -rn "restriction" web/src src/panel/web/assets/*.js.txt` → **0 命中**；「清空全部冷却」只调两个方法，**不碰 gate**：
  ```ts
  // src/index.ts:2982-2984
  const cleared = await pool.clearModelCooldowns(realm, body.uid, body.model)
  const resetCount = await pool.clearCooldowns(realm, body.uid)   // 清 until/breaker/degrade/restricted/fails
  // 没有 clearRestrictionGate()
  ```
- **影响**：触发条件很宽松（15 分钟内**两个**号撞 11140，一次波次封锁很常见）。触发后用户点「解冻」→ toast「解冻 3 个账号」、列表全变正常 → **请求继续 100% 失败，最长 30 分钟**，面板没有任何提示、也没有按钮。`GET /admin/restriction/status` 与 `POST /admin/restriction/clear` 两个端点早已写好（连"带 uid 清单号/不带 uid 清波次"的语义都分开了），就是没人调用。这是「面板能改、后端仍拦」的第二个断点，且与 `b7383f4` 修的对象**不同层**（那修的是账号级 `restrictedUntil`，这是分片级 gate）。
- **建议**：`StatusCard` 加一张「区域暂停」卡，两分片各查 `GET /admin/restriction/status`，active 时显示"还有 N 分钟"，按钮接 `POST /admin/restriction/clear`（不带 uid）；同时把 `/admin/cooldowns/clear` 的文案改成"不解除区域暂停"，或在它里面顺带 `clearRestrictionGate()`。参照已有的 WAF 卡（`web/src/pages/ConfigPage.tsx:527-580`，同样的 30 分钟闸门，功能齐全）照抄即可。
- **工作量**：S-M
- **置信度**：确定

### [中] F4 `/admin/providers/models` 的候选过滤自称"与 `pick()` 一致"，实际少两个维度
- **位置**：`src/index.ts:3214-3219`
- **证据**：
  ```ts
  // 判据与 `pick()` 的健康检查保持一致。      ← 注释
  if (a.disabled === true) continue
  if (a.until > Date.now() || a.breakerUntil > Date.now()) continue
  ```
  而 `pick()` 走的是 `healthy()`（`state.ts:367-375`），还含 `degradeUntil` 与 `restrictedUntil`。注释与实现不符。
- **影响**：可能挑一个**上游已标 11140、还剩 2 小时**的号去拉模型目录，白打一次上游；若它回 401/403，面板会显示「登录态已过期」——把用户引向"重新登录"，而真相是账号被限流（这条错误文案在本仓库历史上已被记为"极具误导性"，见 `index.ts:3200-3208` 的注释）。
- **建议**：这三行直接换成 `if (!healthy(a, Date.now())) continue`（`healthy` 已从 `pool/state.ts` 导出），一处判据、一处维护。
- **工作量**：S
- **置信度**：确定

### [中] F5 导入全部失败时，面板照样弹「账号已导入」
- **位置**：`web/src/lib/queries.ts:186` + `:153-163`；后端 `src/index.ts:3558`
- **证据**：
  ```ts
  // queries.ts:186
  export const useImportAccount = () => useAction((payload) => api('/admin/import', { json: payload }), ['accounts','pool'], '账号已导入')
  // queries.ts:157-159  useAction 的 onSuccess：无条件 toast，从不看响应体
  onSuccess: () => { for (const k of invalidate) qc.invalidateQueries({queryKey:[k]}); if (ok) toast.success(ok) }
  ```
  ```ts
  // index.ts:3558 —— 全部条目被跳过时依然是 200
  return json({ ok: imported.length > 0, imported, skipped })
  ```
  `AddAccountDialog` 只显示本地 JSON 解析错误（`AddAccountDialog.tsx:24`），`skipped[].reason` 在整个 `web/src` 里**无人读取**。
- **影响**：粘错格式 / `CREDENTIAL_KEY` 未配 / uid 非法 / 供应商识别失败时，后端逐条 `skipped.push({reason})` 并回 200，面板弹「账号已导入」、对话框关闭、列表里没有新号。用户会重复粘贴，每次都"成功"，永远看不到真正的原因（`skipped` 里明明写着）。属典型静默失效。
- **建议**：`imp.mutate(payload, { onSuccess: (r) => r.ok ? toast.success(`已导入 ${r.imported.length} 个`) : toast.error('导入失败', { description: r.skipped[0]?.reason }) })`；部分成功时显示「成功 N / 跳过 M」并可展开 `skipped`。
- **工作量**：S
- **置信度**：确定

### [低] F6 `/admin/config/safety` 的注释说"按 realm 读"，实现硬编码 `cn`；运行时缓存还是单槽
- **位置**：`src/index.ts:3032-3037`；`src/gateway/safety.ts:26,105`
- **证据**：
  ```ts
  // ⚠️ 与 `/admin/config/routing` 同款双分片镜像：配置读的是「发起该请求的 realm」
  if (path === '/admin/config/safety' && request.method === 'GET') {
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))   // ← 恒 cn，且没有 realm 参数
  ```
  ```ts
  let cached: { at: number; value: SafetyConfig } | undefined   // 不分 realm
  if (cached !== undefined && now - cached.at < SAFETY_TTL_MS) return cached.value
  ```
- **影响**：今天不炸（POST 会把同一份 config 镜像给 `cn` 与 `global`）。但镜像**非原子**：`:3041-3044` 先写 cn 再写 global，global 抛错时接口 500 而 cn 已落盘 ⇒ 两分片长期漂移，此时面板只显示 cn 的值、运行时只认"10 秒内先被读到的那一个分片"，**没有任何告警**。注释会让下一个维护者以为 realm 维度已经处理过。
- **建议**：GET 接受 `?realm=` 并在面板两分片都读、不一致时红字提示；或直接删掉误导注释并注明"配置是全局单值，镜像只是兼容"；`setSafetyConfig` 的镜像失败至少要 `console.error`。
- **工作量**：S
- **置信度**：确定（注释与实现不符）／待确认（生产两分片是否已漂移，需 `curl` 两个 DO 的 `getSafetyConfig` 比对）

### [低] F7 `auditOnly` 是"设计出来但从未置真"的死概念，且有 4 处分支依赖它
- **位置**：`src/pool/AccountPoolDO.ts:1215-1223`（唯一写入点）
- **证据**：全库只有一处赋值且写死 `auditOnly: false`；而下列分支都要求它为 `true` 才生效：
  `src/pool/state.ts:390`（`healthyForModel` 跳过审计条目）、`:406`（`modelExempt` 不把审计条目算作限流）、`:562`/`:588`（`diagnoseAccount` 的 `blockedBy` 与"正在冷却的模型"）。
- **影响**：这 4 条分支当前不可达（读代码时容易被误导成"已实现"）；同时 `/admin/accounts` 的映射（`index.ts:3873-3878`）**不返回 `auditOnly`**，只回 `until/reason/hits`，而面板判据是 `modelCooldowns.some(m => m.until > now)`——一旦将来真产生审计条目（`until > 0`），面板会把"仅审计、不拦选号"的条目显示成「模型限流」，又是一处双判据。
- **建议**：二选一——删掉 `auditOnly` 字段与 4 处分支；或保留但在映射里带上 `auditOnly` 并让 `status.ts`/`wbUntil` 跳过它。
- **工作量**：S
- **置信度**：确定

### [低] F8 `realm` 白名单只在 `/admin/pins` 校验，其余 10+ 接口照收
- **位置**：`src/index.ts:2521-2522`（**有**校验）
  ```ts
  if (realm !== 'cn' && realm !== 'global') return jsonError(400, 'realm 只能是 cn 或 global', 'invalid_request_error')
  ```
  对照 `:3823`（accounts）、`:3570`（pool）、`:3273`（usage）、`:3303`（logs）、`:3404`（waf）、`:2979`（cooldowns/clear）等，一律 `url.searchParams.get('realm') ?? 'cn'` 后直接 `idFromName(realm)`。
- **影响**：`?realm=Global`（大小写笔误）会 `idFromName('Global')` **新建一个 DO**（`migrate()` 建表并常驻），返回空账号/0 计数，看起来像"账号全丢了"。属"只修一半"的校验分裂；影响面限于管理员自己敲错。
- **建议**：抽 `realmOf(url|body)` 统一白名单，非法直接 400；`/admin/pins` 已经是范本。
- **工作量**：S
- **置信度**：确定

### [低] F9 README 的管理接口清单比实际少 5 条（含整个「防封」配置）
- **位置**：`README.md:352`（"`/admin/*`，仅主密钥，共 **44** 个路径"）
- **证据**：实际 **49** 个唯一路径（脚本按 `path === '/admin/...'` 统计）。README 缺：`config/safety`（**面板「防封」整块配置的落点**）、`accounts/diagnose`、`accounts/probe`、`restriction/status`、`restriction/clear`。
- **影响**：照文档排障的人找不到防封配置的读写端点，也找不到区域暂停——正好是 F2/F3 需要的两个入口；"44"这个数字本身也会让人以为已经列全。
- **建议**：补齐 5 条；计数改成按分类不写死总数（或加一条测试断言 README 路径集合 == 代码路径集合）。
- **工作量**：S
- **置信度**：确定

### 死代码清单（专项 3，不单列严重度）
- **零调用者的 admin 路由**：`GET /admin/restriction/status`、`POST /admin/restriction/clear`、`GET /admin/accounts/diagnose`。三者在 `web/src`、`src/panel/web/assets/*`、`tests/`、`README.md` 里**全都没有引用**（`tests/accounts-diagnose.test.ts` 只测纯函数 `diagnoseAccount`，不测路由）。它们恰好就是 F2/F3 缺的那套"权威判据 + 人工纠正"入口。
- **有文档/测试但面板无 UI**（**不算死代码**，如实标注）：`/admin/usage/clear`、`/admin/packages`（README:361 有列）、`/admin/tasks/{scan,run,start}`（README + `AGENTS.md:1722` 有实测记录）——都是给 `curl` 用的运维接口。
- **`auditOnly`**：见 F7。
- **反向检查（前端调了不存在的接口）**：**0 条**。用脚本把 `web/src` 里 40 个 `/admin/*` URL、以及产物里 41 个（多出 `/admin/accounts/probe`）与后端 49 条路径求差，`前端 − 后端 = ∅`。

---

## 面板开关 ↔ 后端消费 对账表（核心产出）

约定：「后端读取点」列的是**真正消费该值**的代码，不是存储点。所有 `SafetyConfig` / `RoutingConfig` 的写入口都是 `src/index.ts:3039` / `:3056`（**都镜像 cn+global**，故不再逐行注明分片）。

### 配置页 · 路由与调度（`RoutingConfig`，`web/src/pages/ConfigPage.tsx:221-300`）

| 面板控件 | 存储字段 | 后端读取点 | 是否生效 | 备注 |
|---|---|---|---|---|
| 选号策略（临期优先/轮询/随机） | `strategy` | `AccountPoolDO.ts:735` → `:737`(random)/`:757-766`(expiry/roundrobin) | ✅ | 三值全覆盖；`expiry` 用 `creditsEarliestExpiry`，空值视为最晚 |
| 失败换号次数（0-10） | `maxRetries` | `gateway/server.ts:126-134` `maxRotateFor()` | ✅ | 进程内缓存 30s、**不分 realm**（镜像后值相同，暂无影响） |
| 限流冷却起步（10-3600s） | `softCooldownSeconds` | `AccountPoolDO.ts:1032`（`softBaseMs`）、`:1089`（指数退避起点） | ✅ | 仅 `kind==='soft'` 生效；hard/breaker 用各自常量（语义正确） |
| 自动签到与每日任务 | `autoTaskCron` | `index.ts:4483-4487`（cron 到点后再次检查） | ✅ | 读的是 **cn 分片**的 config（`:4426`）；镜像后一致 |
| 自动续期登录凭据 | `autoRefreshCredential` | `index.ts:4449-4452`（跳过 `refreshExpiringCredentials`） | ✅ | 同上，只读 cn |

### 配置页 · 防封（`SafetyConfig`，`ConfigPage.tsx:398-505`）

| 面板控件 | 存储字段 | 后端读取点 | 是否生效 | 备注 |
|---|---|---|---|---|
| 会话链（b3 三件套）开关 | `sessionTrace` | `gateway/safety.ts:114` `setSessionTraceEnabled()` → `upstream/headers.ts:253` | ✅ | 只关 b3，`x-conversation-*` 5 个必需头恒发（`:240-252` 的注释解释了为什么） |
| 单请求消息数上限（0=不限） | `maxContextMessages` | `gateway/server.ts:848-859`（`trimMessagesByLimit`） | ✅ | `/v1/responses` 复用 `handleChatCompletions`（`responses.ts:900`），故两条入口都生效；`0` 正确表示"不限" |
| 消耗熔断窗口（分钟） | `burnRateWindowMs` | `AccountPoolDO.ts:1362`（`enforceBurnRate`）→ `:1365` 为 0 直接返回 | ✅ | 面板 ms↔min 双向换算，边界 1440min=86,400,000ms 与后端上限一致 |
| 消耗熔断阈值（%） | `burnRateThresholdPct` | 同上 | ✅ | 与窗口**任一**为 0 即关闭 |
| 每账号 QPS 上限（0=不限） | `rateLimitQps` | `gateway/safety.ts:115` `configureThrottle()` → `throttleUpstream` | ✅ | 接在 buddy 主路径（`e3286da` 已修，不重复报） |
| 请求前随机抖动（ms） | `rateJitterMs` | 同上 | ✅ | 同上 |

### 配置页 · 运行状态 / 永久积分锁（`ConfigPage.tsx:527-690`）

| 面板控件 | 存储字段 | 后端读取点 | 是否生效 | 备注 |
|---|---|---|---|---|
| 「解除 IP 级拦截」 | `/admin/waf/clear {realm}` | `index.ts:3413` → `pool.clearWafGate()` | ✅ | 面板两分片各发一次（`config.ts:139-152`）；WAF 闸门有完整 UI |
| 「清空全部冷却」（带确认弹窗） | `/admin/cooldowns/clear {realm,uid?}` | `index.ts:2978-2987` | ⚠️ **只清两层，第三层(波次暂停)不动** | 见 **F3**：账号级 + 模型级都清（`b7383f4` 已修），但 `restrictionGate` 与它无关，用户点完仍可能全失败 |
| 每供应商「永久积分锁」 | `/admin/permanent-locks {provider,locked}` | `index.ts:2482-2499` → `setPermanentLock` | ✅ | 面板只传 `{provider,locked}`（`config.ts:101`），后端签名与之匹配；写的是 cn 全局值 |
| 运行状态卡（只读统计） | `GET /admin/pool?realm=` | `AccountPoolDO.ts:945-981` `counts()` | ⚠️ **与账号列表口径不一致** | 见 **F2**：角标用 `healthy()`（含 degrade），列表用前端 5 态判据 ⇒ 数字与行互相矛盾 |

### 供应商 / 账号页（`web/src/pages/providers/*`）

| 面板控件 | 存储字段 | 后端读取点 | 是否生效 | 备注 |
|---|---|---|---|---|
| 停用 / 启用供应商 | `{order,disabled}`（cn 全局） | `index.ts:3017-3030` → `setProviderSettings`；消费于 `/v1/models` 与路由 | ✅ | 未知 id 被丢弃（`:3021-3023`），不会留脏数据 |
| 拖动排序 | `order` | 仅面板展示（`queries.ts:13-20` `sortByOrder`） | ✅（设计如此） | 头注释明确"排序不影响默认供应商" |
| 设为指定账号（只用它 / 优先用它） | `/admin/pins {realm,uid,mode}` | `index.ts:2518-2549` → `setPin(uid,mode,expected)` | ✅ | 唯一**校验 realm 白名单**的接口（`:2521`）；取消时发 `{realm,provider,uid:''}`，后端要求 provider（`:2526`）——契约吻合 |
| 停用 / 启用账号 | `/admin/accounts/toggle {uid,realm,disabled}` | `index.ts:1415-1431` → `setAccountDisabled` | ✅ | 需要 `disabled` 是 **boolean**，面板传 `!a.disabled` ✓ |
| 删除账号（带确认） | `/admin/accounts/remove {uid,realm,confirm:true}` | `index.ts:1493-1511` | ✅ | 后端强制 `confirm === true`，否则 400 `confirm_required`；面板 `queries.ts:181` 一直带 |
| 刷新余额 | `/admin/accounts/balance {realm,uid}` | `index.ts:1445-1490` → `updateBalance` + `enforceBurnRate` | ✅ | 失败**不写 0**（`:1481` 注释）；面板 60s 超时（`queries.ts:255`）与后端 20s/账号匹配 |
| 「探测」（当前是否可用） | `POST /admin/accounts/probe {uid}` | `index.ts:3635` | ✅ **后端已就绪，但只在产物里有按钮** | 见 **F1**：`web/src` 没有这个按钮，重建即消失。另：面板 `api()` 默认 30s 超时，而后端探测无超时（父代理清单 F1），长排队时会显示"请求超时"而后端仍在跑——**不重复计缺陷**，仅记交互后果 |
| 导入凭据 | `POST /admin/import {…payload}` | `index.ts:3464-3558` | ⚠️ **契约对，反馈错** | 见 **F5**：全跳过也回 200，面板无条件报"账号已导入" |
| 面板登录（设备码/扫码/短信） | `/admin/providers/login/*`、`/admin/login/*` | `index.ts:1517-2470` | ✅ | 轮询 3s；`safeHref` 只放行 https/本机 http（`LoginFlow.tsx:63-72`） |

### 模型页 / 任务页 / 子密钥页 / 日志页

| 面板控件 | 存储字段 | 后端读取点 | 是否生效 | 备注 |
|---|---|---|---|---|
| 模型开关（单个 / 批量） | `disabledModels[provider]` | `index.ts:2827/2849` → `writeDisabledModels`；读时**合并 cn+global**（`:3255-3261`） | ✅ | 写用 `realmForProvider()` 选分片，读时合并，不会"在另一分片关掉的模型又活了" |
| 免费模型探针 | `POST /admin/models/probe {model,credits}` | `index.ts:2868` | ✅ | 结果缓存在 localStorage（`models.ts:91`），"清空缓存"按钮只删本地键，无后端交互（设计如此） |
| 一键签到（全部供应商） | `/admin/checkin/all {realm}` | `index.ts:2676-2785` | ✅ | 面板**两分片都发**（`tasks.ts:82-86`），国际版走 `intlDaily` 入队 |
| 每日任务入队 | `/admin/tasks/daily-all {realm:'cn'}` | `index.ts:2787-2825` | ✅（刻意只 cn） | 后端只处理 `provider === DEFAULT_PROVIDER`；国际版权限不同，走签到入队，**不是漏** |
| 补偿「查询」/「领取」 | `/admin/compensation`、`/claim` | `index.ts:2557/2604` | ✅ | 面板两分片都发（`tasks.ts:129-160`），`provider=buddy` |
| 任务进度 | `GET /admin/tasks/status?uid=` | `index.ts:3924-3930` | ✅ | `RunState` 字段（queue/done/finished/lastError/startedAt/updatedAt）与 `TaskRunnerDO.status()` 一致 |
| 新建 / 编辑 / 重置 / 停用 / 删除子密钥 | `/admin/apikeys*` | `index.ts:3087-3183` | ✅ | 重置返回的**新明文**由页面 `onSuccess` 接住并弹一次（`ApiKeysPage.tsx:157-162`）——这条链路是通的（我特意反查过，因为 `useAction` 本身会丢响应） |
| 日志筛选 / 刷新 / 清空 | `GET /admin/logs?realm=&limit=200`、`POST /admin/logs/clear` | `index.ts:3302-3317`；`AccountPoolDO.ts:1809-1812` | ✅ | `limit` 被夹到 `[1,200]`，环形缓冲本身也是 200，**不会全量返回** |
| 用量时间窗（今日/7/30/全部） | `GET /admin/usage?realm=&days=` | `index.ts:3272-3291` | ✅ | `days=0` 表示全部，非法值回退 0（不猜），面板 `days===1` 才画按小时 |

---

## admin 路由鉴权表

**结论先说**：49 条路由**全部**位于同一个前置守卫之后（`src/index.ts:1287` `if (!(await authorized(request, env)))`），该守卫在 `/admin/*` 上**只认主密钥**（`:1286` `isV1Path` 判定 ⇒ 子密钥只在 `/v1/*` 才被 `authenticate()` 尝试，`:1289-1295`）。`authorized()` 是 **fail-closed**（`env.API_KEY` 未配置时**拒绝一切**，`:223-224`）且用 `crypto.subtle` 做**常数时间比较**（`:210-221`）。因此**不存在「读校验了、写忘了校验」的缺口**，也**不存在子密钥越权**——这是我逐条核对 49 个分支后能给出的确定结论（守卫位于 `:1287`，其后到文件末尾 `:4559` 之间没有任何 `return` 旁路；守卫之前只有 `/healthz`、`/login` 302、`/panel*` 静态、`/favicon.ico`、两条登录回调）。

| 路由 | 方法 | 鉴权 | 子密钥作用域 | 结论 |
|---|---|---|---|---|
| `/admin/accounts` | GET | 主密钥（统一守卫 :1287） | 拒绝（非 `/v1/*` → 401） | ⚠️ 不校验 `realm`（F8）；响应字段缺 `degradeUntil`（F2） |
| `/admin/accounts/toggle` | POST | 同上 | 拒绝 | ✅ 校验 uid + `disabled` 类型 |
| `/admin/accounts/remove` | POST | 同上 | 拒绝 | ✅ 强制 `confirm:true` |
| `/admin/accounts/balance` | POST | 同上 | 拒绝 | ✅ 不传 realm 即两分片全刷 |
| `/admin/accounts/diagnose` | GET | 同上 | 拒绝 | ⚠️ 无任何调用者（死路由，见 F2 建议） |
| `/admin/accounts/probe` | POST | 同上 | 拒绝 | ✅ 真打上游不写池状态；⚠️ 无超时（父代理 F1 已列） |
| `/admin/pins` | GET / POST | 同上 | 拒绝 | ✅ **唯一**校验 realm 白名单（F8 的范本） |
| `/admin/import` | POST | 同上 | 拒绝 | ⚠️ 全跳过仍 200（F5） |
| `/admin/credentials` | GET | 同上 | 拒绝 | ✅ 只回 uid 列表与 count，**不回 token** |
| `/admin/pool` | GET | 同上 | 拒绝 | ⚠️ 不校验 realm |
| `/admin/providers` | GET | 同上 | 拒绝 | ✅ 读 cn 全局设置，失败降级为空而不是 500 |
| `/admin/providers/settings` | POST | 同上 | 拒绝 | ✅ 未知 id 丢弃 |
| `/admin/providers/models` | GET | 同上 | 拒绝 | ⚠️ 候选过滤少两维（F4） |
| `/admin/providers/models/toggle` | POST | 同上 | 拒绝 | ✅ `realmForProvider` 选分片 |
| `/admin/providers/models/bulk` | POST | 同上 | 拒绝 | ✅ 服务端批量，避免 N 次往返 |
| `/admin/providers/login/start` | POST | 同上 | 拒绝 | ✅ realm 由 provider 决定（防国际版落错分片） |
| `/admin/providers/login/poll` | GET | 同上 | 拒绝 | ✅ 有副作用（成功时落盘凭据）但需一次性 state |
| `/admin/providers/login/loomy/sms` | POST | 同上 | 拒绝 | ✅ |
| `/admin/providers/login/loomy/bind` | POST | 同上 | 拒绝 | ✅ |
| `/admin/login/start` | POST | 同上 | 拒绝 | ✅ |
| `/admin/login/poll` | GET | 同上 | 拒绝 | ✅ |
| `/admin/config/routing` | GET / POST | 同上 | 拒绝 | ✅ POST 镜像 cn+global + `resetMaxRotateCache()` |
| `/admin/config/safety` | GET / POST | 同上 | 拒绝 | ⚠️ GET 恒读 cn / 缓存单槽（F6）；POST 镜像 |
| `/admin/cooldowns/clear` | POST | 同上 | 拒绝 | ⚠️ 不清波次暂停（F3）；其余维度已全清 |
| `/admin/permanent-locks` | GET / POST | 同上 | 拒绝 | ✅ |
| `/admin/compensation` | GET | 同上 | 拒绝 | ✅ 只读、可反复调 |
| `/admin/compensation/claim` | POST | 同上 | 拒绝 | ✅ 一次性写操作，未接 cron（刻意） |
| `/admin/checkin/all` | POST | 同上 | 拒绝 | ⚠️ 不校验 realm（面板会传对） |
| `/admin/tasks/daily-all` | POST | 同上 | 拒绝 | ⚠️ 不校验 realm |
| `/admin/tasks/scan` | POST | 同上 | 拒绝 | 运维接口，无 UI（README 有列） |
| `/admin/tasks/run` | POST | 同上 | 拒绝 | 运维接口，无 UI（README 有列） |
| `/admin/tasks/start` | POST | 同上 | 拒绝 | 运维接口（`AGENTS.md:1722` 有实测） |
| `/admin/tasks/status` | GET | 同上 | 拒绝 | ✅ 缺 uid 直接 400 |
| `/admin/models/builtin` | GET | 同上 | 拒绝 | ✅ 静态目录 |
| `/admin/models/probe` | POST | 同上 | 拒绝 | ✅ 会真打上游，只读 |
| `/admin/usage` | GET | 同上 | 拒绝 | ⚠️ 不校验 realm；`days` 非法回退 0 |
| `/admin/usage/clear` | POST | 同上 | 拒绝 | ✅ 破坏性但语义明确；面板无按钮（刻意保留，README 有列） |
| `/admin/logs` | GET | 同上 | 拒绝 | ⚠️ 不校验 realm；`limit` 夹到 200 |
| `/admin/logs/clear` | POST | 同上 | 拒绝 | ✅ 面板两分片都清 |
| `/admin/packages` | GET | 同上 | 拒绝 | ✅ 逐账号实时查上游；无 UI（README 有列） |
| `/admin/waf` | GET | 同上 | 拒绝 | ⚠️ 不校验 realm |
| `/admin/waf/clear` | POST | 同上 | 拒绝 | ✅ 面板两分片都清 |
| `/admin/restriction/status` | GET | 同上 | 拒绝 | ⚠️ **零调用者**（F3） |
| `/admin/restriction/clear` | POST | 同上 | 拒绝 | ⚠️ **零调用者**（F3） |
| `/admin/apikeys` | GET / POST | 同上 | 拒绝 | ✅ POST 只回一次明文，之后只有哈希 |
| `/admin/apikeys/update` | POST | 同上 | 拒绝 | ✅ 不允许改 key 明文（要换用 reset） |
| `/admin/apikeys/reset` | POST | 同上 | 拒绝 | ✅ 旧密钥立即失效 + 用量清零（面板会弹新明文） |
| `/admin/apikeys/reset-usage` | POST | 同上 | 拒绝 | ✅ 不动密钥 |
| `/admin/apikeys/remove` | POST | 同上 | 拒绝 | ✅ 不可逆，面板有确认弹窗 |

> **守卫之前的 5 个免鉴权入口**（一并说明，避免误判）：`/healthz`（无信息）、`/login`→302、`/panel/*` 静态（严格 CSP，见亮点）、`/favicon.ico`→204、`/login/{codearts,trae}/callback`（浏览器回跳，**32 字节 CSPRNG state + 10 分钟 TTL**，`index.ts:1244-1274`）。这 5 个都不读也不写账号数据。

---

## 前端 ↔ 后端字段契约表

| 接口 | 前端读/写字段 | 后端是否返回/消费 | 结论 |
|---|---|---|---|
| `GET /admin/accounts` | 读 `uid/provider/nickname/disabled/reason/credits/coolKind/until/successCount/errTotal/expiresAt/lastSuccess/lastErr/fails/breakerUntil/modelCooldowns[]` | ✅ 全部返回（`:3843-3878`） | ✅ 一致 |
| 同上 | 后端还回 `restrictedUntil`（`:3868`）、`softStreak`（`:3869`）、`lastCheckinDay`、`modelCooldowns[].reason/hits` | — | ⚠️ `web/src/lib/types.ts:21-39` **未声明**这四个字段 ⇒ 源码侧无法渲染（产物侧已手补 `restrictedUntil`，见 F1） |
| 同上 | 后端**不**返回 `degradeUntil` | ❌ 缺字段 | ⚠️ **F2**：后端据它拒发，面板无从判断 |
| 同上 | 后端不返回 `modelCooldowns[].auditOnly` | ❌ 缺字段 | ⚠️ 见 F7（当前无实际影响） |
| `GET /admin/pool` | 读 `counts.{total,healthy,disabled,cooling,modelExempt}` | ✅ 字段名逐字匹配（`AccountPoolDO.ts:945`） | ✅ 但口径与列表不一致（F2） |
| `GET /admin/providers` | 读 `default/providers[].capabilities.*/order/disabled` | ✅（`:2989-3015`） | ✅ |
| `GET /admin/providers/models` | 读 `models[].{id,name,disabled}/disabledCount/note` | ✅（`:3184-3267`；无账号时只回 `models:[] + note`） | ✅ 面板用 `note` 兜底 |
| `GET /admin/config/{routing,safety}` | 读 11 个字段 | ✅ 字段名逐字匹配 | ✅ |
| `POST /admin/config/{routing,safety}` | 写 11 个字段 | ✅ 越界值"忽略并保持原值"（`AccountPoolDO.ts:924-931`、`:867-871`），面板用返回值回填表单（`config.ts:79-87`） | ✅ 这一处做得很对（避免"看起来保存了其实被夹掉"） |
| `GET /admin/apikeys` | 读 `keys[].{id,name,prefix,enabled,limits.*,usage.*}` | ✅（`normalizeApiKeyRecord` 输出） | ✅ |
| `POST /admin/apikeys/reset` | 读 `{key}` 明文 | ✅ | ✅ 页面 `onSuccess` 接住并弹一次（`ApiKeysPage.tsx:157-162`） |
| `GET /admin/logs` | 读 `logs[].{time,type,provider,uid,model,status,durationMs,tokens.{input,output},stream,error}` | ✅ `limit` 生效（默认 100，夹 [1,200]） | ✅ 分页参数一致（`limit/offset` 体系里只有 `limit`，**没有** `page/pageSize` 混用） |
| `GET /admin/usage` | 读 `total/ok/failed/inputTokens/outputTokens/avgMs/byHour/byDay/byModel/byAccount/activeDays/detailCount/detailCapped` | ✅ | ✅ `days` 语义（1=今日/0=全部）两侧一致 |
| `GET /admin/tasks/status` | 读 `status.{uid,plan,queue,done[],finished,lastError,startedAt,updatedAt}` | ✅ | ✅ |
| `GET /admin/compensation` | 读 `results[].{uid,nickname,ok,detail,available,status.{claimed,active,creditNum,endTime}}` | ✅ | ✅ |
| `POST /admin/import` | 写任意 JSON；**不读**响应体 | ⚠️ 回 `{ok,imported[],skipped[{reason}]}`，前端忽略 | ⚠️ **F5** |
| 全部错误响应 | 前端按 `{error:{message}}` / `{error:string}` / `{message}` / `{detail}` 四种形态兜底（`api.ts:17-27`） | 后端统一 `{error:{message,type,code}}`（`gateway/http.ts:17-23`）或 `{error:{message}}` | ✅ **形态统一，无"某处不返该字段"** |
| 分页/筛选 | 全站只用 `?realm=`、`?days=`、`?limit=`、`?uid=`、`?state=`、`?provider=` | 后端逐一消费 | ✅ 无 `limit/offset` vs `page/pageSize` 冲突 |

---

## 本模块亮点（值得保留的做法）

1. **面板整体鉴权模型是对的**：页面免鉴权但零敏感信息、`Authorization` 头（不用 cookie ⇒ 天然免疫 CSRF）、主/子密钥在**同一处**分流、子密钥被硬挡在 `/admin/*` 之外（`index.ts:1277-1295` 的注释把"为什么不能在 `authorized()` 里放行"写清了）。`authorized()` 还做到了 **fail-closed + 常数时间比较**。
2. **XSS 面基本封死**：`web/src` 全库 `dangerouslySetInnerHTML / innerHTML / eval` **0 命中**（产物里 5 处 `innerHTML` 全部是 React DOM 内部实现）；上游可控文本一律走 JSX 转义；二维码 SVG 用 `data:` 图片渲染而不是注入 DOM（`LoginFlow.tsx:227-228`）；授权链接过 `safeHref()` 白名单（只放行 https + 本机 http）；CSP 无 `unsafe-inline` 脚本、`connect-src 'self'`（防把密钥发去外网）。
3. **缓存的坑被真踩过并写进了注释**：`src/panel/index.ts:70-90` 记录了"`immutable` + 文件名不含真哈希 ⇒ 用户升级后永远看到旧版号"的实测事故，改成 `no-cache` + ETag（`:120-129` 的 64 位 FNV 拼两段）。这类"注释即事故报告"在本模块质量很高。
4. **数值 0 的语义在前后端都当一等公民**：`SafetyConfig` 六个字段各自的 0 含义写在类型注释里（`AccountPoolDO.ts:440-454`），面板不为 0 做 `|| 默认值` 兜底（`config.ts:53-58` 明确警告），保存后用后端返回值回填（因为后端会夹边界）。
5. **改动面收敛得干净**：`b7383f4` 之后 `clearCooldowns` 把 6 个惩罚维度 + `modelCooldowns` 一起归零（`AccountPoolDO.ts:1692-1712`），并留了"与 `setAccountDisabled` 的区别"的说明——这正是"解冻"该有的语义。

## 测试缺口

1. **产物 ↔ 源码一致性无守护**（F1 的根因）。`tests/panel.test.ts` 只校验"产物里的版本号 == package.json"（`:256-262`）与"manifest 覆盖 index.html 引用的资源"（`:121-136`），**不校验产物功能与 `web/src` 对应**。⇒ 建议加双向标识断言（如产物含 `restricted`/`accounts/probe` ⇒ `web/src` 必含）。
2. **`degradeUntil` 只测了纯函数**。`tests/accounts-diagnose.test.ts:32/…` 覆盖 `diagnoseAccount` 的五个维度，但**没有一条测 `/admin/accounts` 的响应字段完整性** ⇒ F2 这类"后端用了却不返回"的漏字段永远测不出来。建议加一条"响应字段集合 ⊇ `healthy()` 依赖的维度"的断言。
3. **波次暂停（F3）完全无测试**：`RESTRICTION_WAVE_THRESHOLD=2` / `HOLD=30min` 的触发、`clearRestrictionGate` 的效果、以及"清冷却不解 gate"这个事实，`tests/` 里 0 覆盖（`grep -rn restrictionGate tests/` 为空）。这是最该补的一条端到端测试（两个假账号各回 11140 ⇒ 第三个请求应被 gate 拒绝）。
4. **导入的部分失败路径无测试**（F5）：没有任何测试覆盖 `{ok:false, imported:[], skipped:[…]}` 这个 200 响应在 UI 侧的表现。
5. **面板 UI 行为只能靠肉眼**：`tests/panel.test.ts:14-16` 自己承认"UI 交互本身需在真实浏览器里验证"。产物侧的手改（F1）正是从这条缝里进来的。
