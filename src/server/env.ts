/**
 * Node.js 运行时环境配置与依赖装配。
 *
 * ## 设计纪律
 *
 * 1. **持久化 SQLite 路径**：默认保存在 `./data/router.db`，支持通过 `DATABASE_PATH` 环境变量自定义。
 * 2. **自动保护 CREDENTIAL_KEY**：
 *    - 优先采用环境变量中的 `CREDENTIAL_KEY`；
 *    - 若未配置，自动在 SQLite 中生成并持久化 32 字节 CSPRNG base64url 密匙（`server:credential_key`），
 *      确保开箱即用且永久加密，绝不降级明文存储。
 * 3. **完整 DO 命名空间装配**：实例化 `ACCOUNT_POOL` 与 `TASK_RUNNER`，无缝对接 `Env` 契约。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { AccountPoolDO } from '../pool/AccountPoolDO.js'
import { TaskRunnerDO } from '../taskrunner/TaskRunnerDO.js'
import { NodeDurableObjectNamespace } from './namespace.js'
import type { Env } from '../env.js'

export interface NodeRuntimeContext {
  env: Env
  db: DatabaseSync
  accountPoolNamespace: NodeDurableObjectNamespace<AccountPoolDO>
  taskRunnerNamespace: NodeDurableObjectNamespace<TaskRunnerDO>
}

/** base64url 编码工具（无外部依赖） */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * 组装并初始化 Node.js 运行时环境。
 */
export function createNodeRuntime(databasePath?: string): NodeRuntimeContext {
  const dbFile = databasePath || process.env.DATABASE_PATH || './data/router.db'
  const dir = path.dirname(path.resolve(dbFile))
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = new DatabaseSync(dbFile)

  // ⚠️ 必须开启 WAL 与 busy_timeout，否则并发写会直接抛 `database is locked`。
  //
  // DO 语义在 Cloudflare 上是单线程串行的，但本 Node 适配层里 **HTTP 请求处理**
  // 与 **多个 alarm 定时器** 会并发写同一个 SQLite 文件（usage:state、log:ring、
  // 任务进度等）。默认的 rollback journal 模式下，任一写事务未提交时其它写会
  // 立刻 `SQLITE_BUSY` 失败 —— 这是 VPS 上最常见的数据丢失/报错源。
  //
  // 取值依据：
  // - `journal_mode = WAL`：读写不互斥，单写多读并发友好；
  // - `busy_timeout = 5000`：写冲突时等待 5 秒重试，而不是立刻失败；
  // - `synchronous = NORMAL`：WAL 下的推荐值，兼顾安全与吞吐（进程崩溃不丢数据，
  //   仅断电可能丢最后一个事务）。
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `)

  // 基础系统配置表与 Alarm 调度表
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_kv (
      prefix     TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      PRIMARY KEY (prefix, key)
    );
    CREATE TABLE IF NOT EXISTS system_alarms (
      id              TEXT PRIMARY KEY,
      scheduled_time  INTEGER NOT NULL
    );
  `)

  // 解析并确保持久化 CREDENTIAL_KEY
  let credentialKey = process.env.CREDENTIAL_KEY?.trim()
  if (!credentialKey) {
    const row = db
      .prepare('SELECT value FROM system_kv WHERE prefix = ? AND key = ?')
      .all('server', 'credential_key') as Array<{ value: string }>
    if (row.length > 0) {
      try {
        credentialKey = JSON.parse(row[0].value)
      } catch {
        credentialKey = row[0].value
      }
    } else {
      // 首次启动且未通过环境变量注入时，生成安全的 32 字节 CSPRNG 密钥并持久化
      const randomBytes = new Uint8Array(32)
      crypto.getRandomValues(randomBytes)
      credentialKey = toBase64Url(randomBytes)
      db.prepare(
        `INSERT INTO system_kv (prefix, key, value) VALUES (?, ?, ?)
         ON CONFLICT(prefix, key) DO UPDATE SET value = excluded.value`,
      ).run('server', 'credential_key', JSON.stringify(credentialKey))
      console.log('ℹ️ [Security] 首次运行：已自动生成并安全持久化凭据加密密钥 CREDENTIAL_KEY。')
    }
  }

  const envObj: Partial<Env> = {
    API_KEY: process.env.API_KEY?.trim(),
    CREDENTIAL_KEY: credentialKey,
    UPSTREAM_CHAT_BASE: process.env.UPSTREAM_CHAT_BASE?.trim(),
    UPSTREAM_BILLING_BASE: process.env.UPSTREAM_BILLING_BASE?.trim(),
    UPSTREAM_WEB_BASE: process.env.UPSTREAM_WEB_BASE?.trim(),
    // ⚠️ 原样透传（含空串），解析与「0 = 关闭」的语义统一由 `env.ts:resolveBurnRate` 负责 ——
    // 在这里做任何兜底都会形成第二份判据，两处慢慢分叉（本项目已吃过多次亏）。
    BURN_RATE_WINDOW_MS: process.env.BURN_RATE_WINDOW_MS?.trim(),
    BURN_RATE_THRESHOLD_PCT: process.env.BURN_RATE_THRESHOLD_PCT?.trim(),
    // ⚠️ **这个字段曾经漏在这里**：Workers 部署下 `env` 由平台直接绑定，
    // 但 Node/Docker 部署要靠这段映射把 `process.env` 搬进 `Env`。
    // 漏了它的后果是「文档里写了 `MAX_CONTEXT_MESSAGES`，Docker 里设了却毫无作用」
    // —— 而且**没有任何报错**，只能靠实测发现（这条是被
    // `tests/safety-config.test.ts` 的环境变量回落用例抓出来的）。
    // 同为原样透传：解析与「0 = 不限制」的语义归 `resolveMaxContextMessages`。
    MAX_CONTEXT_MESSAGES: process.env.MAX_CONTEXT_MESSAGES?.trim(),
  }

  const accountPoolNamespace = new NodeDurableObjectNamespace<AccountPoolDO>(
    'account_pool',
    db,
    (ctx, e) => new AccountPoolDO(ctx, e),
    () => envObj as Env,
    // ⚠️ 必须串行：Node 没有 CF 的 input gate，并发「读-改-写」会丢更新（见 serializeCalls）。
    { serialize: true },
  )

  const taskRunnerNamespace = new NodeDurableObjectNamespace<TaskRunnerDO>(
    'task_runner',
    db,
    (ctx, e) => new TaskRunnerDO(ctx, e),
    () => envObj as Env,
  )

  envObj.ACCOUNT_POOL = accountPoolNamespace as any
  envObj.TASK_RUNNER = taskRunnerNamespace as any

  return {
    env: envObj as Env,
    db,
    accountPoolNamespace,
    taskRunnerNamespace,
  }
}
