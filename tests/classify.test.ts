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
import { refineModelScoped } from '../src/gateway/server.js'

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

test('🔴 业务码 110 = 日次数上限（不是额度耗尽，绝不能触发 10 小时硬冷却）', async () => {
  // ## 事故复盘（2026-10-21，我自己造成的，代价 10 小时）
  // 用户报「我用不了 qd 渠道了，提示 api 秘钥无效」。
  // 我先把 110 当成 `credit_exhausted`（以为额度用尽），结果：
  //   · `credit_exhausted` → `dimension: 'hard'` ⇒ **硬冷却到次日 04:00**
  //   · 账号被锁 **619 分钟（10.3 小时）**，而实测 `credits: 4565`（充足）
  //   · 用户明确说「我是专业版会员不限制的」—— 他是对的
  //
  // 上游原文是 `Billing daily count exceeded`：关键词 **count（次数）**，不是 credits。
  //
  // ## 现在的定性
  // 110 → `rate_limited`（语义=限流），处置 `dimension: 'soft'`（60 秒）。
  // 且单账号池下 `deferSoft()` 会把它压进 `blame` 延迟记账、全失败则**丢弃**
  // ⇒ 账号不会被锁住。文案也不再是 `auth_error`（避免客户端误报「密钥无效」）。
  const { classify } = await import('../src/upstream/client.ts')

  const body = 'Qoder 返回业务码 110（403）：{"code":"110","message":"Billing daily count exceeded"}'

  // ① 必须是限流语义，不是额度耗尽
  assert.equal(classify(403, body).kind, 'rate_limited')
  assert.equal(classify(403, '{"code":"110"}').kind, 'rate_limited')

  // ② 绝不能是 auth_error（那会让客户端提示「API 密钥无效」）
  assert.notEqual(classify(403, body).kind, 'auth_error', '110 不是鉴权问题')

  // ③ 绝不能是 credit_exhausted（那会触发硬冷却到次日 04:00，锁号 10 小时）
  assert.notEqual(classify(403, body).kind, 'credit_exhausted', '110 不是额度耗尽')

  // ④ 其它码不受影响
  assert.equal(classify(403, '{"code":14018}').kind, 'credit_exhausted', '14018 才是真额度耗尽')
  assert.equal(classify(403, 'Forbidden').kind, 'waf_blocked')
  assert.equal(classify(403, '{"code":11140}').kind, 'request_illegal')
})

test('🔴 业务码 110 必须是**模型级**冷却（不能锁整个账号）', async () => {
  // ## 实测依据（2026-10-21）
  // 同一账号下：`dfmodel` 返回 110（Billing daily count exceeded），
  // 而 `qmodel` / `dmodel` / `auto` / `gmodel` / `mmodel` **全部 200 可用**，
  // `/admin/accounts/balance` 显示 `credits: 4565`（充足）。
  //
  // ⇒ 110 是**模型级**日次数上限。若归成 `dimension: 'soft'`（账号级），
  // 会短暂锁住整个账号，连带影响那些本来能用的模型 —— 那是错的。
  const { refineModelScoped } = await import('../src/gateway/server.ts')
  const r = refineModelScoped('rate_limited', '{"code":"110","message":"Billing daily count exceeded"}')
  assert.equal(r.dimension, 'model', '110 必须只冷却该模型，不能冷却整个账号')
  assert.equal(r.code, 110)

  // 反向守卫：6004 等仍是 model，而真正的账号级限流仍是 soft
  assert.equal(refineModelScoped('rate_limited', '{"code":6004}').dimension, 'model')
  assert.equal(refineModelScoped('rate_limited', '{"code":14003}').dimension, 'model')
  assert.equal(
    refineModelScoped('rate_limited', '{"code":9999,"msg":"too many requests"}').dimension,
    'soft',
    '未识别的码应保守地按账号级处理（不要误判成模型级）',
  )
})

test('🔴 parseBusinessCode 必须同时认「裸数字」与「带引号字符串」两种码形态', async () => {
  // 实测缺陷（2026-10-21）：旧正则只认 `{"code":6004}`，
  // 而 qoder 返回 `{"code":"110"}`（字符串）⇒ 解析成 undefined
  // ⇒ 模型级判据全部失效 ⇒ 错误地按**账号级**冷却，锁住整个账号。
  const { parseBusinessCode } = await import('../src/gateway/server.ts')

  // 两种形态都要认
  assert.equal(parseBusinessCode('{"code":6004}'), 6004, '裸数字')
  assert.equal(parseBusinessCode('{"code":"110"}'), 110, '带引号字符串')
  assert.equal(parseBusinessCode('{"code":"6004","msg":"x"}'), 6004)

  // ⚠️ 带引号时必须要求闭合引号，否则 "11‑128" 会被截成 11（错值）
  assert.equal(parseBusinessCode('{"code":"11‑128"}'), undefined, '非纯数字字符串不得解析出数字')
  assert.equal(parseBusinessCode('{"code":"11-128"}'), undefined)

  // 无 code 时 undefined
  assert.equal(parseBusinessCode('Forbidden'), undefined)
  assert.equal(parseBusinessCode('{"msg":"no code"}'), undefined)
})

test('🔴 双层嵌套 `error.data.code` 必须解析出业务码（workbuddy 14018 实测）', () => {
  // 2026-10-21 实测缺陷：workbuddy 的「额度耗尽」回的是
  //   HTTP 429 {"error":{"data":{"code":14018,"msg":"Credits exhausted…"}}}
  // 顶层没有 code，旧 parseEnvelope 直接返回 undefined
  // ⇒ classify 落到「429 ⇒ rate_limited」⇒ soft(60s)
  // 而 14018 应映射到 credit_exhausted ⇒ hard（冷却到次日 04:00）。
  // 后果：真的没额度的号每 60 秒被重新选中、反复打上游，
  // 面板上却只显示「被限流」。
  const body = '{"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the link below to purchase add-on packs"}}}'

  const env = parseEnvelope(body)
  assert.ok(env !== undefined, '双层嵌套必须被识别成信封')
  assert.equal(env.code, 14018, '业务码必须解析出来')

  const r = classify(429, body)
  assert.equal(r.kind, 'credit_exhausted', '14018 必须归 credit_exhausted（不是 rate_limited）')
  assert.equal(r.code, 14018)
})

test('⚠️ `error.code`（单层）也要认，但不能把「只有 message」误判成信封', () => {
  const single = classify(429, '{"error":{"code":14018,"message":"Credits exhausted"}}')
  assert.equal(single.kind, 'credit_exhausted')

  // 只有 message、没有码 ⇒ 不算信封（否则 isWafBlocked 会放过真 WAF 页）
  assert.equal(parseEnvelope('{"error":{"message":"something went wrong"}}'), undefined,
    '只有 message 的响应不得被当成业务信封')
})

test('🔴 qoder 排队耗尽（10605 + 503）不得判成 server/breaker', () => {
  // 2026-10-21 审查（M3）发现：`qoder.ts` 把排队耗尽的 httpStatus 从 403 改写成 503，
  // 目的是躲开「403 无信封 ⇒ 误判 WAF ⇒ 罚号」。但 503 会落进 classify 的 5xx 分支
  // ⇒ `server` ⇒ `dimension: 'breaker'` ⇒ **3 次熔断一个完全健康的号 30 分钟起**。
  // 等于「修掉一个 60 秒误罚，造出一个 30 分钟误罚」。
  //
  // 修法：报文里带业务码 `{"code":10605}`，并把 10605 登记为 rate_limited
  //（且纳入 refineModelScoped 的模型级判据）。
  const msg = 'Qoder 服务繁忙：排队等待已超过 60 秒（已尝试 4 次，实际等待 45 秒）。'
    + '上游业务码：{"code":10605}。请稍后重试 —— 这是上游排队，不是账号或配置问题。'

  const r = classify(503, msg)
  assert.equal(r.kind, 'rate_limited', '排队必须判 rate_limited，不能是 server')
  assert.equal(r.code, 10605, '业务码必须解析出来')
  assert.notEqual(r.kind, 'server', '⚠️ 判成 server 会喂熔断，把健康号罚掉 30 分钟')

  // 且必须是**模型级**（排队挤的是某个模型，不是账号坏了）
  const scoped = refineModelScoped(r.kind, msg)
  assert.equal(scoped.dimension, 'model', '10605 应归模型级冷却')
})
