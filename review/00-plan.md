# 阶段 0：项目摸底与审查分工计划

> 生成时间：2026-10-21（第四次审查，新基线）
> 审查基线：`claude-master` @ **`6eb0681`**（**v0.9.10**）
> 纪律：**只读**。除 `/review/` 目录外不修改任何文件。
> 说明：前三版分别基于 `c0eecdd`(v0.9.0) / `8ff3d42`(v0.9.1) / `8ae38d8`(v0.9.6)。`competitive-research.md` 保留不动。

---

## 一、项目结构

### 1.1 技术栈

| 项 | 值 |
|---|---|
| 名称 / 版本 | `free-llm-router` @ **0.9.10** |
| 语言 / 模块 | TypeScript 5 / ESM（`"type": "module"`） |
| **生产运行时** | **Node 22 单容器**（国内家宽出口）；保留 Cloudflare Workers 构建路径 |
| **运行时依赖** | **零**（`dependencies: {}`） |
| 开发依赖 | `@cloudflare/workers-types`、`typescript`、`wrangler` |
| 存储 | Durable Object SQLite（Workers）/ `node:sqlite`（Node） |
| 测试 | `node --test` + esbuild 预打包（`scripts/test.sh`），**811 条** |
| 构建 | `build:node` → `dist/server.mjs`（~2.44 MB） |
| **CI** | **无**（`.github/workflows` 不存在） |

**零运行时依赖**是核心架构特征：AES、MD5、SQLite、WASM 全为自实现或平台内建。
好处是无供应链风险；代价是**自实现密码学**（`store/crypto.ts`、`providers/aes-cfb.ts`、`md5.ts`）需重点审查。

### 1.2 代码规模

| 目录 | 文件 | 行数 | 职责 |
|---|---:|---:|---|
| `src/index.ts`（顶层） | 1(+3) | **4428** | **54 个 `/admin/*` 分支** + `/v1/*` 分发 |
| `src/providers/` | 22 | **23841** | 15 个上游供应商适配 |
| `src/gateway/` | 12 | **7789** | 协议转换、限速、记账、上下文治理 |
| `src/upstream/` | 13 | 4655 | HTTP 客户端、鉴权、错误分类 |
| `src/pool/` | 3 | **3122** | `AccountPoolDO` + 状态机（**本轮 +195 行**） |
| `src/taskrunner/` | 5 | 1644 | 定时任务（签到 / 主动续期） |
| `src/store/` | 4 | 1285 | SQLite 访问、加密存储、子密钥 |
| `src/server/` | 5 | 957 | 平台适配、`cf-shim`、`serializeCalls` |
| `src/panel/` | 2 | 159 + 静态 | 管理面板（**预构建产物提交进仓库**） |
| **合计** | **69** | **48118** | |

测试：**40** 文件 / **15585 行** / **811 条**，测试/源码比 **32.4%**。

### 1.3 最大的源文件

| 文件 | 行数 | 变化 |
|---|---:|---|
| `src/index.ts` | **4428** | ⚠️ 上轮 4291 → **+137**（本轮新增端点） |
| `src/gateway/server.ts` | **3445** | 53 次改动 / **37 fix**，全项目最热 |
| `src/providers/trae.ts` | 2524 | |
| `src/providers/qoder.ts` | **2443** | ⚠️ 上轮 2402 → +41（排队预算改动） |
| `src/pool/AccountPoolDO.ts` | 2334 | 34 次改动 / 16 fix |

### 1.4 模块依赖（实测，与上轮一致，环仍在）

| 模块 | 出边 |
|---|---|
| `gateway` | pool, providers, store, upstream |
| `pool` | **gateway** ⚠️, store, upstream |
| `providers` | **gateway** ⚠️, upstream |
| `upstream` | **（无）✅ 干净底层** |
| `store` | **（无）✅ 干净底层** |
| `taskrunner` | store, upstream |
| `server` | pool, taskrunner |

**三条已知的环**（前两条与上轮相同，第三条由上轮验证子代理发现）：
1. `pool → gateway/safety.js`（`AccountPoolDO.ts` 读限速参数）
2. `providers → gateway/{models,payload}.js`（`buddy.ts`）
3. `gateway/models.ts → providers/index.ts → providers/buddy.ts → gateway/models.ts`
   —— **唯一真实的运行时循环**。当前安全仅因 `DEFAULT_PROVIDER` 在**函数体内**才求值；
   若有人把它移到 `models.ts` 顶层读取，会因 TDZ（暂时性死区）崩溃。**这是明确的结构隐患。**

---

## 二、热点区域（基于 git 历史，实测）

### 2.1 概览

**158 次提交**，2026-10-03 → 2026-10-21。

| 类型 | 次数 |
|---|---:|
| `fix` | **78** |
| `feat` | 44 |
| `docs` | 27 |
| `chore` | 6 |
| `perf` | 1 |
| **`refactor`** | **0** ⚠️ |

**fix : feat = 1.77 : 1**，`refactor` 为 **0** ⇒ 持续打补丁，**从未结构性重构**。

### 2.2 文件级热点

| 文件 | 总 | fix |
|---|---:|---:|
| `src/index.ts` | 56 | 25 |
| `src/gateway/server.ts` | **53** | **37**（70% 的改动是修 bug） |
| `src/panel/assets/app.js.txt` | 42 | 17 |
| `AGENTS.md` | 41 | 14 |
| `src/pool/AccountPoolDO.ts` | 34 | 16 |
| `tests/panel.test.ts` | 32 | 17 |
| `src/panel/assets/style.css.txt` | 31 | 14 |
| `tests/gateway.test.ts` | 26 | 21 |

### 2.3 反复出现的同型缺陷（从 78 条 fix 提取）

| 模式 | 频次 | 实例 |
|---|---|---|
| **误判/误杀** | 误 ×**10** | 单次抖动误杀健康号 |
| **静默失效** | 静默 ×4 | `restrictedUntil` 三处静默失效 |
| **写好但没接上** | 未/没有 ×6 | 限速模块「没有任何开启途径」 |
| **只修一半** | 只 ×3 | `provider 路径完全绕过` |
| **双写不一致** | 不一致 ×1 | `developer→system` 归一化 |

> **本次审查的核心输入**：本项目主要缺陷**不是崩溃**，而是
> **「逻辑正确但不可观测 / 只在某条路径生效 / 配置了不生效 / 字段存了没人读」**。

每个子代理必须专项检查三条：
1. **新增字段/配置/开关是否在**所有路径**生效？**
2. **同一概念是否存在**两份判据**？**
3. **有没有「写好但没人调用」的代码？**（本轮就新发现了一处，见 §2.5）

### 2.4 本仓库「只修一半」的完整事故史（**第 5 次已发生**）

这是本项目管理层面最值得记的模式，**已发生 5 次**：

| # | 事故 | 根因 |
|---|---|---|
| 1 | `developer→system` 归一化只加主路径 | provider 路径完全绕过 |
| 2 | SSE `data:` 前缀解析手写第二份 | 重犯已修过的 bug |
| 3 | 延迟记账只加 buddy 路径 | 漏 provider 路径 |
| 4 | `[waf-403]` 日志加在 `!upstream.ok` 分支 | 故障实际在 `ProviderError` 分支 |
| 5 | **本轮（0.9.10）**：`wbProbeHook` 定义后**没挂到 UI** | 写了函数但无人调用（见 §2.5） |

⇒ **子代理请把「这个函数/字段真的被用了吗」作为默认检查项**，grep 定义处 + grep 调用处，两处数量比对。

### 2.5 本轮（v0.9.7 → v0.9.10）新增/修改的代码（**重点自查对象**）

> ⚠️ 这些代码是**我（父代理）在时间压力下写的**，且**有一个子代理明确报告
> 「现有探测端点不符合规范」后尝试重写但失败**。故本轮新代码应作为**一级审查目标**，
> 不要因为「刚写的」就默认正确。

| # | 改动 | 位置 | 风险点 |
|---|---|---|---|
| **N1** | 排队预算 45s→60s（三常量联动） | `providers/qoder.ts`（`QUEUE_TOTAL_BUDGET_MS` 等） | 60s 是否合理？`4×20s=80s>60s` 的逻辑是否真如注释所说「由预算先触发」？ |
| **N2** | 排队超时 `httpStatus` 改 503 | `qoder.ts` 排队分支 | 503 会不会误入别的分类分支？ |
| **N3** | `isWafBlocked` 加固：CJK 文本不判 WAF | `upstream/client.ts` | ⚠️ **判据是否正确**？若上游真用中文返回 WAF 拦截页会漏判；反过来是否过宽 |
| **N4** | `applyFailure` 统一 `[punish]` 日志 | `pool/AccountPoolDO.ts` | 是否刷屏？是否泄漏敏感信息？ |
| **N5** | `diagnoseAccount()` + `humanizeMs()` | `pool/state.ts:529`（+195 行） | 五维度判据是否与 `healthy()` 完全同源？`auditOnly` 处理是否正确？ |
| **N6** | `GET /admin/accounts/diagnose` | `index.ts:3568`（31 行） | **是否真的在统一鉴权守卫之后**？ |
| **N7** | `POST /admin/accounts/probe` | `index.ts:3599`（**122 行**） | 🔴 **子代理报告「不符合规范」，请重点审**：串行探测是否真串行？`verdict` 四分类判据是否复用 `classify()`？失败降级是否合理？是否泄漏凭据？ |
| **N8** | 面板五维度展示 + 探测按钮 | `panel/web/assets/index-Dg0M0nJm.js.txt` | 🔴 **压缩产物手工修改**：命名冲突（`rg` 曾被占用）、变量遮蔽（`e`）已修，但**没有类型检查兜底**，需逐一复查 |

**N7 补充**：该端点内部构造 `Request` 再走 `handleChatCompletions`，会**真实消耗上游配额**；
且它读 `env.API_KEY` 拼 `authorization` 头 —— 请确认这不会把主密钥写进日志。

### 2.6 阶段 0 已确认的事实（子代理可直接用）

| # | 事实 | 证据 |
|---|---|---|
| **A** | `blockConcurrencyWhile` 在 Node 下 = `return await fn()`（**不阻塞**），但真正的串行化由 `serializeCalls` 的 Promise 链承担；构造函数含 `migrate()` 在入缓存前同步完成 ⇒ **建表竞态不存在** | `server/storage.ts:250`、`server/namespace.ts:164` |
| **B** | 吞错误写法：`catch(() => {})` **13 处**、`catch(() => ({}))` **43 处**（上轮 41，本轮 +2） | grep 统计 |
| **C** | `/admin/*` 有**统一前置守卫**（`index.ts` ~1276），主密钥进 `/admin/*` 与 `/v1/*`，子密钥**只能进 `/v1/*`**。⚠️ 需确认本轮新增的两个端点也在守卫之后 | `index.ts` |
| **D** | 配置反模式 `parseInt(x) \|\| 默认` 基本守住（`env.ts` 明确记录该纪律） | `env.ts:2,75,149,186` |
| **E** | `server.ts` 有 **13 处** `applyFailure` 调用（真实调用），历史上曾「只给其中一条路径加延迟记账」 | `gateway/server.ts` |
| **F** | 唯一运行时循环依赖：`gateway/models → providers/index → providers/buddy → gateway/models` | 上轮验证子代理实测 |

---

## 三、审查分工计划

### 3.1 设计原则

1. 按代码体量 + 热点权重分配，避免单点过载。
2. 热点深入查（`server.ts`、`index.ts`、`AccountPoolDO.ts`），边缘抽样。
3. 每个子代理都带 §2.3 的三条共同专项 + §2.4 的「函数是否真被调用」检查。
4. **子代理只写文件**，对话里一句话摘要。
5. 并发上限 20（用户已确认），可一次性全部启动。

### 3.2 阶段 1：模块审查（6 个）

| # | 子代理 | 范围 | 行数 | 重点 |
|---|---|---|---:|---|
| M1 | `gateway-core` | `gateway/server.ts`、`payload.ts`、`responses.ts` | ~5500 | 🔴 最热；**双路径一致性**（buddy vs provider）、13 处 `applyFailure` 归属、记账一致性 |
| M2 | `pool-state` | `pool/*`、`store/*`、`server/{storage,namespace,cf-shim}.ts` | ~4700 | 🔴 状态机、**持久化字段可观测性**、加密、**N5 的 `diagnoseAccount`** |
| M3 | `providers-a` | `qoder.ts`、`qoder-wasm.ts`、`buddy.ts`、`opencode.ts`、`anthropic.ts` | ~5400 | 签名链路、WASM、**N1/N2 排队改动**、信封解析 |
| M4 | `upstream-classify` | `upstream/*`（13 文件 4655 行） | 4655 | 🔴 **错误分类是误判源头**；**N3 `isWafBlocked` 加固** |
| M5 | `providers-b` | `trae.ts`、`gemini.ts`、`codearts.ts`、`minimax.ts`、`cline.ts` | ~8100 | 体量最大；凭据/续期/错误分类 |
| M6 | `entry-panel-tasks` | **`index.ts` 54 路由**、`panel/*`、`taskrunner/*` | ~6400 | 🔴 **N6/N7 新端点**、**N8 面板改动**、路由守卫穷举、定时任务 |

### 3.3 阶段 2：横向专项（5 个）

| # | 子代理 | 视角 |
|---|---|---|
| X1 | `arch` | 模块边界、三个环、重复实现、`index.ts`/`server.ts` 拆分可行性、**「只修一半」的架构防护** |
| X2 | `security` | 鉴权链路、密钥、**自实现密码学**、输入校验、依赖漏洞（**可联网**）、**N7 是否泄漏主密钥** |
| X3 | `consistency-dx` | 一致性（错误/日志/配置）+ DX（README、部署、**无 CI**）、**环境变量名一致性** |
| X4 | `test-quality` | 测试质量：源码文本断言占比、**为什么本轮 811 条测试没抓到 N8 的命名冲突/遮蔽** |
| X5 | `product` | 用户视角：缺什么、体验差在哪（**本人多设备**） |

### 3.4 阶段 3：汇总复核（我自己）

- 交叉核实去重，**剔除误报**。
- 对**严重/高**级问题**逐条回读代码确认**，不接受二手结论。
- **特别复核**：N1–N8 这批我自己写的代码，任何子代理指出的问题都必须亲自验证
  （我对自己代码有盲区，也容易过度辩护）。
- 输出 `REPORT.md`。

### 3.5 产出文件

```
/review/
  00-plan.md                       ← 本文件
  module-gateway-core.md           ← M1
  module-pool-state.md             ← M2
  module-providers-a.md            ← M3
  module-upstream-classify.md      ← M4
  module-providers-b.md            ← M5
  module-entry-panel-tasks.md      ← M6
  cross-arch.md                    ← X1
  cross-security.md                ← X2
  cross-consistency-dx.md          ← X3
  cross-test-quality.md            ← X4
  cross-product.md                 ← X5
  REPORT.md                        ← 阶段 3
```

**统一格式**：

```markdown
## 发现清单
### [严重|高|中|低] 一句话标题
- **位置**：`src/x.ts:123-145`
- **证据**：具体代码 / 实测 / 引用
- **影响**：后果
- **建议**：怎么修
- **工作量**：S(<1h) / M(半天) / L(1-3天) / XL(>3天)
- **置信度**：确定 / 待确认

## 本模块亮点（值得保留的设计）
## 测试缺口
```

**严重度定义**：

| 级别 | 定义 |
|---|---|
| **严重** | 数据丢失 / 凭据泄漏 / 服务不可用 / **静默给出错误结果** |
| **高** | 特定路径失效、安全弱化、明显资源泄漏 |
| **中** | 可维护性差、错误处理不全、边界未覆盖 |
| **低** | 风格、命名、注释过时 |

---

## 四、已确认的环境约束（所有子代理遵守）

| 项 | 值 |
|---|---|
| 生产运行时 | **Node 22 单容器**（不是 Workers） |
| 出口 | 国内家宽 IP（浙江绍兴电信） |
| 使用者 | **本人多设备**（子密钥隔离，**非对外服务、非多租户**） |
| 实测并发 | **30 并发（含流式）全部成功**，网关无并发闸门 ⇒ **不要建议加并发上限** |
| 诊断开关 | `UPSTREAM_DEBUG=1`（非 2xx 原文）、`[waf-403]`（常开）、`[punish]`（常开）、`[stream-error]`（`UPSTREAM_DEBUG`） |
| 上游排队 | `qodercn` 实测正常排队 **20–25 秒**；预算 60 秒（用户要求） |

---

## 五、节奏

| 阶段 | 并发 | 说明 |
|---|---|---|
| 阶段 1（6 模块） | 6 | 一次性启动 |
| 阶段 2（5 专项） | 5 | 与阶段 1 同批启动（共 11，上限 20） |
| 阶段 3（汇总） | 1 | 需回读代码验证高危项 |

全部产出限定 `/review/` 下，**不改动任何业务代码**。
