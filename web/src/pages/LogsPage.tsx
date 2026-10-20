import { RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Empty, Segmented, Skeleton } from '@/components/ui/misc'
import { Table, TD, TH, THead, TR } from '@/components/ui/table'
import { useClearLogs, useLogs } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { fmtDateTime, fmtInt, fmtMs } from '@/lib/utils'

type F = 'all' | 'api' | 'error' | 'task'

export function LogsPage() {
  const logs = useLogs()
  const clear = useClearLogs()
  const [f, setF] = useState<F>('all')
  const [confirm, setConfirm] = useState(false)
  const rows = (logs.data ?? []).filter((l) => f === 'all' || l.type === f)
  return (
    <>
      <PageHeader
        title="日志"
        description="最近的请求与任务记录，用来排查「为什么这次失败」。"
        actions={
          <>
            <Button variant="ghost" size="icon" onClick={() => logs.refetch()} aria-label="刷新" disabled={logs.isFetching}>
              <RefreshCw className={cn(logs.isFetching && 'animate-spin')} />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setConfirm(true)} aria-label="清空日志" disabled={!logs.data?.length}>
              <Trash2 />
            </Button>
            <Segmented<F>
              value={f}
              onChange={setF}
              options={[
                { value: 'all', label: '全部' },
                { value: 'api', label: '请求' },
                { value: 'error', label: '错误' },
                { value: 'task', label: '任务' },
              ]}
            />
          </>
        }
      />
      <Card>
        {logs.isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !rows.length ? (
          <Empty icon={<ScrollText />} title="没有日志" />
        ) : (
          <Table>
            <THead className="border-t-0">
              <tr>
                <TH>时间</TH>
                <TH>状态</TH>
                <TH>模型</TH>
                <TH className="hidden md:table-cell">账号</TH>
                <TH className="hidden text-right sm:table-cell">Token</TH>
                <TH className="text-right">耗时</TH>
                <TH className="hidden lg:table-cell">说明</TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((l, i) => (
                <TR key={`${l.id}-${i}`}>
                  <TD className="text-muted-foreground tabular whitespace-nowrap">{fmtDateTime(l.time)}</TD>
                  <TD>
                    <Badge tone={l.type === 'task' ? 'info' : (l.status ?? 200) >= 400 ? 'danger' : 'success'} className="font-mono">
                      {l.type === 'task' ? '任务' : l.status}
                    </Badge>
                  </TD>
                  <TD className="font-mono text-[12.5px] whitespace-nowrap">{l.model ?? '—'}</TD>
                  <TD className="text-muted-foreground hidden font-mono text-[12px] md:table-cell">{l.uid}</TD>
                  <TD className="tabular text-muted-foreground hidden text-right sm:table-cell">{l.tokens ? fmtInt(l.tokens.total) : '—'}</TD>
                  <TD className="tabular text-right whitespace-nowrap">{fmtMs(l.durationMs ?? 0)}</TD>
                  <TD className="text-muted-foreground hidden max-w-64 truncate lg:table-cell" title={l.error}>
                    {l.error ?? (l.stream ? '流式' : '非流式')}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="清空全部日志？"
        description="请求与任务日志都会删除（国内版、国际版），用量统计不受影响。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={clear.isPending} onClick={() => clear.mutate(undefined, { onSuccess: () => setConfirm(false) })}>
              清空
            </Button>
          </>
        }
      />
    </>
  )
}
