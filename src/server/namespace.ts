/**
 * DurableObject 命名空间适配层（Node.js 运行时实现）。
 *
 * ## 为什么这个文件单独存在
 *
 * 在 Cloudflare Workers 中，`env.ACCOUNT_POOL` 和 `env.TASK_RUNNER` 为 `DurableObjectNamespace`，
 * 通过 `idFromName(name)` 生成 ID，通过 `get(id)` 获取对应的 Stub。
 *
 * 本类在 Node.js 中维护单进程单例实例池（Map），以极低开销实现相同的语义，
 * 并支持服务启动时自动扫描并恢复所有未决的后台任务（Alarm）。
 *
 * ## ⚠️ 内存治理（必须，否则长跑会泄漏）
 *
 * Cloudflare 会**自动回收 idle 的 DO**；本适配层若永久缓存实例，则：
 * - `TaskRunner` 按**每个 uid 一个实例** ⇒ 账号越多、跑的任务越多，Map 无限增长；
 * - 且实例的 alarm 定时器持有闭包 ⇒ 即便 no-op 也无法被 GC。
 *
 * ⇒ 因此提供 {@link pruneIdle}：回收「**没有未决 alarm**」的实例。
 * 有未决 alarm 的实例**绝不回收**（回收会连同定时器一起丢弃，任务永久卡死）。
 * 这是安全的：下次 `get()` 会用同一份 SQLite 数据无损重建实例。
 */

import { DatabaseSync } from 'node:sqlite'
import { createNodeDurableObjectState } from './storage.js'

interface CachedInstance<T> {
  instance: T
  state: { __hasPendingAlarm?: () => boolean }
  lastAccess: number
}

export class NodeDurableObjectNamespace<T extends { alarm?: () => Promise<void> }> {
  private instances = new Map<string, CachedInstance<T>>()
  private db: DatabaseSync
  private factory: (ctx: any, env: any) => T
  private getEnv: () => any
  private prefix: string

  constructor(
    prefix: string,
    db: DatabaseSync,
    factory: (ctx: any, env: any) => T,
    getEnv: () => any,
  ) {
    this.prefix = prefix
    this.db = db
    this.factory = factory
    this.getEnv = getEnv
  }

  /**
   * 将字符串名称转换为标识对象（满足 Cloudflare DurableObjectId 接口）。
   */
  idFromName(name: string): { toString(): string; name: string } {
    return {
      toString: () => name,
      name,
    }
  }

  /**
   * 获取或初始化对应的 DO 实例（单例缓存）。
   */
  get(idOrName: { toString(): string } | string): T {
    const key = typeof idOrName === 'string' ? idOrName : idOrName.toString()
    const cached = this.instances.get(key)
    if (cached) {
      cached.lastAccess = Date.now()
      return cached.instance
    }

    // ⚠️ 用容器持有实例引用，避免闭包捕获一个「此时尚未赋值」的变量。
    // 原写法 `if (typeof inst?.alarm === 'function')` 依赖 TDZ 时序，
    // 虽侥幸能跑，但语义脆弱（见历史实现）。
    const holder: { instance?: T } = {}
    const state = createNodeDurableObjectState({
      instanceId: `${this.prefix}:${key}`,
      db: this.db,
      onAlarm: async () => {
        const inst = holder.instance
        if (inst && typeof inst.alarm === 'function') {
          await inst.alarm()
        }
      },
    })

    const instance = this.factory(state, this.getEnv())
    holder.instance = instance
    this.instances.set(key, { instance, state, lastAccess: Date.now() })
    return instance
  }

  /**
   * 启动时扫描并预热恢复所有带有未决 Alarm 的任务实例。
   */
  restorePendingAlarms(): void {
    const pattern = `${this.prefix}:%`
    const rows = this.db
      .prepare('SELECT id FROM system_alarms WHERE id LIKE ?')
      .all(pattern) as Array<{ id: string }>
    for (const row of rows) {
      const key = row.id.slice(this.prefix.length + 1)
      this.get(key)
    }
  }

  /**
   * 回收 idle 实例（**无未决 alarm** 的），返回回收数量。
   *
   * ⚠️ 判据是「是否还有未决 alarm」，**不是**「最近有没有被访问」——
   * 一个刚触发、正在等待下一步 tasks 的实例可能几分钟无人访问，
   * 但它的定时器必须保留。故这里只回收 `__hasPendingAlarm()` 为 false 的实例。
   *
   * @param maxIdleExternalMs 额外的时间保护：仅回收超过该时长未被访问的实例
   *   （默认 5 分钟），避免把「刚创建、正要被调用」的实例误回收。
   */
  pruneIdle(maxIdleExternalMs = 5 * 60 * 1000): number {
    const now = Date.now()
    let removed = 0
    for (const [key, entry] of this.instances) {
      const pending = entry.state.__hasPendingAlarm?.() ?? false
      if (!pending && now - entry.lastAccess > maxIdleExternalMs) {
        this.instances.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /** 当前内存中缓存的实例数（观测用）。 */
  get size(): number {
    return this.instances.size
  }
}
