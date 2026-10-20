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
  private serialize: boolean

  /**
   * @param options.serialize 是否把对实例的方法调用**逐个排队执行**（见 {@link serializeCalls}）。
   *   只应对「方法内部只读写存储、不发外部请求」的 DO 开启（如 `AccountPoolDO`）。
   */
  constructor(
    prefix: string,
    db: DatabaseSync,
    factory: (ctx: any, env: any) => T,
    getEnv: () => any,
    options: { serialize?: boolean } = {},
  ) {
    this.prefix = prefix
    this.db = db
    this.factory = factory
    this.getEnv = getEnv
    this.serialize = options.serialize === true
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

    const raw = this.factory(state, this.getEnv())
    const instance = this.serialize ? serializeCalls(raw) : raw
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

/**
 * 把对一个 DO 实例的方法调用**逐个排队执行**（一次只跑一个，按调用顺序）。
 *
 * ## ⚠️ 为什么必须有（否则 Node 下并发写会互相覆盖）
 *
 * Cloudflare 的 DO 有 input gate：方法在等存储读写时，**不会**有别的请求插进来。
 * 所以 `AccountPoolDO` 里大量「先 `get` → 改 → 再 `put`」的写法在 CF 上是原子的。
 *
 * Node 适配层没有这层保证：`storage.get()` 虽是同步实现，但调用方 `await` 它时会让出
 * 执行权，另一个并发请求就可能在「读」与「写」之间插进来，读到同一份旧值，
 * 后写的覆盖先写的。实测 50 个并发 `recordApiKeyUse` 只记下 **1** 次 ——
 * 用量、冷却、熔断、WAF 计数、日志都会这样静默丢失。
 *
 * ## 为什么排队不会死锁
 *
 * - 方法内部 `this.xxx()` 调的是**原始实例**，不经过队列；
 * - 只对「方法里只碰存储、不发外部请求、不调别的 DO」的类开启（`AccountPoolDO` 满足）。
 *
 * 排队后语义与 CF 一致：CF 的 DO RPC 本来就返回 Promise，调用方无需改动。
 */
export function serializeCalls<T extends object>(target: T): T {
  let tail: Promise<unknown> = Promise.resolve()
  const wrappers = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>()
  const settle = (): void => {}
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj) as unknown
      if (typeof value !== 'function' || prop === 'constructor') return value
      let wrapped = wrappers.get(prop)
      if (wrapped === undefined) {
        const fn = value as (...args: unknown[]) => unknown
        wrapped = (...args: unknown[]): Promise<unknown> => {
          const run = tail.then(() => fn.apply(obj, args))
          // 前一个调用失败不能卡住后面的调用：队尾只关心「结束了」，不关心成败。
          tail = run.then(settle, settle)
          return run
        }
        wrappers.set(prop, wrapped)
      }
      return wrapped
    },
  })
}
