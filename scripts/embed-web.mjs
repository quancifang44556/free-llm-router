#!/usr/bin/env node
/**
 * 构建管理面板（web/）并把产物嵌进网关源码：src/panel/web/ + manifest.ts。
 *
 * 为什么要「嵌进源码」而不是用 Workers Static Assets：
 * - `wrangler deploy` 与 `npm run build:node` 都直接从 src 打包，部署者无需装前端依赖；
 * - 面板所有响应都要统一加安全头（CSP 等），走同一个 handler 最简单。
 *
 * 文件后缀约定（与 wrangler.jsonc 的 Text 规则、scripts/build-node.mjs 的 loader 对应）：
 * - `.js` → `.js.txt`：esbuild 对 `.js` 有自己的 loader，不会套用 Text 规则；
 * - `.css` → `.css.txt`：Wrangler 对 `.css` 有内建处理，会得到对象而不是字符串；
 * - `.html` 保持原样（Text 规则默认覆盖）。
 *
 * 用法：npm run build:web（会先 `cd web && npm ci && npm run build`，加 --skip-build 只做嵌入）
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const webDir = path.join(root, 'web')
const dist = path.join(webDir, 'dist')
const out = path.join(root, 'src/panel/web')

if (!process.argv.includes('--skip-build')) {
  if (!fs.existsSync(path.join(webDir, 'node_modules'))) execSync('npm ci', { cwd: webDir, stdio: 'inherit' })
  execSync('npm run build', { cwd: webDir, stdio: 'inherit' })
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('web/dist/index.html 不存在，先构建前端')
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}
const SUFFIX = { '.html': '.html', '.js': '.js.txt', '.css': '.css.txt', '.svg': '.svg.txt' }

/** 递归列出 dist 下的文件（相对路径，统一用 /）。 */
function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel]
  })
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const imports = []
const entries = []
for (const [i, rel] of walk(dist).sort().entries()) {
  const ext = path.extname(rel)
  if (!TYPES[ext]) {
    console.error(`不支持嵌入的文件类型：${rel}（需要的话在 scripts/embed-web.mjs 里加上）`)
    process.exit(1)
  }
  const target = rel.slice(0, -ext.length) + SUFFIX[ext]
  fs.mkdirSync(path.dirname(path.join(out, target)), { recursive: true })
  fs.copyFileSync(path.join(dist, rel), path.join(out, target))
  imports.push(`import f${i} from './${target}'`)
  const urlPath = rel === 'index.html' ? '/panel/' : `/panel/${rel}`
  // Vite 产物文件名带内容哈希 ⇒ 可以永久缓存；index.html / theme-init.js 不带哈希，不缓存
  const immutable = rel.startsWith('assets/')
  entries.push(`  ${JSON.stringify(urlPath)}: { body: f${i}, type: ${JSON.stringify(TYPES[ext])}, immutable: ${immutable} },`)
}

fs.writeFileSync(
  path.join(out, 'manifest.ts'),
  `// ⚠️ 自动生成，勿手改：npm run build:web（scripts/embed-web.mjs）
${imports.join('\n')}

export interface WebAsset {
  body: string
  type: string
  /** 文件名带内容哈希，可永久缓存。 */
  immutable: boolean
}

export const WEB_ASSETS: Record<string, WebAsset> = {
${entries.join('\n')}
}
`,
)
const bytes = walk(out).reduce((s, f) => s + fs.statSync(path.join(out, f)).size, 0)
console.log(`已嵌入 ${entries.length} 个文件到 src/panel/web/（${(bytes / 1024).toFixed(0)} KB）`)
