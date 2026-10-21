/**
 * 入口防护（2026-10-21 审查补，安全面专项）。
 *
 * ## 三条缺陷
 * ① **全链路没有请求体上限**：实测一条 120 MiB 请求 RSS +322 MB，
 *    且读完之后才因别的原因失败（没有 413）。注释里那句「网关自己也有体积上限保护」
 *    是假的 —— 那个保护根本不存在。
 * ② `?realm=` **完全不校验**：任何一把有效密钥循环 `?realm=rand` 就能
 *    每请求创建 1 个常驻 DO 实例 + 永久写 2 行 SQLite（实测 400 个全通过）。
 * ③ 两道防线都必须存在：`content-length` 可省略（chunked），
 *    只有预检会被轻易绕过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { request as httpRequest } from 'node:http'

import { startServer } from '../src/server/index.js'

const KEY = 'security-limits-key'

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const tmp = path.join(os.tmpdir(), `seclim-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const saved = process.env.API_KEY
  process.env.API_KEY = KEY
  const originalLog = console.log
  console.log = () => {}
  const { server, runtime } = startServer({ port: 0, host: '127.0.0.1', databasePath: tmp, autoCron: false })
  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  try {
    await fn(`http://127.0.0.1:${addr.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runtime.db.close()
    console.log = originalLog
    if (saved === undefined) delete process.env.API_KEY
    else process.env.API_KEY = saved
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
}

test('🔴 声明了超大 content-length 必须立刻 413（不能先读完再失败）', async () => {
  await withServer(async (base) => {
    // ⚠️ `content-length` 是 fetch 的**禁止修改头**，必须用 raw http 才能伪造
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/v1/chat/completions`)
      const req = httpRequest(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: {
            authorization: `Bearer ${KEY}`,
            'content-type': 'application/json',
            // 声明 200 MiB（实际只发 2 字节）—— 预检必须**不等 body** 就拒
            'content-length': String(200 * 1024 * 1024),
          },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(status, 413, `超大请求体应回 413，实际 ${status}`)
  })
})

test('🔴 不带 content-length（chunked）也必须被边读边截断', async () => {
  await withServer(async (base) => {
    // 10 MiB 的纯字符串，用流式 body 发送 ⇒ 没有 content-length
    const chunk = new Uint8Array(1024 * 1024).fill(0x61)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 10) {
          controller.close()
          return
        }
        sent += 1
        controller.enqueue(chunk)
      },
    })
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: stream,
      // @ts-expect-error Node fetch 需要显式关闭 chunked 的 duplex
      duplex: 'half',
    })
    assert.equal(res.status, 413, `超限的流式请求应回 413，实际 ${res.status}`)
  })
})

test('🔴 realm 必须是 cn/global，任意值一律 400（否则可无界创建实例与落库）', async () => {
  await withServer(async (base) => {
    for (const bad of ['r1_deadbeef', '../escape', 'CN', '']) {
      const res = await fetch(`${base}/v1/chat/completions?realm=${encodeURIComponent(bad)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
      })
      assert.equal(res.status, 400, `realm=${bad} 应回 400，实际 ${res.status}`)
    }
    // 合法值不应被这道门挡掉（这里只因没有账号而 503，不是 400）
    const ok = await fetch(`${base}/v1/chat/completions?realm=global`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    assert.notEqual(ok.status, 400, 'realm=global 是合法分片，不应被白名单拒绝')
  })
})
