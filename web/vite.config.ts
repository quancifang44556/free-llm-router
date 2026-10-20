import { readFileSync } from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 开发 / 预览时把接口转发到本地网关（默认 `node dist/server.mjs` 的 11451 端口，可用 PANEL_API 改）
const target = process.env.PANEL_API ?? 'http://127.0.0.1:11451'
const proxy = { '/admin': target, '/v1': target, '/healthz': target }
// 版本号以仓库根 package.json 为准，和网关保持一致
const { version } = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'))

export default defineConfig({
  base: '/panel/',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false, chunkSizeWarningLimit: 800 },
})
