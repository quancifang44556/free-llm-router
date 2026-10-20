import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { classify } from '../src/upstream/client.ts'
import { CHANNEL_BLOCKED_HINT, punishmentForStreamError, refineModelScoped } from '../src/gateway/server.ts'

// ⚠️ 与 panel.test.ts 同口径：测试在仓库根目录运行，用相对路径读源码。
const SERVER_RAW = readFileSync('src/gateway/server.ts', 'utf8')
const SERVER = SERVER_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 上游「渠道校验失败」的真实响应体（WorkBuddy 国际版，2026-10-20 实测）。 */
const CHANNEL_BLOCKED_BODY = JSON.stringify({
  code: '11-128',
  msg: 'request illegal',
  requestId: '55563a64-e8d6-43d6-8146-ded857ff769e',
  displayMsg: {
    en: 'Request blocked. Please send it again',
    zh: '请求被拦截，请重新发送',
  },
  displayTips: {
    en: 'This call failed channel verification, possibly because it was not sent from an official client.',
  },
  actions: ['EDIT_INPUT', 'SUBMIT_FEEDBACK'],
})

/**
 * 截出 `handleProviderChat` 的函数体。
 *
 * ⚠️ 不能按 `'export async function handleProviderChat'` 定位 —— 它不是导出的
 *（签名实际是 `async function handleProviderChat(...)`），旧断言因此永远截到空串。
 * ⚠️ 也不能只截到文件末尾：同一文件里还有「当前不支持对话」等**相似文案**，
 * 会让 `includes` 被别处的文案喂饱，测不到真正的 return。
 */
function providerChatBody(): string {
  const sig = 'async function handleProviderChat(input: {'
  const start = SERVER.indexOf(sig)
  assert.ok(start >= 0, '应能找到 handleProviderChat 定义')
  const rest = SERVER.slice(start)
  // 函数结束 = 下一个顶格 `export ` / `async function ` / `function ` 定义
  const stops = ['\nexport ', '\nasync function ', '\nfunction ', '\nconst ', '\n/**'].map((s) => {
    const i = rest.indexOf(s, sig.length)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  })
  return rest.slice(0, Math.min(...stops))
}

test('🔴 11-128 必须归类为 channel_blocked（不是 rate_limited / 账号故障）', () => {
  // ⚠️ 实测踩到的误判：11-128 与 429 一样是 HTTP 4xx，若被归成 rate_limited，
  // 就会给**健康账号**写模型级冷却，并在重新选号时空转一整圈。
  const got = classify(400, CHANNEL_BLOCKED_BODY)
  assert.equal(got.kind, 'channel_blocked', '11-128 是渠道校验失败，不是限流')
})

test('🔴 11-128 同时出现在「限流」路径上时必须回落账号维度（不能写模型冷却）', () => {
  // 网关的限流分支是 `kind === 'rate_limited' ? dimension : ...`。
  // 11-128 的 `displayTips` 里同时含 `switch models`（见 displayMsg 之外的文案），
  // 若 refineModelScoped 仅按文案正则判定，就会把它误判成「模型限流」。
  const withSwitchModels = JSON.stringify({
    code: '11-128',
    msg: 'request illegal',
    displayMsg: { en: 'Channel blocked. Please switch models or retry later' },
  })
  const got = refineModelScoped('rate_limited', withSwitchModels)
  assert.equal(got.dimension, 'soft', '11-128 绝不能被当成模型级限流')
})

test('🔴 渠道校验失败必须只试一次：同一份指纹换号无意义（节省 5 次无谓请求）', () => {
  // 5 个国际版账号全回 11-128 时，原来会逐个账号重试一遍（5 次打上游 + 5 次记冷却）。
  // 渠道指纹与账号无关 ⇒ 第一次撞到就应直接返回真实原因。
  assert.match(
    SERVER,
    /kind\s*===\s*'channel_blocked'[\s\S]{0,200}break/,
    'buddy 路径必须在 channel_blocked 时 break（而不是继续轮换账号）',
  )
})

test('🔴 provider 路径同样不得为空账号池报「没有可用账号」', () => {
  // 实测踩到：5 个国际版账号都因渠道校验被记冷却后，用户再请求会收到
  // 「没有可用账号（请先登录/导入凭据）」—— 而账号其实全都正常，
  // 真正的原因是上游拒绝了我方的请求指纹。必须优先回放最后一次的真实原因。
  const body = providerChatBody()

  // ⚠️ 断言直接对源码原文做「包含」判断，不写正则里的模板占位符转义：
  // 源码里就是字面 `供应商「${provider.name}」请求失败`。
  // 旧断言写的是 `\$\{provider\.name\}` 形态，与源码原文对不上，
  // 外加定位串多了 `export`，两处都让断言永远失败 —— 那是断言过期，不是实现有错。
  assert.ok(
    body.includes('供应商「${provider.name}」请求失败'),
    'provider 路径在有 lastError 时必须回放真实原因（而不是「没有可用账号」）',
  )
  // ⚠️ 反向断言：三元的两支必须都在，缺一支就会退回「一律报没有可用账号」
  assert.ok(body.includes('lastError === undefined'), '三元必须保留「空池兜底」一支')
  assert.ok(body.includes('await describeNoAccount('), '空池时才走 describeNoAccount')
  // ⚠️ 顺序：先判 lastError，再走 describeNoAccount（否则真实原因仍被吞掉）
  assert.ok(
    body.indexOf('lastError === undefined') < body.indexOf('await describeNoAccount('),
    '有 lastError 的分支必须优先于「没有可用账号」',
  )
})

// ───── 2026-10-21：数字形态的拦截码、流内裸码、提示文案 ─────

const BARE_CODE = Number(String.fromCharCode(0x31, 0x31, 0x31, 0x32, 0x38))

test('🔴 数字形态的拦截码同样归类为 channel_blocked（曾落到 unknown ⇒ 3 次熔断健康账号）', () => {
  const body = JSON.stringify({ code: BARE_CODE, msg: 'Illegal API invocation from an unapproved channel' })
  for (const status of [400, 403, 502]) {
    assert.equal(classify(status, body).kind, 'channel_blocked', `HTTP ${status}`)
  }
  // 字符串形态仍认（不赌哪种）
  assert.equal(classify(400, CHANNEL_BLOCKED_BODY).kind, 'channel_blocked')
  // 相邻码不受影响
  assert.equal(classify(400, JSON.stringify({ code: 11140, msg: 'illegal request' })).kind, 'request_illegal')
})

test('流内错误：裸码文案也按渠道拦截软冷却', () => {
  assert.equal(punishmentForStreamError('upstream_error code=' + String(BARE_CODE)), 'soft')
  assert.equal(punishmentForStreamError('code 11148'), 'breaker', '相邻码不是渠道拦截')
  assert.equal(
    punishmentForStreamError('流传输中断：reset ts=17' + String(BARE_CODE) + '000'),
    'breaker',
    '长数字串里碰巧含这 5 位不算渠道拦截',
  )
  // 数字码 + 「switch models」文案落到限流路径时，同样不能写模型冷却
  const rl = refineModelScoped('rate_limited', JSON.stringify({ code: BARE_CODE, displayMsg: { en: 'Please switch models' } }))
  assert.equal(rl.dimension, 'soft')
  assert.ok(CHANNEL_BLOCKED_HINT.includes('与账号无关'))
  // 提示里不能出现拦截码本身（客户端可能把它原样贴回下一轮请求）
  assert.ok(!CHANNEL_BLOCKED_HINT.includes(String(BARE_CODE)))
})
