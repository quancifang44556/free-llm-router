import { ArrowRight, Eye, EyeOff, Loader2, Route } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { api, ApiError, auth } from '@/lib/api'

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api('/admin/pool?realm=cn', { key: key.trim() })
      auth.set(key.trim())
      onLogin()
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? '口令不对，请检查部署时设置的 API_KEY' : '连不上网关：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative grid min-h-dvh lg:grid-cols-2">
      <div className="bg-primary relative hidden overflow-hidden lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,.18),transparent_45%),radial-gradient(circle_at_80%_70%,rgba(255,255,255,.12),transparent_40%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.07)_1px,transparent_1px)] bg-[size:40px_40px]" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-2.5 text-[15px] font-semibold">
            <div className="flex size-8 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/25">
              <Route className="size-[18px]" />
            </div>
            free-llm-router
          </div>
          <div>
            <div className="max-w-md text-3xl leading-snug font-semibold">一个 base URL，一把 key，背后是整个账号池。</div>
            <div className="mt-4 max-w-md text-white/75">OpenAI 兼容网关：自动选号、冷却、熔断与跨渠道容灾，外加签到与成长任务自动化。</div>
          </div>
          <div className="text-xs text-white/60">v{__APP_VERSION__} · 仅限本人授权账号自用</div>
        </div>
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="bg-primary text-primary-foreground mb-6 flex size-10 items-center justify-center rounded-xl shadow-sm lg:hidden">
            <Route className="size-5" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">登录控制台</h1>
          <p className="text-muted-foreground mt-1.5">输入部署时设置的 API_KEY（主密钥）。</p>

          <div className="mt-8">
            <Label htmlFor="key">主密钥</Label>
            <div className="relative">
              <Input
                id="key"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="h-10 pr-10"
                placeholder="API_KEY"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer"
                aria-label={show ? '隐藏' : '显示'}
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {err && <div className="text-danger mt-2 text-[13px]">{err}</div>}
          </div>

          <Button type="submit" className="mt-5 h-10 w-full" disabled={!key.trim() || busy}>
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : (
              <>
                进入控制台 <ArrowRight />
              </>
            )}
          </Button>

          <div className="text-muted-foreground mt-8 space-y-1.5 border-t pt-5 text-xs leading-relaxed">
            <div>
              Cloudflare：
              <code className="bg-muted rounded px-1 py-0.5 font-mono">wrangler secret put API_KEY</code>
            </div>
            <div>
              Node / VPS：环境变量 <code className="bg-muted rounded px-1 py-0.5 font-mono">API_KEY</code>
            </div>
            <div>口令只保存在本浏览器，不使用 cookie。</div>
          </div>
        </form>
      </div>
    </div>
  )
}
