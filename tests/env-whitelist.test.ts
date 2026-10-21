/**
 * `process.env → Env` 白名单完整性（2026-10-21 审查补，M6 指出）。
 *
 * ## 为什么要专门测「白名单」
 * Workers 部署由平台直接绑定 `env`；而 Node/Docker 部署要靠 `server/env.ts`
 * 里那段手工映射把 `process.env` 搬进 `Env`。**漏一个键**的后果是：
 * 文档写了、生产设了、**毫无作用、零报错**。
 *
 * 历史上已漏过一次（`MAX_CONTEXT_MESSAGES`，被 `safety-config.test.ts` 抓到），
 * 本次又发现三个（`RATE_LIMIT_QPS` / `RATE_JITTER_MS` / `WORKBUDDY_DAILY_CHAT_MODEL`）。
 * 本测试把「这几个键必须搬进去」钉死，防止以后再漏。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createNodeRuntime } from '../src/server/env.js'

test('🔴 生产可配的环境变量必须真的搬进 Env（漏了＝设了不生效、零报错）', () => {
  const keys = ['RATE_LIMIT_QPS', 'RATE_JITTER_MS', 'WORKBUDDY_DAILY_CHAT_MODEL'] as const
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) {
    saved[k] = process.env[k]
    process.env[k] = `probe-${k}`
  }
  const tmp = path.join(os.tmpdir(), `env-whitelist-${Date.now()}.db`)
  const rt = createNodeRuntime(tmp)
  try {
    for (const k of keys) {
      assert.equal(
        (rt.env as unknown as Record<string, unknown>)[k],
        `probe-${k}`,
        `⚠️ ${k} 没被搬进 Env —— Node/Docker 部署下设了也不会生效`,
      )
    }
  } finally {
    rt.db.close()
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
