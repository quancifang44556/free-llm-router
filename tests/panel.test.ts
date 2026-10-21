/**
 * 管理面板的单测（安全头、资源路由、CSP 纪律、前端安全约定，以及面板依赖的后端行为）。
 *
 * ## 为什么这些断言重要
 *
 * 面板是**唯一被浏览器直接加载**的界面，安全边界最容易在这里被放松：
 * - CSP 一旦加入 `'unsafe-inline'`，页面注入的 `<script>` 就会执行；
 * - 安全头一旦漏加，页面就可能被 iframe 嵌套（点击劫持）；
 * - 资源路由写错会让 CSS/JS 返回错误内容（实测踩过：CSS 返回 `[object Object]`）。
 *
 * 面板本体是 `web/`（React + Vite）；`npm run build:web` 把产物嵌进 `src/panel/web/`。
 * 这里既测**嵌入后的产物**（manifest / HTML 引用完整、缓存策略），也对 `web/src` 做源码纪律检查。
 * UI 交互本身需在真实浏览器里验证（`npm run build:node` 后访问 `/panel/`，真实 CSP 下控制台应无报错）。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { splitModelName } from '../src/providers/types.ts'
import { CSP, panelAsset, securityHeaders } from '../src/panel/index.ts'
import { WEB_ASSETS } from '../src/panel/web/manifest.ts'

/**
 * 剥掉 `//` 行注释与 `/* *\/` 块注释后再做源码断言。
 *
 * ⚠️ 必需：本仓库的注释里会**大量引用反例**（如「原实现是 `accounts.find(...)`」），
 * 朴素的字符串搜索会把注释当成代码 ⇒ **误报**。实测踩到过一次。
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** `web/src` 下全部 .ts/.tsx 源码（相对路径 → 去注释后的内容）。 */
function webSources(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name)) out.set(path.relative('web/src', p), stripComments(readFileSync(p, 'utf8')))
    }
  }
  walk('web/src')
  return out
}

// ─────────────────────── CSP 纪律 ───────────────────────

test("⚠️ CSP 必须禁止内联脚本（不许出现 script-src 'unsafe-inline'）", () => {
  // 内联脚本放行 = 放弃 XSS 防护。这是面板脚本（含 theme-init.js）全部外链的原因。
  assert.ok(
    !/script-src[^;]*unsafe-inline/.test(CSP),
    "script-src 不得含 'unsafe-inline'（那会让注入的 <script> 执行）",
  )
})

test("CSP 的 script-src 只允许同源", () => {
  assert.ok(/script-src 'self'/.test(CSP))
})

test('⚠️ CSP 的 connect-src 必须限制为同源（防把密钥发去外部域）', () => {
  assert.ok(/connect-src 'self'/.test(CSP), 'connect-src 必须是 self，否则前端可能把密钥发去别处')
})

test('⚠️ CSP 必须禁止被 iframe 嵌套（防点击劫持）', () => {
  assert.ok(/frame-ancestors 'none'/.test(CSP))
})

test("CSP 默认全禁（default-src 'none'，逐个开口）", () => {
  assert.ok(/default-src 'none'/.test(CSP))
})

test("CSP 禁止注入 <base>（base-uri 'none'）", () => {
  assert.ok(/base-uri 'none'/.test(CSP))
})

test('内联样式是允许的（style-src 的口子是安全的）', () => {
  // 内联 style 属性不会导致脚本执行，是安全的口子
  assert.ok(/style-src 'self' 'unsafe-inline'/.test(CSP))
})

test('安全响应头齐全', () => {
  const h = securityHeaders()
  assert.equal(h['content-security-policy'], CSP)
  assert.equal(h['x-content-type-options'], 'nosniff')
  assert.equal(h['x-frame-options'], 'DENY')
  assert.equal(h['referrer-policy'], 'no-referrer')
  assert.equal(h['cache-control'], 'no-store', '面板不该被缓存（密钥状态会变）')
})

test("⚠️ CSP 的 form-action 只允许同源（登录表单要能提交，但不能提交到外部域）", () => {
  // 面板登录页有一个真实 `<form>`（JS 里 preventDefault 后用 fetch 提交）。
  // `form-action 'none'` 会让浏览器每次提交都报一条 CSP 违规（旧独立登录页实测踩过）；
  // `'self'` 仍保证「即便 JS 挂了，表单也不可能把密钥提交到外部域名」。
  assert.ok(/form-action 'self'/.test(CSP), "form-action 应为 'self'")
  assert.ok(!/form-action[^;]*(\*|https?:)/.test(CSP), 'form-action 不得放开外部域')
})

test('⚠️ img-src 只额外放开微信官方二维码域名（不得用通配 https:）', () => {
  const m = /img-src ([^;]*)/.exec(CSP)
  assert.ok(m, '应有 img-src')
  assert.deepEqual(m[1].trim().split(/\s+/), ["'self'", 'data:', 'https://open.weixin.qq.com'])
})

// ─────────────────────── 资源路由（嵌入的单页面板） ───────────────────────

test('面板入口：/panel/ 与 /panel/index.html 都返回 HTML，且不缓存', () => {
  for (const p of ['/panel/', '/panel/index.html']) {
    const a = panelAsset(p)
    assert.ok(a, `${p} 应返回面板入口`)
    assert.match(a.contentType, /^text\/html/)
    assert.match(a.body, /<div id="root"><\/div>/)
    // ⚠️ 入口必须 no-store：它引用的是带哈希的资源名，缓存旧入口 ⇒ 升级后仍加载旧版本
    assert.equal(a.cacheControl, 'no-store')
  }
})

test('🔴 入口 HTML 引用的每个 /panel/ 资源都必须真的嵌进了 manifest（否则白屏）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const refs = [...html.matchAll(/(?:src|href)="(\/panel\/[^"]+)"/g)].map((m) => m[1])
  assert.ok(refs.length >= 3, `入口应至少引用主题脚本、主 JS 与 CSS（实际 ${refs.length} 个）`)
  for (const r of refs) assert.ok(panelAsset(r), `入口引用的 ${r} 不在嵌入产物里 —— 重新跑 npm run build:web`)
  assert.ok(refs.some((r) => r.endsWith('.css')), '应引用样式表')
  assert.ok(refs.some((r) => /\/assets\/index-[\w-]+\.js$/.test(r)), '应引用主 bundle')
})

test('🔴 主 bundle 动态加载的分包也都必须嵌进 manifest（否则切到对应页才报错）', () => {
  // Vite 的懒加载页面（React.lazy）在主 bundle 里以 `assets/XxxPage-<hash>.js` 的形式出现。
  const js = Object.entries(WEB_ASSETS)
    .filter(([p]) => p.endsWith('.js'))
    .map(([, a]) => a.body)
    .join('\n')
  const chunks = new Set([...js.matchAll(/assets\/([\w-]+\.(?:js|css))/g)].map((m) => m[1]))
  assert.ok(chunks.size > 0, '应能在产物里找到分包引用')
  for (const c of chunks) assert.ok(panelAsset(`/panel/assets/${c}`), `分包 assets/${c} 未嵌入`)
})

test('⚠️ 面板 assets 用 no-cache + ETag（不能用 immutable，否则永久缓存旧产物）', () => {
  // ## 为什么改掉「永久缓存」（2026-10-21 实测）
  // 原断言的前提是「文件名带内容哈希，升级后名字会变」——**但那是假的**：
  // 面板产物是预构建后提交进仓库的，文件名硬编码（`index-Dg0M0nJm.js`），
  // 内容变了名字不变。于是 `immutable` + 一年缓存让浏览器**永不重新请求**
  // ⇒ 用户升级后界面一直显示旧版本号（实测：服务端 0.9.5、界面 0.9.2）。
  for (const [p, a] of Object.entries(WEB_ASSETS)) {
    const r = panelAsset(p)
    assert.ok(r)
    if (p.startsWith('/panel/assets/')) {
      assert.equal(r.cacheControl, 'no-cache', `${p} 必须 no-cache（回源校验），不能 immutable`)
      assert.match(r.etag, /^"[0-9a-f]+"$/, `${p} 必须有 ETag，否则 no-cache 等于每次全量重下`)
    } else {
      assert.equal(r.cacheControl, 'no-store', `${p} 不带哈希，不能缓存`)
    }
  }
})

test('⚠️ CSS / JS 返回真实内容与正确类型（不是 [object Object]）', () => {
  let css = 0
  let js = 0
  for (const [p, a] of Object.entries(WEB_ASSETS)) {
    assert.equal(typeof a.body, 'string', `${p} 应是字符串`)
    assert.ok(!a.body.startsWith('[object'), `${p} 内容不对（Text 规则没生效？）`)
    if (p.endsWith('.css')) {
      css++
      assert.match(a.type, /^text\/css/)
      assert.ok(a.body.length > 1000, '样式表不应是空壳')
    }
    if (p.endsWith('.js')) {
      js++
      assert.match(a.type, /^application\/javascript/)
    }
  }
  assert.ok(css >= 1 && js >= 2, '应至少有 1 个 CSS 与 2 个 JS（主题脚本 + 主 bundle）')
})

test('未知路径返回 undefined（由调用方 404）', () => {
  for (const p of ['/panel/nope.js', '/panel/assets/', '/panel/../src/index.ts', '/panel/constructor', '/panel/__proto__', '/login', '/']) {
    assert.equal(panelAsset(p), undefined, `${p} 不应命中`)
  }
})

test('⚠️ 网关路由：/login 跳到 /panel/，/panel/* 未知文件 404 且都在鉴权之前', () => {
  const src = readFileSync('src/index.ts', 'utf8')
  const authIdx = src.indexOf('if (!(await authorized(request, env)))')
  const asset = src.indexOf('const asset = panelAsset(path)')
  const login = src.indexOf("if (path === '/login' || path === '/login/')")
  const nf = src.indexOf("if (path.startsWith('/panel/'))")
  assert.ok(asset > 0 && login > 0 && nf > 0, '应有三条分支')
  assert.ok(asset < authIdx && login < authIdx && nf < authIdx, '⚠️ 都必须在鉴权之前（否则静态路径返回 401 JSON）')
  assert.match(src.slice(login, login + 200), /status: 302[\s\S]*location: '\/panel\/'/)
  assert.match(src.slice(nf, nf + 200), /status: 404[\s\S]*securityHeaders\(\)/, '404 也要带安全头')
  // 资源响应用 panelAsset 给的缓存策略覆盖 securityHeaders 的 no-store
  assert.match(src.slice(asset, asset + 300), /\.\.\.securityHeaders\(\)[\s\S]*'cache-control': asset\.cacheControl/)
})

// ─────────────────────── 前端安全约定（web/src 源码纪律） ───────────────────────

test('面板 HTML 不内联脚本（保 CSP 严格性）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\bsrc="\/panel\//, '每个 <script> 都必须是同源外链')
    assert.equal(m[2].trim(), '', '<script> 标签内不得有内联代码')
  }
  assert.ok(!/\son[a-z]+=/i.test(html), 'HTML 里不得有 onclick= 这类内联事件')
})

test('⚠️ 前端不用 cookie 而用 Authorization 头（豁免 CSRF）', () => {
  const all = [...webSources().values()].join('\n')
  assert.ok(!all.includes('document.cookie'), '不得读写 cookie')
  assert.ok(!/credentials:\s*'include'/.test(all), "不得用 credentials: 'include'")
  const api = webSources().get('lib/api.ts') ?? ''
  assert.match(api, /headers\.set\('authorization', 'Bearer '/, '请求应带 Authorization: Bearer 头')
})

test('⚠️ 前端不把密钥写进 URL（避免进日志 / Referer）', () => {
  for (const [f, s] of webSources()) {
    assert.ok(!/[?&](key|token|api_key|apikey)=/i.test(s), `${f} 疑似把密钥拼进了 URL`)
  }
})

test('⚠️ 前端不得用 innerHTML / dangerouslySetInnerHTML / eval 渲染数据（XSS）', () => {
  for (const [f, s] of webSources()) {
    assert.ok(!/dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|\beval\(|new Function\(/.test(s), `${f} 有不安全的 HTML/代码注入写法`)
  }
})

test('⚠️ 前端请求只打同源相对路径（与 connect-src self 对齐）', () => {
  const api = webSources().get('lib/api.ts') ?? ''
  assert.ok(!/fetch\(\s*['"`]https?:/.test(api), 'fetch 不得直连外部域名')
  for (const [f, s] of webSources()) {
    assert.ok(!/fetch\(\s*['"`]https?:\/\//.test(s), `${f} 不得 fetch 外部域名`)
  }
})

test('⚠️ 外链必须带 rel="noreferrer"（防 window.opener 与 Referer 泄露）', () => {
  for (const [f, s] of webSources()) {
    for (const m of s.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
      assert.match(m[0], /rel="[^"]*noreferrer/, `${f} 的 ${m[0].slice(0, 60)} 缺 rel="noreferrer"`)
    }
  }
})

test('⚠️ 主题初始化在任何渲染之前执行（外链脚本，避免首屏闪白）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const theme = html.indexOf('/panel/theme-init.js')
  const main = html.search(/\/panel\/assets\/index-[\w-]+\.js/)
  assert.ok(theme > 0 && main > 0 && theme < main, 'theme-init.js 必须在主 bundle 之前加载')
  assert.ok(!/type="module"[^>]*theme-init/.test(html), 'theme-init 必须是同步经典脚本（module 会延迟执行）')
  const js = panelAsset('/panel/theme-init.js')?.body ?? ''
  assert.ok(/localStorage/.test(js) && /prefers-color-scheme/.test(js), '应读用户偏好并跟随系统')
})

test('⚠️ 版本号与 package.json 一致（由构建注入，不在源码里硬编码）', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  const js = Object.entries(WEB_ASSETS)
    .filter(([p]) => p.endsWith('.js'))
    .map(([, a]) => a.body)
    .join('\n')
  assert.ok([JSON.stringify(pkg.version), `\`${pkg.version}\``, `v${pkg.version}`].some((v) => js.includes(v)),
    `嵌入的面板产物里找不到版本 ${pkg.version} —— 改版本后要重跑 npm run build:web`)
  for (const [f, s] of webSources()) assert.ok(!/\bv\d+\.\d+\.\d+\b/.test(s), `${f} 不得硬编码版本号`)
})

test('⚠️ 嵌入产物与前端源码同步（改了 web/ 必须重跑 npm run build:web）', () => {
  // 只做粗检：每个懒加载页面在产物里都有对应分包，入口引用的 CSS 存在。
  // 精确的「源码 → 产物」一致性只能靠构建；CI / 提交前跑 npm run build:web 是硬约定。
  const app = webSources().get('App.tsx') ?? ''
  const lazyPages = [...app.matchAll(/import\('@\/pages\/(\w+)'\)/g)].map((m) => m[1])
  assert.ok(lazyPages.length > 0, 'App.tsx 应有懒加载页面')
  for (const page of lazyPages) {
    assert.ok(Object.keys(WEB_ASSETS).some((p) => p.startsWith(`/panel/assets/${page}-`)), `产物里没有 ${page} 分包`)
  }
})

// ─────────────────────── 面板依赖的后端行为 ───────────────────────

test('⚠️ /v1/models 必须只列「有账号」的供应商的模型（登录后才显示）', () => {
  // 用户要求：没登录的提供商默认不在 API 里显示，登录后再显示。
  //
  // ⚠️ 实现方式**不是**「预先关闭模型」—— 没有账号时根本拉不到模型目录
  //（列模需要凭据），所以无法预先知道要关哪些 id。
  // 正确做法是 /v1/models **按账号聚合**：遍历有账号的供应商逐个拉目录，
  // 没账号的自然不出现。这也让「登录后再显示」自动成立。
  // ⚠️ 单测是**打包后**在 `.build/tests/` 下跑的，故相对路径要指回源码根。
  // 用 process.cwd()（脚本从仓库根运行）最稳。
  const src = readFileSync('src/index.ts', 'utf8')
  // 简单起见：断言关键标识符存在（比跨行正则更稳）
  assert.ok(src.includes('byProvider'), '/v1/models 应按供应商分组账号')
  assert.ok(/for \(const \[providerId, list\] of byProvider\)/.test(src), '应逐个有账号的供应商拉目录')
  assert.ok(src.includes('provider.capabilities.listModels'), '应只对有列模能力的供应商拉目录')
})

test('⚠️ /v1/models 目录里不得出现裸名（一律带 provider/ 前缀）', () => {
  // 用户要求：「api 上没有前缀的 deepseek-v4.1-flash 和 glm-5.3-flash
  // 是哪个供应商的，加上前缀，方便区分」。
  //
  // 早先给默认供应商额外暴露一份裸名，于是同一模型在目录里出现两次
  //（`buddy/glm-5.3-flash` 与 `glm-5.3-flash`），而多家又有同名模型
  //（buddy / codearts / trae 都有 `deepseek-v4.1-flash`）——
  // 裸名根本分不清是哪一家。
  const src = readFileSync('src/index.ts', 'utf8')
  // ⚠️ 断言锁**事实**（id 由 providerId 与 m.id 拼成、且真的进入 data），
  // 不锁**写法**（是否被 `annotateModelEntry(...)` 包了一层）。
  //
  // 原写法要求逐字匹配 `data.push({ ...base, id: ... })`，于是给它加一层
  // 包装（补渠道前缀与倍率）就会**误报失败**，而实际行为完全没变。
  // 本项目已多次吃过「源码文本断言锁死写法」的亏。
  assert.ok(
    /id: `\$\{providerId\}\/\$\{m\.id\}`/.test(src),
    '目录项的 id 必须由 providerId/m.id 拼成（带 provider/ 前缀）',
  )
  assert.ok(
    /data\.push\([\s\S]{0,160}id: `\$\{providerId\}\/\$\{m\.id\}`/.test(src),
    '该拼接必须真的进入 data（不能只定义在别处）',
  )
  // 不能再有针对默认供应商的裸名分支
  assert.ok(
    !/if \(providerId === DEFAULT_PROVIDER\) data\.push\(base\)/.test(src),
    '不得再单独给默认供应商推裸名',
  )
})

test('⚠️ 裸名仍必须能路由（目录不带前缀 ≠ 请求不接受裸名）', () => {
  // 目录负责「说清楚」，路由负责「不 breaking」——
  // 已有客户端配置里写的裸名不能因为这个改动而失效。
  const r = splitModelName('deepseek-v4.1-flash', ['buddy', 'codearts', 'trae'], 'buddy')
  assert.equal(r.provider, 'buddy', '裸名回退到默认供应商')
  assert.equal(r.model, 'deepseek-v4.1-flash')

  // 而带前缀时按前缀路由，不会混淆同名模型
  const c = splitModelName('codearts/deepseek-v4.1-flash', ['buddy', 'codearts', 'trae'], 'buddy')
  assert.equal(c.provider, 'codearts')
  assert.equal(c.model, 'deepseek-v4.1-flash')
})

test('⚠️ 模型目录必须逐个账号尝试，不能只取第一个（商汤报障的根因）', () => {
  // ## 实测缺陷（用户报「商汤账号怎么又不行了，明明是用微信扫码登录的」）
  //
  // 原实现是 `accounts.find(...)` —— 拿**第一个**该供应商的账号就去拉目录。
  // 而池里可能有多个账号（实测商汤有 2 个），**第一个恰好是坏号**
  //（refresh_token 已失效）时，整个目录请求就失败；另一个好号明明能拉，
  // 而且正是 `chat`（走 `pick()`，会自动跳过坏号）在用的那个。
  //
  // ## 为什么这个缺陷极具误导性
  //
  // 表现为「**同一个账号 chat 完全正常，模型列表却报登录态已过期**」——
  // 用户会以为整个账号废了，实际只是两条路径的**选号策略不一致**。
  //
  // ⚠️ 这类缺陷的形状：**同一份数据、两条路径、两种选号方式**。
  // 修一处不够，必须让两条路径的判据一致。
  const src = readFileSync('src/index.ts', 'utf8')
  const i = src.indexOf("if (path === '/admin/providers/models'")
  assert.ok(i > 0, '应能找到模型目录端点')
  // ⚠️ **必须先剥掉注释再断言** —— 修缺陷时我会在注释里写下「原实现是
  // `accounts.find(...)`」作为反例，而那会让朴素的源码搜索**误报**。
  //（本仓库其它测试也踩过同一个坑：注释里提到禁用字符会误伤。）
  const block = stripComments(src.slice(i, i + 6000))

  // 不得再用 find 取第一个
  assert.ok(
    !/accounts\.find\(/.test(block),
    '⚠️ 不得用 `accounts.find()` 只取第一个账号 —— 坏号会拖垮整个目录请求',
  )
  // 必须是收集候选 + 逐个尝试
  assert.ok(/candidates\.push\(/.test(block), '应收集全部候选账号')
  assert.ok(/for \(const cand of candidates\)/.test(block), '应逐个尝试候选账号')
})

test('⚠️ 模型目录的候选筛选必须与 chat 的健康判据一致', () => {
  // ⚠️ 只遍历而不筛健康状态，等于把坏号也算进重试 —— 白打上游，
  // 且在 refresh_token 已失效（**终态**）时反复触发续期请求。
  const src = readFileSync('src/index.ts', 'utf8')
  const i = src.indexOf("if (path === '/admin/providers/models'")
  const block = src.slice(i, i + 6000)
  /**
   * 🔴 **不得手抄判据，必须复用 `healthy()`**（2026-10-21 审查补，重复实现专项）。
   *
   * 这个位置已经付过一次学费：M5 时发现它只查了 3 个字段、漏了
   * `restrictedUntil`（上游封号）与 `degradeUntil`（连续业务失败降权），
   * 坏号被排到前面白打上游，表现是「模型列表报登录态过期，而池里明明有好号」。
   *
   * 后来把 5 个字段补齐了 —— 但那仍然是**手抄**：`healthy()` 下次加第 6 个维度时，
   * 这里会静默漏判，且**没有任何测试会红**。
   *
   * 所以断言改成「必须调用 `healthy(`」＋「不得再出现手抄的字段比较」。
   */
  assert.ok(
    /healthy\(a, Date\.now\(\)\)/.test(block),
    '候选筛选必须复用 `healthy(a, Date.now())`，不要手抄一份判据',
  )
  assert.ok(
    !/a\.(until|breakerUntil|restrictedUntil|degradeUntil)\s*>/.test(block),
    '这里不该再出现手抄的字段比较 —— 判据只能有一份（state.ts 的 healthy）',
  )
})

test('🔴 供应商关闭必须真的关掉（服务端状态 + 双向拦截）', () => {
  // 用户明确：「彻底关掉（面板 + API 都消失）」。
  // ⚠️ 只在面板隐藏是不够的 —— 客户端可能缓存了旧目录，或按名字硬编码调用。
  const index = readFileSync('src/index.ts', 'utf8')
  const server = readFileSync('src/gateway/server.ts', 'utf8')

  // ① /v1/models 要跳过被关闭的家
  assert.ok(/userDisabledProviders\.has\(providerId\)/.test(index),
    '⚠️ /v1/models 必须跳过被关闭的供应商')

  // ② 路由要拒绝
  assert.ok(index.includes('/admin/providers/settings'), '应有设置端点')
  assert.ok(server.includes('isProviderClosedByUser'), '路由必须有「已关闭」判据')
  assert.ok(/provider_disabled/.test(server), '应回一个可识别的错误码')

  // ③ ⚠️ 判据读**服务端**设置，不是浏览器 localStorage
  assert.ok(/getProviderSettings/.test(server), '判据必须读服务端设置（localStorage 只在面板生效）')

  // ④ ⚠️ 读失败必须按「没关」处理 —— 不能把偏好读取失败放大成全面 403
  const i = server.indexOf('async function isProviderClosedByUser')
  const block = server.slice(i, i + 400)
  assert.ok(/catch\s*\{[\s\S]*?return false/.test(block), '⚠️ 读设置失败必须回 false（不能全面 403）')
})

test('⚠️ 供应商排序不得改变默认供应商（避免悄悄改路由）', () => {
  // 用户选择：「只影响面板展示顺序」，不改默认供应商。
  // ⚠️ 若排序决定默认值，裸模型名的既有请求会被悄悄路由到别家 —— 不可接受。
  const src = readFileSync('src/providers/index.ts', 'utf8')
  assert.ok(/export const DEFAULT_PROVIDER = PROVIDERS\[0\]/.test(src),
    '默认供应商必须仍由**注册表第 0 项**决定，不受面板排序影响')
  // 面板设置里不该有「默认供应商」这个概念
  const index = readFileSync('src/index.ts', 'utf8')
  const i = index.indexOf("path === '/admin/providers/settings'")
  const block = index.slice(i, i + 900)
  assert.ok(!/defaultProvider/.test(block), '设置端点不该改默认供应商')
})

test('🔴 loomy 必须支持短信验证码登录（且走**两步流程**，不是轮询）', () => {
  // 用户要求「Loomy 和 LobsterAI 的设备码登录尽量支持一下」。
  //
  // 实测结论（读了参考实现）：
  // · **loomy 短信**：纯 HTTP 三步（发码 → 用户输入 → 校验），
  //   `loomy-oauth.ts` 里 `127.0.0.1` 出现 **0 次** ⇒ **Workers 上可行**。
  // · **loomy 微信扫码**：需要本地服务器承载弹窗页
  //   （`loomy-wechat-login.ts:11-13` 的 `127.0.0.1:随机端口`）⇒ **不可行**。
  // · **lobsterai**：强制 `http://127.0.0.1:{port}/auth/callback`
  //   （`lobsterai-oauth.ts:95,109`）⇒ **不可行**，已如实声明。
  const loomy = readFileSync('src/providers/loomy.ts', 'utf8')
  assert.ok(/login: true/.test(loomy), 'loomy 应声明 login: true（短信已接线）')

  const index = readFileSync('src/index.ts', 'utf8')
  // 第 1 步：发码（要 phone）
  assert.ok(index.includes("providerId === 'loomy'"), '应有 loomy 发起分支')
  assert.ok(/sendLoomySmsCode/.test(index), '第 1 步应调 sendLoomySmsCode')
  // 第 2 步：提交验证码（**单独端点**，不是 poll）
  assert.ok(index.includes("/admin/providers/login/loomy/sms"), '应有短信提交端点')
  assert.ok(/loginLoomyBySmsCode/.test(index), '第 2 步应调 loginLoomyBySmsCode')
  // ⚠️ 必须是 POST 而不是 GET：验证码进 URL 会落进日志与 Referer
  const i = index.indexOf("path === '/admin/providers/login/loomy/sms'")
  assert.ok(/request\.method === 'POST'/.test(index.slice(i, i + 80)), '⚠️ 提交验证码必须用 POST')

  // ⚠️ msgid 必须持久化（Workers 无跨请求内存）；丢了会被上游判「msgid 无效」
  assert.ok(/msgid/.test(index.slice(index.indexOf("providerId === 'loomy'"), index.indexOf("providerId === 'loomy'") + 2500)),
    '⚠️ 发码后必须把 msgid 存进登录会话')
})

test('⚠️ lobsterai 必须如实声明登录不可行（强制 127.0.0.1 回调）', () => {
  // ⚠️ 用户希望「尽量支持」，但它**架构上不可行** —— 参考实现
  // `lobsterai-oauth.ts:95,109` 明确：`redirect_uri` **必须**是
  // `http://127.0.0.1:{port}/auth/callback`，且回调服务器绑 `127.0.0.1`
  // （`:342` 注释：「绑 127.0.0.1 而非 0.0.0.0：回调只可能来自本机浏览器」）。
  // Workers 没有 listen socket ⇒ 这条链不成立。
  const src = readFileSync('src/providers/lobsterai.ts', 'utf8')
  assert.ok(/login: false/.test(src), 'lobsterai 应如实声明 login: false')
  assert.ok(/loginBlockedReason/.test(src), '必须说明原因（不能只给个 false）')
  // ⚠️ 原因里要说清「怎么做才能用」（导出凭据导入），否则用户卡死
  assert.ok(/导出凭据|粘贴/.test(src), '原因里要给出替代做法')
})

test('🔴 byHour 必须带 token（否则「按小时」给不出用量）', () => {
  // 上一条测试断言「按小时要显示 tokens」，其前提是**后端确实算了**。
  // 这个前提若变了，那条断言就只是空转。
  const src = readFileSync('src/store/usage.ts', 'utf8')
  const iface = src.slice(src.indexOf('export interface UsageHour'))
  const body = iface.slice(0, iface.indexOf('}'))
  for (const k of ['input', 'output']) {
    assert.ok(new RegExp(`\\b${k}\\b`).test(body),
      `⚠️ UsageHour 必须包含 ${k}（否则按小时给不出 token 量）`)
  }
  // ⚠️ 旧数据没有这两个字段 ⇒ 累加时必须按 0 兜底，否则整列变 NaN
  assert.ok(/prev\?\.input \?\? 0/.test(src) && /prev\?\.output \?\? 0/.test(src),
    '⚠️ 旧数据的 byHour 没有 input/output，累加必须 ?？ 0 兜底（否则显示 NaN）')
  assert.ok(/v\.input \?\? 0/.test(src) && /v\.output \?\? 0/.test(src),
    '⚠️ 汇总合并时同样要兜底')
})

test('🔴 聚合只暴露白名单两个模型（用户要求）', () => {
  // 用户原话：「aggregate 只保留 deepseek-v4-1-flash 和 glm-5-3-flash 就行了，
  // 其它的用不上」。
  const src = readFileSync('src/gateway/aggregate.ts', 'utf8')
  assert.ok(/AGGREGATE_ALLOWED_KEYS/.test(src), '应有白名单常量')
  // ⚠️ 必须是白名单（只放认过的），不是黑名单 ——
  // 黑名单会让「上游每加一个模型，聚合目录就多一行」。
  assert.ok(/'deepseek-v4-1-flash'/.test(src) && /'glm-5-3-flash'/.test(src),
    '白名单应含这两个规范名')
  // ⚠️ 过滤必须在 buildVirtualModels 内收口（聚合有目录 + chat 两条路径）
  const fn = src.slice(src.indexOf('export function buildVirtualModels'))
  assert.ok(/AGGREGATE_ALLOWED_KEYS\.has\(key\)/.test(fn.slice(0, fn.indexOf('\n}'))),
    '⚠️ 白名单必须在 buildVirtualModels 内收口，否则两条路径只堵住一条')
})

test('⚠️ /favicon.ico 必须显式处理（否则每次访问多一条 401）', () => {
  // 浏览器对每个页面都会自动请求 /favicon.ico（无需 <link>）。
  // 此前它落进鉴权分支：未登录时返回 401 JSON ⇒ 控制台凭空多一条错误。
  const src = readFileSync('src/index.ts', 'utf8')
  assert.ok(/path === '\/favicon\.ico'/.test(src), '应显式处理 /favicon.ico')
  const i = src.indexOf("path === '/favicon.ico'")
  const block = src.slice(i, i + 200)
  assert.ok(/204/.test(block), '应返回 204 No Content')
  // ⚠️ 必须在**鉴权之前**：否则又变回 401（这正是要修的东西）
  const authIdx = src.indexOf('if (!(await authorized(request, env)))')
  assert.ok(authIdx > 0 && i < authIdx, '⚠️ favicon 处理必须在鉴权之前')
})

test('⚠️ /v1/models 的每个条目都应有 name（aggregate 曾是整列空白）', () => {
  // 报告：模型页 19 个 `aggregate/*` 条目名称列为空，看起来像渲染失败。
  // 根因在后端：`VirtualModel` 本来就有 `name` 字段，只是没往外发。
  const src = readFileSync('src/index.ts', 'utf8')
  const i = src.indexOf('AGGREGATE_AUTO}')
  assert.ok(i > 0, '应能定位 aggregate 条目构造')
  const seg = src.slice(i, i + 900)
  assert.ok(/name:\s*'自动选择/.test(seg), '⚠️ aggregate/auto 必须给 name')
  assert.ok(/name:\s*v\.name\s*\|\|\s*v\.key/.test(seg),
    '⚠️ 虚拟模型必须有 name（并兜底到 key，避免空单元格）')
})
