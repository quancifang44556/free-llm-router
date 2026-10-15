import esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const distDir = path.join(root, 'dist')
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true })
}

console.log('🔨 开始为 Node.js / Linux VPS 构建独立单文件服务端 dist/server.mjs...')

try {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src/server/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: path.join(distDir, 'server.mjs'),
    alias: {
      'cloudflare:workers': path.join(root, 'src/server/cf-shim.ts'),
    },
    loader: {
      '.html': 'text',
      '.css.txt': 'text',
      '.js.txt': 'text',
      '.wasm': 'binary',
    },
    banner: {
      js: '// free-llm-router standalone Node.js server for VPS\n',
    },
    sourcemap: false,
    logLevel: 'info',
  })

  const stat = fs.statSync(path.join(distDir, 'server.mjs'))
  console.log(`✅ 构建完成！产物大小: ${(stat.size / 1024).toFixed(2)} KiB -> dist/server.mjs`)
} catch (err) {
  console.error('❌ 构建失败:', err)
  process.exit(1)
}
