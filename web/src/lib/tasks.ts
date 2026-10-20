import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from './api'
import type { Realm } from './types'

const REALMS: Realm[] = ['cn', 'global']
/** 逐账号串行打上游，账号多时会很久；给足 10 分钟。 */
const LONG = 10 * 60_000

export interface CheckinRow {
  uid: string
  provider: string
  nickname?: string
  ok: boolean
  skipped?: boolean
  alreadyDone?: boolean
  gained?: number
  detail?: string
  realm: Realm
}

export interface CheckinSummary {
  total: number
  ok: number
  skipped: number
  failed: number
  results: CheckinRow[]
}

export interface CompensationRow {
  uid: string
  nickname?: string
  ok: boolean
  detail?: string
  available?: boolean
  status?: {
    claimed: boolean
    active: boolean
    creditNum: number
    endTime: string
  } | null
  // 领取接口的字段
  claimed?: boolean
  alreadyClaimed?: boolean
  creditNum?: number
  realm: Realm
}

export interface DailyStarted {
  uid: string
  nickname?: string
  queued?: number
  error?: string
}

export interface RunState {
  uid: string
  plan?: string
  queue: unknown[]
  done: { code: string; action: string; ok: boolean; detail: string }[]
  finished: boolean
  lastError: string
  startedAt: number
  updatedAt: number
}

/** 签到 / 任务会真的改积分：跑完把账号与余额相关查询都刷新。 */
function useRefreshAfterTask() {
  const qc = useQueryClient()
  return () => {
    for (const k of ['accounts', 'pool', 'logs']) qc.invalidateQueries({ queryKey: [k] })
  }
}

/** 全部供应商一键签到 —— 两个分片都签（国际版账号在 global）。 */
export function useCheckinAll() {
  const refresh = useRefreshAfterTask()
  return useMutation<CheckinSummary, Error, void>({
    mutationFn: async () => {
      const results: CheckinRow[] = []
      for (const realm of REALMS) {
        const r = await api<{ results: Omit<CheckinRow, 'realm'>[] }>('/admin/checkin/all', { json: { realm }, timeoutMs: LONG })
        for (const row of r.results) results.push({ ...row, realm })
      }
      return {
        total: results.length,
        ok: results.filter((r) => r.ok).length,
        skipped: results.filter((r) => !r.ok && r.skipped).length,
        failed: results.filter((r) => !r.ok && !r.skipped).length,
        results,
      }
    },
    onSuccess: (s) => {
      refresh()
      if (s.total === 0) toast.info('没有可签到的账号')
      else toast[s.failed ? 'warning' : 'success'](`签到完成：成功 ${s.ok} · 跳过 ${s.skipped} · 失败 ${s.failed}`)
    },
    onError: (e) => toast.error('签到失败', { description: e.message }),
  })
}

/** Buddy 每日任务（入队后由 TaskRunner 逐步执行）。 */
export function useDailyAll() {
  const refresh = useRefreshAfterTask()
  const qc = useQueryClient()
  return useMutation<DailyStarted[], Error, void>({
    mutationFn: () =>
      api<{ started: DailyStarted[] }>('/admin/tasks/daily-all', {
        json: { realm: 'cn' },
        timeoutMs: LONG,
      }).then((r) => r.started),
    onSuccess: (started) => {
      refresh()
      qc.invalidateQueries({ queryKey: ['task-status'] })
      // 任务是异步跑的：稍后再刷两次，把最终积分带上
      setTimeout(refresh, 45_000)
      setTimeout(refresh, 120_000)
      const ok = started.filter((s) => !s.error).length
      if (!started.length) toast.info('没有可执行的 Buddy 账号')
      else
        toast.success(`已为 ${ok} 个账号入队`, {
          description: '任务在后台逐步执行，可在下方「任务进度」查看。',
        })
    },
    onError: (e) => toast.error('入队失败', { description: e.message }),
  })
}

/** 查限时补偿状态（只读，但会真打上游，故手动触发）。 */
export function useCheckCompensation() {
  return useMutation<CompensationRow[], Error, void>({
    mutationFn: async () => {
      const rows: CompensationRow[] = []
      for (const realm of REALMS) {
        const r = await api<{ results?: Omit<CompensationRow, 'realm'>[] }>(`/admin/compensation?realm=${realm}&provider=buddy`, { timeoutMs: LONG })
        for (const row of r.results ?? []) rows.push({ ...row, realm })
      }
      return rows
    },
    onError: (e) => toast.error('查询失败', { description: e.message }),
  })
}

/** 领取补偿（写操作：只领确实可领的，已领过的服务端会跳过）。 */
export function useClaimCompensation() {
  const refresh = useRefreshAfterTask()
  return useMutation<CompensationRow[], Error, void>({
    mutationFn: async () => {
      const rows: CompensationRow[] = []
      for (const realm of REALMS) {
        const r = await api<{ results?: Omit<CompensationRow, 'realm'>[] }>('/admin/compensation/claim', {
          json: { realm, provider: 'buddy' },
          timeoutMs: LONG,
        })
        for (const row of r.results ?? []) rows.push({ ...row, realm })
      }
      return rows
    },
    onSuccess: (rows) => {
      refresh()
      const got = rows.filter((r) => r.claimed && !r.alreadyClaimed)
      if (got.length) toast.success(`领取成功 ${got.length} 个账号，共 +${got.reduce((s, r) => s + (r.creditNum ?? 0), 0)} 积分`)
      else toast.info('没有新领取的补偿')
    },
    onError: (e) => toast.error('领取失败', { description: e.message }),
  })
}

/** 单账号任务进度；进行中每 5 秒自动刷新。 */
export function useTaskStatus(uid: string) {
  return useQuery({
    queryKey: ['task-status', uid],
    enabled: uid !== '',
    queryFn: () => api<{ status: RunState | null }>(`/admin/tasks/status?uid=${encodeURIComponent(uid)}`).then((r) => r.status),
    refetchInterval: (q) => (q.state.data && !q.state.data.finished ? 5000 : false),
  })
}
