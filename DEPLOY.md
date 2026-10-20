# 部署说明

本项目**一份代码、两种运行形态**，部署方式二选一：

| 运行形态 | 入口 | 适用 | 本章节 |
|---|---|---|---|
| **VPS / Node** | `src/server/index.ts` → `dist/server.mjs` | 自有服务器、Docker、systemd | [§1](#1-vps--node-部署推荐) |
| **Cloudflare Workers** | `src/index.ts` | 想零运维、用 CF 免费额度 | [§2](#2-cloudflare-workers-部署) |

> 两种形态**源码相同**、**数据格式相同**（都是 SQLite），但**存储位置不同**：
> VPS 用本地 `data/router.db`，Workers 用 Durable Object SQLite。**账号数据不互通。**

---

## 1. VPS / Node 部署（推荐）

> 部署到自己的 Linux 服务器（x86_64 / aarch64 均可），用 **Node.js 22+** 直接跑。
> **不需要任何外部数据库** —— 状态全部落在单个 SQLite 文件里。

### 1.1 前置条件

- **Node.js ≥ 22**（内置 `node:sqlite`，**无需编译原生模块**）
  ```bash
  node -v   # 必须 ≥ v22
  ```
- 一个反向代理（nginx / Caddy）用于 HTTPS —— 可选但**强烈建议**（见 [§1.6](#16-反向代理--https)）

### 1.2 构建

```bash
git clone <repo> free-llm-router && cd free-llm-router

# ⚠️ 必须加 --legacy-peer-deps：wrangler 新版把 @cloudflare/workers-types 的
#    peer 版本升到了 v5，与项目锁定的 v4 冲突。（VPS 构建其实不需要 wrangler，
#    只用它带的 esbuild，但安装时 peer 冲突仍会报错。）
npm install --legacy-peer-deps
npm run build:node          # 产出 dist/server.mjs（约 1.5 MB 单文件）
```

### 1.3 配置

复制环境变量模板并填写（**不要提交 `.env` 到任何仓库**）：

```bash
cat > .env <<'EOF'
PORT=11451
HOST=0.0.0.0
DATABASE_PATH=./data/router.db
API_KEY=<你的面板与 API 口令，建议 openssl rand -base64 24 生成>
# CREDENTIAL_KEY=<可选：固定凭据加密密钥，便于迁移/多实例共享
AUTO_TASK_CRON=true
EOF
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `11451` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（**只在本机反代时建议改 `127.0.0.1`**） |
| `DATABASE_PATH` | `./data/router.db` | SQLite 文件路径 |
| `API_KEY` | *（空）* | 面板与全部 API 的口令。**不设则任何请求 401**（fail-closed） |
| `CREDENTIAL_KEY` | *（自动生成）* | 凭据 AES-GCM 加密密钥 |
| `AUTO_TASK_CRON` | `true` | 每小时自动巡检（签到 / 成长任务）开关（`false` / `0` / `no` / `off` 关闭） |
| `TRUST_PROXY` | `false` | 走反向代理时设为 `true`，否则子密钥的「来源 IP」会全部显示为反代地址（见 §1.6） |
| `PUBLIC_URL` | *（空）* | 可选：仅用于启动 banner 显示对外地址 |

> ⚠️ **`CREDENTIAL_KEY` 的行为（务必理解）**：
> - **不设**：首次启动时自动生成 32 字节随机密钥，并**持久化到 `data/router.db` 内部**
>   （表 `system_kv`，键 `server:credential_key`）。开箱即用。
> - **设了**：始终使用你给的密钥，**优先生效**。
>
> ⚠️ **迁移服务器时**：若原部署用的是**自动生成**的密钥，迁移前必须从旧库导出它，
> 否则新库会生成**新的**密钥、旧凭据全部解不开：
> ```bash
> sqlite3 旧库/router.db "SELECT value FROM system_kv WHERE prefix='server' AND key='credential_key'"
> # 或直接把整份 router.db 一起搬过去
> ```

### 1.4 启动

#### 方式 A：Docker（推荐，环境隔离）

仓库自带 `Dockerfile`（`node:22-alpine`，**只 COPY 构建产物**，镜像极小）：

```bash
# ① 先在宿主机构建（见 §1.2）
npm run build:node

# ② 构建镜像
docker build -t free-llm-router:latest .

# ③ 运行
mkdir -p data && chown -R 1000:1000 data   # ⚠️ 容器内以 uid 1000(node) 运行
docker run -d --name free-llm-router \
  --restart unless-stopped \
  -p 11451:11451 \
  -v "$PWD/data:/app/data" \
  -e API_KEY=<你的口令> \
  -e AUTO_TASK_CRON=true \
  free-llm-router:latest
```

> ⚠️ **数据卷必须持久化**：`/app/data` 一旦丢失，所有账号凭据**无法解密**
> （等于全部要重新登录）。备份见 [§1.7](#17-数据备份与迁移)。
>
> ⚠️ **容器内是非 root 用户**（`node`，uid 1000）。宿主 `./data` 若由 root 创建，
> 容器**写不进去** ⇒ SQLite 打开失败。先 `chown -R 1000:1000 data`。
>
> 💡 **开发时想改代码即时生效**：把 `dist/server.mjs` 也 bind mount 进去，
> 改完重建后 `docker restart` 即可，不必重新 `docker build`：
> ```bash
> -v "$PWD/dist/server.mjs:/app/dist/server.mjs:ro"
> ```

也可用 `docker-compose.yml`（已在仓库里），但注意它与上面的 `docker run`
**参数需自行对齐**（特别是 `CREDENTIAL_KEY`）。

#### 方式 B：systemd（裸机常驻）

仓库自带 `free-llm-router.service`：

```bash
sudo mkdir -p /opt/free-llm-router
sudo cp -r dist /opt/free-llm-router/
sudo cp .env /opt/free-llm-router/.env
sudo cp free-llm-router.service /etc/systemd/system/
# 按需修改 service 里的 User / WorkingDirectory / DATABASE_PATH
sudo systemctl daemon-reload
sudo systemctl enable --now free-llm-router
sudo systemctl status free-llm-router
journalctl -u free-llm-router -f          # 看日志
```

#### 方式 C：前台直接跑（调试用）

```bash
node dist/server.mjs
```

启动成功会打印一段 banner（含监听地址、数据库路径、`API_KEY` 是否已配置）。

### 1.5 打开面板

浏览器访问 `http://<你的服务器IP>:11451/panel/`，在登录页输入 `API_KEY` 即可进入。

> `/` 根路径返回 **401**（需密钥）—— 刻意如此，避免被扫到。
> 面板页面本身不含敏感数据，但所有数据接口都要 `Authorization`。

### 1.6 反向代理 + HTTPS

**强烈建议**用反向代理给服务加 HTTPS（否则 API Key 会在明文 HTTP 上传输）。

> ⚠️ **SSE（流式响应）必须关闭缓冲**，否则流式对话会被整段卡住、体验极差。
> 代码已读取 `X-Forwarded-Proto` / `Host`，反代只需正确透传。
>
> ⚠️ **走反代时请在 `.env` 里加 `TRUST_PROXY=true`**：服务会按 `X-Forwarded-For` 最右一项（反代追加的真实地址）识别客户端 IP，
> 子密钥的 IP 白名单与「最后来源 IP」才准确。不走反代、直接对外时**不要**开 —— 那样客户端可以自己伪造这个头。
> 客户端自带的 `CF-Connecting-IP` 一律会被丢弃，无法用来绕过白名单。

**Caddy**（最简，自动申请证书）：

```caddy
llm.example.com {
    reverse_proxy 127.0.0.1:11451 {
        flush_interval -1        # ⚠️ 关闭缓冲，SSE 必需
    }
}
```

**nginx**：

```nginx
server {
    listen 443 ssl http2;
    server_name llm.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:11451;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # ⚠️ 流式（SSE）必需：关闭缓冲、拉长超时
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
```

> 用反代时建议把 `.env` 的 `HOST` 改成 `127.0.0.1`，**避免 11451 端口直接暴露到公网**。

### 1.7 数据备份与迁移

> ⚠️ 本项目启用 **SQLite WAL 模式**，数据库除了 `router.db` 还有两个伴随文件
> `router.db-wal` / `router.db-shm`。**备份时三个文件要一起备**（或先停服务）。

```bash
# 最稳：先停服务再备主库（WAL 内容会回写到主库）
docker stop free-llm-router                       # 或 systemctl stop free-llm-router
cp data/router.db data/router.db.bak-$(date +%Y%m%d)
docker start free-llm-router

# 迁移到新服务器：连 backup 目录 + 确认 CREDENTIAL_KEY 一致（见 §1.3）
```

### 1.8 更新部署

```bash
# 本地/服务器上重新构建
npm run build:node

# 替换产物 + 重启（数据不受影响）
docker cp dist/server.mjs free-llm-router:/app/dist/server.mjs
# 若用了 bind mount，则：cp dist/server.mjs <挂载目录>/dist/server.mjs
docker restart free-llm-router
```

### 1.9 自检

```bash
BASE=http://127.0.0.1:11451
KEY=<你的 API_KEY>

curl -s "$BASE/healthz"                                              # {"ok":true,"service":"free-llm-router"}
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/pool?realm=cn"
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/pool?realm=global"
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/waf?realm=cn"   # IP 级护栏状态
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models" | head -c 200
```

---

## 2. Cloudflare Workers 部署

> 同一份代码也可部署到 Cloudflare Workers（**Free 计划即可**，
> Durable Objects 在 Free 计划可用，仅 SQLite 后端）。

### 2.1 认证与部署

```bash
# 认证（二选一）
npx wrangler login
# 或
export CLOUDFLARE_API_TOKEN=<token>   # 需 "Edit Cloudflare Workers" 权限

npm install
npm run deploy
```

### 2.2 secret（**必须设**）

```bash
openssl rand -base64 32 | npx wrangler secret put API_KEY
openssl rand -base64 32 | npx wrangler secret put CREDENTIAL_KEY
```

| secret | 用途 | 未设置的后果 |
|---|---|---|
| `API_KEY` | 面板与全部 API 的口令 | 所有请求 401（fail-closed） |
| `CREDENTIAL_KEY` | 凭据 AES-GCM 加密密钥 | **拒绝写入凭据**（不静默明文落盘） |

> ⚠️ secret **不会**随 Git 部署带入：用 Dashboard 连 Git 时，需在
> **Settings → Variables and Secrets** 手工加。

### 2.3 域名绑定（Route vs Custom Domain）

| 方式 | DNS 记录归属 | 能否做优选 IP |
|---|---|---|
| **Worker Route** | **你**（CF 只按 pattern 匹配） | ✅ 可以 |
| **Custom Domain** | Cloudflare 自己托管（你改不了） | ❌ 不行 |

**若要优选 IP / 优选域名，必须用 Route** —— 优选的前提就是你自己控制那条 DNS 记录。

- Route 通常要求 DNS 记录是「**已代理（橙云）**」——Worker Route 只在经过 CF 网络的流量上触发。
- Route **不会**自动建 DNS 记录，域名必须已有同 zone 的 DNS 记录，否则 route 不生效
  （表现为「域名解析不了」，与 Worker 本身无关）。

绑定自定义域可用 `PUT`（不是 `POST`）：

```bash
curl -X PUT -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/domains" \
  -d "{\"zone_id\":\"$ZONE\",\"hostname\":\"<你的域名>\",\"service\":\"<worker 名>\",\"environment\":\"production\"}"
```

> `POST` 同一端点会返回 `405 Method not allowed for this authentication scheme`，**改用 `PUT` 即可**。
> 用自定义域 API **不需要 DNS 写权限** —— Cloudflare 会自动创建对应的 DNS 记录。

### 2.4 ⚠️ 三个容易踩的坑（都实测踩过）

1. **一旦 `wrangler.jsonc` 里出现 `routes`，`workers.dev` 会被默认关闭** ——
   若此时自定义域 DNS 还没生效，服务会**完全不可达**（workers.dev 404 + 域名解析失败）。
   故配置里**显式保留** `"workers_dev": true` 作为兜底入口。不要删。

2. **`routes` 里的占位符会让部署失败** —— 本仓库是公开的，真实域名被替换成
   `<你的域名>`。而 `wrangler deploy` 会拿它去 CF **查 zone** ⇒ 查不到 ⇒ 报：
   ```
   Error Occurred: Unable to fetch bindings, routes, or services metadata ...
   ```
   ⚠️ 该报错**极具误导性**（说「稍后重试」，但重试一百次都一样）。
   **故 `wrangler.jsonc` 的 `routes` 默认已注释掉** —— 域名绑定只需在 CF 上做一次。

3. **Worker 名必须与实际一致** —— DO 命名空间名是 `<worker名>_<类名>`，
   改名后不同步会报 `namespace name '..._AccountPoolDO' already in use [code: 10065]`。
   ⚠️ 该报错**与 DO 真重名无关**，只是「worker 名对不上」的副产物。

### 2.5 移除

```bash
npx wrangler delete <worker 名>
# 验证探针（不需要可删）
npx wrangler delete workbuddy-egress-probe
```

---

## 3. 通用：部署后必做

无论哪种形态，**首次部署后**都要：

1. 打开 `/panel/`，用 `API_KEY` 登录；
2. 在「供应商与账号」里**添加账号**（设备码登录 / 导入凭据）；
3. 到「配置」页确认自动任务状态；
4. 调一次 `/v1/chat/completions` 验证协议连通。

## 4. 探针（可选）

`probe/` 是一个**独立的**最小 Worker，用于验证**出口 IP 是否被上游 WAF 拦截**
（本项目架构决策的前置验证项）。它可单独部署、可随时删除，与主服务无关：

```bash
cd probe && npx wrangler deploy
```
