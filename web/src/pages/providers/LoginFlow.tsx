import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Copy, ExternalLink, Loader2, MessageSquareText, QrCode, RotateCcw, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button, buttonClass } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { Provider } from '@/lib/types'

/** 登录方式不是标准设备码的几家：按钮与说明要写实际方式，别让用户去找不存在的设备码。 */
const KIND_LABEL: Record<string, string> = {
  codearts: '浏览器登录',
  trae: '浏览器登录',
  raccoon: '微信扫码登录',
  cline: '用户码登录',
  minimax: '用户码登录',
  loomy: '短信 / 微信登录',
}
export const loginKindLabel = (id: string) => KIND_LABEL[id] ?? '设备码登录'

/** 浏览器回跳式登录：授权完会跳到本服务的提示页，提醒用户回来等。 */
const CALLBACK_HINT: Record<string, string> = {
  codearts: '完成华为登录后浏览器会跳到本服务的提示页，回到这里等待即可，凭据会自动保存。',
  trae: '完成 TRAE 登录后浏览器会跳到本服务的提示页，回到这里等待即可，凭据会自动保存。',
}

interface StartBody {
  state: string
  authUrl?: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete?: string
  qrSvg?: string
  qrUrl?: string
  qrImageUrl?: string
  expiresInMs?: number
}

interface PollBody {
  done?: boolean
  uid?: string
  nickname?: string
  status?: string
  message?: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; start: StartBody; message: string }
  | { kind: 'bind'; state: string; nickname?: string }
  | { kind: 'done'; who: string }
  | { kind: 'failed'; message: string }

/** 只放行 https（以及本机 http），挡掉 javascript: 之类的链接。 */
function safeHref(raw?: string): string {
  if (!raw) return ''
  try {
    const u = new URL(raw, location.origin)
    if (u.protocol === 'https:') return u.href
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.href
  } catch {
    /* 非法 URL */
  }
  return ''
}

const POLL_MS = 3000

export function LoginFlow({ provider }: { provider: Provider }) {
  const qc = useQueryClient()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [loomyMode, setLoomyMode] = useState<'sms' | 'wechat' | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const finish = (who: string) => {
    if (!alive.current) return
    setPhase({ kind: 'done', who })
    for (const k of ['accounts', 'pool', 'credentials']) qc.invalidateQueries({ queryKey: [k] })
    toast.success(`${provider.name} 账号已添加`, { description: who })
  }

  // 轮询：每 3 秒一次，直到成功 / 失败 / 过期 / 组件卸载
  const pollToken = phase.kind === 'waiting' ? phase.start.state : ''
  useEffect(() => {
    if (!pollToken) return
    const buddyPath = provider.id === 'buddy' ? '/admin/login/poll' : '/admin/providers/login/poll'
    const deadline = Date.now() + Math.min((phase.kind === 'waiting' && phase.start.expiresInMs) || 5 * 60_000, 15 * 60_000)
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!alive.current) return
      if (Date.now() > deadline) {
        setPhase({ kind: 'failed', message: '授权超时，请重新发起登录。' })
        return
      }
      try {
        const r = await api<PollBody>(`${buddyPath}?state=${encodeURIComponent(pollToken)}`)
        if (!alive.current) return
        if (r.done) return finish(r.nickname || r.uid || '登录成功')
        if (r.status === 'need_phone')
          return setPhase({
            kind: 'bind',
            state: pollToken,
            nickname: r.nickname,
          })
        if (r.status === 'failed' || r.status === 'canceled' || r.message === '会话不存在或已过期')
          return setPhase({ kind: 'failed', message: r.message || '登录失败' })
        if (r.message) setPhase((p) => (p.kind === 'waiting' ? { ...p, message: r.message! } : p))
      } catch {
        /* 网络抖动：继续等下一轮 */
      }
      timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollToken])

  const start = async (extra: Record<string, unknown> = {}) => {
    setPhase({ kind: 'starting' })
    try {
      const endpoint = provider.id === 'buddy' ? '/admin/login/start' : '/admin/providers/login/start'
      const r = await api<StartBody>(endpoint, {
        json: { realm: 'cn', provider: provider.id, ...extra },
      })
      if (!alive.current) return
      if (!r.authUrl && !r.userCode && !r.qrSvg && !r.qrImageUrl) {
        setPhase({
          kind: 'failed',
          message: '服务端没有返回可用的登录方式，请刷新页面重试。',
        })
        return
      }
      setPhase({
        kind: 'waiting',
        start: r,
        message: r.qrSvg || r.qrImageUrl ? '等待扫码…' : '等待授权中…',
      })
    } catch (e) {
      setPhase({ kind: 'failed', message: (e as Error).message })
    }
  }

  const reset = () => {
    setPhase({ kind: 'idle' })
    setLoomyMode(null)
  }

  if (phase.kind === 'done')
    return (
      <div className="flex flex-col items-center rounded-lg border px-4 py-6 text-center">
        <CheckCircle2 className="text-success size-8" />
        <div className="mt-2 font-medium">登录成功</div>
        <div className="text-muted-foreground mt-0.5 text-[13px]">{phase.who} 已加入账号池</div>
        <Button variant="outline" size="sm" className="mt-4" onClick={reset}>
          再添加一个
        </Button>
      </div>
    )

  if (phase.kind === 'failed')
    return (
      <div className="border-danger/30 bg-danger/5 rounded-lg border px-4 py-4">
        <div className="text-danger flex items-center gap-2 text-[13px] font-medium">
          <XCircle className="size-4" /> 登录没有完成
        </div>
        <p className="text-muted-foreground mt-1 text-[13px] break-words">{phase.message}</p>
        <p className="text-muted-foreground mt-1 text-xs">可以重试，或改用下面的「粘贴凭据导入」。</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={reset}>
          <RotateCcw /> 重新开始
        </Button>
      </div>
    )

  if (phase.kind === 'waiting') return <WaitingPrompt providerId={provider.id} start={phase.start} message={phase.message} onCancel={reset} />

  if (phase.kind === 'bind') return <LoomyBind state={phase.state} nickname={phase.nickname} onDone={finish} onCancel={reset} />

  if (provider.id === 'loomy') {
    if (loomyMode === 'sms') return <LoomySms onDone={finish} onCancel={reset} />
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setLoomyMode('sms')}>
          <MessageSquareText /> 短信验证码
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={phase.kind === 'starting'}
          onClick={() => {
            setLoomyMode('wechat')
            void start({ mode: 'wechat' })
          }}
        >
          {phase.kind === 'starting' ? <Loader2 className="animate-spin" /> : <QrCode />} 微信扫码
        </Button>
      </div>
    )
  }

  return (
    <Button size="sm" disabled={phase.kind === 'starting'} onClick={() => void start()}>
      {phase.kind === 'starting' && <Loader2 className="animate-spin" />}
      发起{loginKindLabel(provider.id)}
    </Button>
  )
}

function copy(text: string, what: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success(`已复制${what}`),
    () => toast.error('复制失败，请手动选择'),
  )
}

function WaitingPrompt({ providerId, start, message, onCancel }: { providerId: string; start: StartBody; message: string; onCancel: () => void }) {
  const verify = safeHref(start.verificationUriComplete || start.verificationUri)
  const auth = safeHref(start.authUrl)
  const qrLink = safeHref(start.qrUrl)
  const qrImg = safeHref(start.qrImageUrl)
  // SVG 二维码走 data: 图片渲染（CSP 已放行 img-src data:），不把服务端字符串注入 DOM
  const qrSvg = start.qrSvg ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(start.qrSvg) : ''

  return (
    <div className="rounded-lg border p-4">
      {start.userCode ? (
        <>
          <p className="text-[13px]">打开授权页面，输入下面的代码完成授权：</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="bg-muted rounded-md px-3 py-1.5 font-mono text-lg font-semibold tracking-[0.2em] select-all">{start.userCode}</code>
            <Button variant="ghost" size="icon-sm" aria-label="复制代码" onClick={() => copy(start.userCode!, '代码')}>
              <Copy />
            </Button>
          </div>
          {verify && (
            <a href={verify} target="_blank" rel="noreferrer noopener" className={buttonClass('default', 'sm', 'mt-3')}>
              <ExternalLink /> 打开授权页面
            </a>
          )}
          <p className="text-muted-foreground mt-2 text-xs">链接里已带上代码时直接确认即可，否则手动输入上面的代码。</p>
        </>
      ) : qrImg || qrSvg ? (
        <>
          <p className="text-[13px]">用微信扫描下方二维码完成授权：</p>
          <div className="mt-3 inline-block rounded-lg border bg-white p-2">
            <img src={qrImg || qrSvg} alt="登录二维码" width={180} height={180} referrerPolicy="no-referrer" />
          </div>
          {qrLink && (
            <a href={qrLink} target="_blank" rel="noreferrer noopener" className="text-primary mt-1 block text-xs hover:underline">
              二维码显示不出来？点这里打开
            </a>
          )}
        </>
      ) : (
        <>
          <p className="text-[13px]">在浏览器里打开授权页面，登录并确认授权：</p>
          {auth && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a href={auth} target="_blank" rel="noreferrer noopener" className={buttonClass('default', 'sm')}>
                <ExternalLink /> 打开授权页面
              </a>
              <Button variant="outline" size="sm" onClick={() => copy(auth, '授权链接')}>
                <Copy /> 复制链接
              </Button>
            </div>
          )}
          {CALLBACK_HINT[providerId] && <p className="text-muted-foreground mt-2 text-xs">{CALLBACK_HINT[providerId]}</p>}
        </>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-muted-foreground flex items-center gap-2 text-[13px]">
          <Loader2 className="size-3.5 animate-spin" /> {message}
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  )
}

function LoomySms({ onDone, onCancel }: { onDone: (who: string) => void; onCancel: () => void }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [state, setState] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const send = async () => {
    setBusy(true)
    setMsg('')
    try {
      const r = await api<{ state: string }>('/admin/providers/login/start', {
        json: { provider: 'loomy', phone: phone.trim(), realm: 'cn' },
      })
      setState(r.state)
      setMsg('验证码已发送，请查收短信。')
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const submit = async () => {
    setBusy(true)
    setMsg('')
    try {
      const r = await api<{ uid?: string; nickname?: string }>('/admin/providers/login/loomy/sms', {
        json: { state, code: code.trim(), realm: 'cn' },
      })
      onDone(r.nickname || r.uid || phone)
    } catch (e) {
      // 验证码失效后要重新发：回到第一步
      setState('')
      setCode('')
      setMsg(`${(e as Error).message}。请重新发送验证码。`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-[13px]">讯飞（Loomy）用短信验证码登录。</p>
      <div className="flex gap-2">
        <Input
          type="tel"
          inputMode="numeric"
          maxLength={11}
          placeholder="11 位手机号"
          value={phone}
          disabled={!!state}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Button variant="outline" disabled={busy || !!state || !/^1\d{10}$/.test(phone.trim())} onClick={send}>
          发送验证码
        </Button>
      </div>
      {state && (
        <div className="flex gap-2">
          <Input inputMode="numeric" maxLength={8} placeholder="短信验证码" value={code} autoFocus onChange={(e) => setCode(e.target.value)} />
          <Button disabled={busy || !code.trim()} onClick={submit}>
            {busy && <Loader2 className="animate-spin" />}登录
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">{msg}</span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          返回
        </Button>
      </div>
    </div>
  )
}

function LoomyBind({ state, nickname, onDone, onCancel }: { state: string; nickname?: string; onDone: (who: string) => void; onCancel: () => void }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const call = async (action: 'send' | 'check') => {
    setBusy(true)
    setMsg('')
    try {
      const r = await api<{ uid?: string; nickname?: string }>('/admin/providers/login/loomy/bind', {
        json: action === 'send' ? { state, action, phone: phone.trim(), realm: 'cn' } : { state, action, code: code.trim(), realm: 'cn' },
      })
      if (action === 'send') {
        setSent(true)
        setMsg('验证码已发送')
      } else onDone(r.nickname || r.uid || nickname || phone)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-[13px]">
        {nickname ? `微信「${nickname}」` : '这个微信号'}
        还没绑定手机号，填写手机号完成绑定：
      </p>
      <div className="flex gap-2">
        <Input type="tel" inputMode="numeric" maxLength={11} placeholder="11 位手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Button variant="outline" disabled={busy || !/^1\d{10}$/.test(phone.trim())} onClick={() => call('send')}>
          发送验证码
        </Button>
      </div>
      <div className="flex gap-2">
        <Input inputMode="numeric" maxLength={8} placeholder="短信验证码" value={code} onChange={(e) => setCode(e.target.value)} />
        <Button disabled={busy || !sent || !code.trim()} onClick={() => call('check')}>
          完成绑定
        </Button>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">{msg}</span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  )
}
