import { test } from 'node:test'
import assert from 'node:assert/strict'

import { estimateCost, summarizeCost } from '../src/gateway/cost-estimate.ts'

// ─────────────────────── estimateCost ───────────────────────

test('estimateCost：正常输入给出 (in+out)×factor', () => {
  const r = estimateCost({ input: 1000, output: 500 }, 0.2)
  assert.equal(r.amount, 300)
  assert.equal(r.comparable, true)
})

test('🔴 estimateCost：倍率未知时**不估算**，且 comparable=false（不是 0）', () => {
  // ## 这条是本模块最重要的不变式
  //
  // `priceFactor === undefined` 的语义是「该家没提供」（`types.ts:120`），
  // **不是**「免费」，也**不是**「不可用」。
  //
  // 若把它当 0，面板会把「查不到倍率的供应商」显示成「免费」——
  // 用户会以为自己白嫖到了，而实际上只是在烧钱且看不见。
  const r = estimateCost({ input: 1000, output: 500 }, undefined)
  assert.equal(r.amount, undefined, '缺倍率必须是 undefined，不能是 0')
  assert.notEqual(r.amount, 0, '⚠️ 绝不能用 0 冒充「未知」')
  assert.equal(r.comparable, false)
  // ⚠️ 只验「note 确实说了点什么、且明确否定免费」，不锁具体措辞 ——
  // 锁死文案会让改一个字就误报失败（本项目为此返工过）。
  assert.ok(r.note.length > 0, 'note 必须非空、说明原因')
  assert.ok(/免费/.test(r.note), 'note 必须明确提到「免费」以否定这个误解')
})

test('✅ estimateCost：倍率**真的是 0** 时给 0，且 comparable=true（免费是合法值）', () => {
  // 与上一条形成**正反两向**：0 是合法配置值，不能因为它 falsy 就当成缺失。
  // 这正是本项目 §6.8「绝不写 parseInt(x) || 默认值」那条纪律的同型问题。
  const r = estimateCost({ input: 1000, output: 500 }, 0)
  assert.equal(r.amount, 0)
  assert.equal(r.comparable, true)
  assert.ok(/免费/.test(r.note))
})

test('estimateCost：用量为 0 时给 0（真的没用，不是未知）', () => {
  const r = estimateCost({ input: 0, output: 0 }, 0.5)
  assert.equal(r.amount, 0)
  assert.equal(r.comparable, true)
})

test('🔴 estimateCost：非法数值一律不估算（NaN 参与比较恒 false，会静默算错）', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1]) {
    const asFactor = estimateCost({ input: 10, output: 10 }, bad)
    assert.equal(asFactor.amount, undefined, `factor=${bad} 必须不估算`)
    assert.equal(asFactor.comparable, false)
  }
  for (const bad of [NaN, Infinity, -5]) {
    const asInput = estimateCost({ input: bad, output: 10 }, 1)
    assert.equal(asInput.amount, undefined, `input=${bad} 必须不估算`)
  }
})

test('estimateCost：非 number 类型的传入也不崩（运行时可能是字符串）', () => {
  // TS 静态类型挡不住 JSON 里来的脏数据
  const r = estimateCost({ input: '10' as never, output: 10 }, 1)
  assert.equal(r.amount, undefined)
})

test('estimateCost：只算 input 或只算 output 都不崩', () => {
  assert.equal(estimateCost({ input: 100, output: 0 }, 1).amount, 100)
  assert.equal(estimateCost({ input: 0, output: 100 }, 1).amount, 100)
})

test('estimateCost：大数不溢出（仍是有限数）', () => {
  const r = estimateCost({ input: 1e9, output: 1e9 }, 10)
  assert.equal(r.comparable, true)
  assert.ok(Number.isFinite(r.amount!))
})

// ─────────────────────── summarizeCost ───────────────────────

test('summarizeCost：同倍率多条累加正确', () => {
  const r = summarizeCost([
    { usage: { input: 100, output: 50 }, priceFactor: 2 },
    { usage: { input: 200, output: 100 }, priceFactor: 2 },
  ])
  // (150 + 300) × 2 = 900
  assert.equal(r.amount, 900)
  assert.equal(r.input, 300)
  assert.equal(r.output, 150)
  assert.equal(r.entries, 2)
  assert.equal(r.skipped, 0)
  assert.equal(r.comparable, true)
})

test('🔴 summarizeCost：缺倍率的条目**不计入**，但必须如实报 skipped', () => {
  // ⚠️ 不隐瞒 —— 若静默丢弃，用户会看到「这个月很便宜」而实际有一半没算。
  const r = summarizeCost([
    { usage: { input: 100, output: 0 }, priceFactor: 1 },
    { usage: { input: 999, output: 999 }, priceFactor: undefined },
  ])
  assert.equal(r.amount, 100, '只算能算的那条')
  assert.equal(r.entries, 1)
  assert.equal(r.skipped, 1, '必须如实报出被跳过的条数')
})

test('summarizeCost：全部都无法估算时 amount=undefined（不是 0）', () => {
  const r = summarizeCost([
    { usage: { input: 100, output: 0 }, priceFactor: undefined },
    { usage: { input: 0, output: 0 }, priceFactor: NaN },
  ])
  assert.equal(r.amount, undefined)
  assert.equal(r.comparable, false)
  assert.equal(r.entries, 0)
  assert.equal(r.skipped, 2)
})

test('summarizeCost：空数组返回 undefined 且不崩', () => {
  const r = summarizeCost([])
  assert.equal(r.amount, undefined)
  assert.equal(r.comparable, false)
  assert.equal(r.entries, 0)
  assert.equal(r.skipped, 0)
})

test('summarizeCost：倍率 0（免费）的条目要计入，不是跳过', () => {
  const r = summarizeCost([
    { usage: { input: 100, output: 50 }, priceFactor: 0 },
    { usage: { input: 10, output: 10 }, priceFactor: 1 },
  ])
  assert.equal(r.amount, 20)
  assert.equal(r.entries, 2, '免费的也要计入 entries')
  assert.equal(r.skipped, 0)
})
