/**
 * 按账号限速器必须**在并发下**依然有效（2026-10-21 审查补，并发专项）。
 *
 * ## 缺陷
 * 原实现是 `get()` → `await sleep()` → `set()`，跨 await 的 check-then-act。
 * 同一 uid 的 N 个并发请求都在 `set` 之前读到同一个 `last` ⇒ **同一毫秒一起放行**：
 *
 * ```
 * qps=5、12 并发 → 放行时刻直方图 { 0: 1, 200: 11 }
 * ```
 *
 * 而「连发」正是限速器唯一要消除的机器特征 —— 这是**防封功能静默失效**，
 * 比不开更糟（多了个「已限速」的错觉）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { configureThrottle, throttleUpstream } from '../src/gateway/throttle.js'

/** 用**假时钟**驱动，避免测试真的等几秒（并且结论与机器快慢无关）。 */
function fakeClock() {
  let t = 0
  const timers: Array<{ at: number; resolve: () => void }> = []
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: t + ms, resolve })
      }),
    /** 推进到所有等待都结束 */
    async drain(): Promise<void> {
      for (let guard = 0; guard < 10_000; guard += 1) {
        if (timers.length === 0) return
        timers.sort((a, b) => a.at - b.at)
        const next = timers.shift()!
        t = Math.max(t, next.at)
        next.resolve()
        await delay(0)
      }
      throw new Error('假时钟没有收敛（可能死循环）')
    },
  }
}

test('🔴 12 个并发请求必须被拉开间隔，不能同一毫秒一起放行', async () => {
  const clock = fakeClock()
  configureThrottle({ qps: 5, jitterMs: 0 }) // 期望最小间隔 200ms
  /**
   * ⚠️ 断言「**预约到的等待时长**」而不是「醒来后读到的时间」：
   * 后者受微任务调度影响（本测试第一版就踩了：第一个请求 `wait=0` 不睡，
   * 它的续体读到的时间已被假时钟推进，于是记录成 200，直方图出现两个 200）。
   *
   * 而「等待时长」正是这个模块的契约：并发者应当分别预约到
   * 0、200、400…… 的**不同**槽位。全部相同 ⇒ 又是同一毫秒放行。
   */
  const waits: number[] = []
  const sleep = (ms: number) => {
    waits.push(ms)
    return clock.sleep(ms)
  }
  const tasks = Array.from({ length: 12 }, () => throttleUpstream('uid-A', sleep, clock.now, 'workbuddy'))
  await clock.drain()
  await Promise.all(tasks)

  waits.sort((a, b) => a - b)
  assert.equal(waits.length, 11, '第一个请求不该等，其余 11 个各等一次')
  assert.deepEqual(
    waits,
    Array.from({ length: 11 }, (_, i) => (i + 1) * 200),
    `⚠️ 12 个并发没有排队，预约到的等待时长是 ${JSON.stringify(waits)}（应严格递增 200ms）—— 说明它们会在同一毫秒一起打到上游`,
  )
})

test('不同 uid 互不影响（限速是按账号的，不是全局的）', async () => {
  const clock = fakeClock()
  configureThrottle({ qps: 5, jitterMs: 0 })
  const at: number[] = []
  await Promise.all([
    throttleUpstream('uid-B', clock.sleep, clock.now, 'workbuddy').then(() => at.push(clock.now())),
    throttleUpstream('uid-C', clock.sleep, clock.now, 'workbuddy').then(() => at.push(clock.now())),
  ])
  await clock.drain()
  assert.deepEqual(at, [0, 0], '两个不同账号应当各自立即放行')
})

test('抖动会并入预约时刻：相邻槽位间隔恒 ≥ 最小间隔', async () => {
  const clock = fakeClock()
  configureThrottle({ qps: 10, jitterMs: 50 }) // 最小间隔 100ms，抖动 ≤50ms
  const waits: number[] = []
  const sleep = (ms: number) => {
    waits.push(ms)
    return clock.sleep(ms)
  }
  const tasks = Array.from({ length: 6 }, () => throttleUpstream('uid-D', sleep, clock.now, 'workbuddy'))
  await clock.drain()
  await Promise.all(tasks)
  waits.sort((a, b) => a - b)
  for (let i = 1; i < waits.length; i += 1) {
    assert.ok(
      waits[i]! - waits[i - 1]! >= 100,
      `抖动不得让相邻槽位靠近（${waits[i]! - waits[i - 1]!}ms < 100ms）：${JSON.stringify(waits)}`,
    )
  }
})
