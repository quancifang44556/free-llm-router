import { Activity, Boxes, KeyRound, LayoutGrid, ListChecks, ScrollText, Settings2, type LucideIcon } from 'lucide-react'
import type { View } from '@/lib/router'

export interface NavItem {
  view: View
  label: string
  icon: LucideIcon
  desc: string
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '总览',
    items: [
      {
        view: 'providers',
        label: '供应商与账号',
        icon: LayoutGrid,
        desc: '账号池健康度、每家供应商的账号与能力',
      },
      {
        view: 'usage',
        label: '用量',
        icon: Activity,
        desc: '请求量、token 与成功率，按模型和账号拆分',
      },
    ],
  },
  {
    group: '自动化',
    items: [
      {
        view: 'tasks',
        label: '任务中心',
        icon: ListChecks,
        desc: '签到、成长任务与限时补偿积分',
      },
    ],
  },
  {
    group: '接入',
    items: [
      {
        view: 'apikeys',
        label: 'API Key',
        icon: KeyRound,
        desc: '给客户端签发子密钥，可限额、限模型、限来源 IP',
      },
      {
        view: 'models',
        label: '模型',
        icon: Boxes,
        desc: '模型目录、启停与单模型探测',
      },
      {
        view: 'config',
        label: '配置',
        icon: Settings2,
        desc: '接入指南、路由策略与永久积分锁',
      },
    ],
  },
  {
    group: '运维',
    items: [
      {
        view: 'logs',
        label: '日志',
        icon: ScrollText,
        desc: '最近的请求与任务记录',
      },
    ],
  },
]

export const NAV_ITEMS = NAV.flatMap((g) => g.items)
