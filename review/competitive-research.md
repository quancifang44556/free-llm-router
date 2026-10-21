# 同类项目调研报告

> 调研时间：2026-10-21
> 调研对象：与 free-llm-router 功能重叠的开源项目
> 方法：GitHub API 核实 star / 活跃度，直读 README 与项目文档（全部经代理访问）

---

## 一、结论先行

找到 **4 类、7 个**直接相关的项目。其中 **1 个同类竞品的封禁复盘文档** 比任何代码都值钱 ——
它用一次真实封号（账号级 403/11140，官方 IDE 也报错）换来了完整根因清单，
而这份清单里有 **3 条我们的项目目前完全没做**。

| 优先级 | 借鉴点 | 来源 | 我们现状 |
|---|---|---|---|
| 🔴 P0 | `x-device-token` 设备指纹 | workbuddy2api | ❌ 未做 |
| 🔴 P0 | 会话链路 ID（conversation/message/request-id 链式） | workbuddy2api | ⚠️ 部分（有粘性但无链路头） |
| 🔴 P0 | `previous_response_id` 跨请求传递 | workbuddy2api / helper | ❌ 未做 |
| 🟠 P1 | 消耗速率异常熔断 | workbuddy2api | ❌ 未做 |
| 🟠 P1 | 上下文治理（消息数硬上限 + 自动摘要） | workbuddy2api | ❌ 未做 |
| 🟠 P1 | 请求间随机抖动（3–10s） | workbuddy2api | ⚠️ 只有防惊群 3s |
| 🟡 P2 | 会话亲和的显式建模 | gpt-load | ⚠️ 我们有，但只 30 分钟 TTL |
| 🟡 P2 | 凭据级权重调度 | gpt-load | ⚠️ 有 roundrobin/random，无权重 |
| 🟡 P2 | 积分延迟复核（异步到账） | workbuddy-helper | ❌ 未做 |

---

## 二、项目清单

### 2.1 同生态直接竞品（最有参考价值）

| 项目 | star | 语言 | 说明 |
|---|---:|---|---|
| [Zhengyuuuui/workbuddy2api](https://github.com/Zhengyuuuui/workbuddy2api) | 19 | Python | 轻量反代，**有完整封禁复盘文档**，指纹模拟做得最细 |
| [EchoPing07/Buddy-2API-Go](https://github.com/EchoPing07/Buddy-2API-Go) | 26 | Go | 单账号单二进制，**明确拒绝号池**，面板功能完整 |
| [autumnsentiment/workbuddy-helper](https://github.com/autumnsentiment/workbuddy-helper) | 5 | Go | 多账户签到看板，**国际版积分延迟复核**做得最细 |
| [kzxheli-commits/dsh-workbuddy-pool](https://github.com/kzxheli-commits/dsh-workbuddy-pool) | 0 | JS | DSH 插件形态的号池（同类定位，但刚起步） |

### 2.2 通用网关（架构层面可借鉴）

| 项目 | star | 语言 | 说明 |
|---|---:|---|---|
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 61,673 | Python | 事实标准，100+ provider，路由/重试/预算体系成熟 |
| [songquanpeng/one-api](https://github.com/songquanpeng/one-api) | 37,210 | JS | 国内最广，渠道管理 + 令牌分发 |
| [tbphp/gpt-load](https://github.com/tbphp/gpt-load) | 7,156 | Go | **多凭据调度与故障隔离做得最好**，目录结构值得学 |

---

## 三、🔴 P0 级借鉴点（安全 / 防封）

### 3.1 `x-device-token`：我们完全没有的防线

**来源**：[封禁复盘](https://github.com/Zhengyuuuui/workbuddy2api/blob/main/doc/incident-postmortem-and-hardening-checklist.md)

复盘结论：封号是**三个因素叠加**触发的 ——
「通道可识别 + 设备指纹缺失 + 机器行为画像」→ 腾讯云 `p_tcaca` 产品线风控
（先 6004 警告，再 11140 执行）。

官方 IDE 的请求带一个 **465 字符**的 `x-device-token`，而所有第三方反代都没有。
更关键的是另一条：

> 消费记录来源列：bridge 显示 `-`，官方 App 显示 `WorkBuddy`
> **结论：从第一笔请求起，后台就能区分哪些是程序化流量**

这说明「通道可识别」是**结构性**的，无法靠改 header 完全消除。但设备指纹是能补的。

**对我们项目的意义**：

我们目前的指纹工作集中在 `upstream/headers.ts`（四套头族 + `deriveID(uid, salt)` 派生的
`machineId`），但**没有 `x-device-token` 这类需要从官方客户端提取的长字符串**。

⚠️ **但必须注意复盘的纪律原文**：

> 一设备一账号一 token，**严禁多账号共用**
> 解封前严禁换号继续打同一设备 —— 设备指纹会**连坐**

这与我们「多账号池」的架构**天然冲突**：一个 device-token 只能对应一个账号，
我们池子里 5 个账号就得有 5 个不同的设备指纹。若共用，一次风控会连坐整池。

**建议**：不急于实现。若要实现，必须先解决「一账号一设备指纹」的存储与隔离，
否则得不偿失。

---

### 3.2 会话链路 ID + `previous_response_id`

**来源**：同上 + [workbuddy-helper](https://github.com/autumnsentiment/workbuddy-helper)

官方 IDE 的请求是**链式**的：

| 头/字段 | 官方 IDE | 普通反代 |
|---|---|---|
| `x-conversation-id` | ✅ 跨请求稳定 | ❌ |
| `x-conversation-message-id` | ✅ 每条消息新生成 | ❌ |
| `x-conversation-request-id` | ✅ 每请求新生成 | ❌ |
| `previous_response_id` | ✅ 会话延续 | ❌ |
| `x-b3-traceid` / `x-b3-spanid` | ✅ 链路追踪 | ❌ |

**我们已有**：会话粘性（30 分钟 TTL，绑定账号），但那是**账号维度**的粘性，
不是**上游会话链路**维度 —— 上游看到的仍是一堆孤立请求。

**workbuddy-helper 的做法更值得学**（针对国际版活跃积分）：

> 每次活跃都**新开一个云端会话**，先 `POST /console/as/conversations/v2` 登记会话
> （`conversationOrigin=legacy_workbuddy_local`），再以服务端返回的会话 ID 作为
> `X-Conversation-ID` 发送对话，并把 `chat_request_send` 遥测事件随请求上报
> —— 让服务端把该账号识别为「真实客户端正在活跃」

**建议**：这个改动**性价比最高**。不涉及账号隔离问题，
只是让请求看起来更像同一个客户端在连续对话。实现成本约 1–2 天。

---

### 3.3 上下文治理：单请求消息数硬上限

**来源**：封禁复盘 P2

复盘记录的真实触发场景：

> 09-12 17:10 国内首次出现请求失败（**2552 条消息的大请求**连发）
> 09-15 14:37 海外最后一次成功（**428→434 条消息**高频连发）
> 09-19 20:24 国内最后一次成功（**987~993 条消息**连发后中断）

**三次封号前的最后一次成功，都是超大消息数请求。**

复盘建议：

> `--optimize-context` 默认开启
> 单请求消息数硬上限（建议 ≤100），超出自动摘要压缩

**我们现状**：`gateway/payload.ts` 有 `repackToolResultBlocks` / `cleanupOrphanToolCalls` 等
修复函数，但**没有消息数硬上限，也没有摘要压缩**。

⚠️ 这个风险很实际：客户端（尤其 agent 场景）很容易攒出上千条消息的历史，
我们目前会**原样转发**给上游。

**建议**：加一个可配置的 `MAX_MESSAGES`（默认 100）+ 超限时保留
「首条 system + 最近 N 条 + 首尾摘要」的策略。成本约半天。

---

## 四、🟠 P1 级借鉴点

### 4.1 消耗速率异常熔断

**来源**：封禁复盘 P2「额度监控」

> 轮询 `POST /billing/meter/get-user-resource`
> 暴露 `GET /v1/credits`
> **消耗速率异常（如 5 分钟烧掉 20%）自动熔断**

**我们现状**：刚实现了余额刷新（`refreshAccountBalances`），**有数据但没有速率判断**。
我们的 `credits` / `creditsExpiring` 是**快照**，看不出「烧得太快」。

**建议**：在 `updateBalance` 里加一个短期历史（保留最近 6 次采样），
算「过去 N 分钟消耗占比」，超过阈值就软冷却该账号并记日志。
这能提前发现「某个号被别的客户端盗用」或「某个模型倍率异常高」。
成本约 1 天。

### 4.2 请求间随机抖动

复盘建议：

> 全局 QPS 上限 + 请求间随机延迟 **3~10s**
> 客户端重试指引写入 README（**禁止 <5s 热重试**）

**我们现状**：只有 `SPREAD_WINDOW_MS = 3000`（3 秒内不选同一账号），
那是**选号防扎堆**，不是**请求节流**。两者语义不同：
我们的机制在账号池大时仍可能整体高频。

**建议**：加一个可选的全局 QPS 上限 + 抖动。但对个人自用场景，
这条**优先级可降低** —— 复盘里的封号是在「Agent 连发」场景下触发的。

---

## 五、🟡 P2 级借鉴点（架构）

### 5.1 gpt-load 的包结构值得学

7k star 的 [gpt-load](https://github.com/tbphp/gpt-load) 把 `internal/` 拆成 40 个单一职责包：

```
scheduler/  health/    ratelimit/  rpm/       affinity/
usage/      usagecost/ pricing/    catalog/   automodel/
requestlog/ requestaudit/ requestredact/     jev/
subscription/ accessquota/        outboundproxy/ ...
```

对比我们的结构（`gateway/ pool/ providers/ upstream/ taskrunner/ store/ server/`），
我们缺的几块：

| gpt-load 有 | 我们 | 说明 |
|---|---|---|
| `affinity/` | `pool/AccountPoolDO` 内联 | 会话亲和被埋在池里，没独立抽象 |
| `health/` | 分散在 pool 的 cooling/breaker | 健康度没有统一视图 |
| `pricing/` + `usagecost/` | `gateway/cost-estimate.ts`（README 说「无生产消费者」） | 我们的成本估算是死代码 |
| `requestredact/` | 无 | 日志脱敏没有独立层 |
| `outboundproxy/` | 无 | 出网代理无抽象 |

**最有价值的一条**：`requestredact`（请求脱敏）独立成包。
我们的日志里目前靠人工注意「不打印凭据」，没有机制保证。

### 5.2 凭据级权重调度

gpt-load：

> 多凭据调度、**可配置权重**、重试、冷却、黑名单与会话亲和

**我们现状**：三种策略 `expiry` / `roundrobin` / `random`，
其中 `random` 的加权 `1 + credits/100` 是**隐式权重**，且刚被证明
「credits 不刷新时退化成等权」（已修）。

**建议**：把权重改成**显式可配置**（面板可调），而不是靠余额隐式推导。
这样用户可以手动给「稳定但额度少」的号降权。成本约 1 天。

### 5.3 积分延迟复核

**来源**：[workbuddy-helper](https://github.com/autumnsentiment/workbuddy-helper)

它发现了一个我们可能也会踩的坑：

> 国际版积分**非即时到账**；会话发出前先校验登录态及积分查询，
> 收到有效对话回答后按设置**延迟（默认 840 分钟=14h）自动复查**积分变化，
> 无变化最多重试 6 次；界面区分"已发送待复核""积分已到账""复核未到账"

还有一条很实用的细节：

> 模型可选 `hy3` / `hy4-preview`；两者都是 `onlyReasoning` 纯推理模型，
> **推理内容同样占用输出预算**，活跃请求统一下发 `max_tokens=4096`，
> 避免推理耗尽预算导致 `content` 为空而被误判为无效会话

**对我们的意义**：如果我们的任务引擎要判断「签到是否真的到账」，
**不能只看 HTTP 200** —— 上游是异步记账。我们已有 `claimPollAttempts=4 × 3s`
（约 12 秒），但 workbuddy-helper 说国际版要**等 14 小时**再复核。

---

## 六、不建议借鉴的

| 项目/做法 | 原因 |
|---|---|
| **Buddy-2API-Go 的单账号定位** | 它明确「不接受号池建议」，而我们的核心就是号池。但它的面板功能（余额包明细、倍率显示、成长任务开关）设计值得抄 |
| **litellm / one-api 的完整功能集** | 它们是「对外提供 API 分发」的定位，我们是「个人自用账号池」，多租户/计费体系对我们无意义 |
| **workbuddy2api 的 `x-device-token` 提取** | ⚠️ **有连坐风险**（见 3.1），我们多账号池场景下收益不明确、风险很高 |

---

## 七、建议的落地顺序

| 顺序 | 事项 | 理由 | 成本 |
|---|---|---|---|
| 1 | **消息数硬上限 + 摘要** | 三次封号前最后一次成功都是超大请求，是**最明确的危险信号** | 半天 |
| 2 | **会话链路 ID + previous_response_id** | 不涉及账号隔离，纯协议层改动，防封收益明确 | 1–2 天 |
| 3 | **消耗速率异常熔断** | 我们有余额数据了，加判断即可；能发现盗用/异常倍率 | 1 天 |
| 4 | **日志脱敏独立层** | 目前靠人工注意，应有机制保证 | 半天 |
| 5 | 显式权重调度 | 面板可调，替代隐式推导 | 1 天 |
| 6 | 积分延迟复核 | 只在做任务引擎到账判断时需要 | 1–2 天 |
| ❌ | device-token | **风险 > 收益**，暂不做 | — |

---

## 八、一个额外发现

调研中看到我们的上游仓库 [XuexGao/free-llm-router](https://github.com/XuexGao/free-llm-router)
在搜索结果里排第一位 —— 说明这个项目在搜索「WorkBuddy 任务自动化 + OpenAI 兼容聚合」时
已经有可见度。同类项目里我们 15 家供应商 + DSH 集成 + Cloudflare/Node 双形态
是**功能最全的**，但**防封能力是最弱的**（对照复盘清单，我们有 5 条没做）。

这个反差值得注意：**功能堆得越多，越容易被识别为程序化流量**。
