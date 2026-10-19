/**
 * Meoo（秒悟）供应商单测。
 *
 * 覆盖：
 * 1. 纯 Web 标准验证（0 node: 内部模块违规引入，无 Buffer 违规使用）；
 * 2. 供应商声明与能力声明（loginBlockedReason、checkin 等）；
 * 3. matchesShape 判定边界与防误判（不抢占其它供应商的凭据）；
 * 4. 凭据解析（API Key、OAuth、环境变量格式、JSON 文件）；
 * 5. 模型目录（listModels 与 getBuiltinModels、前缀路由）；
 * 6. Chat 推理流式/非流式透传与请求头；
 * 7. Balance 余额查询与字段映射；
 * 8. Checkin 签到获得额度与幂等判定；
 * 9. OAuth Token 刷新与 shouldRotate 换号判据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  meooProvider,
  looksLikeMeooCredential,
  parseCredential,
  listModels,
  chat,
  balance,
  checkin,
  refresh,
  shouldRotate,
  MEOO_PROVIDER_ID,
  MEOO_CHAT_COMPLETIONS_URL,
  MEOO_POINTS_URL,
  MEOO_ENTITLEMENT_INIT_URL,
  MEOO_OAUTH_TOKEN_URL,
  MEOO_MODELS,
  MEOO_DEFAULT_MODEL,
} from '../src/providers/meoo.js'
import {
  PROVIDERS,
  DEFAULT_PROVIDER,
  providerIds,
  findProvider,
  requireProvider,
  parseCredentialAnywhere,
  getBuiltinModels,
} from '../src/providers/index.js'
import { ProviderError, splitModelName, type ProviderCredential } from '../src/providers/types.js'

test('⚠️ 零 node: 导入（Workers 只能跑纯 Web 标准）', () => {
  const src = readFileSync('src/providers/meoo.ts', 'utf8')
  const imports = src.split('\n').filter((line) => /^\s*import\b/.test(line))
  for (const line of imports) {
    assert.ok(!line.includes('node:'), `meoo.ts 不得 import node: 模块：${line}`)
  }

  // 剥除注释后检查不得出现 Buffer 构造或引用
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.ok(!/\bBuffer\b/.test(code), 'meoo.ts 不得使用 Node 的 Buffer（注释除外）')
})

test('meooProvider: 注册与能力声明如实声明', () => {
  assert.equal(meooProvider.id, MEOO_PROVIDER_ID)
  assert.equal(meooProvider.name, 'Meoo (秒悟)')

  // 处于 PROVIDERS 列表的末尾，不挤动默认供应商
  const found = findProvider('meoo')
  assert.notEqual(found, undefined)
  assert.equal(PROVIDERS[PROVIDERS.length - 1]?.id, 'meoo')
  assert.equal(DEFAULT_PROVIDER, 'buddy')

  // 能力声明
  const caps = meooProvider.capabilities
  assert.equal(caps.login, false, 'login 必须为 false（官方 CLI 依赖 127.0.0.1 本地回调）')
  assert.ok(
    (caps.loginBlockedReason ?? '').includes('127.0.0.1')
    || (caps.loginBlockedReason ?? '').includes('端口')
    || (caps.loginBlockedReason ?? '').includes('回调'),
    'loginBlockedReason 必须解释本地回调原因',
  )
  assert.equal(caps.listModels, true)
  assert.equal(caps.chat, true)
  assert.equal(caps.balance, true)
  assert.equal(caps.checkin, true)
})

test('matchesShape 边界与防误判：准确命中 Meoo 凭据且绝不抢占其他渠道', () => {
  // ── 正向命中 ──
  // 1. 显式声明 provider
  assert.equal(looksLikeMeooCredential({ provider: 'meoo', apiKey: 'sk-test' }), true)
  // 2. 独有 projectUrlId 字段
  assert.equal(looksLikeMeooCredential({ projectUrlId: 'chat_sample_123', apiKey: 'sk-test' }), true)
  assert.equal(looksLikeMeooCredential({ project_url_id: 'chat_sample_123', apiKey: 'sk-test' }), true)
  // 3. Meoo 环境变量前缀与独有键名
  assert.equal(looksLikeMeooCredential({ MEOO_PROJECT_API_KEY: 'sk-project-key' }), true)
  assert.equal(looksLikeMeooCredential({ MEOO_API_KEY: 'sk-key' }), true)
  assert.equal(looksLikeMeooCredential({ MEOO_TOKEN: 'meoo_ak_xxx' }), true)
  assert.equal(looksLikeMeooCredential({ meooApiKey: 'sk-key' }), true)
  // 4. 域名与独有 Token 前缀
  assert.equal(looksLikeMeooCredential({ apiBaseUrl: 'https://meoo.com', apiKey: 'sk-123' }), true)
  assert.equal(looksLikeMeooCredential({ apiKey: 'meoo_ak_test_token' }), true)
  assert.equal(looksLikeMeooCredential({ scope: 'cli.compat', accessToken: 'some_oauth_tok' }), true)
  // 5. 嵌套凭据
  assert.equal(looksLikeMeooCredential({ credential: { projectUrlId: 'chat_proj' } }), true)

  // ── 严格排除其它供应商（防误判与抢凭据）──
  assert.equal(looksLikeMeooCredential({}), false)
  // WorkBuddy 凭据
  assert.equal(looksLikeMeooCredential({ uid: 'u1', accessToken: 't1', domain: 'www.workbuddy.ai' }), false)
  // Buddy 凭据
  assert.equal(looksLikeMeooCredential({ uid: 'u1', accessToken: 't1', domain: 'copilot.tencent.com' }), false)
  // Cline 凭据
  assert.equal(looksLikeMeooCredential({ accountId: 'acc_1', accessToken: 'workos:token' }), false)
  // Qoder 凭据
  assert.equal(looksLikeMeooCredential({ security_oauth_token: 'tok', domain: 'qoder.aliyun.com' }), false)
  // LobsterAI 凭据
  assert.equal(looksLikeMeooCredential({ uuid: 'uuid_1', access_token: 'tok' }), false)
  // Raccoon 凭据
  assert.equal(looksLikeMeooCredential({ token: 'tok', user_id: '12345' }), false)
  // Trae 凭据
  assert.equal(looksLikeMeooCredential({ machine_id: 'mid', access_token: 'tok' }), false)
  // 通用 OpenCode API Key（无任何 meoo 标记，必须由 OpenCode 处理，不可被 Meoo 抢占）
  assert.equal(looksLikeMeooCredential({ apiKey: 'sk-opencode-generic-key' }), false)
})

test('凭据解析：支持 API Key 字符串、OAuth 结构体与环境变量 JSON', () => {
  // 1. 裸字符串 API Key
  const cred1 = parseCredential('sk-meoo-test-123')
  assert.equal(cred1.provider, 'meoo')
  assert.equal(cred1.accessToken, 'sk-meoo-test-123')
  assert.ok(cred1.uid.startsWith('meoo-'))
  assert.equal(cred1.extras['credentialType'], 'api_key')

  // 2. 官方 CLI 导出的完整 credentials.json（OAuth 形态）
  const oauthJson = JSON.stringify({
    version: 2,
    credentialType: 'oauth',
    apiBaseUrl: 'https://meoo.com',
    accessToken: 'meoo_access_token_val',
    refreshToken: 'meoo_refresh_token_val',
    accessTokenExpiresAt: 1729000000000,
    scope: 'cli.compat',
    openid: 'openid_alice',
    userId: '10086',
    username: 'alice',
    projectUrlId: 'proj_xyz',
    tenantId: '999',
    edition: 'personal',
  })
  const cred2 = parseCredential(oauthJson)
  assert.equal(cred2.provider, 'meoo')
  assert.equal(cred2.accessToken, 'meoo_access_token_val')
  assert.equal(cred2.refreshToken, 'meoo_refresh_token_val')
  assert.equal(cred2.expiresAt, 1729000000000)
  assert.equal(cred2.uid, '10086')
  assert.equal(cred2.nickname, 'alice')
  assert.equal(cred2.extras['projectUrlId'], 'proj_xyz')
  assert.equal(cred2.extras['tenantId'], '999')
  assert.equal(cred2.extras['edition'], 'personal')
  assert.equal(cred2.extras['credentialType'], 'oauth')

  // 3. 环境变量键值形态
  const cred3 = parseCredential({
    MEOO_PROJECT_API_KEY: 'sk-meoo-project-secret',
    MEOO_API_URL: 'https://meoo.com',
  })
  assert.equal(cred3.provider, 'meoo')
  assert.equal(cred3.accessToken, 'sk-meoo-project-secret')
  assert.equal(cred3.extras['credentialType'], 'api_key')

  // 4. 异常输入校验
  assert.throws(
    () => parseCredential('   '),
    (err: unknown) => err instanceof ProviderError && /不能为空/.test(err.message),
  )
  assert.throws(
    () => parseCredential({}),
    (err: unknown) => err instanceof ProviderError && /缺少有效 apiKey 或 accessToken/.test(err.message),
  )
})

test('parseCredentialAnywhere 集成：自动识别与显式声明', () => {
  // 1. 带 meoo_ak_ 前缀的裸字符串通过 bareStringPattern 自动识别为 Meoo
  const r1 = parseCredentialAnywhere('meoo_ak_test_token_88888')
  assert.equal(r1.provider.id, 'meoo')
  assert.equal(r1.credential.accessToken, 'meoo_ak_test_token_88888')

  // 2. 携带 Meoo 字段的对象被自动识别为 Meoo
  const r2 = parseCredentialAnywhere({
    MEOO_PROJECT_API_KEY: 'sk-project-key',
  })
  assert.equal(r2.provider.id, 'meoo')
  assert.equal(r2.credential.accessToken, 'sk-project-key')

  // 3. 通用 sk- 字符串不会被 Meoo 抢占（按 pattern 预筛，由 opencode 认领）
  const r3 = parseCredentialAnywhere('sk-generic-user-key-12345')
  assert.equal(r3.provider.id, 'opencode')

  // 4. 显式指定 meoo 时可解析任意自定义 API Key
  const r4 = parseCredentialAnywhere('custom-meoo-secret-key', 'meoo')
  assert.equal(r4.provider.id, 'meoo')
  assert.equal(r4.credential.accessToken, 'custom-meoo-secret-key')
})

test('模型目录与内置模型：覆盖核心五大模型并支持无歧义路由', async () => {
  const dummyCred: ProviderCredential = {
    provider: 'meoo',
    uid: 'u',
    accessToken: 'k',
    refreshToken: '',
    expiresAt: 0,
    nickname: 'n',
    extras: {},
  }
  const models = await listModels(dummyCred, AbortSignal.timeout(1000))
  const modelIds = models.map((m) => m.id)

  assert.deepEqual(modelIds, [
    'qwen3.6-plus',
    'deepseek-v3.2',
    'kimi-k2.5',
    'glm-5',
    'MiniMax-M2.5',
  ])

  for (const m of models) {
    assert.ok(m.contextWindow > 0, `${m.id} contextWindow 必须大于 0`)
    assert.ok(m.maxOutput > 0, `${m.id} maxOutput 必须大于 0`)
    assert.equal(typeof m.supportsImage, 'boolean')
    assert.equal(m.isFree, true)
  }

  // 默认模型为 qwen3.6-plus
  const defaultModel = models.find((m) => m.id === MEOO_DEFAULT_MODEL)
  assert.notEqual(defaultModel, undefined)
  assert.ok(defaultModel?.name.includes('默认'))

  // 检查 getBuiltinModels 内置模型
  const builtins = getBuiltinModels()
  const meooBuiltins = builtins.filter((b) => b.provider === 'meoo')
  assert.equal(meooBuiltins.length, 5)
  for (const id of modelIds) {
    const found = meooBuiltins.find((b) => b.id === `meoo/${id}`)
    assert.notEqual(found, undefined, `getBuiltinModels 应包含 meoo/${id}`)
    assert.equal(found?.providerName, 'Meoo (秒悟)')
    assert.equal(found?.isBuiltin, true)
  }

  // splitModelName 路由测试
  const splitRes = splitModelName('meoo/qwen3.6-plus', providerIds(), DEFAULT_PROVIDER)
  assert.equal(splitRes.provider, 'meoo')
  assert.equal(splitRes.model, 'qwen3.6-plus')
})

test('Chat 推理：正确拼装 URL、Headers 并透传请求体（含流式与 OneDay-App-Id）', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedMethod = ''
  let capturedHeaders: Record<string, string> = {}
  let capturedBody = ''

  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    capturedUrl = String(url)
    capturedMethod = init.method ?? 'GET'
    capturedHeaders = Object.fromEntries(
      init.headers instanceof Headers
        ? init.headers.entries()
        : Object.entries((init.headers as Record<string, string>) || {}),
    )
    capturedBody = String(init.body ?? '')
    return new Response(JSON.stringify({ id: 'chatcmpl-1', choices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  try {
    const cred: ProviderCredential = {
      provider: 'meoo',
      uid: 'u1',
      accessToken: 'sk-test-token-meoo',
      refreshToken: '',
      expiresAt: 0,
      nickname: 'n',
      extras: { projectUrlId: 'chat_project_999' },
    }

    // 1. 非流式对话
    const res = await chat(cred, {
      model: 'deepseek-v3.2',
      body: { messages: [{ role: 'user', content: 'hello' }], temperature: 0.7 },
      signal: AbortSignal.timeout(5000),
    })

    assert.equal(res.status, 200)
    assert.equal(capturedUrl, MEOO_CHAT_COMPLETIONS_URL)
    assert.equal(capturedMethod, 'POST')
    assert.equal(capturedHeaders['Authorization'], 'Bearer sk-test-token-meoo')
    assert.equal(capturedHeaders['X-Meoo-Client'], 'cli')
    assert.equal(capturedHeaders['OneDay-App-Id'], 'chat_project_999')
    assert.equal(capturedHeaders['Content-Type'], 'application/json')
    assert.equal(capturedHeaders['Accept'], undefined)

    const parsedBody = JSON.parse(capturedBody)
    assert.equal(parsedBody.model, 'deepseek-v3.2')
    assert.equal(parsedBody.temperature, 0.7)

    // 2. 流式对话（stream: true）
    await chat(cred, {
      model: 'qwen3.6-plus',
      body: { messages: [{ role: 'user', content: 'stream test' }], stream: true },
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(capturedHeaders['Accept'], 'text/event-stream')

    // 3. 上游 429 报错重试判定
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    let caughtError: Error | undefined
    try {
      await chat(cred, {
        model: 'qwen3.6-plus',
        body: { messages: [] },
        signal: AbortSignal.timeout(5000),
      })
    } catch (err) {
      caughtError = err as Error
    }
    assert.ok(caughtError instanceof ProviderError)
    assert.equal((caughtError as ProviderError).httpStatus, 429)
    assert.equal((caughtError as ProviderError).retryable, true)
    assert.ok(caughtError.message.includes('rate limit reached'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Balance 余额查询：正确解析可用积分与累计消耗', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedHeaders: Record<string, string> = {}

  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    capturedUrl = String(url)
    capturedHeaders = Object.fromEntries(
      init.headers instanceof Headers
        ? init.headers.entries()
        : Object.entries((init.headers as Record<string, string>) || {}),
    )
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          account: {
            availableBalance: 42000,
            totalGranted: 50000,
            totalConsumed: 8000,
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  try {
    const cred: ProviderCredential = {
      provider: 'meoo',
      uid: 'u1',
      accessToken: 'sk-points-key',
      refreshToken: '',
      expiresAt: 0,
      nickname: 'n',
      extras: {},
    }

    const b = await balance(cred, AbortSignal.timeout(5000))
    assert.equal(capturedUrl, MEOO_POINTS_URL)
    assert.equal(capturedHeaders['Authorization'], 'Bearer sk-points-key')
    assert.equal(capturedHeaders['X-Meoo-Client'], 'cli')

    assert.equal(b.total, 42000)
    assert.equal(b.expiring, 0)
    assert.equal(b.earliestExpiry, 0)
    assert.equal(b.packages.length, 3)
    assert.equal(b.packages[0]?.name, '可用积分')
    assert.equal(b.packages[0]?.amount, 42000)
    assert.equal(b.packages[1]?.name, '累计获得积分')
    assert.equal(b.packages[1]?.amount, 50000)
    assert.equal(b.packages[2]?.name, '累计消耗积分')
    assert.equal(b.packages[2]?.amount, 8000)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Checkin 每日签到：签到成功领取与重复签到幂等处理', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let nextResponseJson = {}

  globalThis.fetch = (async (url: string | URL) => {
    capturedUrl = String(url)
    return new Response(JSON.stringify(nextResponseJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  try {
    const cred: ProviderCredential = {
      provider: 'meoo',
      uid: 'u1',
      accessToken: 'tok-checkin-test',
      refreshToken: '',
      expiresAt: 0,
      nickname: 'n',
      extras: {},
    }

    // 1. 今日首次签到：dailyLoginGranted = true
    nextResponseJson = {
      success: true,
      data: {
        dailyLoginGranted: true,
        dailyLoginGrantAmount: 2000,
      },
    }
    const res1 = await checkin(cred, AbortSignal.timeout(5000))
    assert.equal(capturedUrl, MEOO_ENTITLEMENT_INIT_URL)
    assert.equal(res1.alreadyDone, false)
    assert.equal(res1.gained, 2000)
    assert.ok(res1.detail.includes('2000'))

    // 2. 今日已领过：dailyLoginGranted = false（幂等成功，不报错）
    nextResponseJson = {
      success: true,
      data: {
        dailyLoginGranted: false,
        dailyLoginGrantAmount: 2000,
      },
    }
    const res2 = await checkin(cred, AbortSignal.timeout(5000))
    assert.equal(res2.alreadyDone, true)
    assert.equal(res2.gained, 0)
    assert.ok(res2.detail.includes('已完成'))
    assert.ok(res2.detail.includes('未重复发放'))

    // 3. 上游 401 鉴权失败：必须抛出 ProviderError
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ message: 'invalid_token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    let checkinError: Error | undefined
    try {
      await checkin(cred, AbortSignal.timeout(5000))
    } catch (err) {
      checkinError = err as Error
    }
    assert.ok(checkinError instanceof ProviderError)
    assert.equal((checkinError as ProviderError).httpStatus, 401)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OAuth Token 刷新与 shouldRotate 换号判据', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody = ''

  globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    capturedBody = String(init.body ?? '')
    return new Response(
      JSON.stringify({
        access_token: 'new_access_token_666',
        refresh_token: 'new_refresh_token_777',
        expires_in: 7200,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  try {
    const cred: ProviderCredential = {
      provider: 'meoo',
      uid: 'u_oauth',
      accessToken: 'old_access_token',
      refreshToken: 'valid_refresh_token',
      expiresAt: Date.now() - 1000,
      nickname: 'oauth_user',
      extras: { apiBaseUrl: 'https://meoo.com' },
    }

    const refreshed = await refresh(cred, AbortSignal.timeout(5000))
    assert.equal(refreshed.accessToken, 'new_access_token_666')
    assert.equal(refreshed.refreshToken, 'new_refresh_token_777')
    assert.ok(refreshed.expiresAt > Date.now())
    assert.ok(capturedBody.includes('grant_type=refresh_token'))
    assert.ok(capturedBody.includes('refresh_token=valid_refresh_token'))

    // 缺少 refreshToken 时禁止续期并给出解释
    await assert.rejects(
      async () => refresh({ ...cred, refreshToken: '' }, AbortSignal.timeout(5000)),
      (err: unknown) => err instanceof ProviderError && /缺少 refreshToken/.test(err.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  // shouldRotate 测试
  assert.equal(shouldRotate(429, ''), true)
  assert.equal(shouldRotate(402, ''), true)
  assert.equal(shouldRotate(400, 'insufficient_quota'), true)
  assert.equal(shouldRotate(200, '积分不足，请充值'), true)
  assert.equal(shouldRotate(400, 'invalid_param'), false)
  assert.equal(shouldRotate(500, 'internal_error'), false)
})
