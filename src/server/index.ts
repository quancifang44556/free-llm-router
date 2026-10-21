/**
 * Node.js HTTP 服务入口（适配 VPS / Linux 生产环境）。
 *
 * ## 职责与特性
 *
 * 1. **全链路 Web 标准桥接**：将 Node.js `http.IncomingMessage` 转换为 Web 标准 `Request`，
 *    无缝交给 `src/index.ts` 的 `fetch` 路由器处理。
 * 2. **零拷贝响应流式透传**：通过 `Readable.fromWeb(stream).pipe(res)` 直通 SSE 响应，
 *    完美适配长文本推理、流式思考和工具调用，杜绝缓冲与截断。
 * 3. **客户端断连即时传递**：监听连接关闭事件并触发 `AbortSignal`，防止客户端取消时上游无效空跑。
 * 4. **后台常驻 Cron 定时任务**：模拟 Cloudflare Cron Triggers，默认每整点分发任务，
 *    并在服务启动时自动从 SQLite 恢复未结任务（Alarm）。
 * 5. **优雅停机（Graceful Shutdown）**：捕获 SIGINT/SIGTERM，平稳关闭 HTTP 连接并落盘 SQLite。
 * 6. **面板静态资源 gzip**：Workers 由 Cloudflare 边缘自动压缩，Node 直连时没人压 ——
 *    主 bundle 约 500 KB，gzip 后约 160 KB。只压 `/panel/*` 的 200 响应并按路径缓存
 *   （内容在进程内不变）；API 与 SSE 一律原样透传（压缩会缓冲流式输出）。
 */

import http from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { createNodeRuntime } from './env.js'
import worker from '../index.js'

export interface ServerOptions {
  port?: number
  host?: string
  databasePath?: string
  autoCron?: boolean
  /** 是否信任反向代理追加的 `X-Forwarded-For`（见 {@link resolveClientIp}）。 */
  trustProxy?: boolean
}

/**
 * 解析布尔型环境变量：`false/0/no/off` 为关，`true/1/yes/on` 为开，未设或其他值取默认。
 *
 * ⚠️ 此前 `AUTO_TASK_CRON` 只认字面量 `false`，写成 `0`、`no`、`False` 都会被当成「开启」，
 * 与用户的意图正好相反。
 */
export function envFlag(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase()
  if (['false', '0', 'no', 'off'].includes(v)) return false
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  /**
   * 🔴 **写错要出声**（2026-10-21 审查补，配置健壮性专项）。
   *
   * 原来是静默回落：`TRUST_PROXY=ture`（漏个字母）→ 当成没设 → `false`。
   * 而 `TRUST_PROXY` 一错，反代下 `CF-Connecting-IP` 恒为反代 IP
   * ⇒ 子密钥的「来源 IP 白名单」把**所有**请求拒掉，用户只看到「密钥无效」。
   *
   * 区分「没设」（`undefined` / 空串，正常）与「设了但不认识」（多半是拼错）。
   */
  if (v !== '' && !['undefined', 'null'].includes(v)) {
    console.warn(
      `⚠️ [配置] 布尔开关的值 ${JSON.stringify(raw)} 不是 true/false，已按默认 ${fallback} 处理` +
        `（支持：true/1/yes/on、false/0/no/off）`,
    )
  }
  return fallback
}

/**
 * 确定客户端真实 IP，写进 `CF-Connecting-IP` 交给业务层（`gateway/authz.ts` 只认这个头）。
 *
 * ## ⚠️ 为什么必须由这里重写
 *
 * 在 Cloudflare 上，`CF-Connecting-IP` 由边缘强制覆盖，客户端伪造不了；
 * 但 Node 直接对外时，它只是一个**普通请求头**。原先原样透传 ⇒
 * 任何人带上 `CF-Connecting-IP: <白名单 IP>` 就能绕过子密钥的来源 IP 限制；
 * 而正常走 nginx / Caddy 反代的请求又不带这个头 ⇒ IP 为空，白名单把所有人都拒掉。
 *
 * ## 规则
 *
 * - 默认：用 TCP 连接的对端地址（不可伪造）；
 * - `TRUST_PROXY=true`（前面有自己的反代）：取 `X-Forwarded-For` **最右边**一项 ——
 *   那是你的反代追加的真实对端地址；左边的项客户端可以随便写，不能信。
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: boolean,
): string {
  const normalize = (ip: string): string => {
    const t = ip.trim()
    return t.startsWith('::ffff:') ? t.slice(7) : t
  }
  if (trustProxy && forwardedFor !== undefined) {
    const joined = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
    const parts = joined.split(',').map((p) => p.trim()).filter((p) => p !== '')
    const last = parts[parts.length - 1]
    if (last !== undefined) return normalize(last)
  }
  return normalize(remoteAddress ?? '')
}

/** 严格解析 `PORT`：只接受 1..65535 的纯十进制整数，非法即报错退出。 */
function strictPort(raw: string | undefined): number {
  const t = (raw ?? '').trim()
  if (t === '') return 11451
  if (!/^\d+$/.test(t)) {
    throw new Error(
      `PORT 配置非法：${JSON.stringify(raw)}。只接受 1-65535 的十进制整数（不接受 0x / 1e / 小数 / 多余字符）。`,
    )
  }
  const n = Number(t)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`PORT 超出范围：${JSON.stringify(raw)}。只接受 1-65535。`)
  }
  return n
}

/** 进程级兜底是否已安装（只装一次，见 `startServer` 内的说明）。 */
let unhandledGuardInstalled = false

export function startServer(options: ServerOptions = {}) {
  /**
   * 🔴 **端口不能走 `parseInt`**（2026-10-21 审查补，配置健壮性专项）。
   *
   * `Number.parseInt` 是宽松的：`PORT=0x1f` → `0`（**随机端口**，容器映射对不上，
   * 表现为「服务没起来」）、`PORT=1e3` → `1`（真去绑 1 端口）、
   * `PORT=abc` → `NaN` → 在 `listen()` 里抛 `ERR_SOCKET_BAD_PORT`，
   * 报错里**一个字都没提 PORT**。这是唯一一个不在 `Env` 里、也没走统一解析的数值配置。
   *
   * 端口**没有安全的回落方向**（随便换一个都连不上），故非法时直接报错退出。
   */
  const port = options.port ?? strictPort(process.env.PORT)
  const host = options.host ?? process.env.HOST ?? '0.0.0.0'
  const autoCron = options.autoCron ?? envFlag(process.env.AUTO_TASK_CRON, true)
  const trustProxy = options.trustProxy ?? envFlag(process.env.TRUST_PROXY, false)

  /**
   * 🔴 **进程级未捕获异常兜底**（2026-10-21 审查补，并发专项）。
   *
   * Node 22+ 默认把未处理的 rejection **直接抛成未捕获异常并退出进程**。
   * 而这个服务里有多处「后台定时器 / 存储写入」的异步尾巴，
   * 一次 `SQLITE_FULL` 或「库已关闭」就能让**整个网关**退出
   *（不是那一个任务失败）—— 实测崩之前还会把未迁移的实例留在缓存里。
   *
   * 这里改为**只记日志不退出**：单条后台失败的代价，不该是全租户中断。
   * 真正的致命错误（端口占用、库损坏到无法迁移）仍在启动阶段直接抛。
   */
  // ⚠️ 只注册一次：测试里会反复 startServer，每个都挂监听器会撞
  // `MaxListenersExceededWarning`（也会让排障时看到一堆重复日志）。
  if (!unhandledGuardInstalled) {
    unhandledGuardInstalled = true
    process.on('unhandledRejection', (error: unknown) => {
      console.error('[fatal-guard] 未处理的异步异常（已拦截，进程继续）：', error)
    })
  }

  const runtime = createNodeRuntime(options.databasePath)
  const { env, db, taskRunnerNamespace } = runtime

  // 1. 恢复因重启中断的后台任务
  try {
    taskRunnerNamespace.restorePendingAlarms()
    console.log('✅ [TaskRunner] 成功扫描并恢复所有未决后台任务调度。')
  } catch (err) {
    console.error('⚠️ [TaskRunner] 恢复未决任务时发生异常:', err)
  }

  // 面板静态资源的 gzip 缓存（路径 → 压缩后字节）。条目数 = 面板文件数，不会无限增长：
  // 只缓存 `/panel/*` 下返回 200 的路径，未知路径是 404，不进缓存。
  const gzipCache = new Map<string, Buffer>()

  // 2. 创建 HTTP 服务器
  const server = http.createServer(async (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] as string) || 'http'
    const reqHost = (req.headers['host'] as string) || `${host}:${port}`
    const fullUrl = `${proto}://${reqHost}${req.url || '/'}`

    const abortCtrl = new AbortController()
    req.on('aborted', () => abortCtrl.abort())
    res.on('close', () => {
      if (!res.writableEnded) {
        abortCtrl.abort()
      }
    })

    const headers = new Headers()
    for (const [key, val] of Object.entries(req.headers)) {
      if (val === undefined) continue
      // ⚠️ 客户端自带的 CF-Connecting-IP 一律丢弃，下方用可信来源重写（见 resolveClientIp）。
      if (key === 'cf-connecting-ip') continue
      if (Array.isArray(val)) {
        for (const item of val) headers.append(key, item)
      } else {
        headers.set(key, val)
      }
    }

    const clientIp = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustProxy)
    if (clientIp !== '') headers.set('cf-connecting-ip', clientIp)

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    let webReq: Request
    try {
      webReq = new Request(fullUrl, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as any) : null,
        duplex: hasBody ? 'half' : undefined,
        signal: abortCtrl.signal,
      })
    } catch (err: any) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'Bad Request', message: err?.message || String(err) }))
      return
    }

    const ctx = {
      waitUntil(promise: Promise<unknown>): void {
        promise.catch((err) => console.error('[Node waitUntil Error]', err))
      },
      passThroughOnException(): void {},
    }

    try {
      const response = await worker.fetch(webReq, env, ctx as any)
      res.statusCode = response.status
      res.statusMessage = response.statusText

      for (const [key, val] of response.headers.entries()) {
        res.setHeader(key, val)
      }

      if (typeof (response.headers as any).getSetCookie === 'function') {
        const cookies = (response.headers as any).getSetCookie()
        if (cookies.length > 0) {
          res.setHeader('set-cookie', cookies)
        }
      }

      const pathname = (req.url || '/').split('?')[0] ?? '/'
      if (
        response.body &&
        response.status === 200 &&
        pathname.startsWith('/panel/') &&
        !response.headers.has('content-encoding') &&
        /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
      ) {
        let gz = gzipCache.get(pathname)
        if (gz === undefined) {
          gz = gzipSync(Buffer.from(await response.arrayBuffer()))
          gzipCache.set(pathname, gz)
        } else {
          await response.body.cancel()
        }
        res.setHeader('content-encoding', 'gzip')
        res.setHeader('vary', 'accept-encoding')
        res.setHeader('content-length', gz.length)
        res.end(gz)
        return
      }

      if (response.body) {
        const nodeStream = Readable.fromWeb(response.body as any)
        nodeStream.pipe(res)
        nodeStream.on('error', (err) => {
          if (!res.headersSent) {
            res.statusCode = 502
            res.end('Upstream streaming error')
          } else {
            res.destroy(err)
          }
        })
      } else {
        res.end()
      }
    } catch (err: any) {
      console.error(`[Unhandled Error] ${req.method} ${req.url}:`, err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            error: 'Internal Server Error',
            message: err?.message || 'Server encountered an unexpected error',
          }),
        )
      } else {
        res.destroy(err)
      }
    }
  })

  // 3. 常驻后台计划任务（模拟 Cloudflare Cron，每小时整点分发）
  let cronInterval: NodeJS.Timeout | undefined
  if (autoCron) {
    let lastDispatchedHour = -1
    const checkCron = async () => {
      const now = new Date()
      // 每小时整点触发（容差前 3 分钟内）
      if (now.getMinutes() <= 2 && now.getHours() !== lastDispatchedHour) {
        lastDispatchedHour = now.getHours()
        try {
          console.log(`⏰ [Cron] 触发后台自动任务分发：UTC+8 ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
          const ctx = {
            waitUntil(promise: Promise<unknown>): void {
              promise.catch((err) => console.error('[Cron waitUntil Error]', err))
            },
            passThroughOnException(): void {},
          }
          await worker.scheduled(
            { cron: '0 * * * *', scheduledTime: Date.now() } as any,
            env,
            ctx as any,
          )
        } catch (err) {
          console.error('❌ [Cron] 后台任务执行失败:', err)
        }
      }
    }

    // 每 30 秒探测一次分钟变动
    cronInterval = setInterval(() => {
      void checkCron()
    }, 30_000)
    cronInterval.unref?.()
  }

  // 3b. 周期回收 idle DO 实例（内存治理，与 Cron 是否启用无关）。
  // TaskRunner 按 uid 每账号一个实例，若不回收会随账号/任务数无限增长。
  // pruneIdle 只回收「无未决 alarm 且闲过 5 分钟」的实例，绝不动正在排期的任务。
  const pruneInterval = setInterval(() => {
    try {
      const removed = runtime.accountPoolNamespace.pruneIdle() + runtime.taskRunnerNamespace.pruneIdle()
      if (removed > 0) {
        console.log(`🧹 [GC] 回收 ${removed} 个 idle DO 实例（剩余内存实例：池 ${runtime.accountPoolNamespace.size} / 任务 ${runtime.taskRunnerNamespace.size}）`)
      }
    } catch (err) {
      console.error('⚠️ [GC] 回收 idle DO 实例失败:', err)
    }
  }, 5 * 60 * 1000)
  pruneInterval.unref?.()

  // 4. 启动监听
  server.listen(port, host, () => {
    // 对外的公网地址（可选）：由 PUBLIC_URL 环境变量提供，避免把域名硬编码进代码。
    const publicUrl = process.env.PUBLIC_URL?.trim()
    console.log(`
🚀 free-llm-router 已启动并在 VPS 上运行！
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ▸ 监听地址: http://${host}:${port}${publicUrl ? `\n  ▸ 对外地址: ${publicUrl}` : ''}
  ▸ 控制面板: http://${host}:${port}/panel/
  ▸ 运行平台: Node.js ${process.version} (${process.arch} - ${process.platform})
  ▸ 数据库  : ${process.env.DATABASE_PATH || './data/router.db'}
  ▸ 鉴权密钥: ${env.API_KEY ? '已配置 (Bearer ****)' : '未设置 (所有请求都会返回 401)'}
  ▸ 自动任务: ${autoCron ? '已启用 (每小时巡检与自动签到)' : '已禁用'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
  })

  // 5. 优雅退出
  const shutdown = () => {
    console.log('\n🛑 正在停止 free-llm-router 服务...')
    if (cronInterval) clearInterval(cronInterval)
    clearInterval(pruneInterval)
    /**
     * 🔴 **必须带强制超时**（2026-10-21 审查补，并发专项）。
     *
     * `server.close()` 的语义是「停止接受新连接，等**现有连接全部结束**才回调」。
     * 而 SSE / 长连接（推理进行中）**不会自己结束** —— 于是回调永远不执行，
     * `db.close()` 从未跑过（注释宣称的「安全关闭并落盘 SQLite」不成立，WAL 未 checkpoint），
     * 10 秒后被 Docker 的默认 `stop_grace_period` SIGKILL 掉。
     *
     * 而且被腰斩的那个 alarm，它的 `system_alarms` 行已在触发时删掉 ——
     * 叠加「start() 早退不补排」就是一次完整的「任务静默停摆」事故。
     */
    let closed = false
    const finish = (reason: string) => {
      if (closed) return
      closed = true
      try {
        db.close()
        console.log(`💾 SQLite 数据库连接已安全关闭（${reason}）。`)
      } catch (err) {
        console.error('关闭数据库连接失败:', err)
      }
      process.exit(0)
    }

    // 8 秒兜底：小于 Docker 默认的 10 秒，保证我们**先于** SIGKILL 收尾
    setTimeout(() => finish('强制超时，已放弃等待长连接结束'), 8_000).unref?.()
    // 主动断开长连接（SSE），让 close 的回调能及时执行
    server.closeAllConnections?.()
    server.close(() => finish('全部连接已结束'))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return { server, runtime }
}

// 直接运行入口（node src/server/index.js 或打包后的 node dist/server.mjs）
const isDirectRun =
  !process.argv[1]?.includes('.test.') &&
  (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('server.mjs') ||
    process.argv[1]?.endsWith('server.js'))

if (isDirectRun) {
  startServer()
}
