/**
 * 面板保存不得**冻结**环境变量（2026-10-21 审查补，配置健壮性专项）。
 *
 * ## 缺陷
 * `setSafetyConfig()` 一次写全六个字段，未提供的用「当前合并值」顶替。
 * 于是用户只要在面板点一下**任意一项**，就把当时的环境变量值（常常还是 `0`）
 * 固化进 `systemSafetyConfig`；此后 `num(stored)` 恒命中，`?? resolve*()` 永不执行。
 *
 * 用户视角：「我设了 `RATE_LIMIT_QPS=0.5`，面板显示 0，限速就是不生效。」
 * 而代码在「首次读到」那一刻是对的 —— 所以查代码、查构建都找不到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'

test('🔴 只保存一项时，其他字段必须继续跟随环境变量', async () => {
  const tmp = path.join(os.tmpdir(), `safety-${Date.now()}.db`)
  // 环境变量给一个明显不同的值
  const saved = process.env.RATE_LIMIT_QPS
  process.env.RATE_LIMIT_QPS = '3'
  const rt = createNodeRuntime(tmp)
  try {
    const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn'))
    const before = await pool.getSafetyConfig()
    assert.equal(before.rateLimitQps, 3, '未在面板保存过时应跟随环境变量')

    // 用户只点了一个「会话链」开关
    await pool.setSafetyConfig({ sessionTrace: false })

    const after = await pool.getSafetyConfig()
    assert.equal(after.sessionTrace, false, '被保存的那项应生效')
    assert.equal(
      after.rateLimitQps,
      3,
      '⚠️ 没保存过的 rateLimitQps 被「冻结」成了旧值 —— 之后改 RATE_LIMIT_QPS 再也不会生效',
    )

    // 改环境变量后必须立刻反映（这是「没被冻结」的真正证明）
    process.env.RATE_LIMIT_QPS = '0.5'
    const rt2 = createNodeRuntime(tmp)
    try {
      const pool2 = rt2.env.ACCOUNT_POOL.get(rt2.env.ACCOUNT_POOL.idFromName('cn'))
      const reloaded = await pool2.getSafetyConfig()
      assert.equal(
        reloaded.rateLimitQps,
        0.5,
        '⚠️ 改了 RATE_LIMIT_QPS 却不生效 —— 环境变量已被面板保存永久压住',
      )
      assert.equal(reloaded.sessionTrace, false, '面板保存过的那项仍应保持')
    } finally {
      rt2.db.close()
    }
  } finally {
    if (saved === undefined) delete process.env.RATE_LIMIT_QPS
    else process.env.RATE_LIMIT_QPS = saved
    rt.db.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
