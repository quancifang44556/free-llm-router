/**
 * 配置解析健壮性（2026-10-21 审查补，配置健壮性专项）。
 *
 * 本项目的纪律是「数值配置一律走统一解析器、失败方向必须收紧、写错要出声」。
 * 这个文件把本轮补上的三处钉住：
 * ① `RATE_LIMIT_QPS` / `RATE_JITTER_MS` 曾被 `Number()` 解析（接受 `0x10`/`1e3`）
 * ② `PORT` 曾被 `Number.parseInt` 解析（`0x1f`→0 随机端口、`abc`→崩在 listen 里）
 * ③ `UPSTREAM_*_BASE` 在 buddy 路径曾用 `||`（纯空白挡不住，半侧故障）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { resolveRateLimitQps, resolveRateJitterMs } from '../src/gateway/safety.js'
import { startServer } from '../src/server/index.js'

const envWith = (pairs: Record<string, string>) => pairs as never

test('🔴 RATE_LIMIT_QPS 必须拒绝 0x / 1e 写法，且非法值要有可见痕迹', () => {
  assert.equal(resolveRateLimitQps(envWith({ RATE_LIMIT_QPS: '0.5' })), 0.5, '小数 QPS 是合法用法')
  assert.equal(resolveRateLimitQps(envWith({ RATE_LIMIT_QPS: '3' })), 3)
  assert.equal(resolveRateLimitQps(envWith({ RATE_LIMIT_QPS: '0x10' })), 0, '十六进制不是用户意图')
  assert.equal(resolveRateLimitQps(envWith({ RATE_LIMIT_QPS: '1e3' })), 0, '科学计数法不是用户意图')
  assert.equal(resolveRateLimitQps(envWith({ RATE_LIMIT_QPS: '5m' })), 0, '把毫秒写法抄过来应失效')
  assert.equal(resolveRateLimitQps(envWith({})), 0, '未设置 = 不限速')
  assert.equal(resolveRateJitterMs(envWith({ RATE_JITTER_MS: '0.5' })), 0.5, '抖动也允许小数')
})

test('🔴 PORT 写错必须明确报错，不能静默绑到随机端口', () => {
  const saved = process.env.PORT
  try {
    for (const bad of ['0x1f', '1e3', 'abc', '11451abc', '0', '70000', '-1']) {
      process.env.PORT = bad
      // `strictPort` 在 `startServer` 的**第一行**执行，早于任何 I/O ⇒ 抛错不会泄漏资源
      assert.throws(
        () => startServer(),
        /PORT/,
        `PORT=${bad} 必须报错且错误里提到 PORT`,
      )
    }
  } finally {
    if (saved === undefined) delete process.env.PORT
    else process.env.PORT = saved
  }
})

test('🔴 buddy 路径的上游 base 不得用 `||`（纯空白挡不住）', () => {
  const src = readFileSync('src/providers/buddy.ts', 'utf8')
  const i = src.indexOf('const bases =')
  assert.ok(i > 0, '应能找到 bases 构造处')
  const block = src.slice(i, i + 1400)
  for (const key of ['CHAT', 'BILLING', 'WEB']) {
    assert.ok(
      new RegExp(`parseString\\(env\\.UPSTREAM_${key}_BASE`).test(block),
      `UPSTREAM_${key}_BASE 必须走 parseString（trim 后空串回落），否则纯空白会让 fetch 抛 Failed to parse URL`,
    )
    assert.ok(
      !new RegExp(`env\\.UPSTREAM_${key}_BASE \\|\\|`).test(block),
      `UPSTREAM_${key}_BASE 不得再用 ||`,
    )
  }
})
