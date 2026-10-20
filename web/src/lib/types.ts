export type Realm = 'cn' | 'global'

export interface Provider {
  id: string
  name: string
  capabilities: {
    login: boolean
    listModels: boolean
    chat: boolean
    balance: boolean
    checkin: boolean
    checkinBlockedReason?: string
    loginBlockedReason?: string
    balanceBlockedReason?: string
  }
}

export interface Account {
  uid: string
  realm: Realm
  provider: string
  nickname: string
  disabled: boolean
  reason: string
  credits: number
  coolKind: string
  until: number
  successCount: number
  errTotal: number
  expiresAt: number | null
  lastSuccess: number
  lastErr: number
  fails: number
  breakerUntil: number
  modelCooldowns: { model: string; until: number }[]
}

export interface PoolCounts {
  total: number
  healthy: number
  disabled: number
  cooling: number
  modelExempt: number
}

export interface UsageRow {
  count: number
  failed: number
  input: number
  output: number
}

export interface Usage {
  total: number
  ok: number
  failed: number
  inputTokens: number
  outputTokens: number
  avgMs: number
  byHour: (UsageRow & { hour: string })[]
  byDay: (UsageRow & { day: string })[]
  byModel: (UsageRow & { model: string })[]
  byAccount: (UsageRow & { uid: string })[]
  activeDays: number
  detailCount: number
  detailCapped: boolean
}

export interface ApiKeyLimits {
  maxRequests: number
  maxTokens: number
  windowHours: number
  models: string[]
  allowedIps: string[]
  expiresAt: number
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number
  enabled: boolean
  limits: ApiKeyLimits
  usage: {
    requests: number
    inputTokens: number
    outputTokens: number
    rejected: number
    lastIp: string
    lastModel: string
  }
}

export interface LogEntry {
  id: string
  time: number
  type: string
  model?: string
  provider?: string
  uid?: string
  status?: number
  durationMs?: number
  tokens?: { input: number; output: number; total: number }
  stream?: boolean
  error?: string
}
/** 指定账号模式：only = 只用它（不可用就报错），prefer = 优先用它（不可用时自动换号）。 */
export type PinMode = 'only' | 'prefer'

export interface AccountPin {
  realm: Realm
  provider: string
  uid: string
  mode: PinMode
  nickname: string
}
