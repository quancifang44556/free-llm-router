import { CalendarClock, Copy, Eye, EyeOff, Gauge, Lock, Route, ShieldAlert, ShieldCheck, ShieldCog, Snowflake, Terminal } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input, Switch } from '@/components/ui/input'
import { ProviderAvatar, Segmented, Skeleton } from '@/components/ui/misc'
import { auth } from '@/lib/api'
import {
  type RoutingConfig,
  type SafetyConfig,
  type Strategy,
  useClearCooldowns,
  useClearWaf,
  useCredentialCount,
  usePermanentLocks,
  useRoutingConfig,
  useSafetyConfig,
  useSaveRouting,
  useSaveSafety,
  useSetPermanentLock,
  useWaf,
} from '@/lib/config'
import { dshSnippet } from '@/lib/dsh'
import { useModelCatalog } from '@/lib/models'
import { useAccounts, usePool, useProviders } from '@/lib/queries'
import { cn, fmtDateTime, fmtInt } from '@/lib/utils'
import { copyText } from './ModelsPage'

export function ConfigPage() {
  return (
    <>
      <PageHeader title="配置" description="客户端接入方式、路由策略与运行状态。" />
      <div className="grid gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-3">
          <ConnectCard />
          <RoutingCard />
          <SafetyCard />
        </div>
        <div className="space-y-4 xl:col-span-2">
          <StatusCard />
          <LocksCard />
        </div>
      </div>
    </>
  )
}

function SectionIcon({ children }: { children: ReactNode }) {
  return <span className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4">{children}</span>
}

function Head({ icon, title, desc, action }: { icon: ReactNode; title: string; desc?: ReactNode; action?: ReactNode }) {
  return (
    <CardHeader className="flex flex-row items-start gap-3">
      <SectionIcon>{icon}</SectionIcon>
      <div className="min-w-0 flex-1">
        <CardTitle>{title}</CardTitle>
        {desc && <CardDescription className="mt-0.5">{desc}</CardDescription>}
      </div>
      {action}
    </CardHeader>
  )
}

// ── 接入指南 ──

type Snippet = 'curl' | 'python' | 'env' | 'dsh'

function ConnectCard() {
  const [show, setShow] = useState(false)
  const [snippet, setSnippet] = useState<Snippet>('curl')
  const key = auth.get()
  const masked = key.length > 16 ? `${key.slice(0, 4)}${'•'.repeat(12)}${key.slice(-4)}` : '•'.repeat(Math.max(key.length, 8))
  const base = `${location.origin}/v1`
  // 只有切到 DSH 片段才拉目录（/v1/models 要逐家问上游，配置页本身不需要它）
  const catalog = useModelCatalog(snippet === 'dsh')
  const code = useMemo(() => {
    const k = show ? key : 'YOUR_API_KEY'
    if (snippet === 'dsh') return dshSnippet(base, k, catalog.data?.models ?? [])
    if (snippet === 'curl')
      return `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"aggregate/auto","messages":[{"role":"user","content":"你好"}]}'`
    if (snippet === 'python')
      return `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="${k}")
r = client.chat.completions.create(
    model="aggregate/auto",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)`
    return `OPENAI_BASE_URL=${base}
OPENAI_API_KEY=${k}`
  }, [snippet, show, key, base, catalog.data])

  return (
    <Card>
      <Head icon={<Terminal />} title="接入指南" desc="任何支持 OpenAI 接口的客户端都能直接用：/v1/models、/v1/chat/completions、/v1/responses。" />
      <div className="space-y-3 px-5 pb-5">
        <Field label="Base URL" value={base} onCopy={() => copyText(base, '已复制 Base URL')} />
        <Field
          label="主密钥"
          value={show ? key : masked}
          mono
          onCopy={() => copyText(key, '已复制主密钥')}
          extra={
            <Button variant="ghost" size="icon-sm" onClick={() => setShow((v) => !v)} aria-label={show ? '隐藏' : '显示'}>
              {show ? <EyeOff /> : <Eye />}
            </Button>
          }
          hint="主密钥能登录控制台，给客户端用更推荐在「API Key」页签发子密钥。"
        />
        <div className="pt-1">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Segmented<Snippet>
              value={snippet}
              onChange={setSnippet}
              className="h-8 [&_button]:h-6 [&_button]:text-xs"
              options={[
                { value: 'curl', label: 'cURL' },
                { value: 'python', label: 'Python' },
                { value: 'env', label: '环境变量' },
                { value: 'dsh', label: 'DSH' },
              ]}
            />
            <Button variant="ghost" size="sm" onClick={() => copyText(code.replace('YOUR_API_KEY', key), '已复制（含真实密钥）')}>
              <Copy /> 复制
            </Button>
          </div>
          <pre className={cn('bg-muted/70 overflow-x-auto rounded-lg px-4 py-3 font-mono text-[12px] leading-relaxed', snippet === 'dsh' && 'max-h-96 overflow-y-auto')}>{code}</pre>
          {snippet === 'dsh' && (
            <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
              DSH 只给配置里声明了 <code className="font-mono">reasoningEfforts</code> 的模型开「推理努力」，否则在本地直接报「不支持推理努力」。
              这份片段按「模型」页的真实目录生成（档位取上游下发的值），改完重启 DSH；模型 id 必须与这里一致。
              {catalog.isFetching && !catalog.data && ' 正在读取模型目录，稍等再复制…'}
              {catalog.data?.fallback && ' 当前没拉到真实模型，展示的是内置清单（没有档位与上下文信息）。'}
            </p>
          )}
        </div>
        <ul className="text-muted-foreground space-y-1.5 pt-1 text-[12.5px] leading-relaxed">
          <li>
            <span className="text-foreground font-medium">模型怎么填：</span>
            <code className="font-mono">aggregate/auto</code> 自动挑可用的模型；
            <code className="font-mono">aggregate/&lt;模型&gt;</code> 在所有家里找同一个模型；
            <code className="font-mono">&lt;供应商&gt;/&lt;模型&gt;</code> 只走这一家。完整列表见「模型」页。
          </li>
          <li>
            <span className="text-foreground font-medium">临时指定账号：</span>
            请求头加 <code className="font-mono">X-FLR-Account: &lt;uid&gt;</code>
            ，只对这一次请求生效，且不换号。
          </li>
        </ul>
      </div>
    </Card>
  )
}

function Field({
  label,
  value,
  mono = true,
  onCopy,
  extra,
  hint,
}: {
  label: string
  value: string
  mono?: boolean
  onCopy: () => void
  extra?: ReactNode
  hint?: string
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-xs">{label}</div>
      <div className="flex items-center gap-1 rounded-lg border py-1 pr-1 pl-3">
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', mono && 'font-mono')}>{value}</span>
        {extra}
        <Button variant="ghost" size="icon-sm" onClick={onCopy} aria-label={`复制${label}`}>
          <Copy />
        </Button>
      </div>
      {hint && <div className="text-muted-foreground mt-1 text-[11.5px]">{hint}</div>}
    </div>
  )
}

// ── 路由与调度 ──

const STRATEGIES: { value: Strategy; title: string; desc: string }[] = [
  {
    value: 'expiry',
    title: '临期优先',
    desc: '积分最早过期的账号先用，少浪费',
  },
  { value: 'roundrobin', title: '轮询', desc: '最久没用的账号先用，负载均匀' },
  { value: 'random', title: '随机', desc: '每次随机挑一个可用账号' },
]

function RoutingCard() {
  const q = useRoutingConfig()
  const save = useSaveRouting()
  const [form, setForm] = useState<RoutingConfig | null>(null)
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])
  const dirty = !!form && !!q.data && JSON.stringify(form) !== JSON.stringify(q.data)
  const set = <K extends keyof RoutingConfig>(k: K, v: RoutingConfig[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const retriesOk = !!form && Number.isInteger(form.maxRetries) && form.maxRetries >= 0 && form.maxRetries <= 10
  const softOk = !!form && Number.isInteger(form.softCooldownSeconds) && form.softCooldownSeconds >= 10 && form.softCooldownSeconds <= 3600

  return (
    <Card>
      <Head
        icon={<Route />}
        title="路由与调度"
        desc="网关怎么在账号之间挑选、失败后怎么处理，以及定时任务开关。"
        action={
          form && (
            <div className="flex gap-2">
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => q.data && setForm(q.data)}>
                  还原
                </Button>
              )}
              <Button size="sm" disabled={!dirty || !retriesOk || !softOk || save.isPending} onClick={() => save.mutate(form)}>
                {save.isPending ? '保存中…' : '保存'}
              </Button>
            </div>
          )
        }
      />
      {!form ? (
        <div className="space-y-3 px-5 pb-5">
          <Skeleton className="h-20" />
          <Skeleton className="h-16" />
        </div>
      ) : (
        <div className="space-y-5 px-5 pb-5">
          <div>
            <div className="mb-2 text-[13px] font-medium">选号策略</div>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="选号策略">
              {STRATEGIES.map((s) => (
                <button
                  key={s.value}
                  role="radio"
                  aria-checked={form.strategy === s.value}
                  onClick={() => set('strategy', s.value)}
                  className={cn(
                    'cursor-pointer rounded-lg border px-3.5 py-3 text-left transition-colors',
                    form.strategy === s.value ? 'border-primary bg-primary/[0.05] ring-primary/20 ring-2' : 'hover:bg-muted/60',
                  )}
                >
                  <div className="text-[13px] font-medium">{s.title}</div>
                  <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{s.desc}</div>
                </button>
              ))}
            </div>
            <div className="text-muted-foreground mt-1.5 text-[11.5px]">面板里「指定账号」与永久积分锁优先于策略生效。</div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <NumField
              label="失败换号次数"
              hint="一次请求失败后最多再换几个账号重试（0–10）"
              value={form.maxRetries}
              min={0}
              max={10}
              ok={retriesOk}
              onChange={(v) => set('maxRetries', v)}
            />
            <NumField
              label="限流冷却起步（秒）"
              hint="被限流的账号先歇这么久，连续限流翻倍，最长 30 分钟（10–3600）"
              value={form.softCooldownSeconds}
              min={10}
              max={3600}
              ok={softOk}
              onChange={(v) => set('softCooldownSeconds', v)}
            />
          </div>

          <div className="divide-y rounded-lg border">
            <ToggleRow
              title="自动签到与每日任务"
              desc="北京时间 09:00、21:00 签到，01:00 跑完整每日任务（CodeBuddy 含成长任务与领奖）。关掉后仍会每小时刷新余额。"
              checked={form.autoTaskCron}
              onChange={(v) => set('autoTaskCron', v)}
            />
            <ToggleRow
              title="自动续期登录凭据"
              desc="定时检查快过期的登录凭据并自动刷新，避免账号突然掉线。"
              checked={form.autoRefreshCredential}
              onChange={(v) => set('autoRefreshCredential', v)}
            />
          </div>
        </div>
      )}
    </Card>
  )
}

function NumField({
  label,
  hint,
  value,
  min,
  max,
  ok,
  step = 1,
  zero,
  onChange,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  ok: boolean
  /** 步长；`'any'` 表示这一项允许小数（QPS、分钟数都是小数量级）。 */
  step?: number | 'any'
  /** `value === 0` 时贴在标签旁的语义。0 不是「没填」，各字段含义不同，必须写出来。 */
  zero?: string
  onChange: (v: number) => void
}) {
  const id = `num-${label}`
  const decimal = step === 'any' || !Number.isInteger(step)
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
        {label}
        {zero && value === 0 && <Badge tone="neutral">{zero}</Badge>}
      </label>
      <Input
        id={id}
        type="number"
        inputMode={decimal ? 'decimal' : 'numeric'}
        step={step === 'any' ? 'any' : step}
        min={min}
        max={max}
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        className={cn('tabular w-32', !ok && 'border-danger focus-visible:border-danger')}
        aria-invalid={!ok}
      />
      <div className={cn('mt-1 text-[11.5px] leading-relaxed', ok ? 'text-muted-foreground' : 'text-danger')}>{hint}</div>
    </div>
  )
}

function ToggleRow({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{desc}</div>
      </div>
      <Switch label={title} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

// ── 防封 ──

/** 熔断窗口在界面上用「分钟」呈现：毫秒没人能一眼读懂，而运维真正在算的是「60 分钟够不够覆盖采样间隔」。 */
const MS_PER_MINUTE = 60_000

/** 毫秒 → 分钟（保留 0.1 秒精度）。不这么归一化，33.333333 这类输入会回显成 33.333333333333336。 */
const minutesOf = (ms: number) => (Number.isFinite(ms) ? Math.round(ms / 6) / 10_000 : Number.NaN)

function SafetyCard() {
  const q = useSafetyConfig()
  const save = useSaveSafety()
  const [form, setForm] = useState<SafetyConfig | null>(null)
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])
  const dirty = !!form && !!q.data && JSON.stringify(form) !== JSON.stringify(q.data)
  const set = <K extends keyof SafetyConfig>(k: K, v: SafetyConfig[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  // 范围与后端一致。后端对越界值的选择是「忽略并保持原值」，前端若不先拦，用户会以为保存成功了。
  const ctxOk = !!form && Number.isInteger(form.maxContextMessages) && form.maxContextMessages >= 0 && form.maxContextMessages <= 100_000
  const windowOk = !!form && Number.isFinite(form.burnRateWindowMs) && form.burnRateWindowMs >= 0 && form.burnRateWindowMs <= 86_400_000
  const pctOk = !!form && Number.isFinite(form.burnRateThresholdPct) && form.burnRateThresholdPct >= 0 && form.burnRateThresholdPct <= 100
  const qpsOk = !!form && Number.isFinite(form.rateLimitQps) && form.rateLimitQps >= 0 && form.rateLimitQps <= 50
  const jitterOk = !!form && Number.isInteger(form.rateJitterMs) && form.rateJitterMs >= 0 && form.rateJitterMs <= 10_000
  const allOk = ctxOk && windowOk && pctOk && qpsOk && jitterOk

  return (
    <Card>
      <Head
        icon={<ShieldCog />}
        title="防封"
        desc="降低被上游风控判成机器行为的开关，可按需开关。五个数值项填 0 都有明确含义（不限制 / 关闭 / 不限速 / 不抖动），不是「没设置」。"
        action={
          form && (
            <div className="flex gap-2">
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => q.data && setForm(q.data)}>
                  还原
                </Button>
              )}
              <Button size="sm" disabled={!dirty || !allOk || save.isPending} onClick={() => form && save.mutate(form)}>
                {save.isPending ? '保存中…' : '保存'}
              </Button>
            </div>
          )
        }
      />
      {!form ? (
        <div className="space-y-3 px-5 pb-5">
          {q.isError ? (
            <div className="border-danger/30 bg-danger/[0.06] rounded-lg border px-3.5 py-3">
              <div className="text-danger flex items-center gap-2 text-[13px] font-medium">
                <ShieldAlert className="size-4" /> 读取防封配置失败
              </div>
              <div className="text-muted-foreground mt-1 text-xs leading-relaxed">{q.error.message}</div>
              <Button size="sm" variant="outline" className="mt-2.5" disabled={q.isFetching} onClick={() => q.refetch()}>
                {q.isFetching ? '重试中…' : '重试'}
              </Button>
            </div>
          ) : (
            <>
              <Skeleton className="h-14" />
              <Skeleton className="h-28" />
            </>
          )}
        </div>
      ) : (
        <div className="space-y-5 px-5 pb-5">
          {q.isError && (
            <div className="text-warning bg-warning/10 rounded-md px-3 py-2 text-xs leading-relaxed">
              没读到最新配置（{q.error.message}），下面是上次读到的值；保存仍以表单为准。
            </div>
          )}

          <div className="divide-y rounded-lg border">
            <ToggleRow
              title="会话链（b3 + x-conversation-*）"
              desc="关掉 = 不再发 b3 三件套，请求失去可串联的链路特征；x-conversation-* 那 5 个是必需头（缺了上游直接回 11‑128），仍照发。"
              checked={form.sessionTrace}
              onChange={(v) => set('sessionTrace', v)}
            />
            <ToggleRow
              title="模型级冷却（某个模型失败后暂时拉黑它）"
              desc="关掉后失败的请求照样报错、照样换号，但不再把「这个账号 + 这个模型」的组合锁上几分钟到几小时。实测上游的 429 / 排队多为瞬时，锁起来经常变成「明明还能用却选不到号」。账号级冷却（熔断、余额耗尽、上游封号）不受此开关影响。"
              checked={form.modelCooldownEnabled}
              onChange={(v) => set('modelCooldownEnabled', v)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <NumField
              label="单请求消息数上限"
              hint="0 = 不限制；建议 300 —— 已观测到的封禁样本最少也带了 434 条消息。"
              value={form.maxContextMessages}
              min={0}
              max={100_000}
              ok={ctxOk}
              zero="不限制"
              onChange={(v) => set('maxContextMessages', v)}
            />
            <NumField
              label="消耗熔断窗口（分钟）"
              hint="0 = 关闭；窗口不能短于采样间隔（整点 cron ⇒ 至少 60 分钟），否则每轮都在跟自己的起点比，检测永远不会触发。"
              value={minutesOf(form.burnRateWindowMs)}
              min={0}
              max={1440}
              step="any"
              ok={windowOk}
              zero="已关闭"
              onChange={(v) => set('burnRateWindowMs', Math.round(v * MS_PER_MINUTE))}
            />
            <NumField
              label="消耗熔断阈值（%）"
              hint="0 = 关闭；窗口内消耗掉的积分占窗口起点余额的百分比，超过就熔断。"
              value={form.burnRateThresholdPct}
              min={0}
              max={100}
              ok={pctOk}
              zero="已关闭"
              onChange={(v) => set('burnRateThresholdPct', v)}
            />
            <NumField
              label="每账号 QPS 上限"
              hint="0 = 不限速；开了之后同一账号的上游请求要排队，吞吐明显下降，只在上游 429 咬过之后才建议开（可填 0.5）。"
              value={form.rateLimitQps}
              min={0}
              max={50}
              step="any"
              ok={qpsOk}
              zero="不限速"
              onChange={(v) => set('rateLimitQps', v)}
            />
            <NumField
              label="请求前随机抖动（毫秒）"
              hint="0 = 不抖动；每次请求前随机等 0~N 毫秒，把固定节奏打散。"
              value={form.rateJitterMs}
              min={0}
              max={10_000}
              step={100}
              ok={jitterOk}
              zero="不抖动"
              onChange={(v) => set('rateJitterMs', v)}
            />
          </div>
        </div>
      )}
    </Card>
  )
}

// ── 运行状态 ──

function StatusCard() {
  const pool = usePool()
  const waf = useWaf()
  const creds = useCredentialCount()
  const clearWaf = useClearWaf()
  const clearCd = useClearCooldowns()
  const [confirm, setConfirm] = useState(false)
  const blocked = waf.data?.filter((w) => w.active) ?? []
  const c = pool.data
  const cooling = (c?.cooling ?? 0) + (c?.modelExempt ?? 0)

  return (
    <Card>
      <Head icon={<Gauge />} title="运行状态" />
      <div className="space-y-3 px-5 pb-5">
        <div className="grid grid-cols-3 divide-x rounded-lg border">
          {[
            ['账号', c?.total],
            ['可用', c?.healthy],
            ['已存凭据', creds.data],
          ].map(([k, v]) => (
            <div key={k as string} className="px-3.5 py-2.5">
              <div className="text-muted-foreground text-xs">{k}</div>
              <div className="tabular mt-0.5 text-lg font-semibold">{v === undefined ? '—' : fmtInt(v as number)}</div>
            </div>
          ))}
        </div>

        {c && creds.data !== undefined && creds.data < c.total && (
          <div className="text-warning bg-warning/10 rounded-md px-3 py-2 text-xs leading-relaxed">
            有 {fmtInt(c.total - creds.data)} 个账号没有存下凭据，网关用不了它们，需要重新登录或导入。
          </div>
        )}
        {blocked.length ? (
          <div className="border-danger/30 bg-danger/[0.06] rounded-lg border px-3.5 py-3">
            <div className="text-danger flex items-center gap-2 text-[13px] font-medium">
              <ShieldAlert className="size-4" /> 出口 IP 被上游拦截
            </div>
            <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {blocked.map((w) => `${w.realm === 'cn' ? '国内版' : '国际版'}${w.until ? `，${fmtDateTime(w.until)} 自动恢复` : ''}`).join('；')}
              。期间该分片的请求会直接失败，避免越试越封。确认已换 IP 可以提前解除。
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-2.5"
              disabled={clearWaf.isPending}
              onClick={() => clearWaf.mutate(blocked.map((w) => w.realm))}
            >
              立即解除
            </Button>
          </div>
        ) : (
          <Row
            icon={<ShieldCheck className="text-success" />}
            title="出口 IP 正常"
            desc={waf.isLoading ? '检查中…' : '国内版、国际版都没有被上游 WAF 拦截'}
          />
        )}

        <Row
          icon={<Snowflake className={cooling ? 'text-warning' : 'text-muted-foreground'} />}
          title={cooling ? `${fmtInt(cooling)} 个账号在冷却 / 限流` : '没有账号在冷却'}
          desc="冷却到期会自动恢复；确认上游已恢复可以手动全部清空。"
          action={
            <Button size="sm" variant="outline" disabled={!cooling || clearCd.isPending} onClick={() => setConfirm(true)}>
              全部清空
            </Button>
          }
        />
        <Row
          icon={<CalendarClock className="text-muted-foreground" />}
          title="定时器每小时触发一次"
          desc="每小时刷新余额、续期凭据；北京时间 01 / 09 / 21 点另跑签到与每日任务。"
        />
        <Row
          icon={<Lock className="text-muted-foreground" />}
          title="凭据加密存储"
          desc="账号凭据用 AES-GCM 加密后落盘，密钥是部署时配置的 CREDENTIAL_KEY。"
        />
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="清空全部冷却？"
        description="所有账号立刻回到可选状态。如果上游仍在限流，它们会很快再次进入冷却。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button
              onClick={() =>
                clearCd.mutate(undefined, {
                  onSuccess: () => setConfirm(false),
                })
              }
              disabled={clearCd.isPending}
            >
              清空
            </Button>
          </>
        }
      />
    </Card>
  )
}

function Row({ icon, title, desc, action }: { icon: ReactNode; title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3.5 py-3">
      <span className="shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{desc}</div>
      </div>
      {action}
    </div>
  )
}

// ── 永久积分锁 ──

function LocksCard() {
  const providers = useProviders()
  const accounts = useAccounts()
  const locks = usePermanentLocks()
  const setLock = useSetPermanentLock()
  const [all, setAll] = useState(false)
  const used = new Set((accounts.data ?? []).map((a) => a.provider))
  const list = (providers.data?.providers ?? []).filter((p) => all || used.has(p.id) || locks.data?.[p.id])
  const hidden = (providers.data?.providers.length ?? 0) - list.length

  return (
    <Card>
      <Head icon={<Lock />} title="永久积分锁" desc="开启后，这家「只剩永久积分」的账号不再参与选号，免得免费额度用完后悄悄烧掉花钱买的积分。" />
      <div className="px-5 pb-5">
        {!locks.data || !providers.data ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="divide-y rounded-lg border">
            {list.map((p) => {
              const on = !!locks.data[p.id]
              return (
                <div key={p.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <ProviderAvatar id={p.id} name={p.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{p.name}</div>
                    <div className="text-muted-foreground text-[11.5px]">{on ? '已锁定，永久积分受保护' : '未锁定，可能消耗永久积分'}</div>
                  </div>
                  {on && <Badge tone="success">已锁</Badge>}
                  <Switch
                    label={`${p.name} 永久积分锁`}
                    checked={on}
                    disabled={setLock.isPending}
                    onCheckedChange={(v) =>
                      setLock.mutate({
                        provider: p.id,
                        name: p.name,
                        locked: v,
                      })
                    }
                  />
                </div>
              )
            })}
            {!list.length && <div className="text-muted-foreground px-3.5 py-5 text-center text-[13px]">还没有账号</div>}
          </div>
        )}
        {(hidden > 0 || all) && (
          <button className="text-muted-foreground hover:text-foreground mt-2 cursor-pointer text-xs" onClick={() => setAll((v) => !v)}>
            {all ? '只看有账号的供应商' : `显示其余 ${hidden} 家没有账号的供应商`}
          </button>
        )}
      </div>
    </Card>
  )
}
