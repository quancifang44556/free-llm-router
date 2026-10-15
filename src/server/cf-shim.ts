/**
 * Cloudflare Workers DurableObject 适配层（Node.js 环境桩）。
 *
 * ## 为什么这个文件单独存在
 *
 * 在 Cloudflare Workers 环境下，`AccountPoolDO` 和 `TaskRunnerDO` 继承自 `'cloudflare:workers'`
 * 导出的 `DurableObject` 基类。该基类主要作用是注入 `this.ctx`（DurableObjectState）与
 * `this.env`（环境变量与 bindings）。
 *
 * 在 Node.js / VPS 环境下，通过 esbuild 将 `'cloudflare:workers'` 重定向至本文件，
 * 实现零代码侵入、零业务改动复用 `AccountPoolDO` 与 `TaskRunnerDO` 的 100% 状态机逻辑。
 */

export class DurableObject<Env = unknown> {
  ctx: any
  env: Env

  constructor(ctx: any, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  /** 子类可选实现的定时 Alarm 步进处理器。 */
  alarm?(): Promise<void>
}
