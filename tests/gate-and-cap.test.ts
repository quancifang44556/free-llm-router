/**
 * 2026-10-21 审查补（重复实现 + 并发 + 安全面）里的三条行为。
 *
 * ① 逐模型「停用」此前只在目录/聚合路径生效 —— 直连 `provider/model` 照样打通。
 * ② 上游错误响应体原先**整包读进内存**再 slice(0,4096)，注释却写「截断到 4KB」。
 * ③ OAuth 回调地址不能由请求头 Host 拼（PUBLIC_URL 优先）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readTextCapped } from '../src/gateway/body.js'
import { startServer } from '../src/server/index.js'

const KEY = 'gate-cap-key'

test('🔴 上游错误体必须边读边截断，不能整包进内存', async () => {
  const big = 'x'.repeat(8 * 1024 * 1024) // 8 MiB
  const res = new Response(big, { status: 500 })
  const text = await readTextCapped(res, 4096)
  assert.equal(text.length, 4096, '必须只保留前 4096 字节')
  assert.ok(!text.includes('undefined'))
})

test('🔴 直连 provider/model 也必须拦住「面板里停用的模型」', async () => {
  const tmp = path.join(os.tmpdir(), `gate-${Date.now()}.db`)
  const saved = process.env.API_KEY
  process.env.API_KEY = KEY
  const originalLog = console.log
  console.log = () => {}
  const { server, runtime } = startServer({ port: 0, host: '127.0.0.1', databasePath: tmp, autoCron: false })
  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const addr = server.address() as { port: number }
  const base = `http://127.0.0.1:${addr.port}`
  try {
    // 直接把模型标成停用（等价于面板上关掉它）
    const pool = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('cn'))
    await pool.setDisabledModels('qodercn', ['dfmodel'])

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qodercn/dfmodel', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(
      res.status,
      403,
      `⚠️ 停用的模型仍能直连打通（期望 403 provider 已关/模型已停用，实际 ${res.status}）—— 面板上关掉它是空话`,
    )
    const body = (await res.json()) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'model_disabled')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runtime.db.close()
    console.log = originalLog
    if (saved === undefined) delete process.env.API_KEY
    else process.env.API_KEY = saved
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})

test('🔴 OAuth 回调地址必须优先用 PUBLIC_URL，而不是请求头 Host', () => {
  const src = readFileSyncSafe('src/index.ts')
  assert.ok(/PUBLIC_URL/.test(src), '必须支持 PUBLIC_URL')
  assert.ok(
    /publicOrigin\(env, url\)/.test(src),
    '回调地址必须走 publicOrigin(env, url)（不能直接用 url.origin —— 它来自客户端可控的 Host 头）',
  )
  assert.ok(
    !/buildCodeArtsCallbackUrl\(url\.origin/.test(src),
    '不得再用 url.origin 拼回调地址',
  )
})

function readFileSyncSafe(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

test('🔴 停用列表里的陈旧 `auto` 不得把默认入口 buddy/auto 打成 403', async () => {
  const tmp = path.join(os.tmpdir(), `gate-auto-${Date.now()}.db`)
  const saved = process.env.API_KEY
  process.env.API_KEY = KEY
  const originalLog = console.log
  console.log = () => {}
  const { server, runtime } = startServer({ port: 0, host: '127.0.0.1', databasePath: tmp, autoCron: false })
  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const addr = server.address() as { port: number }
  const base = `http://127.0.0.1:${addr.port}`
  try {
    const pool = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('cn'))
    // 陈旧记录：`auto` 不是真实模型 id（`/v1/models` 里没有 buddy/auto）
    await pool.setDisabledModels('buddy', ['auto'])

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'buddy/auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.notEqual(
      res.status,
      403,
      '⚠️ 默认入口 buddy/auto 被陈旧的停用记录打成 403 —— 这是网关自己的别名，不是供应商模型',
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runtime.db.close()
    console.log = originalLog
    if (saved === undefined) delete process.env.API_KEY
    else process.env.API_KEY = saved
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})
