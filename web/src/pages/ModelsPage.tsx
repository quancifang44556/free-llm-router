import { Boxes, Copy, FlaskConical, Info, Loader2, Search, Square, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input, Select } from '@/components/ui/input'
import { Empty, Progress, Segmented, Skeleton } from '@/components/ui/misc'
import { Table, TD, TH, THead, TR } from '@/components/ui/table'
import { type GatewayModel, isAggregate, isFreeModel, priceOf, probeModel, useModelCatalog, useProbeCache } from '@/lib/models'
import { useProviders } from '@/lib/queries'
import { fmtInt } from '@/lib/utils'

type Price = 'all' | 'free'

export async function copyText(text: string, ok = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(ok)
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

export function ModelsPage() {
  const catalog = useModelCatalog()
  const providers = useProviders()
  const { cache, clear } = useProbeCache()
  const [q, setQ] = useState('')
  const [price, setPrice] = useState<Price>('all')
  const [owner, setOwner] = useState('')
  const [probing, setProbing] = useState<Set<string>>(new Set())
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const stop = useRef(false)

  const names = useMemo(() => {
    const m = new Map<string, string>([['aggregate', '聚合路由']])
    for (const p of providers.data?.providers ?? []) m.set(p.id, p.name)
    return m
  }, [providers.data])
  const nameOf = (id: string) => names.get(id) ?? id

  const all = catalog.data?.models ?? []
  const owners = useMemo(() => {
    const c = new Map<string, number>()
    for (const m of all) c.set(m.owned_by, (c.get(m.owned_by) ?? 0) + 1)
    return [...c.entries()]
  }, [all])
  const rows = all.filter(
    (m) =>
      (!owner || m.owned_by === owner) &&
      (price === 'all' || isFreeModel(m, cache[m.id])) &&
      (!q || m.id.toLowerCase().includes(q.toLowerCase()) || (m.name ?? '').toLowerCase().includes(q.toLowerCase())),
  )
  const freeCount = all.filter((m) => isFreeModel(m, cache[m.id])).length
  const probeTargets = rows.filter((m) => !isAggregate(m.id))
  const cachedCount = Object.keys(cache).length

  const probeOne = async (m: GatewayModel) => {
    setProbing((s) => new Set(s).add(m.id))
    const r = await probeModel(m)
    setProbing((s) => {
      const n = new Set(s)
      n.delete(m.id)
      return n
    })
    return r
  }

  const runBatch = async () => {
    setConfirm(false)
    stop.current = false
    const list = probeTargets
    setBatch({ done: 0, total: list.length })
    let free = 0
    let failed = 0
    let i = 0
    for (const m of list) {
      if (stop.current) break
      const r = await probeOne(m)
      if (!r.ok) failed++
      else if (r.isFree) free++
      setBatch({ done: ++i, total: list.length })
    }
    setBatch(null)
    toast.success(stop.current ? `已停止，检测了 ${i} 个` : `检测完成：${i} 个模型`, { description: `免费 ${free} 个 · 不可用 ${failed} 个` })
  }

  return (
    <>
      <PageHeader
        title="模型"
        description="网关对外提供的模型，客户端把模型 ID 填进 model 字段即可。"
        actions={
          <>
            {cachedCount > 0 && !batch && (
              <Button variant="ghost" onClick={() => (clear(), toast.success('已清除检测结果'))}>
                <Trash2 /> 清除检测结果
              </Button>
            )}
            {batch ? (
              <Button variant="outline" onClick={() => (stop.current = true)}>
                <Square /> 停止（{batch.done}/{batch.total}）
              </Button>
            ) : (
              <Button onClick={() => setConfirm(true)} disabled={!probeTargets.length || catalog.data?.fallback}>
                <FlaskConical /> 检测资费
              </Button>
            )}
          </>
        }
      />

      {catalog.data?.fallback && (
        <div className="border-primary/25 bg-primary/[0.05] mb-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[13px] leading-relaxed">
          <Info className="text-primary mt-0.5 size-4 shrink-0" />
          <span>网关还没拉到任何上游模型（账号未就绪，或上游暂时不可达），下面是内置的已知模型清单，仅供参考。添加可用账号后会显示真实列表。</span>
        </div>
      )}
      {!!catalog.data?.errors.length && !catalog.data.fallback && (
        <div className="bg-warning/10 text-warning mb-4 rounded-lg px-4 py-3 text-[13px] leading-relaxed">
          有 {catalog.data.errors.length} 家拉取模型失败：
          {catalog.data.errors.map((e) => `${nameOf(e.provider)}（${e.error}）`).join('；')}
        </div>
      )}
      {batch && (
        <div className="mb-4 rounded-lg border px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 font-medium">
              <Loader2 className="size-4 animate-spin" /> 正在逐个检测资费…
            </span>
            <span className="text-muted-foreground tabular">
              {batch.done} / {batch.total}
            </span>
          </div>
          <Progress value={(batch.done / Math.max(batch.total, 1)) * 100} />
        </div>
      )}

      <Card>
        <div className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模型 ID / 名称" className="h-8 pl-8 text-[13px]" />
          </div>
          <div className="flex gap-2">
            <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="h-8 min-w-36 text-[13px]" aria-label="供应商">
              <option value="">全部供应商（{all.length}）</option>
              {owners.map(([id, n]) => (
                <option key={id} value={id}>
                  {nameOf(id)}（{n}）
                </option>
              ))}
            </Select>
            <Segmented<Price>
              value={price}
              onChange={setPrice}
              className="h-8 [&_button]:h-6 [&_button]:text-xs"
              options={[
                { value: 'all', label: '全部' },
                { value: 'free', label: `免费 ${freeCount}` },
              ]}
            />
          </div>
        </div>

        {catalog.isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !rows.length ? (
          <Empty icon={<Boxes />} title={all.length ? '没有匹配的模型' : '暂无模型'}>
            {all.length ? '换个关键词或筛选条件试试。' : '添加账号后，各家可用模型会出现在这里。'}
          </Empty>
        ) : (
          <Table>
            <THead className="border-t-0">
              <tr>
                <TH className="w-[60%]">模型</TH>
                <TH className="hidden md:table-cell">供应商</TH>
                <TH>资费</TH>
                <TH className="w-px" />
              </tr>
            </THead>
            <tbody>
              {rows.map((m) => {
                const p = priceOf(m, cache[m.id])
                const busy = probing.has(m.id)
                return (
                  <TR key={m.id}>
                    <TD className="max-w-0 min-w-0">
                      <button
                        className="group block max-w-full cursor-pointer text-left"
                        onClick={() => copyText(m.id, `已复制 ${m.id}`)}
                        title="点击复制模型 ID"
                      >
                        <div className="truncate font-mono text-[12.5px] font-medium group-hover:underline">{m.id}</div>
                        {m.name && m.name !== m.id && <div className="text-muted-foreground truncate text-xs">{m.name}</div>}
                      </button>
                    </TD>
                    <TD className="text-muted-foreground hidden whitespace-nowrap md:table-cell">{nameOf(m.owned_by)}</TD>
                    <TD className="whitespace-nowrap">
                      {p ? (
                        <Badge tone={p.tone} title={p.title}>
                          {p.label}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex justify-end gap-1">
                        {!isAggregate(m.id) && !catalog.data?.fallback && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy || !!batch}
                            onClick={() => probeOne(m)}
                            title="发一次 1 token 请求，看实际扣多少积分"
                          >
                            {busy ? <Loader2 className="animate-spin" /> : <FlaskConical />}
                            <span className="hidden sm:inline">测资费</span>
                          </Button>
                        )}
                        <Button variant="ghost" size="icon-sm" onClick={() => copyText(m.id, `已复制 ${m.id}`)} aria-label="复制模型 ID">
                          <Copy />
                        </Button>
                      </div>
                    </TD>
                  </TR>
                )
              })}
            </tbody>
          </Table>
        )}
        {!!all.length && (
          <div className="text-muted-foreground border-t px-5 py-3 text-xs">
            共 {fmtInt(all.length)} 个模型，当前显示 {fmtInt(rows.length)} 个
            {catalog.data?.disabledCount ? `；另有 ${fmtInt(catalog.data.disabledCount)} 个已在供应商详情里关闭` : ''}
            {cachedCount ? `；已检测 ${fmtInt(cachedCount)} 个` : ''}
          </div>
        )}
      </Card>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`检测 ${probeTargets.length} 个模型的资费？`}
        description="会对每个模型真实发送一次 1 token 的请求，根据上游返回的扣费判断是否免费。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button onClick={runBatch}>开始检测</Button>
          </>
        }
      >
        <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed">
          <li>只检测当前筛选出的模型（聚合条目跳过），逐个进行，可随时停止。</li>
          <li>计费模型会消耗极少量积分；结果保存在本浏览器，可随时清除。</li>
        </ul>
      </Dialog>
    </>
  )
}
