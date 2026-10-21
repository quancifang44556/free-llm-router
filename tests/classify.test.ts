/**
 * 上游错误分类的单测。
 *
 * ## 这些用例为什么重要
 *
 * 分类错误的代价是**不对称**的（AGENTS.md §6.7）：
 * - 把「临时限流」当「账号死亡」→ 误杀健康账号；
 * - 把「WAF 拦截」当「凭据过期」→ 排查方向完全错。
 *
 * 尤其 **WAF 判据**：本项目出口验证探针**真的踩过**这个坑 ——
 * 最初把「401 无信封」也当 WAF，而实测 APISIX 对缺凭据就是回 401。
 * 下面的用例把这个边界钉死。
 *
 * 运行：`node --test --experimental-strip-types tests/classify.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, isWafBlocked, parseEnvelope, shouldPunish, shouldRotate, CHANNEL_BLOCKED_CODE } from '../src/upstream/client.ts'

/** 真实抓到的 401 HTML（APISIX / openresty）。 */
const HTML_401 =
  '<html>\r\n<head><title>401 Authorization Required</title></head>\r\n<body>\r\n<center><h1>401 Authorization Required</h1></center>\r\n<hr><center>openresty</center>\r\n</body>\r\n</html>\r\n'

/** 真实的 WAF 403 拦截页形态。 */
const HTML_403 = '<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body><center><h1>403 Forbidden</h1></center></body></html>'

/** 真实抓到的成功信封。 */
const OK_200 =
  '{"code":0,"msg":"OK","requestId":"30a5de2f","data":{"state":"0443bd6c","authUrl":"https://copilot.tencent.com/login"}}'

test('🔴 畸形字符串码**不得**被当成业务信封（否则会把 WAF 误判成 auth_error）', () => {
  // ## 这条是红队实测发现的真缺陷（2026-10-19）
  //
  // 为了让渠道拦截码 "11-128" 被认出，\`parseEnvelope\` 一度放宽成
  // 「任何字符串都算 code」⇒ 任意畸形体（\`{"code":"abc"}\`）都变成合法信封。
  //
  // 后果链（实测）：
  //   403 + {"code":"abc"}
  //     改动前：Number("abc")=NaN → 不是信封 → **waf_blocked**（正确）
  //     放宽后：算信封 → 落进 401/403 分支 → **auth_error**
  //   而 auth_error 的 shouldRotate = true ⇒ **白换号**，还触发不必要的凭据续期。
  //
  // ⇒ 收紧为「数字」或「形如错误码的字符串」（\`11-128\` / \`6004\`），其余一律当没有码。
  const REAL = String.fromCharCode(0x31, 0x31, 0x2d, 0x31, 0x32, 0x38)

  // ① 真码必须仍被认出（否则修过头，渠道拦截又修不回来了）
  assert.equal(classify(403, JSON.stringify({ code: REAL, msg: 'x' })).kind, 'channel_blocked')
  assert.equal(classify(429, JSON.stringify({ code: '6004', msg: 'x' })).kind, 'rate_limited')

  // ② 畸形字符串码一律**不算信封** ⇒ 403 应落回 waf_blocked
  for (const bad of ['abc', 'xyz-1', '1-2-3', 'code', '{}']) {
    const body = JSON.stringify({ code: bad, msg: 'x' })
    assert.equal(
      classify(403, body).kind,
      'waf_blocked',
      `畸形码 "${bad}" 不得被当成信封（403 应落回 WAF，而不是 auth_error）`,
    )
    assert.equal(parseEnvelope(body), undefined, `畸形码 "${bad}" 必须返回 undefined`)
  }

  // ③ 空串 / 纯空白 / null 同样不算
  for (const empty of ['', '   ']) {
    assert.equal(parseEnvelope(JSON.stringify({ code: empty })), undefined)
  }
  assert.equal(parseEnvelope(JSON.stringify({ code: null })), undefined)
})

test('parseEnvelope：认数字 code，也认**字符串 code**（渠道拦截码就是字符串）', () => {
  // ## 🔴 本测试的期望值曾把缺陷锁死（2026-10-19 修复）
  //
  // 原断言写的是 `assert.equal(parseEnvelope('{"code":"abc"}'), undefined)`，
  // 理由是「code 必须能转成数字」。但**上游渠道拦截码就是字符串**：
  // `{"code":"11‑128","msg":"Illegal API invocation from an unapproved channel"}`。
  //
  // 于是那条「必须可转成数字」的规则把**真实报文判成「不是信封」** ⇒
  // 落到「无信封 + 403」分支 ⇒ 判成 `waf_blocked` ⇒ 触发 IP 级封禁
  // ⇒ 凑够 2 个账号就让整个服务停服 60 秒。
  //
  // ⇒ 新规则：**非空字符串码一律保留**。
  //    ⚠️ 但仍要求「非空」—— 空串/纯空白说明上游回了个畸形体，
  //    不能当合法信封（否则会把网关的错误页也当业务响应）。
  assert.notEqual(parseEnvelope(OK_200), undefined)
  assert.equal(parseEnvelope(HTML_401), undefined, 'HTML 不是信封')
  assert.equal(parseEnvelope(''), undefined)
  assert.equal(parseEnvelope('[]'), undefined)

  // 数字码
  assert.notEqual(parseEnvelope('{"code":0}'), undefined, '数字 code 应接受')
  assert.notEqual(parseEnvelope('{"code":"0"}'), undefined, '字符串数字应接受')

  // 字符串码：**必须**接受（渠道拦截码是字符串）
  const FP = String.fromCharCode(0x31, 0x31, 0x2d, 0x31, 0x32, 0x38)
  const channelBody = JSON.stringify({ code: FP, msg: 'Illegal API invocation from an unapproved channel' })
  assert.notEqual(parseEnvelope(channelBody), undefined, '字符串渠道拦截码必须被认出')
  assert.equal(parseEnvelope(channelBody)?.code, CHANNEL_BLOCKED_CODE)

  // 畸形体：空串 / 纯空白 / 非字符串非数字 都**不是**信封
  assert.equal(parseEnvelope('{"code":""}'), undefined, '空串码不是信封')
  assert.equal(parseEnvelope('{"code":"   "}'), undefined, '纯空白码不是信封')
  assert.equal(parseEnvelope('{"code":null}'), undefined, 'null 不是信封')
})

test('⚠️ WAF 判据：只有「403 + 无信封」才算', () => {
  assert.equal(isWafBlocked(403, HTML_403), true)
  assert.equal(isWafBlocked(403, ''), true)
  assert.equal(isWafBlocked(403, 'Forbidden'), true)
})

test('⚠️ 401 不是 WAF —— 探针踩过的真实误判', () => {
  assert.equal(isWafBlocked(401, HTML_401), false)
  assert.equal(classify(401, HTML_401).kind, 'auth_error')
})

test('⚠️ 403 但带业务信封不是 WAF（如 11140）', () => {
  const body = '{"code":11140,"msg":"request illegal"}'
  assert.equal(isWafBlocked(403, body), false)
  assert.equal(classify(403, body).kind, 'request_illegal')
})

test('成功信封 → code 0 不被当作错误类别', () => {
  const r = classify(200, OK_200)
  assert.equal(r.code, 0)
})

test('已知业务码映射到正确类别', () => {
  const cases: Array<[number, string]> = [
    [6004, 'rate_limited'],
    [11102, 'model_unavailable'],
    [14018, 'credit_exhausted'],
    [14017, 'rate_limited'],
    [11140, 'request_illegal'],
    [12153, 'session_dead'],
    [11115, 'context_exceeded'],
    [11135, 'image_invalid'],
    [10001, 'already_done'],
    [1001, 'already_done'],
  ]
  for (const [code, kind] of cases) {
    const r = classify(200, `{"code":${code},"msg":"x"}`)
    assert.equal(r.kind, kind, `code ${code} 应映射为 ${kind}`)
  }
})

test('5xx → server（可重试且喂熔断）', () => {
  assert.equal(classify(500, 'oops').kind, 'server')
  assert.equal(classify(503, '{"code":10000,"msg":"API request failed"}').kind, 'server')
})

test('402 → credit_exhausted（硬冷却至次日 04:00）', () => {
  assert.equal(classify(402, '').kind, 'credit_exhausted')
})

test('404 → not_found（可能需换 fallback 路径）', () => {
  assert.equal(classify(404, '').kind, 'not_found')
})

test('⚠️ 参数类错误不换号（换号会重放同样的非法请求）', () => {
  assert.equal(shouldRotate('context_exceeded'), false)
  assert.equal(shouldRotate('image_invalid'), false)
  assert.equal(shouldRotate('network'), false)
  // ⚠️ `request_illegal`（11140）也**不换号**，但理由不是「参数类」：
  //    它是账号级限制，换号改变不了被盯上的**设备**，只会连坐更多号
  //    （workbuddy2api-hub #422：一个请求遍历整池，7 个号一次任务全被封）。
  //    见 safety-config.test.ts 里的专门用例与推理演进。
  assert.equal(shouldRotate('request_illegal'), false)
})

test('限流/余额/鉴权类错误应换号', () => {
  assert.equal(shouldRotate('rate_limited'), true)
  assert.equal(shouldRotate('credit_exhausted'), true)
  assert.equal(shouldRotate('auth_error'), true)
  assert.equal(shouldRotate('session_dead'), true)
})

test('⚠️ 11115/11135 不罚号（是请求的问题，不是账号的问题）', () => {
  assert.equal(shouldPunish('context_exceeded'), false)
  assert.equal(shouldPunish('image_invalid'), false)
})

test('⚠️ 网络层错误不罚号（抖动量，不构成「这个号坏了」的证据）', () => {
  assert.equal(shouldPunish('network'), false)
  assert.equal(shouldRotate('network'), false, '网络错误也不该立刻换号 —— 可能是本地出口抖动')
})

test('应罚号：限流/余额/WAF/session 死亡/5xx', () => {
  assert.equal(shouldPunish('rate_limited'), true)
  assert.equal(shouldPunish('credit_exhausted'), true)
  assert.equal(shouldPunish('waf_blocked'), true)
  assert.equal(shouldPunish('session_dead'), true)
  assert.equal(shouldPunish('server'), true)
})

test('⚠️ auth_error 不罚号 —— 续期凭据即可，不该惩罚账号', () => {
  assert.equal(shouldPunish('auth_error'), false)
})

test('⚠️ 关键回归：parseEnvelope 与 classify 必须能识别带 data: 前缀的 SSE 错误帧', () => {
  const sseSingle = 'data: {"code":6004,"msg":"模型限流，建议切换其他模型"}'
  const env1 = parseEnvelope(sseSingle)
  assert.notEqual(env1, undefined, 'parseEnvelope 必须能剥离单行 data: 前缀')
  assert.equal(env1?.code, 6004)
  assert.equal(classify(200, sseSingle).kind, 'rate_limited')

  const sseMulti = ': heartbeat\n\ndata: {"code":6004,"msg":"模型限流"}\n\n'
  const env2 = parseEnvelope(sseMulti)
  assert.notEqual(env2, undefined, 'parseEnvelope 必须能从多行 SSE 中提取数据帧')
  assert.equal(env2?.code, 6004)
  assert.equal(classify(200, sseMulti).kind, 'rate_limited')
  assert.equal(shouldRotate(classify(200, sseMulti).kind), true, '限流帧必须触发换号重试')
})
