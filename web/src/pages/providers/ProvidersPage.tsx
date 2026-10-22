import {
  ArrowUpDown,
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  GripVertical,
  Layers,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Power,
  RefreshCw,
  Search,
  Snowflake,
  Star,
  Timer,
  Trash2,
  Users,
} from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { PIN_META, PinBadge } from '@/components/PinBadge'
import { StatCard } from '@/components/StatCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Empty, ProviderAvatar, Segmented, Skeleton } from '@/components/ui/misc'
import { Table, TD, TH, THead, TR } from '@/components/ui/table'
import { useClearCooldowns, useProbeAccount, useSetProviderOrder } from '@/lib/config'
import {
  pinModeOf,
  useAccounts,
  usePins,
  usePool,
  useProviders,
  useRefreshBalance,
  useRemoveAccount,
  useSetPin,
  useToggleAccount,
} from '@/lib/queries'
import { accountStatus, recoveryText, STATUS_META, type AccountStatus } from '@/lib/status'
import type { Account, PinMode, Provider } from '@/lib/types'
import { cn, fmtInt, fmtRelative } from '@/lib/utils'
import { AddAccountDialog } from './AddAccountDialog'
import { ProviderSheet, type SheetTab } from './ProviderSheet'

type Filter = 'all' | 'ok' | 'issue' | 'disabled'

export function ProvidersPage() {
  const providers = useProviders()
  const accounts = useAccounts()
  const pool = usePool()
  const pins = usePins()
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [openProvider, setOpenProvider] = useState<Provider | null>(null)
  const [sheetTab, setSheetTab] = useState<SheetTab>('accounts')
  const openSheet = (p: Provider, tab: SheetTab = 'accounts') => {
    setSheetTab(tab)
    setOpenProvider(p)
  }
  const [adding, setAdding] = useState(false)
  const [showEmpty, setShowEmpty] = useState(false)

  const byProvider = useMemo(() => {
    const m = new Map<string, Account[]>()
    for (const a of accounts.data ?? []) m.set(a.provider, [...(m.get(a.provider) ?? []), a])
    return m
  }, [accounts.data])

  const providerName = (id: string) => providers.data?.providers.find((p) => p.id === id)?.name ?? id

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return (accounts.data ?? []).filter((a) => {
      const s = accountStatus(a)
      if (filter === 'ok' && s !== 'ok') return false
      // ⚠️ 「有问题」必须覆盖全部非正常态，否则新加的状态会变成「孤儿」：
      // 面板上明明标红，用户点「有问题」却筛不到它。
      if (filter === 'issue' && !(s === 'cooling' || s === 'breaker' || s === 'model' || s === 'degraded' || s === 'restricted')) return false
      if (filter === 'disabled' && s !== 'disabled') return false
      return !kw || `${a.nickname} ${a.uid} ${a.provider}`.toLowerCase().includes(kw)
    })
  }, [accounts.data, filter, q])

  const c = pool.data
  const withAccounts = providers.data?.providers.filter((p) => byProvider.has(p.id)).length ?? 0
  const [sorting, setSorting] = useState(false)
  const setOrder = useSetProviderOrder()
  // 排过序就按保存的顺序（useProviders 已排好）；从没排过时，账号多的在前
  const customOrder = (providers.data?.order?.length ?? 0) > 0
  const providerList = (providers.data?.providers ?? [])
    .filter((p) => showEmpty || byProvider.has(p.id))
    .sort((a, b) => (customOrder ? 0 : (byProvider.get(b.id)?.length ?? 0) - (byProvider.get(a.id)?.length ?? 0)))
  // 排序模式下列出全部供应商（顺序要完整保存），初始顺序与当前展示一致
  const sortSeed = useMemo(() => {
    const all = providers.data?.providers ?? []
    return customOrder ? all : [...all].sort((a, b) => (byProvider.get(b.id)?.length ?? 0) - (byProvider.get(a.id)?.length ?? 0))
  }, [providers.data, customOrder, byProvider])

  return (
    <>
      <PageHeader
        title="供应商与账号"
        description="账号池总览。网关会在这些账号之间自动选号、冷却与容灾。"
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> 添加账号
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="总账号" value={c?.total ?? 0} icon={Users} tone="primary" loading={!c} sub={`分布在 ${withAccounts} 家供应商`} />
        <StatCard
          label="可用"
          value={c?.healthy ?? 0}
          icon={CheckCircle2}
          tone="success"
          loading={!c}
          sub={c && c.total ? `可用率 ${Math.round((c.healthy / c.total) * 100)}%` : '—'}
          onClick={() => setFilter('ok')}
        />
        <StatCard
          label="冷却 / 限流"
          value={(c?.cooling ?? 0) + (c?.modelExempt ?? 0)}
          icon={Timer}
          tone="warning"
          loading={!c}
          sub="到期后自动恢复"
          onClick={() => setFilter('issue')}
        />
        <StatCard
          label="已停用"
          value={c?.disabled ?? 0}
          icon={Ban}
          tone="danger"
          loading={!c}
          sub="需要手动处理"
          onClick={() => setFilter('disabled')}
        />
        <StatCard
          className="col-span-2 md:col-span-1"
          label="供应商"
          value={providers.data?.providers.length ?? 0}
          icon={Layers}
          loading={!providers.data}
          sub={`默认：${providerName(providers.data?.default ?? '')}`}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-col gap-3 sm:flex-row sm:items-center">
            <div>
              <CardTitle>账号</CardTitle>
              <CardDescription>共 {accounts.data?.length ?? 0} 个，按健康度和积分参与选号</CardDescription>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <div className="relative w-full sm:w-52">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索昵称 / UID" className="h-8 pl-8 text-[13px]" />
              </div>
              <Segmented<Filter>
                value={filter}
                onChange={setFilter}
                className="h-8 [&_button]:h-6 [&_button]:px-2.5 [&_button]:text-xs"
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'ok', label: '正常' },
                  { value: 'issue', label: '冷却' },
                  { value: 'disabled', label: '停用' },
                ]}
              />
            </div>
          </CardHeader>
          <AccountsTable rows={rows} loading={accounts.isLoading} providerName={providerName} />
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <div>
              <CardTitle>供应商</CardTitle>
              <CardDescription>
                {withAccounts} 家有账号 · 共 {providers.data?.providers.length ?? 0} 家
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              {!sorting && (
                <button className="text-primary cursor-pointer text-xs font-medium hover:underline" onClick={() => setShowEmpty((v) => !v)}>
                  {showEmpty ? '只看有账号的' : '显示全部'}
                </button>
              )}
              <Button
                variant={sorting ? 'default' : 'ghost'}
                size="sm"
                disabled={!providers.data}
                onClick={() => setSorting((v) => !v)}
                title="拖动调整供应商的展示顺序（不影响默认供应商与路由）"
              >
                {sorting ? (
                  <>
                    <Check /> 完成
                  </>
                ) : (
                  <>
                    <ArrowUpDown /> 排序
                  </>
                )}
              </Button>
            </div>
          </CardHeader>
          <div className="flex-1 px-2 pb-2">
            {sorting && providers.data ? (
              <SortableProviders
                items={sortSeed}
                counts={byProvider}
                onCommit={(order) => setOrder.mutate({ order, disabled: providers.data?.disabled ?? [] })}
              />
            ) : providers.isLoading ? (
              Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mx-3 my-3 h-10" />)
            ) : (
              providerList.map((p) => {
                const list = byProvider.get(p.id) ?? []
                const ok = list.filter((a) => accountStatus(a) === 'ok').length
                const pin = pins.data?.find((x) => x.provider === p.id)
                return (
                  <button
                    key={p.id}
                    onClick={() => openSheet(p)}
                    className="hover:bg-muted/70 group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left"
                  >
                    <ProviderAvatar id={p.id} name={p.name} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-medium">{p.name}</span>
                        {providers.data?.disabled?.includes(p.id) && <Badge tone="danger">已停用</Badge>}
                        {pin && (
                          <span title={`已指定账号：${pin.nickname || pin.uid}（${PIN_META[pin.mode].label}）`} className="text-primary shrink-0">
                            <Pin className="size-3.5" strokeWidth={2.5} />
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                        {list.length ? (
                          <>
                            <span className={cn('size-1.5 rounded-full', ok === list.length ? 'bg-success' : ok ? 'bg-warning' : 'bg-danger')} />
                            {ok}/{list.length} 可用
                          </>
                        ) : (
                          '暂无账号'
                        )}
                      </div>
                    </div>
                    <HealthBar list={list} />
                    <ChevronRight className="text-muted-foreground/50 group-hover:text-muted-foreground size-4" />
                  </button>
                )
              })
            )}
          </div>
        </Card>
      </div>

      <ProviderSheet
        provider={openProvider}
        initialTab={sheetTab}
        accounts={openProvider ? (byProvider.get(openProvider.id) ?? []) : []}
        onClose={() => setOpenProvider(null)}
      />
      <AddAccountDialog open={adding} onOpenChange={setAdding} providers={providers.data?.providers ?? []} onLogin={(p) => openSheet(p, 'add')} />
    </>
  )
}

/**
 * 拖动排序（只拖手柄，不拖整行）。
 *
 * ⚠️ 用 Pointer Events 而不是 HTML5 拖放：iOS Safari 不支持普通元素的 HTML5 拖放，
 * 手柄加 `touch-none` 防止手指拖动时页面跟着滚。键盘上用 ↑ / ↓ 调整。
 * 松手（或按键）即保存；排序只影响面板展示，不改默认供应商与路由。
 */
function SortableProviders({ items, counts, onCommit }: { items: Provider[]; counts: Map<string, Account[]>; onCommit: (order: string[]) => void }) {
  const [ids, setIds] = useState(() => items.map((p) => p.id))
  const [drag, setDrag] = useState<string | null>(null)
  const latest = useRef(ids)
  const start = useRef<string[]>(ids)
  const byId = new Map(items.map((p) => [p.id, p]))

  const update = (next: string[]) => {
    latest.current = next
    setIds(next)
  }
  const move = (id: string, to: number) => {
    const cur = latest.current
    const from = cur.indexOf(id)
    if (from < 0 || to < 0 || to >= cur.length || from === to) return false
    const next = [...cur]
    next.splice(from, 1)
    next.splice(to, 0, id)
    update(next)
    return true
  }
  const commitIfChanged = () => {
    if (latest.current.join() !== start.current.join()) onCommit(latest.current)
    start.current = latest.current
  }

  const onDown = (id: string) => (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = latest.current
    setDrag(id)
  }
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-pid]')?.dataset.pid
    if (over && over !== drag) move(drag, latest.current.indexOf(over))
  }
  const onUp = () => {
    if (!drag) return
    setDrag(null)
    commitIfChanged()
  }
  const onKey = (id: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (!d) return
    e.preventDefault()
    if (move(id, latest.current.indexOf(id) + d)) commitIfChanged()
  }

  return (
    <div>
      <p className="text-muted-foreground px-3 pb-2 text-xs">按住左侧手柄拖动（或聚焦后按 ↑ / ↓），松手即保存。只影响面板展示顺序。</p>
      {ids.map((id) => {
        const p = byId.get(id)
        if (!p) return null
        const n = counts.get(id)?.length ?? 0
        return (
          <div
            key={id}
            data-pid={id}
            className={cn('flex items-center gap-3 rounded-lg px-2 py-2', drag === id ? 'bg-muted ring-primary/40 ring-1' : 'hover:bg-muted/50')}
          >
            <button
              aria-label={`调整「${p.name}」的位置`}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-grab touch-none rounded p-1 outline-none focus-visible:ring-2 active:cursor-grabbing"
              onPointerDown={onDown(id)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onKeyDown={onKey(id)}
            >
              <GripVertical className="size-4" />
            </button>
            <ProviderAvatar id={p.id} name={p.name} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{p.name}</span>
            <span className="text-muted-foreground text-xs">{n ? `${n} 个账号` : '暂无账号'}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 迷你健康条：每个账号一格，绿=正常、黄=冷却/限流、红=熔断、灰=停用。 */
function HealthBar({ list }: { list: Account[] }) {
  if (!list.length) return null
  const color: Record<AccountStatus, string> = {
    ok: 'bg-success',
    cooling: 'bg-warning',
    model: 'bg-warning',
    degraded: 'bg-warning',
    breaker: 'bg-danger',
    restricted: 'bg-danger',
    disabled: 'bg-muted-foreground/30',
  }
  return (
    <div className="hidden gap-0.5 sm:flex">
      {list.slice(0, 8).map((a) => (
        <span
          key={a.uid}
          className={cn('h-4 w-1.5 rounded-sm', color[accountStatus(a)])}
          title={`${a.nickname}：${STATUS_META[accountStatus(a)].label}`}
        />
      ))}
    </div>
  )
}

export function AccountsTable({
  rows,
  loading,
  providerName,
  compact,
}: {
  rows: Account[]
  loading?: boolean
  providerName?: (id: string) => string
  compact?: boolean
}) {
  const toggle = useToggleAccount()
  const remove = useRemoveAccount()
  const balance = useRefreshBalance()
  const clearCd = useClearCooldowns()
  const probe = useProbeAccount()
  const pins = usePins()
  const setPin = useSetPin()
  const providers = useProviders()
  const [confirm, setConfirm] = useState<Account | null>(null)

  const pinTo = (a: Account, mode: PinMode | null) => {
    const s = accountStatus(a)
    const name = providers.data?.providers.find((p) => p.id === a.provider)?.name ?? a.provider
    setPin.mutate({
      account: a,
      mode,
      providerName: name,
      // 指定一个当前不可用的号为「只用它」⇒ 提醒用户：恢复前请求都会报错
      ...(mode === 'only' && s !== 'ok'
        ? {
            warn: `它当前「${STATUS_META[s].label}」，恢复之前 ${name} 的请求都会报错。`,
          }
        : {}),
    })
  }

  if (loading)
    return (
      <div className="space-y-2 px-5 pb-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    )
  if (!rows.length)
    return (
      <Empty icon={<Users />} title="没有符合条件的账号">
        换个筛选条件，或点右上角「添加账号」。
      </Empty>
    )

  return (
    <>
      <Table>
        <THead>
          <tr>
            <TH>账号</TH>
            {providerName && <TH className="hidden md:table-cell">供应商</TH>}
            <TH>状态</TH>
            <TH className="text-right">积分</TH>
            {!compact && <TH className="hidden text-right lg:table-cell">成功 / 失败</TH>}
            <TH className="hidden sm:table-cell">最近成功</TH>
            <TH className="w-10" />
          </tr>
        </THead>
        <tbody>
          {rows.map((a) => {
            const s = accountStatus(a)
            const meta = STATUS_META[s]
            // ⚠️ 封号 / 降权 / 模型限流都要给出「什么时候恢复、还剩多久」，否则用户只能猜
            const recovery = recoveryText(a, s)
            const hint =
              s === 'disabled'
                ? a.reason
                : s === 'restricted'
                  ? `上游封号，${recovery}`
                  : s === 'degraded'
                    ? `降权中，${recovery}`
                    : s === 'model'
                      ? `模型限流，${recovery}`
                      : s === 'cooling' || s === 'breaker'
                        ? recovery
                        : ''
            const mode = pinModeOf(a, pins.data)
            return (
              <TR key={a.realm + a.uid}>
                <TD>
                  <div className="flex items-center gap-1.5 font-medium">
                    <span className="truncate">{a.nickname || '未命名'}</span>
                    {mode && <PinBadge mode={mode} />}
                  </div>
                  <div className="text-muted-foreground font-mono text-[11.5px]">{a.uid}</div>
                  {/* ⚠️ 会真实打一次上游（消耗极少配额），故只在点击时触发 */}
                  <button
                    type="button"
                    aria-label="探测该账号当前是否可用"
                    title="探测该账号当前是否可用（会真实打一次上游，消耗极少配额）"
                    className="text-muted-foreground hover:text-foreground mt-1 cursor-pointer text-[11px] underline decoration-dotted"
                    onClick={() => probe.mutate({ uid: a.uid, realm: a.realm })}
                    disabled={probe.isPending}
                  >
                    {probe.isPending ? '探测中…' : '探测'}
                  </button>
                </TD>
                {providerName && (
                  <TD className="hidden md:table-cell">
                    <div className="flex items-center gap-2">
                      <ProviderAvatar id={a.provider} name={providerName(a.provider)} size="sm" />
                      <span className="max-w-36 truncate">{providerName(a.provider)}</span>
                    </div>
                  </TD>
                )}
                <TD>
                  <Badge tone={meta.tone} dot>
                    {meta.label}
                  </Badge>
                  {hint && (
                    // ⚠️ 加了「还剩 X」倒计时后这条提示会变长（如「上游封号，11/22 12:30恢复（还剩 7 分钟）」），
                    // 原来的 `max-w-32` 会把倒计时整段截掉 ⇒ 等于没加。故放宽一档并补 `title`，
                    // 极窄屏仍能悬停看到全文。
                    <div className="text-muted-foreground mt-1 max-w-44 truncate text-[11.5px]" title={hint}>
                      {hint}
                    </div>
                  )}
                </TD>
                <TD className="tabular text-right font-medium">{fmtInt(a.credits)}</TD>
                {!compact && (
                  <TD className="tabular text-muted-foreground hidden text-right lg:table-cell">
                    <span className="text-foreground">{fmtInt(a.successCount)}</span> / {fmtInt(a.errTotal)}
                  </TD>
                )}
                <TD className="text-muted-foreground hidden whitespace-nowrap sm:table-cell">{fmtRelative(a.lastSuccess)}</TD>
                <TD>
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="更多操作">
                        <MoreHorizontal />
                      </Button>
                    </MenuTrigger>
                    <MenuContent className="min-w-56">
                      <MenuLabel>指定账号</MenuLabel>
                      <MenuItem active={mode === 'only'} onSelect={() => pinTo(a, 'only')}>
                        <Pin />
                        <PinOption title="只用这个账号" desc="不可用时直接报错，不换号" checked={mode === 'only'} />
                      </MenuItem>
                      <MenuItem active={mode === 'prefer'} onSelect={() => pinTo(a, 'prefer')}>
                        <Star />
                        <PinOption title="优先用这个账号" desc="不可用时自动换号" checked={mode === 'prefer'} />
                      </MenuItem>
                      {mode && (
                        <MenuItem onSelect={() => pinTo(a, null)}>
                          <PinOff /> 取消指定（自动选号）
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      {providers.data?.providers.find((p) => p.id === a.provider)?.capabilities.balance && (
                        <MenuItem onSelect={() => balance.mutate(a)}>
                          <RefreshCw /> 刷新余额
                        </MenuItem>
                      )}
                      {(s === 'cooling' || s === 'breaker' || s === 'model' || s === 'degraded' || s === 'restricted') && (
                        <MenuItem onSelect={() => clearCd.mutate({ uid: a.uid, realm: a.realm })}>
                          <Snowflake /> 清除冷却
                        </MenuItem>
                      )}
                      <MenuItem onSelect={() => toggle.mutate(a)}>
                        <Power /> {a.disabled ? '启用（同时清除冷却）' : '停用'}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem danger onSelect={() => setConfirm(a)}>
                        <Trash2 /> 删除账号
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </TD>
              </TR>
            )
          })}
        </tbody>
      </Table>
      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="删除这个账号？"
        description="凭据和积分记录会一并删除，且不可恢复。只是暂时不用的话，选「停用」即可。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => confirm && remove.mutate(confirm, { onSuccess: () => setConfirm(null) })}
            >
              确认删除
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="bg-muted/60 rounded-lg px-4 py-3">
            <div className="font-medium">{confirm.nickname}</div>
            <div className="text-muted-foreground font-mono text-xs">{confirm.uid}</div>
          </div>
        )}
      </Dialog>
    </>
  )
}

function PinOption({ title, desc, checked }: { title: string; desc: string; checked: boolean }) {
  return (
    <>
      <span className="flex-1">
        <span className="block leading-5">{title}</span>
        <span className="text-muted-foreground block text-[11.5px] leading-4 font-normal">{desc}</span>
      </span>
      {checked && <Check className="text-primary" />}
    </>
  )
}
