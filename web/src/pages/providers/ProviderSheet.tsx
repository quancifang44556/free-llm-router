import { AlertTriangle, Boxes, Check, Coins, KeyRound, Loader2, Pin, PinOff, Search, Shuffle, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PIN_META } from '@/components/PinBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/dialog'
import { Input, Switch } from '@/components/ui/input'
import { Empty, ProviderAvatar, Segmented, Skeleton } from '@/components/ui/misc'
import { useSetProviderDisabled } from '@/lib/config'
import { useProviderModels, useProviders, usePins, useSetPin, useToggleProviderModels } from '@/lib/queries'
import { accountStatus, STATUS_META } from '@/lib/status'
import type { Account, PinMode, Provider } from '@/lib/types'
import { cn, fmtInt } from '@/lib/utils'
import { ImportForm } from './AddAccountDialog'
import { LoginFlow, loginKindLabel } from './LoginFlow'
import { AccountsTable } from './ProvidersPage'

const CAPS: {
  key: 'login' | 'balance' | 'checkin' | 'listModels'
  label: string
  reason?: 'loginBlockedReason' | 'balanceBlockedReason' | 'checkinBlockedReason'
}[] = [
  { key: 'login', label: '面板登录', reason: 'loginBlockedReason' },
  { key: 'balance', label: '查余额', reason: 'balanceBlockedReason' },
  { key: 'checkin', label: '每日签到', reason: 'checkinBlockedReason' },
  { key: 'listModels', label: '拉取模型' },
]

export type SheetTab = 'accounts' | 'models' | 'add'

export function ProviderSheet({
  provider,
  accounts,
  initialTab = 'accounts',
  onClose,
}: {
  provider: Provider | null
  accounts: Account[]
  initialTab?: SheetTab
  onClose: () => void
}) {
  return (
    <Sheet open={!!provider} onOpenChange={(o) => !o && onClose()} title={provider?.name ?? ''}>
      {/* key：换供应商时重置 Tab 等内部状态 */}
      {provider && <SheetBody key={provider.id + initialTab} provider={provider} accounts={accounts} initialTab={initialTab} />}
    </Sheet>
  )
}

function SheetBody({ provider, accounts, initialTab }: { provider: Provider; accounts: Account[]; initialTab: SheetTab }) {
  const [tab, setTab] = useState<SheetTab>(initialTab)
  const providers = useProviders()
  const setDisabled = useSetProviderDisabled()
  const disabled = providers.data?.disabled?.includes(provider.id) ?? false
  const ok = accounts.filter((a) => accountStatus(a) === 'ok').length
  const credits = accounts.reduce((s, a) => s + a.credits, 0)
  const reasons = CAPS.filter((c) => c.reason && provider.capabilities[c.reason]).map((c) => ({
    label: c.label,
    text: provider.capabilities[c.reason!]!,
  }))

  return (
    <>
      <div className="border-b px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 pr-8">
          <ProviderAvatar id={provider.id} name={provider.name} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-base font-semibold">
              <span className="truncate">{provider.name}</span>
              {disabled && <Badge tone="danger">已停用</Badge>}
            </div>
            <div className="text-muted-foreground font-mono text-xs">{provider.id}</div>
          </div>
          <label className="text-muted-foreground flex shrink-0 cursor-pointer items-center gap-2 text-[12.5px]">
            {disabled ? '已停用' : '已启用'}
            <Switch
              label="启用该供应商"
              checked={!disabled}
              disabled={!providers.data || setDisabled.isPending}
              onCheckedChange={(on) =>
                providers.data &&
                setDisabled.mutate({
                  id: provider.id,
                  name: provider.name,
                  disabled: !on,
                  current: {
                    order: providers.data.order ?? [],
                    disabled: providers.data.disabled ?? [],
                  },
                })
              }
            />
          </label>
        </div>
        {disabled && (
          <div className="bg-danger/8 text-danger mt-3 rounded-md px-3 py-2 text-[12.5px] leading-relaxed">
            停用中：它的模型不会出现在 /v1/models，请求也不会路由过来。账号与凭据都保留，随时可以重新启用。
          </div>
        )}
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {CAPS.map((c) =>
            provider.capabilities[c.key] ? (
              <Badge key={c.key} tone="success">
                <Check className="size-3" strokeWidth={3} /> {c.key === 'login' ? loginKindLabel(provider.id) : c.label}
              </Badge>
            ) : (
              <Badge key={c.key} tone="neutral" className="line-through decoration-1">
                <X className="size-3" strokeWidth={3} /> {c.label}
              </Badge>
            ),
          )}
        </div>
        <div className="mt-4 grid grid-cols-3 divide-x rounded-lg border">
          {[
            ['账号', fmtInt(accounts.length)],
            ['可用', fmtInt(ok)],
            ['积分合计', fmtInt(credits)],
          ].map(([k, v]) => (
            <div key={k} className="px-4 py-2.5">
              <div className="text-muted-foreground text-xs">{k}</div>
              <div className="tabular mt-0.5 text-lg font-semibold">{v}</div>
            </div>
          ))}
        </div>
        <Segmented<SheetTab>
          value={tab}
          onChange={setTab}
          className="mt-4 w-full [&_button]:flex-1"
          options={[
            {
              value: 'accounts',
              label: <TabLabel icon={Users} text={`账号 ${accounts.length}`} />,
            },
            { value: 'models', label: <TabLabel icon={Boxes} text="模型" /> },
            {
              value: 'add',
              label: <TabLabel icon={KeyRound} text="添加账号" />,
            },
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'accounts' && (
          <>
            <PinSection provider={provider} accounts={accounts} />
            {reasons.length > 0 && (
              <div className="space-y-2 px-6 pt-5">
                {reasons.map((r) => (
                  <div key={r.label} className="bg-muted/60 text-muted-foreground rounded-lg px-3.5 py-2.5 text-[12.5px] leading-relaxed">
                    <span className="text-foreground font-medium">为什么没有「{r.label}」：</span>
                    {r.text}
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 px-6 pt-5 pb-3 text-[13px] font-medium">
              <Coins className="text-muted-foreground size-4" /> 账号列表
            </div>
            {accounts.length ? (
              <AccountsTable rows={accounts} compact />
            ) : (
              <Empty icon={<Users />} title="还没有账号">
                <Button size="sm" variant="outline" className="mt-1" onClick={() => setTab('add')}>
                  添加第一个账号
                </Button>
              </Empty>
            )}
          </>
        )}
        {tab === 'models' && <ModelsTab provider={provider} hasAccounts={accounts.length > 0} />}
        {tab === 'add' && (
          <div className="space-y-6 px-6 py-5">
            {provider.capabilities.login ? (
              <section>
                <h3 className="mb-3 text-[13px] font-medium">{loginKindLabel(provider.id)}</h3>
                <LoginFlow provider={provider} />
              </section>
            ) : (
              provider.capabilities.loginBlockedReason && (
                <div className="bg-muted/60 text-muted-foreground rounded-lg px-3.5 py-2.5 text-[12.5px] leading-relaxed">
                  <span className="text-foreground font-medium">不支持面板登录：</span>
                  {provider.capabilities.loginBlockedReason}
                </div>
              )
            )}
            <section>
              <h3 className="mb-3 text-[13px] font-medium">{provider.capabilities.login ? '或者：导入凭据 JSON' : '导入凭据 JSON'}</h3>
              <ImportForm provider={provider.id} onDone={() => setTab('accounts')} />
            </section>
          </div>
        )}
      </div>
    </>
  )
}

function TabLabel({ icon: Icon, text }: { icon: typeof Users; text: string }) {
  return (
    <span className="flex items-center justify-center gap-1.5">
      <Icon className="size-3.5" /> {text}
    </span>
  )
}

/** 该家的模型目录与开关：关掉的模型不出现在 /v1/models，也不会被路由。 */
function ModelsTab({ provider, hasAccounts }: { provider: Provider; hasAccounts: boolean }) {
  const q = useProviderModels(provider.id)
  const toggle = useToggleProviderModels()
  const [kw, setKw] = useState('')
  const models = useMemo(() => q.data?.models ?? [], [q.data])
  const rows = models.filter((m) => !kw || `${m.id} ${m.name ?? ''}`.toLowerCase().includes(kw.toLowerCase()))
  const off = models.filter((m) => m.disabled).length
  const pending = toggle.isPending ? toggle.variables : undefined

  if (q.isLoading)
    return (
      <div className="space-y-2 px-6 py-5">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    )
  if (q.isError)
    return (
      <Empty icon={<AlertTriangle />} title="模型目录拉取失败">
        <span className="block">{hasAccounts ? '上游暂时不可达，或账号凭据已失效。' : '这家还没有账号，无法拉取模型目录。'}</span>
        {q.error.message !== '模型目录拉取失败' && <span className="text-muted-foreground/80 mt-1 block font-mono text-[11.5px]">{q.error.message}</span>}
        <Button size="sm" variant="outline" className="mt-3" onClick={() => q.refetch()}>
          重试
        </Button>
      </Empty>
    )
  if (!models.length)
    return (
      <Empty icon={<Boxes />} title="没有模型">
        {q.data?.note}
      </Empty>
    )

  return (
    <div className="px-6 py-5">
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索模型" className="h-8 pl-8 text-[13px]" />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!off || toggle.isPending}
          onClick={() =>
            toggle.mutate({
              provider: provider.id,
              models: models.filter((m) => m.disabled).map((m) => m.id),
              enabled: true,
            })
          }
        >
          全部开启
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={off === models.length || toggle.isPending}
          onClick={() =>
            toggle.mutate({
              provider: provider.id,
              models: models.filter((m) => !m.disabled).map((m) => m.id),
              enabled: false,
            })
          }
        >
          全部关闭
        </Button>
      </div>
      <div className="text-muted-foreground mb-2 text-xs">
        共 {models.length} 个，已关闭 {off} 个。关掉的模型不会出现在 /v1/models，也不会被路由。
      </div>
      <div className="divide-y rounded-lg border">
        {rows.map((m) => {
          const busy = pending?.models.length === 1 && pending.models[0] === m.id
          const on = busy ? pending.enabled : !m.disabled
          return (
            <div key={m.id} className={cn('flex items-center gap-3 px-3.5 py-2.5', !on && 'opacity-60')}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12.5px]">{m.id}</div>
                {m.name && m.name !== m.id && <div className="text-muted-foreground truncate text-xs">{m.name}</div>}
              </div>
              {busy && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
              <Switch
                label={`启用 ${m.id}`}
                checked={on}
                disabled={toggle.isPending}
                onCheckedChange={(v) =>
                  toggle.mutate({
                    provider: provider.id,
                    models: [m.id],
                    enabled: v,
                  })
                }
              />
            </div>
          )
        })}
        {!rows.length && <div className="text-muted-foreground px-3.5 py-6 text-center text-[13px]">没有匹配的模型</div>}
      </div>
    </div>
  )
}

/** 选号方式：自动 / 指定某个账号（只用它 · 优先用它）。 */
function PinSection({ provider, accounts }: { provider: Provider; accounts: Account[] }) {
  const pins = usePins()
  const setPin = useSetPin()
  const pin = pins.data?.find((p) => p.provider === provider.id && accounts.some((a) => a.uid === p.uid && a.realm === p.realm))
  const account = pin && accounts.find((a) => a.uid === pin.uid && a.realm === pin.realm)
  const status = account ? accountStatus(account) : undefined

  if (!pin || !account) {
    return (
      <div className="px-6 pt-5">
        <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
          <Shuffle className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="text-[13px]">
            <div className="font-medium">自动选号</div>
            <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-relaxed">
              按健康度、积分和轮询在账号间分配。想固定用某个号，在下方账号行的「⋯」菜单里选「只用 / 优先用这个账号」。
            </div>
          </div>
        </div>
      </div>
    )
  }

  const change = (mode: PinMode | null) =>
    setPin.mutate({
      account,
      mode,
      providerName: provider.name,
      ...(mode === 'only' && status !== 'ok' && status
        ? {
            warn: `它当前「${STATUS_META[status].label}」，恢复之前请求都会报错。`,
          }
        : {}),
    })

  return (
    <div className="px-6 pt-5">
      <div className="border-primary/30 bg-primary/[0.04] rounded-lg border px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary grid size-8 shrink-0 place-items-center rounded-md">
            <Pin className="size-4" strokeWidth={2.5} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground text-xs">已指定账号</div>
            <div className="truncate text-[13.5px] font-medium">
              {account.nickname || '未命名'} <span className="text-muted-foreground font-mono text-[11.5px] font-normal">{account.uid}</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => change(null)} disabled={setPin.isPending}>
            <PinOff /> 取消
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented<PinMode>
            value={pin.mode}
            onChange={(m) => m !== pin.mode && change(m)}
            className="h-8 [&_button]:h-6 [&_button]:px-3 [&_button]:text-xs"
            options={[
              { value: 'only', label: PIN_META.only.label },
              { value: 'prefer', label: PIN_META.prefer.label },
            ]}
          />
          <span className="text-muted-foreground text-[12px]">{pin.mode === 'only' ? '不可用时直接报错，不换号' : '不可用时自动换到其他账号'}</span>
        </div>
        {pin.mode === 'only' && status && status !== 'ok' && (
          <div className="text-warning bg-warning/10 mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-[12.5px] leading-relaxed">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              它当前「{STATUS_META[status].label}」，{provider.name} 的请求会直接报错，直到它恢复。可以改成「优先用它」让请求自动换号。
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
