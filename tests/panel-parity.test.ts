/**
 * 面板「线上产物 ⇄ 仓库源码」对账（P1）。
 *
 * ## 缺陷是什么
 *
 * 线上跑的是 `src/panel/web/assets/*.js.txt`（压缩产物），它的源码在 `web/`。
 * 这两者**是两套实现**：产物被**直接手改**过（产物里能搜到 `wbRemain` /
 * `wbProbeHook` / `wbLeft` 这类只有人手才会起的名字），而 `web/src` 一直没跟上。
 * 后果：谁跑一次 `npm run build:web`，产物里那些功能就**整体消失** ——
 * 界面悄悄退化成「另一个版本」，且没有任何测试会红。
 *
 * 上一轮已经补了 `degraded`（降权中）/ `restricted`（上游封号）两态与「探测」按钮，
 * 并加了守卫测试（`tests/panel.test.ts` 的「状态标签」那条）。
 * 但两套实现的**其它差异**仍在，其中「还剩 X 恢复」倒计时、
 * 「模型限流」不给恢复时间、探测按钮缺 `aria-label` 这三条是本轮补的。
 *
 * ## 怎么对账（不靠肉眼）
 *
 * 1. **文案**：把压缩产物与 `web/src` 都切成「中文文案片段」再做集合差。
 *    JSX 文本节点与压缩后的模板串会被切成**同样的片段**，故可以直接比较
 *    （实测：产物 578 段 / 源码 584 段，差集只有 2 段）。
 * 2. **端点**：两侧调用的 `/admin/*`、`/v1/*` 必须完全一致 ——
 *    这一条能抓到「产物多调了一个接口」这类光看文案发现不了的漂移。
 * 3. **账号表的字段访问**：见下面「模型限流」那条 —— 本轮就是靠它抓到
 *    「文案一样、行为不一样」（产物把 `modelCooldowns` 算进了恢复时刻，源码没算）。
 *
 * ## ⚠️ 去注释必须区分字符串内外
 *
 * 本项目注释里会**逐字引用缺陷原文**，而 `web/src/pages/ApiKeysPage.tsx` 的正文里
 * 有一句 `子密钥只能调用 /v1/*，不能登录控制台。` —— 其中的 `/v1/*` 会被
 * 朴素的「正则删块注释」当成注释开头，把后面几百行源码整段吞掉。
 * 第一次跑这个对账就踩到了（源码片段数从 584 掉到 400 多，差集凭空多出 20 条）。
 * 故 `stripComments()` 用逐字符扫描，只有在字符串字面量之外才认注释。
 *
 * ## 白名单纪律
 *
 * 差集**必须为空**。确需保留的，写进 `WHITELIST` 并逐条说明「为什么不用补」；
 * 且测试会反向校验「白名单里的每一条现在**仍然**只存在于产物」——
 * 将来产物重建（差异消失）或有人补上了（差异消失）都会红，逼着清理白名单。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import * as status from '../web/src/lib/status.ts'

// ⚠️ 只能 import `web/src` 里**没有运行时依赖**的模块：README 写明
// 「部署时不需要装前端依赖」，故 `web/node_modules` 在单测环境里可能不存在。
// `lib/status.ts` 只有 `import type`（打包时被擦掉），符合这条纪律；
// `lib/utils.ts` 顶层 import 了 clsx，不能在这里 import。

// ─────────────────────── 对账工具 ───────────────────────

/**
 * 去注释：逐字符扫描，只有**不在字符串字面量里**的 `//` `/*` 才算注释。
 *
 * ⚠️ 不能用 `code.replace(/\/\*[\s\S]*?\*\//g, '')`：`/v1/*` 这种正文
 * 会被当成块注释开头（见文件头说明）。
 */
function stripComments(code: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < code.length) {
    const c = code[i]!
    const n = code[i + 1]
    if (quote !== null) {
      out += c
      if (c === '\\') {
        out += n ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    out += c
    i++
  }
  return out
}

/**
 * 中文文案片段：以汉字开头，持续吃汉字 / 全角标点 / ASCII 常见字符，
 * 在插值边界（`$` `{` `}` `<` `>` 引号）处断开。
 *
 * 之所以这样切：JSX 里 `共 {n} 个，按健康度…` 与压缩后的
 * `` `共 ${x} 个，按健康度…` `` 会得到**同样的两段**，可直接做集合比较。
 */
const RUN = /[\u4e00-\u9fa5][\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef0-9A-Za-z .,:;!?/()\-×…—·+%=~、。，！？：；（）「」『』《》]*/g

function fragments(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(RUN)) {
    const v = m[0]
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[，。、：；]$/, '')
      .trim()
    if (v) out.push(v)
  }
  return out
}

/** 递归收集文件（按扩展名过滤），返回绝对路径 → 相对 dir 的路径。 */
function walk(dir: string, filter: RegExp): [string, string][] {
  const out: [string, string][] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, filter))
    else if (filter.test(name)) out.push([p, path.relative(dir, p)])
  }
  return out
}

/** 线上产物的全部 JS 分包（`index-*.js.txt` 是主包，其余是懒加载页）。 */
function bundleFiles(): string[] {
  return readdirSync('src/panel/web/assets')
    .filter((f) => /\.js\.txt$/.test(f))
    .map((f) => path.join('src/panel/web/assets', f))
}

/** 产物里的全部文案片段（产物没有注释，无需剥离）。 */
function bundleFragments(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const file of bundleFiles()) {
    for (const f of fragments(readFileSync(file, 'utf8'))) {
      if (!out.has(f)) out.set(f, new Set())
      out.get(f)!.add(path.basename(file))
    }
  }
  return out
}

/** `web/src` 下的全部文案片段（**已剥注释**）。 */
function sourceFragments(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [abs, rel] of walk('web/src', /\.tsx?$/)) {
    for (const f of fragments(stripComments(readFileSync(abs, 'utf8')))) {
      if (!out.has(f)) out.set(f, new Set())
      out.get(f)!.add(rel)
    }
  }
  return out
}

/** 源码文件（**已剥注释**），供下面按需断言。 */
function sourceFile(rel: string): string {
  return stripComments(readFileSync(path.join('web/src', rel), 'utf8'))
}

// ─────────────────────── 白名单 ───────────────────────

/**
 * 「产物有、源码没有」的**已知**差异。
 *
 * 每一条都必须写清「为什么不用补」。新增条目之前先问：真的补不了吗？
 * （本轮就是先把三条能补的补掉，白名单才缩到 2 条。）
 */
const WHITELIST: { text: string; kind: '伪差异' | '暂不补'; why: string }[] = [
  {
    // 压缩产物里两段相邻文本被合并成一个字符串（源码里它们被 <code> 元素切开）
    text:
      '的模型开「推理努力」，否则在本地直接报「不支持推理努力」。 这份片段按「模型」页的真实目录生成（档位取上游下发的值），改完重启 DSH；模型 id 必须与这里一致',
    kind: '伪差异',
    why:
      '不是功能差异：源码 `ConfigPage.tsx` 在同一句话中间插了 <code>reasoningEfforts</code>，' +
      '压缩时相邻文本节点被合并成一个字符串 ⇒ 只是片段切法不同。补不了也不需要补。',
  },
]

// ─────────────────────── 对账断言 ───────────────────────

test('🔴 面板产物有、源码没有的文案，必须只剩白名单里的这几条', () => {
  const bundle = bundleFragments()
  const source = sourceFragments()

  // 先自检「解析器没坏」：两侧都要抽出足够多的片段，否则下面的空差集是假绿
  assert.ok(bundle.size > 400, `产物文案片段太少（${bundle.size}）—— 解析或文件枚举坏了`)
  assert.ok(source.size > 400, `源码文案片段太少（${source.size}）—— 去注释可能把正文吞了`)

  const missing = [...bundle.keys()].filter((f) => !source.has(f)).sort()
  const allowed = WHITELIST.map((w) => w.text).sort()
  assert.deepEqual(
    missing,
    allowed,
    '⚠️ 产物里有、源码里没有的文案变了：新增的说明又有人**直接改产物**了（重建即丢）；' +
      '变少则说明差异已被补齐，请同步删掉白名单条目。',
  )
})

test('🔴 白名单里的每一条都必须仍然「只存在于产物」（防止白名单变成垃圾场）', () => {
  const bundle = bundleFragments()
  const source = sourceFragments()
  for (const entry of WHITELIST) {
    assert.ok(
      bundle.has(entry.text),
      `白名单条目已不在产物里（产物重建过？）：${JSON.stringify(entry.text.slice(0, 24))}… —— 请删除该条`,
    )
    assert.ok(
      !source.has(entry.text),
      `白名单条目已经出现在源码里：${JSON.stringify(entry.text.slice(0, 24))}… —— 请删除该条`,
    )
    assert.ok(
      ['伪差异', '暂不补'].includes(entry.kind),
      '白名单条目必须标 kind（伪差异 / 暂不补）',
    )
    assert.ok(entry.why.length >= 20, `白名单条目必须写清原因（当前只有 ${entry.why.length} 字）`)
  }
})

test('🔴 面板产物与源码调用的后端端点必须完全一致', () => {
  // 文案一致但**多调一个接口**，光比文案是发现不了的；端点集合是最便宜的结构性对账。
  const EP = /\/(?:admin|v1)\/[A-Za-z0-9_\-/${}.]*/g
  const norm = (s: string) => s.replace(/\$\{[^}]*\}/g, '${X}')

  const fromBundle = new Set<string>()
  for (const file of bundleFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(EP)) fromBundle.add(norm(m[0]))
  }
  const fromSource = new Set<string>()
  for (const [abs] of walk('web/src', /\.tsx?$/)) {
    for (const m of stripComments(readFileSync(abs, 'utf8')).matchAll(EP)) fromSource.add(norm(m[0]))
  }

  assert.ok(fromBundle.size > 20, `产物端点太少（${fromBundle.size}）—— 解析坏了`)
  assert.deepEqual(
    [...fromBundle].filter((e) => !fromSource.has(e)).sort(),
    [],
    '⚠️ 产物调了、源码没调的端点 ⇒ 重建面板就丢功能',
  )
  assert.deepEqual(
    [...fromSource].filter((e) => !fromBundle.has(e)).sort(),
    [],
    '⚠️ 源码调了、产物没调的端点 ⇒ 线上跑的不是这份源码（改动没构建进去？）',
  )
})

// ─────────────────────── 本轮补齐的功能点 ───────────────────────

test('🔴 账号表的恢复提示必须带「还剩 X」倒计时（产物一直有，源码曾没有）', () => {
  // 产物：`` `${ja(wbUntil)}恢复（还剩 ${wbLeft}）` ``（`wbRemain` 算剩余时长）。
  // 源码此前只有 `12:30恢复`，倒计时只在产物里 ⇒ 重建即丢。
  // ⚠️ 实现已迁到 `lib/status.ts` 的 `recoveryText()`（纯函数，可行为断言）：
  // 页面只负责调用，文案与倒计时都在 lib 里。
  const page = sourceFile('pages/providers/ProvidersPage.tsx')
  const lib = sourceFile('lib/status.ts')
  assert.ok(page.includes('recoveryText('), '⚠️ 账号表必须调用 recoveryText()')
  assert.ok(lib.includes('恢复（还剩'), '⚠️ lib/status.ts 的 recoveryText 必须带「还剩 X」倒计时')
  assert.ok(/fmtRemaining\(/.test(lib), '倒计时必须走 fmtRemaining（不要就地手算一份）')
})

test('🔴 「模型限流」也要给出恢复时间（产物把 modelCooldowns 算进恢复时刻）', () => {
  // ## 缺陷形状：文案一样、行为不一样
  //
  // 产物的恢复时刻是 `Math.max(until, breakerUntil, restrictedUntil, modelCooldowns[].until)`，
  // 源码此前只看 `until` / `breakerUntil` ⇒ **`model`（模型级限流）那一行什么提示都没有**，
  // 用户只看到一个「模型限流」徽章，不知道要等多久。这类差异光比文案**查不出来**
  // （两侧都有「恢复」二字），是靠比「字段访问」抓到的。
  // ⚠️ 这里**不再只查源码文本**（复核者把实现换成产物那套 `Math.max(...)`，
  // 只查字段名出现的写法仍然全绿）。改成**行为断言**：
  const { recoveryText } = status as unknown as {
    recoveryText?: (a: unknown, s: string, now?: number) => string
  }
  assert.equal(typeof recoveryText, 'function', '⚠️ web/src/lib/status.ts 必须导出 recoveryText')
  const now = 1_000_000_000_000
  const base = {
    until: 0, breakerUntil: 0, restrictedUntil: 0, degradeUntil: 0, modelCooldowns: [],
  }
  const mk = (patch: Record<string, unknown>) => ({ ...base, ...patch })

  // ① model（模型级限流）必须有提示，且取最晚的那个模型截止时刻
  assert.equal(
    recoveryText!(mk({ modelCooldowns: [{ model: 'a', until: now + 120_000 }, { model: 'b', until: now + 300_000 }] }), 'model', now),
    '恢复（还剩 5 分钟）',
    '⚠️ 模型限流必须给出恢复时间（取最晚的模型截止时刻）',
  )
  // ② restricted / degraded 各自取自己的截止时刻
  assert.equal(recoveryText!(mk({ restrictedUntil: now + 60_000 }), 'restricted', now), '恢复（还剩 1 分钟）')
  assert.equal(recoveryText!(mk({ degradeUntil: now + 120_000 }), 'degraded', now), '恢复（还剩 2 分钟）')
  // ③ **核心决策**：同时「封号 5 分钟」+「降权 30 分钟」时，封号那行必须写 5 分钟
  //    —— 产物那套 Math.max 会写成 30 分钟，用户照着等就白等 25 分钟。
  const both = mk({ restrictedUntil: now + 300_000, degradeUntil: now + 1_800_000 })
  assert.equal(
    recoveryText!(both, 'restricted', now),
    '恢复（还剩 5 分钟）',
    '⚠️ 不得用 Math.max 取全局最晚时刻：封号行会写成降权的 30 分钟',
  )
  assert.equal(recoveryText!(both, 'degraded', now), '恢复（还剩 30 分钟）')
  // ④ 熔断/冷却都是账号级，取两者较晚者（与改动前行为一致）
  assert.equal(recoveryText!(mk({ until: now + 60_000, breakerUntil: now + 180_000 }), 'breaker', now), '恢复（还剩 3 分钟）')
  // ⑤ 已到点 ⇒ 空串
  assert.equal(recoveryText!(mk({ restrictedUntil: now - 1 }), 'restricted', now), '')
  // ⑥ 文案不重复、不打架（不得出现「7 分钟后恢复（还剩 8 分钟）」那种两句数）
  const text = recoveryText!(both, 'restricted', now)
  assert.equal((text.match(/分钟/g) ?? []).length, 1, `⚠️ 恢复文案里出现了两个时长：${text}`)
  assert.ok(/模型限流，/.test(sourceFile('pages/providers/ProvidersPage.tsx')), '⚠️ model 状态要给出可读的恢复提示，不能只显示徽章')
})

test('🔴 探测按钮必须有 aria-label（产物有，源码曾没有）', () => {
  // 产物：`aria-label:"探测该账号当前是否可用"`。源码只有 title ——
  // 屏幕阅读器读不到 title，读屏用户根本不知道这个「探测」按钮是干什么的。
  const page = sourceFile('pages/providers/ProvidersPage.tsx')
  assert.ok(page.includes('aria-label="探测该账号当前是否可用"'), '⚠️ 探测按钮缺 aria-label')
})

// ─────────────────────── 倒计时函数的边界 ───────────────────────

test('倒计时 fmtRemaining：秒 / 分钟 / 小时 / 已到点的边界', () => {
  const fn = (status as unknown as { fmtRemaining?: (u: number, now?: number) => string }).fmtRemaining
  assert.equal(typeof fn, 'function', '⚠️ web/src/lib/status.ts 必须导出 fmtRemaining')
  const f = fn!
  const now = 1_000_000_000_000

  // 没有截止时刻 / 已经到点 ⇒ 空串（不能拼出「恢复（还剩 -3 分钟）」）
  assert.equal(f(0, now), '', '没有截止时刻应回空串')
  assert.equal(f(now, now), '', '恰好到点应回空串')
  assert.equal(f(now - 5_000, now), '', '已过点应回空串')

  assert.equal(f(now + 1_000, now), '1 秒')
  assert.equal(f(now + 59_000, now), '59 秒')
  // 60 秒整 → 「1 分钟」；61 秒向上取整到 2 分钟（宁可让用户多等一会儿）
  assert.equal(f(now + 60_000, now), '1 分钟')
  assert.equal(f(now + 61_000, now), '2 分钟')
  assert.equal(f(now + 59 * 60_000, now), '59 分钟')
  assert.equal(f(now + 60 * 60_000, now), '1 小时')
  assert.equal(f(now + 3_700_000, now), '1 小时 2 分')
  assert.equal(f(now + 2 * 60 * 60_000, now), '2 小时')
})
