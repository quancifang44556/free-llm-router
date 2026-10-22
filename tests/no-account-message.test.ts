/**
 * 「选不到号」的**说明文案必须与 `pick()` 用同一份判据**。
 *
 * ## 现场（2026-10-22 05:57，用户截图）
 *
 * 5 个并行子代理同时请求 `qodercn/dfmodel`，全部得到
 * `503 供应商「qodercn」暂时没有可用账号（请稍后重试或查看面板状态）`。
 * 而面板上那个账号：`disabled=false`、`credits=4562`、四个账号级冷却全为 0，
 * 唯一的异常是 `modelCooldowns['dfmodel']`（上游排队 10605 打上的模型级冷却）。
 *
 * ## 根因：`describeNoAccount()` 手抄了一份「这号为什么不可用」的判据
 *
 * `pick()` 走 `healthyForModel()`，它查 **6 个维度**：
 *   `disabled` / `until` / `breakerUntil` / `degradeUntil` / `restrictedUntil`
 *   / `modelCooldowns[model]`
 *
 * 而 `describeNoAccount()` 只查 **4 个**：`until` / `breakerUntil` / `degradeUntil` /
 * `disabled` —— 漏了 `restrictedUntil` 与 `modelCooldowns`。
 *
 * ⇒ 当账号**只**因模型级冷却而不可用时，它落进最后的兜底文案
 * 「暂时没有可用账号（请稍后重试或查看面板状态）」。
 * 这句话对用户是**误导**：账号根本没坏，等这个模型的冷却过去（或换个模型）就行；
 * 「查看面板状态」却只会看到一个健康的号，用户无从下手。
 *
 * 这与 `state.ts` 里 `modelExempt` 漏 `restrictedUntil`、`shouldPunish` 与
 * `mapErrorToPunishment` 漂移是**同一类缺陷**：判据写了两份，改一份漏一份。
 *
 * ## 本文件钉住三件事
 *   1. 只因模型级冷却 ⇒ 文案必须**点名该模型**，不能说「没有可用账号」；
 *   2. 只因 `restrictedUntil` ⇒ 文案必须说「被上游限制」，不能说「没有可用账号」；
 *   3. 账号真的健康（没有任何冷却）时 ⇒ 仍然保留兜底文案（防止修过头，
 *      把「真的选不到」也归咎于某个维度）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import { writeAccount } from '../src/store/db.js'
import { describeNoAccount } from '../src/gateway/server.js'

const REALM = 'cn'
const PROVIDER = 'qodercn'
const MODEL = 'dfmodel'

/** 每个用例一个独立 SQLite 文件（账号状态是整条 JSON 重写，共库会互相污染）。 */
function freshRuntime(tag: string) {
  const dir = path.join(process.cwd(), '.build', 'test-no-account-message')
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, `${tag}.db`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  return { runtime: createNodeRuntime(dbPath), dbPath }
}

function poolOf(env: any) {
  return env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(REALM))
}

/** 造一个账号并落盘。`mutate` 用来施加各种冷却维度。 */
async function seed(pool: any, uid: string, mutate: (s: any) => void) {
  const state = createAccountState({ uid, nickname: uid, realm: REALM, provider: PROVIDER })
  state.credits = 4562
  mutate(state)
  writeAccount(pool.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
}

test('🔴 只因模型级冷却 ⇒ 文案必须点名该模型，不能说「没有可用账号」', async () => {
  const { runtime } = freshRuntime('model-only')
  const pool = poolOf(runtime.env)
  const now = Date.now()
  await seed(pool, 'u-model', (s) => {
    // 只有「dfmodel 这个模型被上游排队锁了」，账号本身完全健康。
    // 这正是 2026-10-22 05:57 现场的形态。
    s.modelCooldowns[MODEL] = {
      until: now + 5 * 3600_000,
      resetAt: 0,
      reason: 'rate_limited: 上游排队 10605',
      hits: 1,
      confirmed: 1,
      cause: 'busy',
      auditOnly: false,
    }
  })

  const msg = await describeNoAccount(runtime.env, REALM, PROVIDER, MODEL)
  // ⚠️ `describeNoAccount` 的 `model` 参数此前不存在 —— 旧实现在这一步就
  // 拿不到模型名，只能笼统报错。现在必须点名。
  assert.ok(
    !msg.includes('暂时没有可用账号'),
    `账号只因模型级冷却不可用时不该说「没有可用账号」，实际：${msg}`,
  )
  assert.ok(
    msg.includes(MODEL) || msg.includes('模型'),
    `文案必须指出是「模型」维度的冷却，实际：${msg}`,
  )

  runtime.db.close()
})

test('🔴 只因 restrictedUntil ⇒ 文案必须说「被上游限制」，不能说「没有可用账号」', async () => {
  const { runtime } = freshRuntime('restricted-only')
  const pool = poolOf(runtime.env)
  const now = Date.now()
  await seed(pool, 'u-restricted', (s) => {
    // 11140：上游明确标记该账号异常行为。`healthy()` 会因为这一维拒绝派单。
    s.restrictedUntil = now + 2 * 3600_000
  })

  const msg = await describeNoAccount(runtime.env, REALM, PROVIDER, MODEL)
  assert.ok(
    !msg.includes('暂时没有可用账号'),
    `账号被上游限制时不该说「没有可用账号」，实际：${msg}`,
  )
  assert.ok(
    msg.includes('限制') || msg.includes('风控'),
    `文案必须说明是上游限制，实际：${msg}`,
  )

  runtime.db.close()
})

test('账号真的健康（无任何冷却）⇒ 仍保留兜底文案（防止修过头）', async () => {
  const { runtime } = freshRuntime('healthy')
  const pool = poolOf(runtime.env)
  await seed(pool, 'u-healthy', () => {
    // 不施加任何冷却：这一条是为了证明「新增的分支没有把正常情况也吞掉」。
  })

  const msg = await describeNoAccount(runtime.env, REALM, PROVIDER, MODEL)
  assert.ok(
    msg.includes('暂时没有可用账号') || msg.includes('冷却中'),
    `完全健康的号走到「选不到号」时，说明问题不在这几个维度上，实际：${msg}`,
  )

  runtime.db.close()
})

test('🔴 判据必须复用 healthyForModel，不许手抄维度（源码级钉住）', async () => {
  // 行为测试能挡住**当前**这两个维度，但挡不住「下次又加第 7 个维度」。
  // 这条断言要求实现**直接调用**共享判据，从根上避免再抄一份。
  const raw = fs.readFileSync('src/gateway/server.ts', 'utf8')
  const start = raw.indexOf('export async function describeNoAccount(')
  assert.ok(start >= 0, '应能找到 describeNoAccount 定义')
  const rest = raw.slice(start)
  const stop = rest.indexOf('\nexport ', 1)
  const body = stop < 0 ? rest : rest.slice(0, stop)

  assert.ok(
    /healthyForModel\s*\(/.test(body),
    'describeNoAccount 必须用 healthyForModel() 判「这号为什么不可用」，'
      + '不能自己再列一遍 until / breakerUntil / degradeUntil',
  )
})
