import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

export const fmtInt = (n: number) => Math.round(n).toLocaleString('zh-CN')

export function fmtCompact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'
  return String(Math.round(n))
}

export function fmtMs(ms: number): string {
  if (!ms) return '—'
  return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10_000 ? 0 : 1) + ' 秒' : Math.round(ms) + ' 毫秒'
}

/** 相对时间：过去「3 分钟前」，未来「12 分钟后」；0 表示没有。 */
export function fmtRelative(ts: number, now = Date.now()): string {
  if (!ts) return '—'
  const d = ts - now
  const abs = Math.abs(d)
  const suffix = d > 0 ? '后' : '前'
  if (abs < 60_000) return d > 0 ? '马上' : '刚刚'
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${suffix}`
  return `${Math.round(abs / 86_400_000)} 天${suffix}`
}

export function fmtDateTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const pct = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0)

/** 供应商头像配色：按 id 稳定取色，不同家一眼能分开。 */
const HUES = [255, 160, 25, 300, 200, 60, 330, 120, 280, 10, 230, 90, 180, 350, 40]
export function providerHue(id: string): number {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]
}
