# free-llm-router

**把多个大模型供应商的账号池，聚合成一个 OpenAI 兼容的 API** ——
外加任务自动化（签到 / 成长任务 / 自动领奖）。

一份代码，两种运行形态：

| 运行形态 | 入口 | 说明 |
|---|---|---|
| **VPS / Node**（推荐自持服务器） | `src/server/index.ts` → `dist/server.mjs` | 单文件产物，`node dist/server.mjs` 直接跑；用 `node:sqlite` 落盘，无需任何外部数据库 |
| **Cloudflare Workers** | `src/index.ts` | Free 计划即可；用 Durable Objects + SQLite |

> 名字直白说明它是什么：**多个免费/自持账号 → 一个统一的 LLM 路由入口**。

> ⚠️ **仅限本人授权账号自用。** 见 [使用边界](#使用边界)。

---

## 目录

- [功能](#功能)
- [支持的供应商](#支持的供应商)
- [VPS 部署（Node / Docker / systemd）](#vps-部署)
- [Cloudflare Workers 部署](#cloudflare-workers-部署)
- [快速上手](#快速上手)
- [使用边界](#使用边界)
- [已知限制](#已知限制)
- [License](#license)

---

## 功能

| 能力 | 说明 |
|---|---|
| **任务自动执行** | 成长任务（11 个零对话消耗动作）+ 每日签到 + 自动领奖。真实账号实测 **growth 计划 23/23 步全成功**，其中 `first_buddy` 真实领到 +300 积分 |
| **OpenAI 兼容网关** | `GET /v1/models` + `POST /v1/chat/completions`，**流式与非流式**均支持，含**工具调用**。已接入账号池（选号 / 记账 / 失败换号 / 会话粘性） |
| **Responses API** | `POST /v1/responses`（Codex CLI 等新一代客户端用），含流式 SSE 与工具调用。**内部复用 Chat 路径**，故 Chat 侧修好的缺陷它自动受益 |
| **多供应商** | **13 家**，统一 `Provider` 接口；模型名用 `provider/model` 前缀路由 |
| **聚合路由** | `aggregate/…`：把各渠道的**同一个真实模型**归到一个规范名下，按**积分最快作废**自动选渠道（临期的先烧、长期的留着），失败自动换下一家 |
| **用量统计** | 今日 / 近 7 天 / 近 30 天 / 全部 四个窗口 + 按天趋势。⚠️ 按天聚合**保留 90 天**，明细保留最近 500 条 |
| **凭据自动续期** | 8 家支持续期。**每小时巡检在过期前 1 小时主动换新**（不是等 401 才补救），并在 401 时兜底续期重放 |
| **凭据加密** | AES-GCM 落库（**不落明文**）；未配置密钥时**拒绝写入** |
| **账号接入** | 设备码 / 扫码 / 短信登录（浏览器授权）+ 凭据导入（三种 JSON 形态自动识别） |
| **管理面板** | 6 个视图：供应商与账号 / 任务中心 / 用量 / 模型 / 配置 / 日志 |

---

## 支持的供应商

> 腾讯有**国内版**（`buddy`）与**国际版**（`workbuddy`）两个变体，同源但端点与模型池不同。

| 供应商 | id | 面板登录 | 签到 | 续期 | 说明 |
|---|---|---|---|---|---|
| Buddy（腾讯国内版） | `buddy` | ✅ 设备码 | ✅ | ✕ | **默认供应商**（裸模型名的兜底） |
| WorkBuddy（腾讯国际版） | `workbuddy` | ✅ 设备码 | ✕ | ✕ | |
| Cline | `cline` | ✅ 用户码 | ✅ | ✅ | WorkOS 设备码（用户码式） |
| Qoder | `qoder` | ✅ 设备码 | ✅ | ✅ | 会**排队**，实测 11–27s |
| MiniMax Code（中国版） | `minimax` | ✅ 设备码 | ✅ | ✅ | OAuth 设备码 + PKCE |
| Loomy（讯飞） | `loomy` | ✅ **短信验证码** | ✅ | ✕ | |
| Raccoon（商汤） | `raccoon` | ✅ 微信扫码 | ✕ | ✅ | |
| ZCode（智谱） | `zcode` | ✅ 设备码 | ⚠️ | ✕ | 推理受上游风控（见下） |
| CodeArts（华为云码道） | `codearts` | ✕ | ✅ | ✅ | 登录回调被上游**强制**指向 `127.0.0.1` ⇒ 只能导入凭据 |
| TRAE（字节跳动） | `trae` | ✕ | ✅ | ✅ | 同上（强制本机回调） |
| LobsterAI（有道龙虾） | `lobsterai` | ✕ | ✅ | ✅ | 同上 |
| OpenCode Zen | `opencode` | ✕ | ✕ | ✕ | 用 API key |
| Gemini（Cloud Code Assist） | `gemini` | ✕ | ✕ | ✅ | 导入凭据 |

> 另有**虚拟供应商** `aggregate`（聚合路由）。它**不是**上面那类真实渠道 ——
> 它没有账号、没有凭据，而是把上面各家的模型归到一起再挑一个发出去。

**打 ✕ 的都能正常对话**（`opencode` 的 ✕ 只影响登录与签到）。
不能从本服务发起登录的 4 家，原因都是**上游的协议限制**，不是本服务的缺失：

- **codearts / trae / lobsterai / gemini**：登录回调被上游**强制**指向本机
  `127.0.0.1`（codearts 的跳转链还会在服务端死循环），而服务器**收不到用户本机的端口**
  ⇒ 用**粘贴凭据导入**（见下）。
- **opencode**：上游只有匿名槽与 API key 两种用法，没有登录流程。

> `GET /admin/providers` 返回完整能力矩阵与每项不可用的具体原因。

---

## VPS 部署

> 部署到自己的 Linux 服务器（x86_64 / aarch64 均可），用 **Node.js 22+** 直接跑，
> 或用 Docker / systemd 托管。**不需要外部数据库** —— 状态全部落在单个 SQLite 文件里。

### 前置条件

- **Node.js ≥ 22**（内置 `node:sqlite`，无需编译原生模块）
- 一个反向代理（nginx / Caddy）用于 HTTPS —— 可选但**强烈建议**

### 方式一：源码构建（推荐）

```bash
git clone <repo> free-llm-router && cd free-llm-router

# 1. 安装依赖并构建单文件产物
npm install --legacy-peer-deps
npm run build:node          # 产出 dist/server.mjs（约 1.5 MB）

# 2. 配置环境变量（复制一份 .env 或直接 export）
#    ⚠️ API_KEY 不设置则任何人都能访问；CREDENTIAL_KEY 不设置会自动生成并落库
cat > .env <<'EOF'
PORT=11451
HOST=0.0.0.0
DATABASE_PATH=./data/router.db
API_KEY=<你的面板与 API 口令>
# CREDENTIAL_KEY=<可选：固定凭据加密密钥，便于迁移>
AUTO_TASK_CRON=true
EOF

# 3. 启动
node dist/server.mjs
```

打开 `http://<你的服务器IP>:11451/panel/`，把 `API_KEY` 填进右上角输入框。

### 方式二：Docker

仓库自带 `Dockerfile`（基于 `node:22-alpine`，**只 COPY 构建产物**，镜像极小）：

```bash
npm install --legacy-peer-deps && npm run build:node   # 先在宿主机构建
docker build -t free-llm-router:latest .

docker run -d --name free-llm-router \
  --restart unless-stopped \
  -p 11451:11451 \
  -v "$PWD/data:/app/data" \
  -v "$PWD/dist/server.mjs:/app/dist/server.mjs:ro" \
  -e API_KEY=<你的口令> \
  -e AUTO_TASK_CRON=true \
  free-llm-router:latest
```

> ⚠️ **数据卷必须持久化**：`/app/data`（含 `router.db`）一旦丢失，
> 所有账号凭据将**无法解密**（等于全部要重新登录）。备份时记得
> `router.db` 连同 `router.db-wal` / `router.db-shm` 一起备。
>
> ⚠️ **容器内以非 root 用户（`node`，uid 1000）运行**。若宿主 `./data` 目录
> 由 root 创建，容器会写不进去 ⇒ SQLite 打开失败。先执行 `chown -R 1000:1000 data`。

### 方式三：systemd（裸机常驻）

仓库自带 `free-llm-router.service`：

```bash
sudo mkdir -p /opt/free-llm-router
sudo cp -r dist /opt/free-llm-router/
sudo cp .env /opt/free-llm-router/.env
sudo cp free-llm-router.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now free-llm-router
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `11451` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATABASE_PATH` | `./data/router.db` | SQLite 文件路径 |
| `API_KEY` | *（空）* | 面板与全部 API 的口令。**不设 = 任何人可访问** |
| `CREDENTIAL_KEY` | *（自动生成）* | 凭据 AES-GCM 加密密钥。不设则在 SQLite 内自动生成并持久化 |
| `AUTO_TASK_CRON` | `true` | 是否启用每小时自动巡检（签到 / 成长任务） |
| `PUBLIC_URL` | *（空）* | 可选：对外访问地址，仅用于启动 banner 显示 |
| `UPSTREAM_CHAT_BASE` | 内置默认 | 高级：覆盖上游 chat 端点（如自建反代） |
| `UPSTREAM_BILLING_BASE` | 内置默认 | 高级：覆盖上游计费端点 |
| `UPSTREAM_WEB_BASE` | 内置默认 | 高级：覆盖上游 web 端点 |

> ⚠️ **迁移服务器时**：若原部署用的是自动生成的 `CREDENTIAL_KEY`，
> 迁移前务必从旧库导出它（`SELECT value FROM system_kv WHERE prefix='server' AND key='credential_key'`），
> 或改成显式设 `CREDENTIAL_KEY` 环境变量。否则新库会生成**新的**密钥，旧凭据全部解不开。

---

## Cloudflare Workers 部署

同一份代码也可部署到 Cloudflare Workers（**Free 计划即可**，Durable Objects 仅 SQLite 后端）。

```bash
npm install
openssl rand -base64 32 | npx wrangler secret put API_KEY
openssl rand -base64 32 | npx wrangler secret put CREDENTIAL_KEY
npm run deploy
```

| secret | 用途 | 未设置的后果 |
|---|---|---|
| `API_KEY` | 面板与全部 API 的口令 | 所有请求 401（fail-closed） |
| `CREDENTIAL_KEY` | 凭据 AES-GCM 加密密钥 | **拒绝写入凭据**（不静默明文落盘） |

域名绑定（Route vs Custom Domain / 优选 IP 前提）、`workers.dev` 兜底、GitHub 自动部署等，
见 [DEPLOY.md](DEPLOY.md)。

---

## 快速上手

### 调用 API

```bash
curl -N http://127.0.0.1:11451/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"buddy/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

### Responses API

```bash
curl -N http://127.0.0.1:11451/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"buddy/deepseek-v4-flash","input":"你好"}'
```

⚠️ 不支持 `previous_response_id` 与 `store: true`（本服务无状态），传了会**明确报 400**
而不是静默忽略 —— 静默忽略会让客户端以为有上下文，进而答非所问。

### 模型路由（`provider/model` 前缀）

```jsonc
"model": "buddy/deepseek-v4-flash"   // 带前缀 → 指定供应商
"model": "deepseek-v4-flash"         // 裸名 → 回落到默认供应商（buddy），保持兼容
```

- `GET /v1/models` 的目录里**一律带 `provider/` 前缀**（多家有同名模型，裸名分不清）；
  只列「有账号」的供应商的模型。
- 请求侧**仍接受裸名**，回落到默认供应商。

### 聚合路由（`aggregate/…`）

同一个真实模型在各渠道叫法不同，例如 DeepSeek V4.1 Flash：`buddy` 叫 `deepseek-v4.1-flash`、
`lobsterai` 叫 `deepseek-flash`、`raccoon` 叫 `sn-deepseek-v4-1-flash`。
聚合把它们归到一个规范名，并按**积分最快作废**自动选渠道：

```jsonc
"model": "aggregate/deepseek-v4-1-flash"  // 该模型的所有渠道里挑最该先烧的
"model": "aggregate/auto"                 // 不指定模型：在所有渠道的所有模型里挑
```

- 规范名可从 `GET /v1/models`（`aggregate/` 开头）看到；
- 传不存在的规范名会**报错并列出可用键**；
- **失败自动换下一家**，但只在「还没开始输出内容」时换（否则会把两个模型的半截回答拼成乱码）；
- **遵循面板里的模型停用设置**（停用 = 彻底关掉）。

### 添加账号

**① 面板登录**（8 家支持）：点「添加账号」，按提示完成授权，面板自动加密保存。
`buddy` / `workbuddy` / `minimax` / `qoder` / `zcode` 是**设备码**；
`cline` 是**用户码**式；`raccoon` 是**微信扫码**；`loomy`（讯飞）是**短信验证码**。

**② 导入凭据**（所有供应商可用）：粘贴 JSON。支持三种形态：

```jsonc
// 嵌套形
{ "auth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000, "realm": "cn" },
  "account": { "uid": "...", "nickname": "..." } }

// 扁平形 camelCase
{ "accessToken": "...", "uid": "...", "expiresAt": 1700000000 }

// 扁平形 snake_case
{ "access_token": "...", "user_id": "...", "expires_at": 1793427699000 }
```

也接受数组或 `{"accounts":[...]}`。系统会**自动识别**是哪一家（靠各家 `matchesShape` 判别式），
也可显式指定 `"provider":"codearts"` 覆盖。

---

## 使用边界

本项目**仅限本人授权账号自用**，明确反对：

- 批量注册小号 / 收购账号；
- 账号池出租、对外提供付费 API、二次加壳售卖。

技术方案不阻止这些用法，但**本项目的开发意图不包含它们**。
批量注册与转售接口配额违反目标平台服务条款。

---

## 已知限制

已修掉的不再列在这里；下面全部是**当前仍然存在**的限制。

| 项 | 影响 |
|---|---|
| **带真实凭据的高频请求未验证过 WAF** | IP 级护栏已实现（60 秒内 2 个不同账号接连 403 即 fail-fast），但触发条件本身未被真实命中过 |
| **流内换号未实现**（trae / lobsterai） | 需先消费整个 SSE 才能决定重发，与逐帧透传（低 CPU 铁律）冲突 |
| **codearts / trae / lobsterai / gemini 的登录** | 上游**强制**回调 `127.0.0.1`（codearts 还会在服务端死循环）⇒ 只能导入凭据 |
| **opencode 每账号代理** | `fetch` 不接受 `dispatcher` ⇒ 多个匿名槽共享同一出口 IP，免费额度**不再能通过多开扩容** |
| **zcode 签到** | 需 headful Chromium 过阿里云 captcha（推理不受影响） |
| **zcode 推理受上游风控** | 间歇性返回 `405 / code 3012 unusual activity`。官方身份块**已逐字对齐且实测正确** ⇒ 判为**账号/IP 级风控**，非本服务缺陷 |
| **codearts 的 `deepseek-v4.1-flash` 间歇不可用** | 上游回 `InferHub.4004.200 benefit not found`（权益未生效）。本服务**如实报错**并附上游原文，不静默返回空回复 |
| **聚合路由不做缓存** | 每次聚合请求现拉目录与到期时刻，**刻意优先正确性**（缓存新旧不一致会让「临期优先」选错） |
| **聚合的到期时刻由各家 `balance()` 决定** | 不支持查余额的家（如 `opencode`）被判「查不到」而**不参与**排序 |
| **用量按天聚合保留 90 天** | 更早的日键会被淘汰；明细只保留最近 500 条 |

### 关于「空回复」

本服务**绝不用空回复掩盖失败**：上游若返回没有正文、没有思考内容、也没有可识别错误帧的
响应，会明确报 502 `upstream_error` 并附上游原文片段。
（唯一例外是**只调用工具**的响应 —— 那时正文本来就是空的。）

---

## License

MIT
