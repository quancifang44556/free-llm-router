import { useEffect, useState } from 'react'

export type View = 'providers' | 'usage' | 'tasks' | 'apikeys' | 'models' | 'config' | 'logs'
export const VIEWS: View[] = ['providers', 'usage', 'tasks', 'apikeys', 'models', 'config', 'logs']

function parse(): View {
  const v = location.hash.replace(/^#\/?/, '') as View
  return VIEWS.includes(v) ? v : 'providers'
}

/** 极简 hash 路由：#/usage 这种地址可收藏、可刷新，不需要服务端配合。 */
export function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(parse)
  useEffect(() => {
    const on = () => setView(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [view, (v) => (location.hash = '/' + v)]
}
/** 跨页跳转（例如任务中心 → 配置）。 */
export function navigate(v: View): void {
  location.hash = '/' + v
  window.scrollTo({ top: 0 })
}
