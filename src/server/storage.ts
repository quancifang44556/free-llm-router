/**
 * Node.js 运行时存储抽象：基于 node:sqlite 的 DurableObjectStorage 完整实现。
 *
 * ## 设计纪律
 *
 * 1. **标准 node:sqlite**：Node.js 22+ 原生内置 `DatabaseSync`，零 C++ 编译、零原生依赖、无 ABI 风险。
 * 2. **完全兼容 SqlStorage**：实现 `exec(query, ...params)`，支持 `.toArray()` 与 `.one()`，
 *    无缝对接 `src/store/db.ts` 的所有迁移表结构与增删改查。
 * 3. **实例隔离 Key-Value 存储**：以 `prefix` 隔离不同 DO 实例的 KV（如 `cn:usage:state` 与 `global:usage:state`）。
 * 4. **持久化 Alarm 定时器**：将 `setAlarm` 的时间戳落盘至 `alarm_storage`，并在 Node.js 事件循环中
 *    挂载 `setTimeout`。服务重启时自动扫描并恢复待执行 Alarm。
 */

import { DatabaseSync } from 'node:sqlite'

/**
 * 适配 Cloudflare SqlStorage 接口的 SQLite 封装。
 */
export class NodeSqlStorage {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  exec<T extends Record<string, any> = Record<string, any>>(
    query: string,
    ...params: any[]
  ): { toArray(): T[]; one(): T } {
    const trimmed = query.trim()
    const isSelect = /^SELECT\b/i.test(trimmed) || /^PRAGMA\b/i.test(trimmed)

    if (params.length === 0 && !isSelect) {
      this.db.exec(query)
      return {
        toArray: () => [],
        one: () => {
          throw new Error('Expected exactly one result from SQL query, but got no results.')
        },
      }
    }

    const sanitizedParams = params.map((p) => (p === undefined ? null : p))
    const stmt = this.db.prepare(query)
    if (isSelect) {
      const rows = stmt.all(...sanitizedParams) as T[]
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`Expected exactly one result from SQL query, but got ${rows.length} results.`)
          }
          return rows[0]!
        },
      }
    }

    stmt.run(...sanitizedParams)
    return {
      toArray: () => [],
      one: () => {
        throw new Error('Expected exactly one result from SQL query, but got no results.')
      },
    }
  }
}

export interface NodeDurableObjectStateOptions {
  instanceId: string
  db: DatabaseSync
  onAlarm?: () => Promise<void> | void
}

/**
 * 为单个 DO 实例创建 DurableObjectState 与 Storage 适配器。
 */
export function createNodeDurableObjectState(options: NodeDurableObjectStateOptions): any {
  const { instanceId, db, onAlarm } = options
  const sql = new NodeSqlStorage(db)

  // 确保存储 KV 与 Alarm 的系统表已就绪
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

  let activeTimer: NodeJS.Timeout | undefined
  /**
   * alarm 处理器**正在执行中**的标志。
   *
   * ⚠️ 为什么需要它：`triggerAlarm` 一进来就 `clearTimer()`，于是**整个 handler
   * 执行期间** `activeTimer === undefined` —— 若此时有 GC（`pruneIdle`）跑过来，
   * 会把「正在算」的实例误判成 idle 并回收，下次 `get()` 新建第二个实例读写
   * **同一份 SQLite、同一个 uid** ⇒ 重复执行 / 进度互相覆盖。
   *
   * 而 TaskRunner 的**单个 alarm 内**确实会长时间阻塞（`chat5` / `blackCat`
   * 等在一步里循环 + `await setTimeout`，可轻易超过 5 分钟的 GC 空窗），
   * 故这个标志是必需的。
   */
  let running = false

  const clearTimer = () => {
    if (activeTimer !== undefined) {
      clearTimeout(activeTimer)
      activeTimer = undefined
    }
  }

  /**
   * 兜底重试延迟：alarm 处理器抛异常时，隔这么久再排一次。
   *
   * ⚠️ 为什么必须有这条兜底（与 Cloudflare 语义对齐）：
   * CF 的 alarm handler 抛异常时会被平台**自动重试**；而本适配层是一次性
   * `setTimeout`，若 handler 抛异常且不再重排，该任务会**永久卡死**，
   * 且因为执行前已删除 `system_alarms` 记录，**服务重启也救不回来**
   * （`restorePendingAlarms` 扫不到记录）。用户表现为「任务跑一半没声音了」。
   */
  const ALARM_RETRY_DELAY_MS = 30_000

  const triggerAlarm = async () => {
    clearTimer()
    if (!onAlarm) return

    running = true
    try {
      // 🔴 **执行前清理记录**必须在 try 内（2026-10-21 审查补，并发专项）：
      // 原来写在 try **之外**，`SQLITE_FULL`/只读库时这条语句一抛，
      // 错误连 `console.error` 都进不去，且直接冒成 unhandledRejection ⇒ 杀进程。
      db.prepare('DELETE FROM system_alarms WHERE id = ?').run(instanceId)
      await onAlarm()
    } catch (err) {
      console.error(`[Node Alarm Error for ${instanceId}]`, err)
      // handler 抛异常：它**不会**执行到内部的 setAlarm 续期逻辑，
      // 故这里主动排一次延迟 alarm 兜底重试（写回 DB + 挂定时器）。
      const retryAt = Date.now() + ALARM_RETRY_DELAY_MS
      db.prepare(
        `INSERT INTO system_alarms (id, scheduled_time) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET scheduled_time = excluded.scheduled_time`,
      ).run(instanceId, retryAt)
      activeTimer = setTimeout(() => {
        // ⚠️ 必须 catch：`void` 一个会 reject 的 promise = unhandledRejection
        // ⇒ Node 默认**直接杀进程**（整个网关，不只是这个任务）。
        void triggerAlarm().catch((e) => console.error('[alarm] 重试调度失败：', e))
      }, ALARM_RETRY_DELAY_MS)
      activeTimer.unref?.()
    } finally {
      // 执行结束（正常或异常）：无论 handler 内部是否已 setAlarm 续期，
      // 都不能再标记为「执行中」——否则 GC 永远收不了这个实例。
      running = false
    }
  }

  // 启动/恢复检查：若数据库中已存在本实例的未决 Alarm，立即恢复其定时调度
  const pendingAlarmRow = db
    .prepare('SELECT scheduled_time FROM system_alarms WHERE id = ?')
    .all(instanceId) as Array<{ scheduled_time: number }>
  if (pendingAlarmRow.length > 0) {
    const delay = Math.max(0, pendingAlarmRow[0].scheduled_time - Date.now())
    activeTimer = setTimeout(() => {
      void triggerAlarm().catch((e) => console.error('[alarm] 恢复调度失败：', e))
    }, delay)
    activeTimer.unref?.()
  }

  const storage = {
    sql,

    async get<T = unknown>(key: string): Promise<T | undefined> {
      const rows = db
        .prepare('SELECT value FROM system_kv WHERE prefix = ? AND key = ?')
        .all(instanceId, key) as Array<{ value: string }>
      if (rows.length === 0) return undefined
      const raw = rows[0].value
      // 历史脏数据（早期 put(undefined) 写入的 "undefined"）视为不存在并顺手清理。
      if (raw === 'undefined' || raw === 'null') {
        db.prepare('DELETE FROM system_kv WHERE prefix = ? AND key = ?').run(instanceId, key)
        return undefined
      }
      try {
        return JSON.parse(raw) as T
      } catch {
        return undefined
      }
    },

    async put<T = unknown>(key: string, value: T): Promise<void> {
      // ⚠️ `JSON.stringify(undefined)` 返回的是 `undefined`（不是字符串），
      // 而 node:sqlite 会把它绑定为 SQL NULL 或字符串 "undefined"，
      // 之后 get 时 JSON.parse 失败被 catch 成 undefined —— 行为侥幸正确，
      // 但会在库里留下脏行。Cloudflare 的语义是「put undefined 等价删除」，
      // 这里对齐：显式删除，不留脏数据。
      if (value === undefined) {
        db.prepare('DELETE FROM system_kv WHERE prefix = ? AND key = ?').run(instanceId, key)
        return
      }
      const serialized = JSON.stringify(value)
      if (serialized === undefined) {
        db.prepare('DELETE FROM system_kv WHERE prefix = ? AND key = ?').run(instanceId, key)
        return
      }
      db.prepare(
        `INSERT INTO system_kv (prefix, key, value) VALUES (?, ?, ?)
         ON CONFLICT(prefix, key) DO UPDATE SET value = excluded.value`,
      ).run(instanceId, key, serialized)
    },

    async delete(key: string): Promise<boolean> {
      const result = db
        .prepare('DELETE FROM system_kv WHERE prefix = ? AND key = ?')
        .run(instanceId, key)
      return (result.changes ?? 0) > 0
    },

    async setAlarm(scheduledTime: number | Date): Promise<void> {
      const timeMs = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime()
      db.prepare(
        `INSERT INTO system_alarms (id, scheduled_time) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET scheduled_time = excluded.scheduled_time`,
      ).run(instanceId, timeMs)

      clearTimer()
      const delay = Math.max(0, timeMs - Date.now())
      activeTimer = setTimeout(() => {
        void triggerAlarm().catch((e) => console.error('[alarm] 执行失败：', e))
      }, delay)
      // 不阻止 Node.js 进程退出（但在常驻服务中由 HTTP 服务器保持运行）
      activeTimer.unref?.()
    },

    async getAlarm(): Promise<number | null> {
      const rows = db
        .prepare('SELECT scheduled_time FROM system_alarms WHERE id = ?')
        .all(instanceId) as Array<{ scheduled_time: number }>
      return rows.length > 0 ? rows[0].scheduled_time : null
    },

    async deleteAlarm(): Promise<void> {
      clearTimer()
      db.prepare('DELETE FROM system_alarms WHERE id = ?').run(instanceId)
    },
  }

  return {
    storage,
    /**
     * 与 Cloudflare 真实语义一致：`ctx.id.name` 是 `idFromName()` 传入的名字。
     *
     * ## 为什么必须补上（2026-10-22）
     *
     * `AccountPoolDO` 需要知道自己服务的是哪个 realm（cn / global），
     * 才能把账号读写限定在本分片内 —— 因为**所有 realm 共用一张 `accounts` 表**，
     * 只按 uid 查会跨 realm 串味（探针实测：cn 的账号被 global 的同 uid 覆盖）。
     *
     * 真实 Cloudflare 环境本来就有 `ctx.id.name`，只有本 Node 适配层漏了 ——
     * 补上它，业务代码就能用**平台原生语义**而不是自己维护一份我是谁的映射。
     */
    id: {
      name: instanceId.includes(':') ? instanceId.slice(instanceId.indexOf(':') + 1) : instanceId,
      toString: () => instanceId,
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
    waitUntil(promise: Promise<unknown>): void {
      promise.catch((err) => {
        console.error(`[Node waitUntil uncaught for ${instanceId}]`, err)
      })
    },
    /**
     * 本适配层的**内部**方法（非 Cloudflare DurableObjectState 标准接口）。
     *
     * 供 `NodeDurableObjectNamespace` 判断该实例是否**忙**（不可回收）：
     * - `activeTimer !== undefined`：已排了未触发的 alarm；
     * - `running === true`：alarm 处理器**正在执行**（此时定时器已清空，
     *   但绝不能回收 —— 否则会新建第二个实例操作同一份数据）。
     *
     * 两者皆为假时才说明实例真正 idle，可安全从内存 Map 移除（下次用时重建）。
     */
    __hasPendingAlarm(): boolean {
      return activeTimer !== undefined || running
    },
  }
}
