import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from './api'
import { sortByOrder } from './queries'
import type { Realm } from './types'

const REALMS: Realm[] = ['cn', 'global']

export type Strategy = 'expiry' | 'roundrobin' | 'random'

export interface RoutingConfig {
  strategy: Strategy
  maxRetries: number
  softCooldownSeconds: number
  autoTaskCron: boolean
  autoRefreshCredential: boolean
}

export function useRoutingConfig() {
  return useQuery({
    queryKey: ['routing'],
    queryFn: () => api<{ config: RoutingConfig }>('/admin/config/routing').then((r) => r.config),
    staleTime: 60_000,
  })
}

export function useSaveRouting() {
  const qc = useQueryClient()
  return useMutation<RoutingConfig, Error, Partial<RoutingConfig>>({
    mutationFn: (v) => api<{ config: RoutingConfig }>('/admin/config/routing', { json: v }).then((r) => r.config),
    onSuccess: (cfg) => {
      qc.setQueryData(['routing'], cfg)
      toast.success('路由与调度配置已保存', {
        description: '国内版和国际版分片都已生效。',
      })
    },
    onError: (e) => toast.error('保存失败', { description: e.message }),
  })
}

export function usePermanentLocks() {
  return useQuery({
    queryKey: ['perm-locks'],
    queryFn: () => api<{ locks: Record<string, boolean> }>('/admin/permanent-locks').then((r) => r.locks),
  })
}

export function useSetPermanentLock() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { provider: string; name: string; locked: boolean }>({
    mutationFn: ({ provider, locked }) => api('/admin/permanent-locks', { json: { provider, locked } }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['perm-locks'] })
      toast.success(`${v.name} 永久积分锁已${v.locked ? '开启' : '解除'}`)
    },
    onError: (e) => toast.error('设置失败', { description: e.message }),
  })
}

export interface WafStatus {
  realm: Realm
  active: boolean
  until?: number
  recentUids?: number
  windowMs: number
  threshold: number
}

/** 出口 IP 被上游 WAF 拦截的熔断状态（两个分片各自独立）。 */
export function useWaf() {
  return useQuery({
    queryKey: ['waf'],
    queryFn: async () => {
      const out: WafStatus[] = []
      for (const realm of REALMS)
        out.push({
          ...(await api<Omit<WafStatus, 'realm'>>(`/admin/waf?realm=${realm}`)),
          realm,
        })
      return out
    },
    refetchInterval: 60_000,
  })
}

export function useClearWaf() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, Realm[]>({
    mutationFn: async (realms) => {
      for (const realm of realms) await api('/admin/waf/clear', { json: { realm } })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['waf'] })
      toast.success('已解除 IP 级拦截', {
        description: '若其实是账号级问题，相关账号仍在各自的冷却中。',
      })
    },
    onError: (e) => toast.error('操作失败', { description: e.message }),
  })
}

/** 清空冷却：不传 uid = 全部账号（两个分片）；传 uid = 只清这一个号。 */
export function useClearCooldowns() {
  const qc = useQueryClient()
  return useMutation<{ cleared: number; resetCount: number }, Error, { uid?: string; realm?: Realm } | void>({
    mutationFn: async (v) => {
      const realms = v && v.realm ? [v.realm] : REALMS
      let cleared = 0
      let resetCount = 0
      for (const realm of realms) {
        const r = await api<{ cleared: number; resetCount: number }>('/admin/cooldowns/clear', { json: { realm, uid: v ? v.uid : undefined } })
        cleared += r.cleared ?? 0
        resetCount += r.resetCount ?? 0
      }
      return { cleared, resetCount }
    },
    onSuccess: (r) => {
      for (const k of ['accounts', 'pool']) qc.invalidateQueries({ queryKey: [k] })
      toast.success('冷却已清空', {
        description: `解冻 ${r.resetCount} 个账号，清掉 ${r.cleared} 条模型级冷却。`,
      })
    },
    onError: (e) => toast.error('操作失败', { description: e.message }),
  })
}

export function useCredentialCount() {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: async () => {
      let n = 0
      for (const realm of REALMS) n += (await api<{ count: number }>(`/admin/credentials?realm=${realm}`)).count
      return n
    },
    staleTime: 60_000,
  })
}

/** 保存供应商展示顺序（拖动排序）。乐观更新：松手即生效，失败再回滚。 */
export function useSetProviderOrder() {
  const qc = useQueryClient()
  type Data = { default: string; providers: { id: string }[]; order?: string[]; disabled?: string[] }
  return useMutation<unknown, Error, { order: string[]; disabled: string[] }, { prev?: Data }>({
    mutationFn: ({ order, disabled }) => api('/admin/providers/settings', { json: { order, disabled } }),
    onMutate: async ({ order }) => {
      await qc.cancelQueries({ queryKey: ['providers'] })
      const prev = qc.getQueryData<Data>(['providers'])
      if (prev) qc.setQueryData<Data>(['providers'], { ...prev, order, providers: sortByOrder(prev.providers, order) })
      return { prev }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['providers'], ctx.prev)
      toast.error('保存顺序失败', { description: e.message })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  })
}

/** 停用 / 启用供应商（停用 = 模型从 /v1/models 消失，且拒绝路由到它）。 */
export function useSetProviderDisabled() {
  const qc = useQueryClient()
  return useMutation<
    unknown,
    Error,
    {
      id: string
      name: string
      disabled: boolean
      current: { order: string[]; disabled: string[] }
    }
  >({
    mutationFn: ({ id, disabled, current }) => {
      const next = new Set(current.disabled)
      if (disabled) next.add(id)
      else next.delete(id)
      return api('/admin/providers/settings', {
        json: { order: current.order, disabled: [...next] },
      })
    },
    onSuccess: (_r, v) => {
      for (const k of ['providers', 'models']) qc.invalidateQueries({ queryKey: [k] })
      toast.success(v.disabled ? `已停用 ${v.name}` : `已启用 ${v.name}`, {
        description: v.disabled ? '它的模型不再出现在 /v1/models，请求也不会路由过去。' : '它的模型重新出现在 /v1/models。',
      })
    },
    onError: (e) => toast.error('操作失败', { description: e.message }),
  })
}
