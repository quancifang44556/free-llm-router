import {
  CalendarCheck,
  CheckCircle2,
  CircleDashed,
  Clock,
  Gift,
  ListChecks,
  Loader2,
  MinusCircle,
  RefreshCw,
  Sparkles,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Select } from '@/components/ui/input'
import { Empty, Progress, ProviderAvatar, Skeleton } from '@/components/ui/misc'
import { Table, TD, TH, THead, TR } from '@/components/ui/table'
import { useRoutingConfig } from '@/lib/config'
import { useAccounts, useProviders } from '@/lib/queries'
import { navigate } from '@/lib/router'
import {
  useCheckCompensation,
  useCheckinAll,
  useClaimCompensation,
  useDailyAll,
  useTaskStatus,
  type CheckinSummary,
  type CompensationRow,
  type DailyStarted,
} from '@/lib/tasks'
import { cn, fmtDateTime, fmtRelative } from '@/lib/utils'

type Last =
  | { kind: 'checkin'; at: number; data: CheckinSummary }
  | { kind: 'daily'; at: number; data: DailyStarted[] }
  | { kind: 'comp-check' | 'comp-claim'; at: number; data: CompensationRow[] }

const tones = {
  warning: 'bg-warning/15 text-warning',
  success: 'bg-success/12 text-success',
  primary: 'bg-primary/10 text-primary',
}

function TaskCard({
  icon: Icon,
  tone,
  title,
  children,
  actions,
}: {
  icon: LucideIcon
  tone: keyof typeof tones
  title: string
  children: ReactNode
  actions: ReactNode
}) {
  return (
    <Card className="flex flex-col p-5">
      <div className={cn('mb-3 flex size-9 items-center justify-center rounded-lg [&_svg]:size-[18px]', tones[tone])}>
        <Icon />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <div className="text-muted-foreground mt-1.5 flex-1 space-y-1.5 text-[13px] leading-relaxed">{children}</div>
      <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
    </Card>
  )
}

export function TasksPage() {
  const checkin = useCheckinAll()
  const daily = useDailyAll()
  const check = useCheckCompensation()
  const claim = useClaimCompensation()
  const accounts = useAccounts()
  const providers = useProviders()
  const routing = useRoutingConfig()
  const [last, setLast] = useState<Last | null>(null)
  const [confirmClaim, setConfirmClaim] = useState(false)

  const nameOf = useMemo(() => {
    const m = new Map((accounts.data ?? []).map((a) => [a.uid, a.nickname]))
    return (uid: string, nickname?: string) => nickname || m.get(uid) || uid.slice(0, 12)
  }, [accounts.data])
  const providerName = (id: string) => providers.data?.providers.find((p) => p.id === id)?.name ?? id

  const busy = checkin.isPending || daily.isPending || check.isPending || claim.isPending
  const auto = routing.data?.autoTaskCron !== false

  return (
    <>
      <PageHeader title="任务中心" description="点一下就跑完，不用选账号。所有任务都是幂等的，重复点也安全。" />

      <div
        className={cn(
          'mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5 text-[13px]',
          auto ? 'bg-card' : 'border-warning/40 bg-warning/8',
        )}
      >
        <Clock className="text-muted-foreground size-4" />
        <span className="font-medium">自动调度{auto ? '已开启' : '已关闭'}</span>
        <span className="text-muted-foreground">
          {auto ? '每天北京时间 01:00 跑完整的 Buddy 每日任务，09:00 和 21:00 各签到一次。' : '定时签到与每日任务不会自动执行，只能在这里手动点。'}
        </span>
        <button className="text-primary ml-auto cursor-pointer text-[13px] font-medium hover:underline" onClick={() => navigate('config')}>
          去配置
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <TaskCard
          icon={Gift}
          tone="warning"
          title="限时补偿积分"
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  check.mutate(undefined, {
                    onSuccess: (data) => setLast({ kind: 'comp-check', at: Date.now(), data }),
                  })
                }
              >
                {check.isPending && <Loader2 className="animate-spin" />}查状态
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setConfirmClaim(true)}>
                {claim.isPending && <Loader2 className="animate-spin" />}领取
              </Button>
            </>
          }
        >
          <p>查有没有可领的限时补偿（例如服务抖动后补 500 积分）。</p>
          <p>「查状态」只读；「领取」只领确实可领的账号，领过的会跳过。</p>
        </TaskCard>
        <TaskCard
          icon={CalendarCheck}
          tone="success"
          title="全部供应商一键签到"
          actions={
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                checkin.mutate(undefined, {
                  onSuccess: (data) => setLast({ kind: 'checkin', at: Date.now(), data }),
                })
              }
            >
              {checkin.isPending ? <Loader2 className="animate-spin" /> : <CalendarCheck />}
              {checkin.isPending ? '签到中…' : '一键签到'}
            </Button>
          }
        >
          <p>对所有账号逐个签到（串行，避免触发风控），国内版和国际版都会签。</p>
          <p>不支持签到的供应商会写明原因，不会静默跳过。</p>
        </TaskCard>
        <TaskCard
          icon={Sparkles}
          tone="primary"
          title="Buddy 每日任务"
          actions={
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                daily.mutate(undefined, {
                  onSuccess: (data) => setLast({ kind: 'daily', at: Date.now(), data }),
                })
              }
            >
              {daily.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
              执行每日任务
            </Button>
          }
        >
          <p>对国内版全部账号执行：签到 → 成长任务 → 真实对话任务（专家召唤 / 技能加载 / 夜猫子）→ 自动领奖。</p>
          <p>真实对话每次都是最短对话，已达标的任务自动跳过。</p>
        </TaskCard>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <div>
            <CardTitle>执行结果</CardTitle>
            <CardDescription>
              {last ? `${LAST_TITLE[last.kind]} · ${fmtRelative(last.at)}` : '点上面任意一个任务后，逐账号结果会显示在这里。'}
            </CardDescription>
          </div>
        </CardHeader>
        {busy ? (
          <div className="text-muted-foreground flex items-center gap-2 px-5 pb-5 text-[13px]">
            <Loader2 className="size-4 animate-spin" /> 正在逐账号执行，账号多时需要一点时间…
          </div>
        ) : last ? (
          <ResultTable last={last} nameOf={nameOf} providerName={providerName} />
        ) : null}
      </Card>

      <TaskProgress />

      <Dialog
        open={confirmClaim}
        onOpenChange={setConfirmClaim}
        title="领取限时补偿积分？"
        description="这是写操作：只领确实可领的账号，已领过的会跳过。活动过了截止时间就作废。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmClaim(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setConfirmClaim(false)
                claim.mutate(undefined, {
                  onSuccess: (data) => setLast({ kind: 'comp-claim', at: Date.now(), data }),
                })
              }}
            >
              领取
            </Button>
          </>
        }
      />
    </>
  )
}

const LAST_TITLE: Record<Last['kind'], string> = {
  checkin: '一键签到',
  daily: 'Buddy 每日任务',
  'comp-check': '补偿积分 · 查状态',
  'comp-claim': '补偿积分 · 领取',
}

type Mark = 'ok' | 'skip' | 'fail' | 'info'
const MARK: Record<Mark, { icon: LucideIcon; cls: string }> = {
  ok: { icon: CheckCircle2, cls: 'text-success' },
  skip: { icon: MinusCircle, cls: 'text-muted-foreground' },
  fail: { icon: XCircle, cls: 'text-danger' },
  info: { icon: CircleDashed, cls: 'text-primary' },
}

interface Row {
  key: string
  mark: Mark
  provider?: string
  who: string
  detail: string
}

function rowsOf(last: Last, nameOf: (uid: string, n?: string) => string): Row[] {
  if (last.kind === 'checkin')
    return last.data.results.map((r) => ({
      key: r.realm + r.uid,
      mark: r.ok ? 'ok' : r.skipped ? 'skip' : 'fail',
      provider: r.provider,
      who: nameOf(r.uid, r.nickname),
      detail: r.detail || (r.ok ? (r.alreadyDone ? '今天已签过' : r.gained ? `+${r.gained} 积分` : '已签到') : ''),
    }))
  if (last.kind === 'daily')
    return last.data.map((s) => ({
      key: s.uid,
      mark: s.error ? 'fail' : 'ok',
      provider: 'buddy',
      who: nameOf(s.uid, s.nickname),
      detail: s.error ?? `已入队 ${s.queued ?? 0} 步，后台逐步执行`,
    }))
  return last.data.map((r) => {
    const base = {
      key: r.realm + r.uid,
      provider: 'buddy',
      who: nameOf(r.uid, r.nickname),
    }
    if (!r.ok) return { ...base, mark: 'fail' as Mark, detail: r.detail || '失败' }
    if (last.kind === 'comp-claim') {
      if (r.alreadyClaimed) return { ...base, mark: 'skip' as Mark, detail: '此前已领，跳过' }
      if (r.claimed)
        return {
          ...base,
          mark: 'ok' as Mark,
          detail: `领取成功 +${r.creditNum ?? 0} 积分`,
        }
      return { ...base, mark: 'skip' as Mark, detail: r.detail || '无可领取' }
    }
    const st = r.status
    // 「查不到」≠「没有补偿」：可能是上游接口形态变了，如实区分
    if (r.available !== true || !st)
      return {
        ...base,
        mark: 'skip' as Mark,
        detail: '查不到补偿活动（可能是接口形态变化，不一定是没有）',
      }
    if (st.claimed)
      return {
        ...base,
        mark: 'skip' as Mark,
        detail: `已领取 ${st.creditNum} 积分`,
      }
    if (!st.active) return { ...base, mark: 'skip' as Mark, detail: '活动已结束' }
    return {
      ...base,
      mark: 'info' as Mark,
      detail: `可领 ${st.creditNum} 积分（截至 ${st.endTime}）`,
    }
  })
}

function ResultTable({
  last,
  nameOf,
  providerName,
}: {
  last: Last
  nameOf: (uid: string, n?: string) => string
  providerName: (id: string) => string
}) {
  const rows = rowsOf(last, nameOf)
  if (!rows.length) return <p className="text-muted-foreground px-5 pb-5 text-[13px]">没有可处理的账号。</p>
  const s = last.kind === 'checkin' ? last.data : null
  return (
    <>
      {s && (
        <div className="flex flex-wrap gap-2 px-5 pb-3">
          <Badge tone="success">成功 {s.ok}</Badge>
          <Badge>跳过 {s.skipped}</Badge>
          <Badge tone={s.failed ? 'danger' : 'neutral'}>失败 {s.failed}</Badge>
          <span className="text-muted-foreground text-xs leading-5">共 {s.total} 个账号</span>
        </div>
      )}
      <Table>
        <THead>
          <tr>
            <TH className="w-10" />
            <TH>账号</TH>
            <TH className="hidden sm:table-cell">供应商</TH>
            <TH>详情</TH>
          </tr>
        </THead>
        <tbody>
          {rows.map((r) => {
            const M = MARK[r.mark]
            return (
              <TR key={r.key}>
                <TD>
                  <M.icon className={cn('size-4', M.cls)} />
                </TD>
                <TD className="font-medium">{r.who}</TD>
                <TD className="hidden sm:table-cell">
                  {r.provider && (
                    <span className="inline-flex items-center gap-2">
                      <ProviderAvatar id={r.provider} name={providerName(r.provider)} size="sm" />
                      {providerName(r.provider)}
                    </span>
                  )}
                </TD>
                <TD className="text-muted-foreground">{r.detail}</TD>
              </TR>
            )
          })}
        </tbody>
      </Table>
    </>
  )
}

function TaskProgress() {
  const accounts = useAccounts()
  const buddy = (accounts.data ?? []).filter((a) => a.provider === 'buddy' && a.realm === 'cn' && !a.disabled)
  const [uid, setUid] = useState('')
  useEffect(() => {
    if (!uid && buddy.length) setUid(buddy[0]!.uid)
  }, [uid, buddy])
  const status = useTaskStatus(uid)
  const st = status.data
  const total = st ? st.done.length + st.queue.length : 0

  return (
    <Card className="mt-4">
      <CardHeader className="flex-wrap gap-3">
        <div>
          <CardTitle>任务进度</CardTitle>
          <CardDescription>每个 Buddy 账号最近一次任务的逐步结果；进行中每 5 秒自动刷新。</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select aria-label="选择账号" value={uid} onChange={(e) => setUid(e.target.value)} className="w-48" disabled={!buddy.length}>
            {!buddy.length && <option value="">没有可用的 Buddy 账号</option>}
            {buddy.map((a) => (
              <option key={a.uid} value={a.uid}>
                {a.nickname || a.uid.slice(0, 12)}
              </option>
            ))}
          </Select>
          <Button variant="outline" size="icon" aria-label="刷新进度" disabled={!uid || status.isFetching} onClick={() => status.refetch()}>
            <RefreshCw className={cn(status.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      {!uid ? (
        <Empty icon={<ListChecks />} title="没有 Buddy 账号">
          每日任务只对国内版 Buddy 账号生效。
        </Empty>
      ) : status.isLoading ? (
        <div className="space-y-2 px-5 pb-5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      ) : !st ? (
        <Empty icon={<ListChecks />} title="还没有运行记录">
          点上面的「执行每日任务」，或等每天 01:00 的自动调度。
        </Empty>
      ) : (
        <div className="px-5 pb-5">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            {st.finished ? (
              <Badge tone="success" dot>
                已完成
              </Badge>
            ) : (
              <Badge tone="info" dot>
                进行中
              </Badge>
            )}
            <span className="text-muted-foreground">
              已完成 {st.done.length} / {total} 步 · 开始于 {fmtDateTime(st.startedAt)} · 更新于 {fmtRelative(st.updatedAt)}
            </span>
          </div>
          <Progress value={total ? (st.done.length / total) * 100 : 100} tone={st.finished ? 'success' : 'primary'} />
          {st.lastError && <div className="bg-danger/8 text-danger mt-3 rounded-md px-3 py-2 text-[13px]">最后错误：{st.lastError}</div>}
          <ul className="mt-3 divide-y rounded-lg border">
            {st.done.map((d, i) => (
              <li key={i} className="flex items-start gap-3 px-3 py-2 text-[13px]">
                {d.ok ? <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" /> : <XCircle className="text-danger mt-0.5 size-4 shrink-0" />}
                <div className="min-w-0">
                  <div>
                    <span className="font-mono text-xs">{d.code}</span>
                    <span className="text-muted-foreground"> → {d.action}</span>
                  </div>
                  {d.detail && <div className="text-muted-foreground mt-0.5 text-xs break-all">{d.detail}</div>}
                </div>
              </li>
            ))}
            {!st.finished && (
              <li className="text-muted-foreground flex items-center gap-3 px-3 py-2 text-[13px]">
                <Loader2 className="size-4 animate-spin" /> 还剩 {st.queue.length} 步排队中…
              </li>
            )}
          </ul>
        </div>
      )}
    </Card>
  )
}
