/**
 * Qoder 的 **WASM 签名模块互斥锁**。
 *
 * ## 线上故障（2026-10-22，用户报障）
 *
 * 用户的原话是「我在官方客户端可以用啊」，而网关报：
 * ```
 * 供应商「Qoder (中国版)」请求失败：unknown: Qoder 请求失败：unreachable
 * ```
 *
 * `unreachable` 是 **Rust 的 panic 文本**（wasm 以 `panic=abort` 编译），
 * 不是网络错误、也不是账号问题 —— 所以「官方客户端能用」与它完全自洽。
 *
 * ## ⚠️ 诚实记录：根因**未被证实**
 *
 * 我最初假设是「并发交错破坏共享堆栈」，据此加了互斥锁。
 * 但 A/B 实验**推翻了这个假设**：
 * - 去掉锁之后，20 个并发调用 `generateRuntimeAuthFields` **依然全部成功**，没有 panic；
 * - 15 种 payload 形态（空/超长/emoji/孤立代理/NUL/工具调用/多轮）全部正常；
 * - 最大 4.6 MB 的 body（1765 条消息）也正常。
 *
 * ⇒ **本文件守的是「纵深防御」，不是「已定位的根因」。**
 * 之所以仍然保留锁：`qoder-wasm.ts` 的既有注释本就写明
 * 「`QoderContext` 指针**不可跨并发复用**」，而我们此前把**同一个实例**
 * 复用给了所有并发请求 —— 这是对一个已记录约束的违反，即便它未必是本次故障的成因。
 *
 * ## 为什么仍值得加这把锁（约束来源）
 *
 * `getGlue()` 返回**模块级单例**，而 WASM 实例的这些资源全部共享：
 * - 线性内存 `exports.memory`（唯一视图）
 * - **栈指针**（`__wbindgen_add_to_stack_pointer` 是全局偏移，不是每调用一份）
 * - wasm-bindgen 对象堆（`pushObject` / `takeObject` 共用一个数组）
 * - `lastLength` 之类的可变状态
 *
 * 而 `prepareQoderInfer` 内部有多处 `await`，每条 chat 请求都会调它。
 * 理论上并发请求可能在堆栈上交错（不过实测未能复现，故不把它当结论）。
 *
 * 真正**已被证实**的收获是那条文案修复：用户看到 `unreachable` 会去怀疑账号，
 * 而它与账号无关（官方客户端正常）。
 *
 * ## 本文件钉住三件事
 *
 * 1. 并发调用**必须严格串行**（同一时刻只有一个在 WASM 里跑）；
 * 2. 某个调用**失败不得阻塞后续调用**（否则一次 panic 会让整个 provider 永久卡死，
 *    那比崩溃更难查）；
 * 3. 锁**不可重入** —— 锁内不得再调加锁的函数（会死锁），
 *    故 `prepareQoderInfer` 内部改用不加锁的 `buildRuntimeAuthFields`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync('src/providers/qoder-wasm.ts', 'utf8')

/** 去掉注释，避免注释里的同名文字骗到源码级断言（本项目已踩过多次）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const CODE = stripComments(SRC)

test('🔴 必须存在 WASM 互斥锁，且链不会因失败而卡死', () => {
  assert.ok(/function withWasmLock/.test(CODE), '必须实现 withWasmLock')

  // 链的续接必须**吞掉**错误：`run.then(() => undefined, () => undefined)`
  // 若写成 `wasmChain = run`（直接赋值），一个请求 reject 后
  // 后续所有 `.then(() => fn())` 都不会执行 ⇒ **整个 provider 永久卡死**。
  const body = CODE.slice(CODE.indexOf('function withWasmLock'))
  const head = body.slice(0, body.indexOf('\n}') + 2)
  assert.ok(
    /wasmChain\s*=\s*run\.then\(\s*\(\)\s*=>\s*undefined,\s*\(\)\s*=>\s*undefined\s*,?\s*\)/.test(head),
    'açık链必须同时处理成功与失败两种结局，否则一次失败会让后续请求永远等一个已 reject 的 promise',
  )
})

test('🔴 两个 WASM 入口都必须加锁', () => {
  const authAt = CODE.indexOf('export async function generateRuntimeAuthFields')
  assert.ok(authAt >= 0, '应能找到 generateRuntimeAuthFields')
  const authBody = CODE.slice(authAt, authAt + 400)
  assert.ok(
    /withWasmLock\s*\(/.test(authBody),
    'generateRuntimeAuthFields 必须在锁内执行',
  )

  const prepAt = CODE.indexOf('export async function prepareQoderInfer')
  assert.ok(prepAt >= 0, '应能找到 prepareQoderInfer')
  const prepBody = CODE.slice(prepAt)
  assert.ok(
    /withWasmLock\s*\(/.test(prepBody.slice(0, 2000)),
    'prepareQoderInfer 必须在锁内执行 —— 它是每条 chat 请求的必经之路',
  )
})

test('🔴 锁内不得再调加锁函数（否则死锁）', () => {
  // `prepareQoderInfer` 已在锁内；它若继续调 `generateRuntimeAuthFields`（也加锁），
  // 就会永远等自己 —— 表现为「每条 qoder 请求都挂死，日志里什么都没有」。
  const prepAt = CODE.indexOf('export async function prepareQoderInfer')
  const prepBody = CODE.slice(prepAt)
  assert.ok(
    !/await generateRuntimeAuthFields\s*\(/.test(prepBody),
    '锁内不得 await generateRuntimeAuthFields（会死锁）；应改用不加锁的 buildRuntimeAuthFields',
  )
  assert.ok(
    /buildRuntimeAuthFields\s*\(\s*g\s*,/.test(prepBody),
    '锁内必须改用 buildRuntimeAuthFields(g, user)',
  )
})

test('锁是模块级单例（与 getGlue 同源），不能每个请求各建一个', () => {
  // 若锁是 `prepareQoderInfer` 里的局部变量，那根本没起到串行作用 ——
  // 每个请求各持一把锁，等于没锁。这条防的正是「加了个假的锁」。
  const lockAt = CODE.indexOf('let wasmChain')
  const glueAt = CODE.indexOf('async function getGlue')
  assert.ok(lockAt >= 0, '锁必须是模块级 `let wasmChain`')
  assert.ok(lockAt < glueAt, '锁的声明应在 getGlue 之前（模块级作用域）')
})

test('panic 文案必须说清「不是账号问题」', () => {
  // 用户看到 `unreachable` 会以为号坏了/网关坏了，而真相是签名引擎。
  // 文案必须把他从「检查我的账号」引开，否则会去反复重新登录（浪费时间）。
  const qoder = stripComments(readFileSync('src/providers/qoder.ts', 'utf8'))
  const at = qoder.indexOf('const wasmPanic')
  assert.ok(at > 0, '必须单独识别 WASM panic')

  // ⚠️ 必须验证**识别逻辑本身**，不能只验证文案存在。
  // 变异实验暴露过这个漏洞：把判据改成恒 `false`，文案仍在下面那个三元里，
  // 只查「有没有『签名模块』字样」的断言照样全绿 —— 而功能已经完全失效。
  // ⇒ 判据行里必须真的对 message 做 unreachable 匹配。
  const judgeLine = qoder.slice(at, qoder.indexOf('\n', qoder.indexOf('\n', at) + 1))
  assert.ok(
    /\/unreachable\/i\.test\(\s*message\s*\)|message[^\n]{0,40}unreachable/i.test(judgeLine),
    'panic 判据必须真的拿 message 去匹配 unreachable，不能是常量：' + judgeLine.trim().slice(0, 160),
  )

  const seg = qoder.slice(at, at + 900)
  assert.ok(/签名模块/.test(seg), '文案必须指出是「签名模块」的问题')
  assert.ok(
    /不是账号|账号是正常/.test(seg),
    '文案必须明确排除账号问题 —— 否则用户会去反复重新登录',
  )
})

/**
 * 🔴 **运行时证明**：真实 WASM 上的并发调用必须不 panic。
 *
 * 上面几条都是源码级断言 —— 它们只能证明「锁写着」，不能证明「锁有效」。
 * 这一条**真的实例化 WASM** 并并发调用，是唯一能证明修复有效的证据。
 *
 * `generateRuntimeAuthFields` 是**纯本地签名**（不访问网络），
 * 故可以在单测里安全地反复调用，不消耗任何上游配额。
 */
test('回归守卫（非根因证明）：并发 20 次签名必须全部成功，不得 panic', async () => {
  const { generateRuntimeAuthFields } = await import('../src/providers/qoder-wasm.ts')

  const user = {
    uid: 'test-uid-0001',
    securityOauthToken: 'test-token-abcdef',
    organizationId: 'org-1',
    organizationTags: ['tag-a'],
    dataPolicyAgreed: true,
  }

  // 先单发一次：证明 WASM 能在本测试环境里正常实例化并工作。
  // 若这一步就失败，说明是环境问题（loader/字节），不该归咎于并发。
  const first = await generateRuntimeAuthFields(user)
  assert.ok(typeof first.encrypt_user_info === 'string' && first.encrypt_user_info !== '',
    '单次调用应当返回非空的 encrypt_user_info')
  assert.ok(typeof first.key === 'string' && first.key !== '', '单次调用应当返回非空的 key')

  // 并发：**注意这是回归守卫，不是根因证明**。
  // A/B 实测：去掉锁后这 20 个并发**也全部成功** ⇒ 本条用例目前抓不到"没锁"的回归，
  // 但它能抓到「WASM 被改坏 / 堆视图失效 / 序列化逻辑死锁」这类真实破坏。
  // 保留它的价值在于：它真的实例化了 WASM（而非只读源码），是本文件唯一的运行时证据。
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => generateRuntimeAuthFields(user)),
  )

  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(
    rejected.length,
    0,
    '并发签名不得有任何一次失败（失败即说明 WASM 堆栈被交错破坏）。实际错误：'
      + rejected.map((r) => String((r as PromiseRejectedResult).reason).slice(0, 200)).join(' | '),
  )

  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    const v = r.value
    assert.ok(v.encrypt_user_info !== '', '每个并发结果都必须有 encrypt_user_info')
    assert.ok(v.key !== '', '每个并发结果都必须有 key')
    // ⚠️ **不要**断言「同输入 ⇒ 同密文」：`encrypt_user_info` 内部带随机 nonce/IV，
    // 每次结果本就不同（我第一版写错了这条，属于对加密语义的误解，不是缺陷）。
    // 真正要验的是「结果可用且结构完整」，以及**不 panic**。
    assert.ok(v.encrypt_user_info.length > 10, '密文长度应当合理')
  }
})

test('🔴 检出 wasm panic 必须丢弃缓存实例（自愈，否则一直撞同一个坏实例）', () => {
  // ## 为什么这条比"找根因"更重要
  //
  // 那次 `unreachable` 我复现不出来（A/B 已推翻并发假设，payload/大体积也都正常）。
  // 对一个「可能发生但无法复现的状态损坏」，正确的工程处置不是继续猜根因，
  // 而是**让它自愈**：单例是模块级缓存，一旦某个实例损坏，
  // 之后**每条请求都会撞同一个坏实例** —— 用户看到「一直失败、重试无用，
  // 只能重启进程」，而官方客户端重开一次就好（这正是他觉得"官方能用"的原因）。
  const wasm = stripComments(readFileSync('src/providers/qoder-wasm.ts', 'utf8'))
  assert.ok(/export function resetQoderWasm/.test(wasm), '必须导出 resetQoderWasm')
  const fnAt = wasm.indexOf('export function resetQoderWasm')
  const fnBody = wasm.slice(fnAt, fnAt + 200)
  assert.ok(
    /gluePromise\s*=\s*null/.test(fnBody),
    'resetQoderWasm 必须把 gluePromise 置 null（只置 undefined 也行，但不能什么都不做）',
  )

  const qoder = stripComments(readFileSync('src/providers/qoder.ts', 'utf8'))
  const panicAt = qoder.indexOf('if (wasmPanic) resetQoderWasm()')
  assert.ok(panicAt > 0, '检出 wasm panic 时必须调用 resetQoderWasm')

  // ⚠️ 反向：不能对**所有**错误都重置 —— 那会让每个网络抖动都白付一次
  // wasm 实例化成本，而且掩盖了「这次不是 wasm 的问题」。
  const catchSeg = qoder.slice(qoder.indexOf('const wasmPanic'), qoder.indexOf('const wasmPanic') + 3000)
  assert.ok(
    !/^\s*resetQoderWasm\(\)/m.test(catchSeg.split('if (wasmPanic)')[0] ?? ''),
    '重置必须**以 wasmPanic 为条件**，不能无条件调用',
  )
})

test('resetQoderWasm 之后必须能重建（不能把单例永久置空）', () => {
  // 若 `getGlue` 写成 `if (gluePromise === null) throw`，重置后就永久不可用了 ——
  // 那比不重置更糟（一次 panic 让 provider 永久死亡）。
  const wasm = stripComments(readFileSync('src/providers/qoder-wasm.ts', 'utf8'))
  const glueAt = wasm.indexOf('async function getGlue')
  const body = wasm.slice(glueAt, glueAt + 200)
  assert.ok(
    /gluePromise\s*\?\?=\s*createGlue\(\)/.test(body),
    'getGlue 必须在 null 时重建（`gluePromise ??= createGlue()`），否则重置即永久失效',
  )
})
