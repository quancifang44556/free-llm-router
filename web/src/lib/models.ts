import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'
import { api } from './api'

export interface GatewayModel {
  id: string
  name?: string
  owned_by: string
  /** 上游下发的倍率字符串，如 "x0.00" / "x1.5"。 */
  credits?: string
  priceFactor?: number
  isFree?: boolean
}

interface BuiltinModel {
  id: string
  name: string
  provider: string
  providerName?: string
  isFree?: boolean
}

export interface ModelCatalog {
  models: GatewayModel[]
  /** true = 网关没拉到真实模型，展示的是内置清单。 */
  fallback: boolean
  disabledCount: number
  errors: { provider: string; error: string }[]
}

export const isAggregate = (id: string) => id.startsWith('aggregate/')

export function useModelCatalog() {
  return useQuery({
    queryKey: ['models'],
    queryFn: async (): Promise<ModelCatalog> => {
      const [remote, builtin] = await Promise.all([
        api<{
          data?: GatewayModel[]
          disabledCount?: number
          errors?: { provider: string; error: string }[]
        }>('/v1/models').catch(() => undefined),
        api<{ data?: BuiltinModel[] }>('/admin/models/builtin').catch(() => undefined),
      ])
      const live = remote?.data ?? []
      // 只有聚合条目 = 没有任何上游真正返回模型（账号未就绪或上游不可达）
      const real = live.filter((m) => !isAggregate(m.id))
      if (real.length > 0 || !builtin?.data?.length)
        return {
          models: live,
          fallback: false,
          disabledCount: remote?.disabledCount ?? 0,
          errors: remote?.errors ?? [],
        }
      return {
        models: builtin.data.map((b) => ({
          id: b.id,
          name: b.name,
          owned_by: b.provider,
          isFree: b.isFree,
        })),
        fallback: true,
        disabledCount: remote?.disabledCount ?? 0,
        errors: remote?.errors ?? [],
      }
    },
    staleTime: 60_000,
  })
}

// ── 资费检测结果：存 localStorage，跨刷新保留 ──

export interface ProbeResult {
  ok: boolean
  isFree: boolean
  credit: number
  status: string
  error?: string
  officialCredits?: string
  at: number
}

const KEY = 'model_probe_cache'
let cache: Record<string, ProbeResult> = read()
const subs = new Set<() => void>()

function read(): Record<string, ProbeResult> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    return {}
  }
}
function write(next: Record<string, ProbeResult>) {
  cache = next
  try {
    if (Object.keys(next).length) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式等写不进去就算了 */
  }
  for (const f of subs) f()
}

export function useProbeCache() {
  const snap = useSyncExternalStore(
    useCallback((f: () => void) => {
      subs.add(f)
      return () => subs.delete(f)
    }, []),
    () => cache,
  )
  return { cache: snap, clear: () => write({}) }
}

export async function probeModel(m: GatewayModel): Promise<ProbeResult> {
  let r: Omit<ProbeResult, 'at'>
  try {
    r = await api<Omit<ProbeResult, 'at'>>('/admin/models/probe', {
      json: { model: m.id, credits: m.credits ?? '' },
      timeoutMs: 90_000,
    })
  } catch (e) {
    r = {
      ok: false,
      isFree: false,
      credit: -1,
      status: '检测失败',
      error: e instanceof Error ? e.message : String(e),
    }
  }
  const res = { ...r, at: Date.now() }
  write({ ...cache, [m.id]: res })
  return res
}

export function useProbe() {
  return useMutation({ mutationFn: probeModel })
}

/** 资费标签：检测结果优先，其次服务端事实（isFree / priceFactor），再次上游倍率字符串。 */
export function priceOf(m: GatewayModel, probe?: ProbeResult): { label: string; tone: 'success' | 'warning' | 'danger'; title?: string } | undefined {
  if (probe) {
    if (!probe.ok)
      return {
        label: probe.status || '不可用',
        tone: 'danger',
        title: probe.error,
      }
    if (probe.isFree) return { label: '免费', tone: 'success', title: probe.status }
    return {
      label: probe.credit > 0 ? `~${probe.credit} 积分/次` : probe.officialCredits ? `${probe.officialCredits} 倍率` : '计费',
      tone: 'warning',
      title: probe.status,
    }
  }
  // 0 是合法值（免费），不能写成 priceFactor || …
  const pf = typeof m.priceFactor === 'number' ? m.priceFactor : undefined
  if (m.isFree === true || pf === 0) return { label: '免费', tone: 'success' }
  // 聚合条目的倍率是推导值，不展示
  if (isAggregate(m.id)) return undefined
  if (pf !== undefined && Number.isFinite(pf))
    return {
      label: `x${pf.toLocaleString('zh-CN')}`,
      tone: 'warning',
      title: `计费倍率 ${pf}`,
    }
  if (m.credits) {
    const free = m.credits === 'x0.00' || m.credits === 'x0' || m.credits === '0'
    return free ? { label: '免费', tone: 'success' } : { label: `${m.credits} 倍率`, tone: 'warning' }
  }
  return undefined
}

export const isFreeModel = (m: GatewayModel, probe?: ProbeResult) => priceOf(m, probe)?.label === '免费'
