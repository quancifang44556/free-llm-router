/**
 * 管理面板的静态资源与安全响应头。
 *
 * ## 资源怎么进 Worker
 *
 * 面板是 `web/` 下的 React 单页应用（Vite 构建）。`npm run build:web`
 * （`scripts/embed-web.mjs`）把构建产物拷进 `src/panel/web/` 并生成 `manifest.ts`，
 * 这里用 Wrangler 的 **Text 模块规则**（`wrangler.jsonc` 的 `rules`）把它们作为字符串 import。
 * 产物随源码提交 ⇒ `wrangler deploy` / `npm run build:node` 都不需要装前端依赖。
 *
 * ⚠️ 为什么不用 Workers Static Assets：那需要额外的 `assets` binding 与路由优先级配置，
 * 而面板必须挂在 `/panel/*` 前缀下并**统一加安全头** —— 走同一个 handler 只有一处实现。
 *
 * ## 为什么 JS 都是外链文件，而不是内联进 HTML
 *
 * 内联脚本会迫使 CSP 放开 `script-src 'unsafe-inline'` —— 那等于放弃 XSS 防护
 * （任何注入的 `<script>` 都会执行）。所以连首屏主题初始化都放在外链的 `theme-init.js` 里。
 *
 * ## 为什么页面本身不需要鉴权，而数据接口必须鉴权
 *
 * 页面不含任何敏感信息（不知道有哪些账号、也不知道 token）。
 * 真正的数据都在 `/admin/*` 与 `/v1/*` 后面，**一律要 Bearer 密钥**。
 * 用户把密钥粘进页面（存 localStorage），页面再带 `Authorization` 头请求。
 *
 * ⚠️ 刻意**不用 cookie**：cookie 会被浏览器自动附带，需要额外的 CSRF 防护；
 * 而 `Authorization` 头不会被自动附带，天然免疫 CSRF。
 */

import { WEB_ASSETS } from './web/manifest.js'

/**
 * 内容安全策略（严格版，**无需 unsafe-inline 脚本**）。
 *
 * - `default-src 'none'`：默认全禁，逐个开口；
 * - `script-src 'self'`：只跑同源的打包脚本；
 * - `style-src 'self' 'unsafe-inline'`：允许内联样式属性（React 的 `style={}`、Radix 定位，**不会导致脚本执行**）；
 * - `connect-src 'self'`：前端 fetch 只能打本服务（防把密钥发去外部域）；
 * - `frame-ancestors 'none'`：禁止被 iframe 嵌套（防点击劫持）；
 * - `base-uri 'none'`：禁止注入 `<base>` 改写相对路径；
 * - `form-action 'self'`：面板登录页有一个真实 `<form>`（JS 里 `preventDefault` 后用 fetch 提交）。
 *   ⚠️ 不能写 `'none'`：浏览器每提交一次都会在控制台报一条 CSP 违规；
 *   写 `'self'` 仍保证「即便 JS 挂了，表单也不可能提交到外部域名」（那等于把密钥送到别人服务器）。
 */
export const CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; " +
  // ⚠️ 必须放开 `https://open.weixin.qq.com`：Loomy（讯飞）微信扫码登录的二维码
  // 是**微信官方图片端点**（`https://open.weixin.qq.com/connect/qrcode/<uuid>`），
  // 由面板 `<img src>` 直接加载。只写 `'self' data:` 会让该图被 CSP 拦截
  // ⇒ 二维码显示为破碎图标、且不报「我们的」错误（只有浏览器控制台一条 CSP 违规）。
  // ❗ 仅放开**这一个** HTTPS 域名（微信官方、可信）；不要用通配 `https:`。
  "img-src 'self' data: https://open.weixin.qq.com; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'"

/** 面板统一安全响应头（页面与静态资源都要）。 */
export function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

/**
 * 面板静态资源（路径 → 内容、类型、缓存策略）。
 *
 * - `/panel/`（与 `/panel/index.html`）→ 单页入口，`no-store`：每次都拿最新入口；
 * - `/panel/assets/*` → `no-cache`（**允许缓存，但每次必须回源校验**）。
 *
 * ## 🔴 为什么不能 `immutable`（2026-10-21 实测踩到）
 *
 * 原注释的理由是「文件名带内容哈希，升级后文件名会变」——**但那是假的**：
 * 面板产物是**预构建后提交进仓库**的，文件名是硬编码的
 *（`index-Dg0M0nJm.js` / `style-xxx.css.txt` …），内容变了名字**不变**。
 *
 * 于是 `cache-control: immutable` + `max-age=31536000` 让浏览器**一年内
 * 永不重新请求**该资源 ⇒ 用户升级后界面**一直显示旧版本号**
 *（实测：服务端已返回 `0.9.5`，用户看到的仍是 `0.9.2`）。
 *
 * 改名方案（给文件名加真哈希）要改构建脚本，成本高；
 * 而 `no-cache` 的成本只是一次 304 往返（有 ETag），对本人多设备完全可接受。
 * ⇒ 取 `no-cache`：正确性优先于那点带宽。
 */
/** 内容哈希缓存（路径 → ETag）。产物是静态的，算一次即可，不必每次请求都算。 */
const etagCache = new Map<string, string>()

/**
 * 计算资源内容的 ETag。
 *
 * ⚠️ 用 64 位 FNV-1a 拼两段（快、同步、无依赖）。**不需要密码学强度** ——
 * ETag 只用于「内容变没变」的协商，不是安全边界。
 */
function etagOf(body: string): string {
  const existing = etagCache.get(body)
  if (existing !== undefined) return existing
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0
  }
  const tag = `"${h1.toString(16)}${h2.toString(16)}"`
  // 防无限增长：产物数量有限，超过 64 条整体清空即可
  if (etagCache.size > 64) etagCache.clear()
  etagCache.set(body, tag)
  return tag
}

export function panelAsset(
  path: string,
): { body: string; contentType: string; cacheControl: string; etag: string } | undefined {
  const key = path === '/panel/index.html' ? '/panel/' : path
  const asset = Object.hasOwn(WEB_ASSETS, key) ? WEB_ASSETS[key] : undefined
  if (asset === undefined) return undefined
  return {
    body: asset.body,
    contentType: asset.type,
    // ⚠️ 不用 `immutable`：文件名不随内容变，会让浏览器永久缓存旧产物
    //（见上方注释的实测记录）。`no-cache` 允许缓存但强制回源校验。
    cacheControl: asset.immutable ? 'no-cache' : 'no-store',
    etag: etagOf(asset.body),
  }
}
