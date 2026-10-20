import { Activity, ArrowDownToLine, ArrowUpFromLine, CircleAlert, Clock } from 'lucide-react'
import { useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatCard } from '@/components/StatCard'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, Progress, Segmented, Skeleton } from '@/components/ui/misc'
import { Table, TD, TH, THead, TR } from '@/components/ui/table'
import { useAccounts, useUsage } from '@/lib/queries'
import type { UsageRow } from '@/lib/types'
import { fmtCompact, fmtInt, fmtMs, pct } from '@/lib/utils'

const RANGES = [
  { value: '1', label: '今日' },
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '0', label: '全部' },
] as const
type RangeValue = (typeof RANGES)[number]['value']

export function UsagePage() {
  const [range, setRange] = useState<RangeValue>(() => (localStorage.getItem('wb_usage_range') as RangeValue) || '7')
  const days = Number(range)
  const usage = useUsage(days)
  const accounts = useAccounts()
  const u = usage.data
  const nick = (uid: string) => accounts.data?.find((a) => a.uid === uid)?.nickname

  const series =
    days === 1
      ? (u?.byHour ?? []).map((r) => ({
          label: r.hour.slice(0, 5),
          ok: r.count - r.failed,
          failed: r.failed,
          tokens: r.input + r.output,
        }))
      : (u?.byDay ?? []).map((r) => ({
          label: r.day.slice(5).replace('-', '/'),
          ok: r.count - r.failed,
          failed: r.failed,
          tokens: r.input + r.output,
        }))

  return (
    <>
      <PageHeader
        title="用量"
        description="经网关转发的全部请求。汇总按天保留 90 天，明细保留最近 500 条。"
        actions={
          <Segmented<RangeValue>
            value={range}
            onChange={(v) => {
              localStorage.setItem('wb_usage_range', v)
              setRange(v)
            }}
            options={[...RANGES]}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="请求数"
          value={fmtInt(u?.total ?? 0)}
          icon={Activity}
          tone="primary"
          loading={!u}
          sub={u ? `成功率 ${pct(u.ok, u.total).toFixed(1)}%` : ''}
        />
        <StatCard
          label="失败"
          value={fmtInt(u?.failed ?? 0)}
          icon={CircleAlert}
          tone={u?.failed ? 'danger' : 'neutral'}
          loading={!u}
          sub="含上游报错与超时"
        />
        <StatCard
          label="输入 token"
          value={fmtCompact(u?.inputTokens ?? 0)}
          icon={ArrowDownToLine}
          loading={!u}
          sub={u ? fmtInt(u.inputTokens) : ''}
        />
        <StatCard
          label="输出 token"
          value={fmtCompact(u?.outputTokens ?? 0)}
          icon={ArrowUpFromLine}
          loading={!u}
          sub={u ? fmtInt(u.outputTokens) : ''}
        />
        <StatCard className="col-span-2 md:col-span-1" label="平均耗时" value={fmtMs(u?.avgMs ?? 0)} icon={Clock} loading={!u} sub="首包到结束" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>请求趋势</CardTitle>
              <CardDescription>{days === 1 ? '今日按小时' : '按天'}，成功与失败分开堆叠</CardDescription>
            </div>
            <div className="text-muted-foreground flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="bg-chart-1 size-2 rounded-sm" />
                成功
              </span>
              <span className="flex items-center gap-1.5">
                <span className="bg-danger size-2 rounded-sm" />
                失败
              </span>
            </div>
          </CardHeader>
          <div className="h-72 px-2 pb-4">
            {!u ? (
              <Skeleton className="mx-3 h-full" />
            ) : series.length === 0 ? (
              <Empty title="这个时间段还没有请求" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ top: 8, right: 12, left: -12, bottom: 0 }} barCategoryGap="28%" maxBarSize={44}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
                  <YAxis tickLine={false} axisLine={false} allowDecimals={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
                  <Tooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTip />} />
                  <Bar dataKey="ok" name="成功" stackId="a" fill="var(--chart-1)" />
                  <Bar dataKey="failed" name="失败" stackId="a" fill="var(--danger)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Token 消耗</CardTitle>
              <CardDescription>输入 + 输出</CardDescription>
            </div>
            <div className="tabular text-right text-lg font-semibold">{fmtCompact((u?.inputTokens ?? 0) + (u?.outputTokens ?? 0))}</div>
          </CardHeader>
          <div className="h-40 px-2">
            {u && series.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 12, left: 12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="tk" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" hide />
                  <Tooltip content={<ChartTip tokens />} cursor={{ stroke: 'var(--border)' }} />
                  <Area type="monotone" dataKey="tokens" name="Token" stroke="var(--chart-2)" strokeWidth={2} fill="url(#tk)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 px-5 pt-2 pb-5">
            <Split label="输入" value={u?.inputTokens ?? 0} total={(u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)} />
            <Split label="输出" value={u?.outputTokens ?? 0} total={(u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <RankCard
          title="按模型"
          rows={u?.byModel.map((r) => ({ ...r, key: r.model, name: r.model })) ?? []}
          total={u?.total ?? 0}
          loading={!u}
          mono
        />
        <RankCard
          title="按账号"
          rows={
            u?.byAccount.map((r) => ({
              ...r,
              key: r.uid,
              name: nick(r.uid) ?? r.uid,
              sub: r.uid,
            })) ?? []
          }
          total={u?.total ?? 0}
          loading={!u}
        />
      </div>
    </>
  )
}

function Split({ label, value, total }: { label: string; value: number; total: number }) {
  return (
    <div className="bg-muted/60 rounded-lg px-3 py-2.5">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="tabular mt-0.5 font-semibold">
        {fmtCompact(value)} <span className="text-muted-foreground text-xs font-normal">{pct(value, total).toFixed(0)}%</span>
      </div>
    </div>
  )
}

function ChartTip({
  active,
  payload,
  label,
  tokens,
}: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  tokens?: boolean
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-popover rounded-lg border px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="text-muted-foreground flex items-center gap-2">
          <span className="size-2 rounded-sm" style={{ background: p.color }} />
          {p.name}
          <span className="tabular text-foreground ml-auto pl-4 font-medium">{tokens ? fmtInt(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

function RankCard({
  title,
  rows,
  total,
  loading,
  mono,
}: {
  title: string
  rows: (UsageRow & { key: string; name: string; sub?: string })[]
  total: number
  loading?: boolean
  mono?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>按请求数排序，前 8 名</CardDescription>
        </div>
      </CardHeader>
      {loading ? (
        <div className="space-y-2 px-5 pb-5">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>{title.replace('按', '')}</TH>
              <TH className="w-[38%]">占比</TH>
              <TH className="text-right">请求</TH>
              <TH className="hidden text-right sm:table-cell">Token</TH>
              <TH className="text-right">失败</TH>
            </tr>
          </THead>
          <tbody>
            {rows.slice(0, 8).map((r) => (
              <TR key={r.key}>
                <TD className="max-w-48">
                  <div className={mono ? 'truncate font-mono text-[12.5px]' : 'truncate font-medium'}>{r.name}</div>
                  {r.sub && <div className="text-muted-foreground truncate font-mono text-[11px]">{r.sub}</div>}
                </TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <Progress value={pct(r.count, total)} />
                    <span className="tabular text-muted-foreground w-10 text-right text-xs">{pct(r.count, total).toFixed(0)}%</span>
                  </div>
                </TD>
                <TD className="tabular text-right font-medium">{fmtInt(r.count)}</TD>
                <TD className="tabular text-muted-foreground hidden text-right sm:table-cell">{fmtCompact(r.input + r.output)}</TD>
                <TD className={r.failed ? 'tabular text-danger text-right' : 'tabular text-muted-foreground text-right'}>{r.failed}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  )
}
