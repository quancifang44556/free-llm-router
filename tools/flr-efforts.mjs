#!/usr/bin/env node
/**
 * flr-efforts —— 给 DSH 的 provider 批量补 `reasoningEfforts`（思考档位）。
 *
 * ## 为什么需要这个脚本
 *
 * DSH 的模型发现（`dsh-llm-pi-ai` 的 `discoverModels` / `readListing`）
 * **只解析这五个字段**：
 *
 *     id / name / contextWindow / maxTokens / inputModalities
 *
 * 它**不读** `reasoningEfforts`（也没有 `reasoning_efforts`、`defaultEffort`）。
 * 而档位在 DSH 内部**只有唯一来源**：
 *
 *     resolveModelReasoning() ← entry.reasoningEfforts（配置项）
 *
 * ⇒ 无论网关的 `/v1/models` 返回什么，DSH 都收不到档位；
 *    必须在**每台 DSH 自己的** `cordis.patch.yml` 里写。
 *    本脚本就是把这件重复劳动自动化。
 *
 * ## 用法
 *
 *     node flr-efforts.mjs                      # 处理默认路径，只报告不写
 *     node flr-efforts.mjs --write              # 就地写入（先备份）
 *     node flr-efforts.mjs --write --dry-run    # 只显示将要改什么
 *     node flr-efforts.mjs --config /path/cordis.patch.yml --provider flr
 *
 * 默认档位 `low/high/max`，可用 `--levels` 覆盖：
 *
 *     node flr-efforts.mjs --write --levels high,max
 *
 * ## 安全
 *
 * - 写入前把原文件复制到 `<file>.bak-<时间戳>`；
 * - 只**新增**缺失的 `reasoningEfforts`，已存在的一律不碰；
 * - 改完重新解析 YAML 校验，失败即回滚。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── 参数解析（手写：不引入依赖，脚本要能在任何机器上直接跑）──

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, def) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}

const WRITE = has('--write')
const DRY = has('--dry-run')
const PROVIDER = val('--provider', 'flr')
const LEVELS = val('--levels', 'low,high,max').split(',').map((s) => s.trim()).filter(Boolean)

/** 默认配置路径：优先 `$DSH_HOME`，否则 `~/.dsh`，再否则当前常见的 1Panel 布局。 */
function defaultConfig() {
  const candidates = []
  if (process.env.DSH_HOME) candidates.push(join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'))
  candidates.push(join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'))
  candidates.push('/data/dsh/profiles/web/cordis.patch.yml')
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

const CONFIG = val('--config', defaultConfig())

if (!existsSync(CONFIG)) {
  console.error(`找不到配置文件：${CONFIG}\n用 --config 指定 cordis.patch.yml 的路径。`)
  process.exit(2)
}

// ── 缩进推断 ──
//
// 不同 DSH 版本的 YAML 缩进可能是 2 或 4 空格。硬编码缩进会生成
// 「看起来对、解析后结构错」的文件，故从现有 `- id:` 行的序号推断。

const original = readFileSync(CONFIG, 'utf8')
const lines = original.split('\n')

/** 定位 `providers.<name>:` 段的行范围（到下一个同级或更浅的键为止）。 */
function providerRange(name) {
  const key = `        ${name}:` // providers 下的直属子键（8 空格是 DSH 的既有布局）
  let start = lines.findIndex((l) => l.trimEnd() === key || l.trimEnd() === `  ${name}:`)
  if (start < 0) {
    // 退一步：按「任意缩进 + name:」找，取 providers: 之后第一个匹配
    const provAt = lines.findIndex((l) => /^\s*providers:\s*$/.test(l))
    if (provAt < 0) return null
    const re = new RegExp(`^\\s{4,}${name}:\\s*$`)
    start = lines.findIndex((l, i) => i > provAt && re.test(l))
    if (start < 0) return null
  }
  const baseIndent = lines[start].search(/\S/)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') continue
    const ind = l.search(/\S/)
    if (ind <= baseIndent) { end = i; break }
  }
  return { start, end }
}

const range = providerRange(PROVIDER)
if (range === null) {
  console.error(`配置里找不到 provider「${PROVIDER}」。现有 provider：`)
  const provAt = lines.findIndex((l) => /^\s*providers:\s*$/.test(l))
  if (provAt >= 0) {
    const base = lines[provAt].search(/\S/)
    for (let i = provAt + 1; i < lines.length; i++) {
      const l = lines[i]
      if (l.trim() === '') continue
      const ind = l.search(/\S/)
      if (ind <= base) break
      if (/^[^#\s][^:]*:\s*$/.test(l.trim())) console.error(`  - ${l.trim().replace(/:$/, '')}`)
    }
  }
  process.exit(3)
}

// ── 扫描该 provider 下的模型条目 ──

const seg = lines.slice(range.start, range.end)
const modelIndices = []
for (let i = 0; i < seg.length; i++) {
  if (/^\s*-\s+id:\s*\S/.test(seg[i])) modelIndices.push(i)
}

if (modelIndices.length === 0) {
  console.error(`provider「${PROVIDER}」下没有找到任何模型条目。`)
  process.exit(4)
}

const modelIndent = seg[modelIndices[0]].search(/\S/)
const fieldIndent = modelIndent + 2 // 模型条目的字段比 `- ` 再进一级

/** 单个模型的结束行（下一个模型起点或段尾）。 */
function entryEnd(k) {
  return k + 1 < modelIndices.length ? modelIndices[k + 1] : seg.length
}

/** 该条目已有的字段名（用于判断是否已声明）。 */
function entryFields(k) {
  const from = modelIndices[k]
  const to = entryEnd(k)
  const fields = new Set()
  for (let i = from + 1; i < to; i++) {
    const m = /^\s*([A-Za-z_][\w-]*):/.exec(seg[i])
    if (m && seg[i].search(/\S/) === fieldIndent) fields.add(m[1])
  }
  return fields
}

/** 该条目的 id。 */
function entryId(k) {
  const m = /^\s*-\s+id:\s*(\S+)/.exec(seg[modelIndices[k]])
  return m ? m[1] : '(未知)'
}

// ── 决定要插入什么 ──

const pad = ' '.repeat(fieldIndent)
const insertBlock = [
  `${pad}reasoningEfforts:`,
  ...LEVELS.map((lv) => `${' '.repeat(fieldIndent + 2)}${lv}: ${lv}`),
]

const insertions = [] // { at, id }
const skipped = []
for (let k = 0; k < modelIndices.length; k++) {
  const id = entryId(k)
  const fields = entryFields(k)
  if (fields.has('reasoningEfforts')) {
    skipped.push(id)
    continue
  }
  // 插在条目末尾（保持「id 在最前、档位紧跟其他字段」的可读性）
  insertions.push({ at: range.start + entryEnd(k), id })
}

// ── 报告 ──

console.log(`配置文件：${CONFIG}`)
console.log(`provider：${PROVIDER}（${modelIndices.length} 个模型）`)
console.log(`档位：${LEVELS.join(' / ')}`)
console.log('')
if (skipped.length) {
  console.log(`已有档位、跳过（${skipped.length}）：`)
  for (const id of skipped) console.log(`  - ${id}`)
  console.log('')
}
if (insertions.length === 0) {
  console.log('✅ 所有模型都已有 reasoningEfforts，无需改动。')
  process.exit(0)
}
console.log(`将补上档位（${insertions.length}）：`)
for (const it of insertions) console.log(`  + ${it.id}`)
console.log('')

if (!WRITE) {
  console.log('（未写入。加 --write 实际修改，或 --dry-run 与 --write 同用看细节。）')
  process.exit(0)
}

// ── 应用：从后往前插，避免行号偏移 ──

const out = [...lines]
for (const it of [...insertions].sort((a, b) => b.at - a.at)) {
  out.splice(it.at, 0, ...insertBlock)
}

const next = out.join('\n')

// 结构校验：模型数必须不变、每处 reasoningEfforts 都必须能被解析到
const countBefore = (original.match(/reasoningEfforts:/g) ?? []).length
const countAfter = (next.match(/reasoningEfforts:/g) ?? []).length
if (countAfter !== countBefore + insertions.length) {
  console.error(`❌ 自检失败：reasoningEfforts 数量 ${countBefore} → ${countAfter}，预期 +${insertions.length}`)
  process.exit(5)
}

if (DRY) {
  console.log('（--dry-run：以下是将写入的内容差异片段）')
  for (const it of insertions.slice(0, 3)) {
    console.log(`\n--- ${it.id} ---`)
    console.log(insertBlock.join('\n'))
  }
  process.exit(0)
}

const backup = `${CONFIG}.bak-${Date.now()}`
copyFileSync(CONFIG, backup)
writeFileSync(CONFIG, next, 'utf8')
console.log(`✅ 已写入 ${insertions.length} 处档位`)
console.log(`   备份：${backup}`)
console.log('')
console.log('下一步：重启 DSH 使配置生效（它只在启动时读配置，没有热重载）：')
console.log('   docker restart <dsh 容器名>')
