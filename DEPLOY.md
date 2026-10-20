# 部署指南

free-llm-router 用同一份代码支持两种部署形态。先按下表选一种，再看对应章节。

- [选哪种](#选哪种)
- [VPS / Node](#vps--node)：[环境要求](#1-环境要求) · [构建](#2-构建) · [配置](#3-配置) · [运行](#4-运行) · [HTTPS 与反向代理](#5-https-与反向代理) · [备份与迁移](#6-备份与迁移) · [升级](#7-升级) · [自检](#8-自检)
- [Cloudflare Workers](#cloudflare-workers)：[部署](#1-部署) · [设置 Secret](#2-设置-secret) · [绑定自定义域名](#3-绑定自定义域名) · [三个坑](#4-三个坑) · [升级与日志](#5-升级与日志) · [移除](#6-移除)
- [部署后检查](#部署后检查)
- [常见问题](#常见问题)
- [出口 IP 探针](#出口-ip-探针)

## 选哪种

| | VPS / Node | Cloudflare Workers |
|---|---|---|
| 运维 | 自己维护服务器、HTTPS 和备份 | 基本不用运维，Free 计划即可 |
| 运行方式 | 单文件 `dist/server.mjs`（约 2.3 MB），Docker / systemd / 前台 | `wrangler deploy` 上传 |
| 数据存储 | 本地 SQLite 文件 `data/router.db` | Durable Objects（SQLite 后端） |
| 定时任务 | 进程内定时器，重启后恢复未完成的任务 | Cron Trigger + DO alarm |
| 出口 IP | 你的服务器 IP | Cloudflare 共享出口，个别上游可能拦截（可用[探针](#出口-ip-探针)验证） |
| 适合 | 想完全掌控数据和出口 | 不想维护服务器 |

两种形态功能一致，但**数据不互通**：从一种换到另一种时，账号需要重新导入。

---

## VPS / Node

Linux 服务器（x86_64 或 aarch64）上跑一个 Node 进程，不需要外部数据库。

### 1. 环境要求

- **Node.js ≥ 22.13**：内置的 `node:sqlite` 从这个版本起不再需要 `--experimental-sqlite` 参数，也不用编译原生模块。用 Docker 时宿主机的 Node 只用来构建。
- **Docker**（可选）：用容器运行时需要。
- **域名 + 反向代理**（强烈建议）：不加 HTTPS，API Key 会以明文传输。

```bash
node -v   # 需要 v22.13 或更高
```

### 2. 构建

```bash
git clone https://github.com/quancifang44556/free-llm-router.git && cd free-llm-router
npm install --legacy-peer-deps   # 必须带：wrangler 与 @cloudflare/workers-types 的 peer 版本冲突
npm run build:node               # 产出 dist/server.mjs，已包含管理面板
```

产物是自包含的单文件，可以在一台机器上构建，再只把 `dist/server.mjs` 拷到服务器上运行。

### 3. 配置

在项目根目录创建 `.env`（已在 `.gitignore` 里，不要提交）。注释请单独占一行，systemd 不支持行尾注释：

```bash
cat > .env <<ENV
API_KEY=$(openssl rand -hex 24)
# 可选：固定凭据加密密钥，见下文
# CREDENTIAL_KEY=
# 前面有反向代理时打开
# TRUST_PROXY=true
ENV
chmod 600 .env && cat .env   # 记下 API_KEY
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `API_KEY` | 空 | 面板和全部 API 的口令。**不设置时所有请求都返回 401** |
| `CREDENTIAL_KEY` | 自动生成 | 账号凭据的加密密钥（AES-GCM），见下文 |
| `PORT` | `11451` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只让本机反向代理访问时设为 `127.0.0.1` |
| `DATABASE_PATH` | `./data/router.db` | SQLite 文件路径 |
| `TRUST_PROXY` | `false` | 前面有反向代理（nginx、Caddy、cloudflared）时设为 `true`，按 `X-Forwarded-For` 最右一项识别客户端 IP |
| `AUTO_TASK_CRON` | `true` | 每小时定时器总开关（签到、每日任务、余额刷新、凭据续期）。`false` / `0` / `no` / `off` 都表示关闭。只想停签到，请用面板里的开关 |
| `PUBLIC_URL` | 空 | 只用于启动日志里显示对外地址 |
| `UPSTREAM_CHAT_BASE`、`UPSTREAM_BILLING_BASE`、`UPSTREAM_WEB_BASE` | 内置 | 高级用法：覆盖上游接口地址 |

> [!IMPORTANT]
> **`CREDENTIAL_KEY` 决定已保存的凭据能不能解开。**
>
> - **不设置**：首次启动时生成随机密钥，保存在数据库里（`system_kv` 表，键 `server:credential_key`）。开箱即用，迁移时把整个 `data/` 目录一起搬走即可。
> - **设置了**：始终用你给的值（任意高熵字符串都行，例如 `openssl rand -base64 32`）。适合密钥和数据分开管理的场景。
>
> 不管哪种情况，密钥变了，旧凭据就全部解不开，只能重新登录或导入。

### 4. 运行

> [!NOTE]
> Node 进程**不会自动读取 `.env`**。下面几种运行方式各有加载办法：Compose 自动读取同目录的 `.env`，systemd 用 `EnvironmentFile`，前台运行用 `node --env-file=.env`。

#### 4.1 Docker Compose（推荐）

仓库自带 `Dockerfile`（基于 `node:22-alpine`，只拷贝 `dist/server.mjs`）和 `docker-compose.yml`。Compose 会从同目录的 `.env` 读取 `API_KEY`、`CREDENTIAL_KEY`、`AUTO_TASK_CRON`、`TRUST_PROXY` 和 `PUBLIC_URL`；容器内的 `HOST`、`PORT`、`DATABASE_PATH` 是固定值，`.env` 里的这几项不生效。

```bash
npm run build:node                       # 镜像只拷贝构建产物，先构建
mkdir -p data && sudo chown -R 1000:1000 data   # 容器内以 node 用户（uid 1000）运行
docker compose up -d --build
docker compose logs -f                   # 看启动日志
```

- 前面有本机反向代理时，把 `docker-compose.yml` 的端口映射改成 `"127.0.0.1:11451:11451"`，并在 `.env` 里设置 `TRUST_PROXY=true`。
- `./data` 存着全部账号凭据和用量数据，丢了就得重新登录所有账号。备份方法见[第 6 节](#6-备份与迁移)。

#### 4.2 docker run

```bash
npm run build:node
docker build -t free-llm-router:latest .
mkdir -p data && sudo chown -R 1000:1000 data
docker run -d --name free-llm-router --restart unless-stopped \
  -p 11451:11451 \
  -v "$PWD/data:/app/data" \
  -e API_KEY='<你的口令>' \
  free-llm-router:latest
```

其他变量同样用 `-e` 传入。不要用 `--env-file .env`，否则 `.env` 里的 `HOST=127.0.0.1` 会让容器外连不上。

调试时可以把产物挂载进容器，改完重新构建后 `docker restart` 即可生效，不用重建镜像：`-v "$PWD/dist/server.mjs:/app/dist/server.mjs:ro"`。

#### 4.3 systemd

仓库自带 `free-llm-router.service`，默认装在 `/opt/free-llm-router`，以 `ubuntu` 用户运行：

```bash
sudo mkdir -p /opt/free-llm-router/dist /opt/free-llm-router/data
sudo cp dist/server.mjs /opt/free-llm-router/dist/
sudo cp .env /opt/free-llm-router/.env
sudo cp free-llm-router.service /etc/systemd/system/
sudo chown -R ubuntu:ubuntu /opt/free-llm-router   # 换成 service 里的 User，它必须能写 data/
sudo chmod 600 /opt/free-llm-router/.env

sudo systemctl daemon-reload
sudo systemctl enable --now free-llm-router
journalctl -u free-llm-router -f
```

- `ExecStart` 写的是 `/usr/bin/node`。用 nvm 等方式安装的 Node 不在这个路径，请改成 `which node` 的输出。
- `.env` 通过 `EnvironmentFile` 加载，会覆盖 service 文件里 `Environment=` 的同名项，所以改 `HOST` 等配置只改 `.env` 就行。

#### 4.4 前台运行（调试用）

```bash
node --env-file=.env dist/server.mjs
```

启动后会打印监听地址、数据库路径，以及 `API_KEY` 是否已配置。显示「未设置」时，所有请求都会返回 401。

无论用哪种方式运行，启动后都在浏览器打开 `http://<服务器 IP>:11451/panel/`，用 `API_KEY` 登录。根路径 `/` 返回 401 是正常的。

### 5. HTTPS 与反向代理

用反向代理加上 HTTPS，并注意三点：

1. **关闭响应缓冲**，否则流式输出会被攒成一整段才返回。
2. 在 `.env` 里设置 **`TRUST_PROXY=true`**，否则子密钥的来源 IP 白名单和「最后来源 IP」看到的都是反代地址。服务直接对公网暴露时**不要**打开它，否则客户端可以伪造 `X-Forwarded-For`。客户端自带的 `CF-Connecting-IP` 头总是会被丢弃。
3. 把服务改为只监听本机：裸跑或 systemd 设置 `HOST=127.0.0.1`；Docker 把端口映射改成 `127.0.0.1:11451:11451`。

**Caddy**（自动申请证书）：

```caddy
llm.example.com {
    reverse_proxy 127.0.0.1:11451 {
        flush_interval -1
    }
}
```

**nginx**：

```nginx
server {
    listen 443 ssl http2;
    server_name llm.example.com;
    # ssl_certificate     /path/to/fullchain.pem;
    # ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:11451;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 流式输出必需：关闭缓冲，拉长超时
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

面板静态资源 `/panel/assets/*` 的响应头是一年 `immutable`，入口页是 `no-store`。反代或 CDN 不要改写这两个头，否则升级后浏览器可能拿不到新版面板。Node 直连时面板资源已经 gzip 压缩，API 和流式响应不压缩。

### 6. 备份与迁移

数据库开启了 WAL 模式：除了 `router.db`，运行中还可能有 `router.db-wal` 和 `router.db-shm`。**只复制 `router.db` 可能丢掉最近的写入。**

```bash
# 方法一：停服务后复制整个目录（最稳妥）
docker compose stop            # 或 sudo systemctl stop free-llm-router
tar czf router-backup-$(date +%F).tgz data/
docker compose start

# 方法二：在线备份（需要 sqlite3 命令行工具）
sqlite3 data/router.db ".backup router-backup-$(date +%F).db"
```

**迁移到新服务器**：停掉旧服务，把整个 `data/` 目录（和 `.env`）拷过去，再在新服务器上启动。

- 一直用自动生成的密钥时，密钥就在库里，跟着 `data/` 一起走，不用额外处理。
- `.env` 里显式设置过 `CREDENTIAL_KEY` 时，新服务器必须用同一个值。
- 想把自动生成的密钥改成显式配置（比如换一个新的空库），先把它导出来：

```bash
# 参数是数据库路径；Docker 下用 docker exec free-llm-router node -e '…' /app/data/router.db
node -e 'const{DatabaseSync}=require("node:sqlite");const r=new DatabaseSync(process.argv[1],{readOnly:true}).prepare("SELECT value FROM system_kv WHERE prefix=? AND key=?").get("server","credential_key");let v=r&&r.value;try{v=JSON.parse(v)}catch{}console.log(v||"未找到（可能一直用的是环境变量里的 CREDENTIAL_KEY）")' data/router.db
```

把输出填进 `.env` 的 `CREDENTIAL_KEY=` 即可。

### 7. 升级

```bash
git pull
npm install --legacy-peer-deps
npm run build:node
```

然后按运行方式替换产物并重启，数据不受影响：

| 运行方式 | 命令 |
|---|---|
| Docker Compose | `docker compose up -d --build` |
| docker run | `docker build -t free-llm-router:latest .`，再删除旧容器并用同样的参数重新 `docker run` |
| systemd | `sudo cp dist/server.mjs /opt/free-llm-router/dist/ && sudo systemctl restart free-llm-router` |
| 前台运行 | 停掉进程后重新运行 |

### 8. 自检

```bash
BASE=http://127.0.0.1:11451
KEY=<你的 API_KEY>

curl -s "$BASE/healthz"                                              # {"ok":true,"service":"free-llm-router"}
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/pool?realm=cn"     # 国内分片账号池
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/pool?realm=global" # 国际分片账号池
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/waf?realm=cn"      # IP 级拦截状态
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models" | head -c 300
```

---

## Cloudflare Workers

Free 计划即可运行：Durable Objects 在 Free 计划下可用（SQLite 后端），定时任务由 `wrangler.jsonc` 里的 Cron Trigger（每小时整点）驱动。

### 1. 部署

```bash
git clone https://github.com/quancifang44556/free-llm-router.git && cd free-llm-router
npm install --legacy-peer-deps

npx wrangler login                       # 或 export CLOUDFLARE_API_TOKEN=<有 Workers 编辑权限的 token>
npm run deploy
```

部署成功后访问 `https://<worker 名>.<你的子域>.workers.dev/panel/`。Worker 名默认是 `free-llm-router`，在 `wrangler.jsonc` 的 `name` 里配置。

### 2. 设置 Secret

两个 secret 都**必须**设置：

```bash
KEY=$(openssl rand -hex 24); echo "API_KEY=$KEY"      # 记下来，secret 写入后无法再读出
echo "$KEY" | npx wrangler secret put API_KEY
openssl rand -base64 32 | npx wrangler secret put CREDENTIAL_KEY
```

| Secret | 用途 | 不设置会怎样 |
|---|---|---|
| `API_KEY` | 面板和全部 API 的口令 | 所有请求返回 401 |
| `CREDENTIAL_KEY` | 账号凭据加密密钥 | 拒绝保存凭据（不会以明文落盘） |

- `CREDENTIAL_KEY` 设置后**不要再改**，否则已保存的凭据全部解不开。
- 在 Dashboard 里连接 Git 自动部署时，secret 不会跟着代码走，需要在 Worker 的 **Settings → Variables and Secrets** 里手动添加。
- 用 `npm run dev` 本地调试时，把两个值写进项目根目录的 `.dev.vars`（已在 `.gitignore` 里）。

### 3. 绑定自定义域名

有两种方式：

| 方式 | DNS 记录由谁管 | 能否用优选 IP |
|---|---|---|
| **Custom Domain** | Cloudflare 自动创建和托管 | 不能 |
| **Worker Route** | 你自己 | 可以 |

**Custom Domain** 最省事，在 Dashboard 的 Worker 设置里添加即可，DNS 记录会自动创建。也可以用 API，注意要用 `PUT`，`POST` 会返回 `405 Method not allowed for this authentication scheme`：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"zone_id":"<zone id>","hostname":"llm.example.com","service":"free-llm-router","environment":"production"}'
```

**Worker Route** 适合要用优选 IP 或优选域名的情况，前提是这条 DNS 记录由你自己控制：

- Route 不会自动创建 DNS 记录。必须先在同一个 zone 里建好记录，否则域名解析不了。
- 记录通常要开启代理（橙色云朵），Route 只对经过 Cloudflare 的流量生效。
- `wrangler.jsonc` 里的 `routes` 默认是注释掉的（原因见下面的坑 2），可以在 Dashboard 里配置，或填入真实域名后取消注释。

### 4. 三个坑

1. **配置了 `routes` 后，`workers.dev` 会被默认关闭。** 自定义域名还没生效时，服务就完全访问不了。所以 `wrangler.jsonc` 里保留了 `"workers_dev": true` 作为后备入口，不要删。
2. **`routes` 里留着占位符会导致部署失败。** wrangler 会拿 `<你的域名>` 去查 zone，查不到就报 `Unable to fetch bindings, routes, or services metadata`。这个报错让你「稍后重试」，但重试多少次结果都一样。要么填真实域名，要么保持注释。
3. **`wrangler.jsonc` 的 `name` 必须与 Cloudflare 上的 Worker 名一致。** 不一致时 wrangler 会尝试新建 Worker，并报 `Durable Object namespace name '<名字>_AccountPoolDO' already in use [code: 10065]`。这个报错和 DO 本身无关。想给 Worker 改名，先在 Dashboard 里改（数据和 secret 会保留），再同步修改 `name`；只改 `name` 等于新建一个空 Worker，账号会全部「消失」。

### 5. 升级与日志

```bash
git pull
npm install --legacy-peer-deps
npm run deploy      # Durable Objects 里的数据不受影响
npm run tail        # 查看线上实时日志
```

### 6. 移除

```bash
npx wrangler delete free-llm-router            # 换成你的 Worker 名；删除前确认不再需要其中的账号数据
npx wrangler delete workbuddy-egress-probe     # 如果部署过出口 IP 探针
```

---

## 部署后检查

无论哪种形态，首次部署后建议依次确认：

1. `GET /healthz` 返回 `{"ok":true,...}`。
2. 打开 `/panel/`，能用 `API_KEY` 登录。
3. 在「供应商与账号」里添加至少一个账号（面板登录或导入凭据）。
4. 在「配置」页检查「路由与调度」的各项开关；「运行状态」里已保存的凭据数应与账号数一致。
5. `GET /v1/models` 能列出模型，再发一次 `/v1/chat/completions`（最好带 `"stream":true`）确认能正常返回。
6. 需要分发给其他工具时，在「API Key」页签发子密钥，不要到处使用主密钥。

## 常见问题

**`npm install` 报 `ERESOLVE could not resolve`**
加上 `--legacy-peer-deps`。这是 wrangler 与 `@cloudflare/workers-types` 的 peer 版本冲突，不影响运行。

**启动时报找不到 `node:sqlite`（`No such built-in module`）**
Node 版本太低。升级到 22.13 或更高；Docker 镜像已经满足要求。

**面板登录不上，所有请求都返回 401**
`API_KEY` 没有传进进程。看启动日志：「鉴权密钥」显示「未设置」就是这个原因。

- 前台运行要加 `--env-file=.env`；直接 `node dist/server.mjs` 或 `npm start` 不会读取 `.env`。
- Compose 的 `.env` 必须和 `docker-compose.yml` 放在同一目录。
- systemd 检查 `/opt/free-llm-router/.env` 是否存在，以及 `EnvironmentFile` 的路径。
- Workers 检查 secret 是否已设置（通过 Dashboard 连 Git 部署时需要手动添加）。

**容器反复重启，日志提示无法打开数据库**
宿主机的 `data/` 目录不归 uid 1000 所有，容器写不进去。执行 `sudo chown -R 1000:1000 data` 后重启。

**流式输出卡住，最后一次性吐出全部内容**
反向代理或 CDN 在缓冲响应。nginx 加 `proxy_buffering off`，Caddy 加 `flush_interval -1`，见[第 5 节](#5-https-与反向代理)。

**换服务器后，所有账号都提示凭据解密失败**
`CREDENTIAL_KEY` 变了：可能只拷了 `router.db` 而 `.env` 里的密钥不同，或者旧库用的是自动生成的密钥、新机器却换了一个空库。恢复原来的密钥或原来的整个 `data/` 目录即可，见[第 6 节](#6-备份与迁移)。

**子密钥的来源 IP 都显示成 `127.0.0.1` 或 Docker 网关地址，IP 白名单不生效**
走了反向代理但没设置 `TRUST_PROXY=true`。

**所有请求突然直接失败，日志提示 IP 级拦截**
IP 级 WAF 护栏判断出口 IP 被上游拦截，暂停了轮转。确认出口正常后，在面板「配置 → 运行状态」里解除，或调用 `POST /admin/waf/clear`。

**升级后面板还是旧版本**
强制刷新页面。仍然不行的话，检查反代或 CDN 有没有改写 `/panel/` 入口页的 `Cache-Control: no-store`。

**Workers：部署报 `Unable to fetch bindings, routes, or services metadata`**
`wrangler.jsonc` 的 `routes` 里还留着占位符，见[三个坑](#4-三个坑)第 2 条。

**Workers：部署报 `already in use [code: 10065]`**
`wrangler.jsonc` 的 `name` 与 Cloudflare 上的 Worker 名不一致，见[三个坑](#4-三个坑)第 3 条。

**Workers：导入账号时提示未配置 `CREDENTIAL_KEY`**
执行 `openssl rand -base64 32 | npx wrangler secret put CREDENTIAL_KEY`。

## 出口 IP 探针

`probe/` 是一个独立的最小 Worker，用来验证 Cloudflare 的出口 IP 会不会被上游 WAF 拦截。它与主服务无关，可以随时部署或删除：

```bash
cd probe && npx wrangler deploy        # 部署后名为 workbuddy-egress-probe
npx wrangler delete workbuddy-egress-probe
```
