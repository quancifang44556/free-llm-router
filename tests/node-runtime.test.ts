/**
 * Node.js 运行时集成测试。
 *
 * 验证：
 * 1. NodeSqlStorage 对 SQLite 的封装（exec、toArray、one、参数绑定）；
 * 2. NodeDurableObjectNamespace 与 Storage 的 KV、Alarm 机制；
 * 3. createNodeRuntime 完整装配与持久化加密密钥；
 * 4. AccountPoolDO 在 Node 环境下的完整读写、选号与剪枝；
 * 5. HTTP 服务端在动态端口下的 Request/Response 桥接与流处理。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqlStorage, createNodeDurableObjectState } from '../src/server/storage.js'
import { createNodeRuntime } from '../src/server/env.js'
import { startServer } from '../src/server/index.js'
import { createAccountState } from '../src/pool/state.js'

test('NodeSqlStorage：兼容 Cloudflare SqlStorage 行为', () => {
  const db = new DatabaseSync(':memory:')
  const sql = new NodeSqlStorage(db)

  // 1. DDL
  sql.exec('CREATE TABLE test (id TEXT PRIMARY KEY, val TEXT, count INTEGER)')

  // 2. DML insert
  sql.exec('INSERT INTO test (id, val, count) VALUES (?, ?, ?)', 'k1', 'val1', 42)
  sql.exec('INSERT INTO test (id, val, count) VALUES (?, ?, ?)', 'k2', 'val2', 100)

  // 3. SELECT toArray
  const rows = sql.exec<{ id: string; val: string; count: number }>(
    'SELECT * FROM test ORDER BY count ASC',
  ).toArray()
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.id, 'k1')
  assert.equal(rows[0]?.count, 42)
  assert.equal(rows[1]?.id, 'k2')

  // 4. SELECT one (成功)
  const single = sql.exec<{ val: string }>('SELECT val FROM test WHERE id = ?', 'k1').one()
  assert.equal(single?.val, 'val1')

  // 5. SELECT one (0 行应抛异常)
  assert.throws(
    () => {
      sql.exec('SELECT val FROM test WHERE id = ?', 'non-exist').one()
    },
    /Expected exactly one result/,
  )

  // 6. SELECT one (多行应抛异常)
  assert.throws(
    () => {
      sql.exec('SELECT val FROM test').one()
    },
    /Expected exactly one result/,
  )

  // 7. ON CONFLICT UPSERT
  sql.exec(
    'INSERT INTO test (id, val, count) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET val = excluded.val',
    'k1',
    'val1-updated',
    42,
  )
  const updated = sql.exec<{ val: string }>('SELECT val FROM test WHERE id = ?', 'k1').one()
  assert.equal(updated?.val, 'val1-updated')

  db.close()
})

test('NodeDurableObjectState：KV 存储与 Alarm 调度', async () => {
  const db = new DatabaseSync(':memory:')
  let alarmCalled = false
  const state = createNodeDurableObjectState({
    instanceId: 'test_inst:1',
    db,
    onAlarm: () => {
      alarmCalled = true
    },
  })

  // 1. KV put & get
  await state.storage.put('config', { port: 11451, enabled: true })
  const conf = await state.storage.get<{ port: number; enabled: boolean }>('config')
  assert.deepEqual(conf, { port: 11451, enabled: true })

  // 2. KV delete
  const deleted = await state.storage.delete('config')
  assert.equal(deleted, true)
  const nonExist = await state.storage.get('config')
  assert.equal(nonExist, undefined)

  // 3. Alarm 调度（即刻调度触发）
  await state.storage.setAlarm(Date.now() - 100)
  const scheduledTime = await state.storage.getAlarm()
  assert.ok(typeof scheduledTime === 'number')

  // 等待事件循环微任务触发 onAlarm
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(alarmCalled, true)

  // 4. 触发后 alarm 记录应自动清理
  const afterAlarm = await state.storage.getAlarm()
  assert.equal(afterAlarm, null)

  db.close()
})

test('createNodeRuntime：完整装配与 AccountPoolDO 操作验证', async () => {
  const tmpDbPath = path.join(process.cwd(), '.build', 'test-runtime.db')
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)

  const runtime = createNodeRuntime(tmpDbPath)
  const { env, db } = runtime

  assert.ok(env.ACCOUNT_POOL)
  assert.ok(env.TASK_RUNNER)
  assert.ok(typeof env.CREDENTIAL_KEY === 'string' && env.CREDENTIAL_KEY.length > 20)

  // 获取 AccountPoolDO 实例
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
  assert.ok(pool)

  // 写入测试账号
  const testAccount = createAccountState({
    uid: 'test-uid-1',
    nickname: 'VPS测试号',
    realm: 'cn',
    provider: 'buddy',
  })
  await pool.upsertAccount(testAccount, Date.now())

  // 读取账号
  const fetched = await pool.getAccount('test-uid-1')
  assert.ok(fetched)
  assert.equal(fetched.uid, 'test-uid-1')
  assert.equal(fetched.nickname, 'VPS测试号')

  // 列出账号
  const list = await pool.listAccounts('cn', Date.now())
  assert.equal(list.length, 1)
  assert.equal(list[0]?.uid, 'test-uid-1')

  // 清理
  db.close()
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)
})

test('startServer：HTTP 服务端启动、健康检查与面板可访问性', async () => {
  const tmpDbPath = path.join(process.cwd(), '.build', 'test-http.db')
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)

  const originalApiKey = process.env.API_KEY
  process.env.API_KEY = 'test-secret-key-12345'

  const { server, runtime } = startServer({
    port: 0, // 动态随机端口，防止端口冲突
    host: '127.0.0.1',
    databasePath: tmpDbPath,
    autoCron: false,
  })

  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once('listening', () => resolve())
  })

  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const port = addr.port
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    // 1. /healthz 免鉴权返回 200
    const healthRes = await fetch(`${baseUrl}/healthz`)
    assert.equal(healthRes.status, 200)
    const healthJson = (await healthRes.json()) as any
    assert.equal(healthJson?.ok, true)

    // 2. /panel/ 静态网页访问返回 200 与 HTML
    const panelRes = await fetch(`${baseUrl}/panel/`)
    assert.equal(panelRes.status, 200)
    const html = await panelRes.text()
    assert.ok(html.includes('free-llm-router'))

    // 3. 入口引用的样式表正常返回 CSS（文件名带哈希，从 HTML 里取）
    const cssPath = /href="(\/panel\/assets\/[^"]+\.css)"/.exec(html)?.[1]
    assert.ok(cssPath, '入口 HTML 应引用样式表')
    const cssRes = await fetch(`${baseUrl}${cssPath}`)
    assert.equal(cssRes.status, 200)
    assert.ok(cssRes.headers.get('content-type')?.includes('text/css'))
    assert.match(cssRes.headers.get('cache-control') ?? '', /immutable/)
    // 3b. 旧登录页地址跳到面板；/panel/ 下不存在的文件 404（不是 401）
    const loginRes = await fetch(`${baseUrl}/login`, { redirect: 'manual' })
    assert.equal(loginRes.status, 302)
    assert.equal(loginRes.headers.get('location'), '/panel/')
    assert.equal((await fetch(`${baseUrl}/panel/nope.js`)).status, 404)
    // 3c. 面板资源在 Node 直连时也要 gzip（Workers 由边缘压缩）；fetch 会自动解压，内容不变
    assert.equal(panelRes.headers.get('content-encoding'), 'gzip')
    assert.equal(cssRes.headers.get('content-encoding'), 'gzip')
    const plain = await fetch(`${baseUrl}${cssPath}`, { headers: { 'accept-encoding': 'identity' } })
    assert.equal(plain.headers.get('content-encoding'), null, '不接受 gzip 的客户端拿原文')
    assert.equal((await plain.text()).length > 1000, true)

    // 4. /v1/models 无 Authorization 应返回 401
    const unauthRes = await fetch(`${baseUrl}/v1/models`)
    assert.equal(unauthRes.status, 401)

    // 5. /v1/models 带正确 Bearer token 应返回 200 与列表
    const authRes = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: 'Bearer test-secret-key-12345' },
    })
    assert.equal(authRes.status, 200)
    assert.equal(authRes.headers.get('content-encoding'), null, 'API 响应不压缩（SSE 不能被缓冲）')
    const modelsJson = (await authRes.json()) as any
    assert.ok(Array.isArray(modelsJson?.data))
  } finally {
    if (originalApiKey !== undefined) {
      process.env.API_KEY = originalApiKey
    } else {
      delete process.env.API_KEY
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    runtime.db.close()
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath)
  }
})

test('🔴 Node 下 AccountPoolDO 并发「读-改-写」不丢更新（串行队列）', async () => {
  // 复现：没有串行队列时，50 个并发 recordApiKeyUse 只记下 1 次。
  const originalLog = console.log
  console.log = () => {}
  const rt = createNodeRuntime(':memory:')
  console.log = originalLog
  const pool = rt.env.ACCOUNT_POOL.get(rt.env.ACCOUNT_POOL.idFromName('cn')) as any
  const rec = await pool.addApiKey({ name: 'race', hash: 'hash-race', prefix: 'sk-race' })
  await Promise.all(
    Array.from({ length: 50 }, () =>
      pool.recordApiKeyUse({ id: rec.id, ip: '203.0.113.9', model: 'm', input: 0, output: 0 }),
    ),
  )
  const usage = await pool.getApiKeyUsage(rec.id)
  assert.equal(usage.requests, 50)
})

test('串行队列：前一个调用抛错不会卡住后续调用', async () => {
  const { serializeCalls } = await import('../src/server/namespace.js')
  const order: string[] = []
  const obj = serializeCalls({
    async boom(): Promise<void> {
      order.push('boom')
      throw new Error('x')
    },
    async ok(v: string): Promise<string> {
      order.push(v)
      return v
    },
  })
  const a = obj.boom().catch(() => 'caught')
  const b = obj.ok('after')
  assert.equal(await a, 'caught')
  assert.equal(await b, 'after')
  assert.deepEqual(order, ['boom', 'after'])
})

test('🔴 Node 客户端 IP：默认只认 TCP 对端，客户端伪造的头无效', async () => {
  const { resolveClientIp } = await import('../src/server/index.js')
  // 未开 TRUST_PROXY：X-Forwarded-For 不可信，取对端地址
  assert.equal(resolveClientIp('198.51.100.7', '1.2.3.4', false), '198.51.100.7')
  // IPv4 映射地址去掉 ::ffff: 前缀，白名单才能匹配
  assert.equal(resolveClientIp('::ffff:198.51.100.7', undefined, false), '198.51.100.7')
  // 开了 TRUST_PROXY：取最右一项（反代追加的），左边客户端自填的不算
  assert.equal(resolveClientIp('127.0.0.1', '6.6.6.6, 203.0.113.5', true), '203.0.113.5')
  // 开了但没有 X-Forwarded-For：回落对端地址
  assert.equal(resolveClientIp('127.0.0.1', undefined, true), '127.0.0.1')
})

test('🔴 Node 服务：客户端自带的 CF-Connecting-IP 被丢弃并按对端地址重写', async () => {
  const tmp = path.join(process.cwd(), '.build', `ip-test-${Date.now()}.db`)
  const originalApiKey = process.env.API_KEY
  process.env.API_KEY = 'ip-test-key'
  // ⚠️ 静音启动横幅：node:test 子进程的 stdout 同时承载测试协议帧，
  // 大段 console 输出与协议帧交错时偶发「Unable to deserialize cloned data」。
  const originalLog = console.log
  console.log = () => {}
  const { server, runtime } = startServer({ port: 0, host: '127.0.0.1', databasePath: tmp, autoCron: false })
  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const base = `http://127.0.0.1:${addr.port}`
  try {
    const auth = { authorization: 'Bearer ip-test-key', 'content-type': 'application/json' }
    // 建两把子密钥：一把只允许 10.9.9.9，一把只允许本机
    const mk = async (ips: string[]): Promise<string> => {
      const r = (await (await fetch(`${base}/admin/apikeys`, {
        method: 'POST', headers: auth, body: JSON.stringify({ name: 'ip', limits: { allowedIps: ips } }),
      })).json()) as { key?: string }
      assert.ok(typeof r.key === 'string' && r.key !== '')
      return r.key
    }
    const remoteOnly = await mk(['10.9.9.9'])
    const localOnly = await mk(['127.0.0.1'])
    // 伪造白名单 IP：必须被拒（真实对端是 127.0.0.1）
    const forged = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${remoteOnly}`, 'cf-connecting-ip': '10.9.9.9' },
    })
    assert.equal(forged.status, 403)
    // 真实对端在白名单内：放行
    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${localOnly}` } })
    assert.equal(ok.status, 200)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runtime.db.close()
    console.log = originalLog
    if (originalApiKey === undefined) delete process.env.API_KEY
    else process.env.API_KEY = originalApiKey
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
  }
})

test('envFlag：常见的「关」写法都能关掉', async () => {
  const { envFlag } = await import('../src/server/index.js')
  for (const v of ['false', 'FALSE', '0', 'no', 'off', ' False ']) assert.equal(envFlag(v, true), false, v)
  for (const v of ['true', '1', 'yes', 'on']) assert.equal(envFlag(v, false), true, v)
  assert.equal(envFlag(undefined, true), true)
  assert.equal(envFlag('乱写', false), false)
})
