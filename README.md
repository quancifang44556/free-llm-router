# free-llm-router

**把多个大模型供应商的账号池，聚合成一个 OpenAI 兼容的 API** —— 外加账号自动化（签到 / 成长任务 / 领奖）。

一份代码，两种运行形态：Cloudflare Workers，或自有 VPS 上的单个 Node 进程。

> ⚠️ **仅限本人授权账号自用。** 见 [使用边界](#使用边界)。

---

## 目录

- [它能做什么](#它能做什么)
- [两种运行形态](#两种运行形态)
- [支持的供应商](#支持的供应商)
- [快速上手](#快速上手)
- [主要端点](#主要端点)
- [管理面板](#管理面板)
- [使用边界](#使用边界)
- [已知限制](#已知限制)
- [License](#license)

---

## 它能做什么

**1. 一个 OpenAI 兼容入口，背后是一池账号**

`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses` 三个端点，
流式与非流式、工具调用都支持。模型名用 `provider/model` 前缀路由；裸模型名回落到默认供应商，保证旧客户端不改代码也能用。

价值在于：**你只需要记一个 base URL 和一把 key**，不必为每家供应商各写一套适配。

**2. 选号、冷却、熔断、会话粘性都是自动的**

账号池按「健康度 → 防惊群 → 加权随机」选号；失败按上游错误语义分层处置（账号级 / 模型级 / 不罚号），
同一会话在 30 分钟内粘在同一账号上以复用 prompt cache。**模型级限流不会连坐整个账号** —— 换个模型即可继续。

**3. 聚合路由：同一个模型，挑最该先烧的那个渠道**

同一个真实模型在各家叫法不同、积分到期时间也不同。`aggregate/<规范名>` 把各家同一个模型归到一起，
按**积分最快作废**自动选渠道（临期的先烧、长期的留着），失败自动换下一家。
`aggregate/auto` 则不指定模型，在所有渠道里挑。

**4. 账号自动化：签到、成长任务、自动领奖、补偿领取**

任务引擎拆成「状态机 + 定时步进」，跑在每账号一个的 Durable Object 上，中途被回收也能恢复。
反风控间隔照抄实测值（不是性能参数，调小会让任务白跑）。
**会真实消耗配额的任务默认不入队**，必须显式开启。

---

## 两种运行形态

| | **Cloudflare Workers** | **VPS / Node** |
|---|---|---|
| 入口 | `src/index.ts` | `src/server/index.ts` → `dist/server.mjs` |
| 状态存储 | Durable Objects + SQLite | `node:sqlite` 单文件（`data/router.db`） |
| 后台任务 | DO alarm 自我续期 | 进程内定时器 + 启动时恢复未决任务 |
| 产物 | 由 `wrangler deploy` 上传 | 约 1.7 MB 单文件，`node dist/server.mjs` 直接跑 |
| 外部依赖 | 无（Free 计划即可） | Node.js ≥ 22、无外部数据库 |
| 适合 | 不想维护服务器 | 想完全掌控数据与出口 |

两者**共用同一份 `fetch` 路由与全部业务代码**，Node 侧只是一层 HTTP / DO 桥接。
故功能一致，差异只在存储后端与调度实现。

---

## 支持的供应商

**共 15 家**（含腾讯国内版 / 国际版、Qoder 国际版 / 中国版两组同源变体）。

「登录」= 能否**从本服务发起**登录流程；不能的并非不能用 —— 它们全部支持**粘贴凭据导入**。

| id | 名称 | 面板登录 | 每日签到 |
|---|---|---|---|
| `buddy` | Buddy（腾讯国内版） | ✅ 设备码 | ✅ |
| `workbuddy` | WorkBuddy（腾讯国际版） | ✅ 设备码 | ✕ |
| `cline` | Cline | ✅ 用户码 | ✕ |
| `minimax` | MiniMax Code（中国版） | ✅ 设备码 | ✅ |
| `codearts` | CodeArts（华为云码道） | ✕ | ✅ |
| `lobsterai` | LobsterAI（有道龙虾） | ✕ | ✅ |
| `trae` | TRAE（字节跳动） | ✕ | ✅ |
| `qoder` | Qoder | ✅ 设备码 | ✅ |
| `qodercn` | Qoder（中国版） | ✅ 设备码 | ✅ |
| `opencode` | OpenCode Zen | ✕ | ✕ |
| `raccoon` | Raccoon（商汤） | ✅ 微信扫码 | ✕ |
| `zcode` | ZCode（智谱） | ✅ 设备码 | ⚠️ |
| `loomy` | Loomy（讯飞） | ✅ 短信 / 扫码 | ✅ |
| `gemini` | Gemini（Cloud Code Assist） | ✕ | ✕ |
| `meoo` | Meoo（秒悟） | ✕ | ✅ |

`buddy` 是**默认供应商**（裸模型名的兜底），它排在第一项且不参与自动识别，避免抢走别家的凭据。

**打 ✕ 的都能正常对话**，签到与登录是独立能力。不能发起登录的原因都在上游协议侧，不是本服务的缺失：

- **codearts / lobsterai**：授权回调被强制指向本机 `127.0.0.1` 端口，服务器收不到（codearts 的跳转链还会在服务端绕回登录页）。
- **trae**：授权页对回调地址有硬编码正则，只认 `http://127.0.0.1:<端口>/authorize`。
- **gemini**：Google 对原生应用只允许 loopback 重定向（RFC 8252）。
- **meoo**：官方 CLI 在 `127.0.0.1` 起本地 HTTP 服务收 OAuth 回调。
- **opencode**：上游本就没有登录流程，只有 API key 与匿名通道。

`zcode` 的 ⚠️ 是如实的：签到接口始终索要阿里云验证码，本服务**大概率签到失败并如实报错**（推理不受影响）。

能力矩阵不是写死的表 —— `GET /admin/providers` 返回真实的能力声明与**每项不可用的具体原因**，
面板也据此渲染。新增一家只需实现 `Provider` 接口并注册，网关不认识具体供应商。

> 另有**虚拟供应商** `aggregate`：它没有账号、没有凭据，只是把上面各家的模型归到一起再挑一个发出去。

---

## 快速上手

### 1. 构建

```bash
git clone <repo> free-llm-router && cd free-llm-router
npm install --legacy-peer-deps   # wrangler 与 workers-types 的 peer 版本冲突，必须带这个参数
npm run build:node               # 产出 dist/server.mjs
```

### 2. 配置

```bash
cat > .env <<'EOF'
PORT=11451
HOST=0.0.0.0
DATABASE_PATH=./data/router.db
API_KEY=<你的口令，建议 openssl rand -base64 24 生成>
# CREDENTIAL_KEY=<可选：固定凭据加密密钥，便于迁移>
AUTO_TASK_CRON=true
EOF
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `11451` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机反代时建议改 `127.0.0.1`） |
| `DATABASE_PATH` | `./data/router.db` | SQLite 文件路径 |
| `API_KEY` | *（空）* | 面板与全部 API 的口令。**不设则任何请求 401**（fail-closed） |
| `CREDENTIAL_KEY` | *（自动生成）* | 凭据 AES-GCM 加密密钥；不设则首次启动生成并持久化到库里 |
| `AUTO_TASK_CRON` | `true` | 每小时巡检开关。⚠️ Node 侧只认字面量 `false`，其余值一律视为开启 |
| `PUBLIC_URL` | *（空）* | 可选，仅用于启动 banner 显示 |
| `UPSTREAM_CHAT_BASE` / `UPSTREAM_BILLING_BASE` / `UPSTREAM_WEB_BASE` | 内置默认 | 高级：覆盖上游端点 |

> ⚠️ **迁移服务器时**：若原部署用的是自动生成的 `CREDENTIAL_KEY`，必须从旧库导出后再迁移，
> 否则新库会生成新密钥、旧凭据全部解不开。

### 3. 启动

```bash
node dist/server.mjs
```

打开 `http://localhost:11451/panel/`，用 `API_KEY` 登录。

### 4. 加账号

面板「供应商与账号」→「添加账号」，两种方式：

- **面板登录**（9 家支持）：设备码 / 用户码 / 扫码 / 短信，按提示完成授权；
- **粘贴凭据 JSON**（所有供应商可用）：系统按各家的判别式**自动识别**是哪一家，
  也接受显式 `"provider":"codearts"` 覆盖，以及数组或 `{"accounts":[...]}` 批量导入。

### 5. 调用

```bash
curl -N http://localhost:11451/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"buddy/<模型名>","messages":[{"role":"user","content":"你好"}]}'
```

`GET /v1/models` 里列出的模型**一律带 `provider/` 前缀**，且只列「有账号」的供应商 ——
列出必然失败的模型只会让客户端挑错。

部署到 Cloudflare Workers，以及反向代理 / HTTPS / 备份迁移 / 排障的详细步骤，见 [DEPLOY.md](DEPLOY.md)。

---

## 主要端点

### 免鉴权

| 路径 | 说明 |
|---|---|
| `GET /healthz` | 存活探针，不含任何敏感信息 |
| `GET /panel/` | 管理面板静态资源（页面本身不含数据） |
| `GET /login/codearts/callback`、`GET /login/trae/callback` | 浏览器登录回跳，安全性由一次性 `state` 保证 |

### OpenAI 兼容（`/v1/*`）

| 路径 | 说明 |
|---|---|
| `GET /v1/models` | 模型目录（带 `provider/` 前缀 + `aggregate/` 虚拟模型） |
| `POST /v1/chat/completions` | 对话，流式 / 非流式，含工具调用 |
| `POST /v1/responses` | Responses API，内部复用 Chat 路径 |

`/v1/*` 接受**两种** Key：主密钥（`API_KEY`）与面板签发的**子密钥**。
子密钥只能进 `/v1/*`，不能登录面板、不能改账号 —— 否则它能给自己扩容。子密钥可限制请求数、token 数、
统计窗口、可用模型、来源 IP（支持 CIDR）与过期时刻。

### 管理（`/admin/*`，共 42 个路径）

按用途分类，不逐个罗列：

| 分类 | 代表路径 |
|---|---|
| 账号与凭据 | `accounts`、`accounts/toggle`、`accounts/remove`、`import`、`credentials`、`pool` |
| 供应商与登录 | `providers`、`providers/login/{start,poll}`、`login/{start,poll}`、`providers/login/loomy/{sms,bind}`、`providers/settings` |
| 模型目录 | `providers/models`、`providers/models/{toggle,bulk}`、`models/builtin`、`models/probe` |
| 任务与签到 | `tasks/{scan,run,status,start}`、`tasks/daily-all`、`checkin/all` |
| 补偿与积分锁 | `compensation`、`compensation/claim`、`permanent-locks` |
| 用量与日志 | `usage`、`usage/clear`、`logs`、`logs/clear`、`packages` |
| 子密钥 | `apikeys`、`apikeys/{update,reset,reset-usage,remove}` |
| 运维 | `config/routing`、`cooldowns/clear`、`waf`、`waf/clear` |

---

## 管理面板

`/panel/`，**7 个视图**：

| 视图 | 内容 |
|---|---|
| **供应商与账号** | 15 家供应商卡片、账号列表、登录 / 导入 / 删除、逐账号积分与额度分级（区分「用光了」与「查不到」）、拖动排序 |
| **任务中心** | 一键签到（串行，不支持的会说明原因）、Buddy 每日任务、限时补偿积分查询 / 领取 |
| **用量** | 今日 / 近 7 天 / 近 30 天 / 全部 四个窗口 + 按天趋势；明细最近 500 条，按天聚合保留 90 天 |
| **API Key** | 子密钥的创建、限额、重置、吊销（明文只在生成时出现一次） |
| **模型** | 模型目录、启用 / 停用、单模型探测 |
| **配置** | 接入指南、路由配置、**永久积分锁**开关、冷却清理 |
| **日志** | 请求与任务日志，按类型过滤 |

页面本身免鉴权（不含数据），口令存在 `localStorage`、每个请求带 `Authorization` 头 ——
刻意不用 cookie，避免额外引入 CSRF 面。

### 三个值得一提的开关

**永久积分锁**（配置页，逐供应商）：开启后，该供应商下「**只剩永久额度**」的账号不再参与选号。
免费额度烧完后若继续用，消耗的是你花钱买的永久积分，且**不可撤回** —— 这个开关就是拦这件事。
有临期额度的账号照常可用，因此它不是「停用该供应商」。

**限时补偿积分**（任务中心）：上游偶尔发限时补偿（如服务抖动后补积分），过期作废。
面板提供「查状态」（只读）与「领取」（一次性写操作）两个按钮。**刻意不接进 cron 与自动签到** ——
一次性动作误触没有第二次机会，必须由人显式触发。

**零输出熔断**（自动，无开关）：部分上游虚报上下文窗口，按虚高窗口打包就会越墙 ——
上游「收下请求但吐 0 个字符」并回 `finish_reason=length`。判据要求**同时**满足「零输出」，
因为 `length` + **有输出** 是「答到半截撞输出上限」，此时换目标会丢掉已产出的正文。
命中后把该（账号, 模型）目标冷却 10 分钟并改道重发；工具调用与客户端主动取消都不算命中。

---

## 使用边界

本项目**仅限本人授权账号自用**，明确反对：

- 批量注册小号 / 收购账号；
- 账号池出租、对外提供付费 API、二次加壳售卖。

技术方案不阻止这些用法，但**本项目的开发意图不包含它们**。
批量注册与转售接口配额违反目标平台服务条款。

---

## 已知限制

已修掉的不再列在这里；下面全部是**当前仍然存在**的。

| 项 | 影响 |
|---|---|
| **6 家不能从本服务发起登录** | codearts / lobsterai / trae / gemini / meoo 的回调被上游限制在本机端口，opencode 上游无登录流程 ⇒ 只能导入凭据 |
| **流内换号未实现** | 只在「还没开始输出」时换号。一旦开始流式输出就固定，否则会把两个模型的半截回答拼成乱码 |
| **zcode 签到大概率失败** | 上游强制阿里云验证码，需 headful 浏览器；本服务如实报错，不谎报已领。推理不受影响 |
| **zcode 签到受上游风控** | 间歇性返回风控错误（账号/IP 级），非本服务缺陷 |
| **5 家没有每日签到** | workbuddy（上游无此接口）、cline（端点扫描无命中）、raccoon（服务端按日自动发放）、gemini（额度是配额比例不是可领积分）、opencode（无积分体系） |
| **3 家不能自动续期** | zcode（凭据静态）、loomy（无续期端点）、opencode（匿名通道无凭据）—— 不给它们写假续期，否则 UI 会显示「可自动续期」 |
| **opencode 无余额端点** | 且 `fetch` 不支持 per-request 代理 ⇒ 多个匿名槽共享同一出口 IP，免费额度**无法靠多开扩容** |
| **聚合路由不做缓存** | 每次请求现拉目录与到期时刻，刻意优先正确性（缓存新旧不一致会让「临期优先」选错） |
| **聚合排序依赖各家 `balance()`** | 查不到余额的家（如 opencode）不参与排序 |
| **IP 级 WAF 护栏是启发式推测** | 60 秒内 2 个不同账号接连 403 即暂停轮转；可能误判，故留了 `POST /admin/waf/clear` 人工纠正 |
| **用量明细只留 500 条** | 更早的日键保留 90 天；明细淘汰后无法回答「某一笔长什么样」，但「用了多少」不受影响 |
| **费用估算模块目前无生产消费者** | `src/gateway/cost-estimate.ts` 只有单测覆盖，尚未接进面板与用量统计。且它输出的是**无量纲相对值**，不是钱 —— 各家倍率不同基准，跨供应商相加没有意义 |

### 关于「空回复」

本服务**绝不用空回复掩盖失败**：上游若返回没有正文、没有思考内容、也没有可识别错误帧的响应，
会明确报 502 `upstream_error` 并附上游原文片段。
（唯一例外是**只调用工具**的响应 —— 那时正文本来就是空的。）

同理，「查不到」与「没有」严格区分：查不到补偿活动就显示「查不到」，不会编成「没有」。

---

## License

MIT
