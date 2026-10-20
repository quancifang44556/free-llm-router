import { Copy, Eraser, KeyRound, MoreHorizontal, Pencil, Plus, Power, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Empty, Progress, Skeleton } from '@/components/ui/misc'
import { Table, TD, TH, THead, TR } from '@/components/ui/table'
import { useApiKeys, useCreateApiKey, useRemoveApiKey, useResetApiKey, useResetApiKeyUsage, useToggleApiKey, useUpdateApiKey } from '@/lib/queries'
import type { ApiKey } from '@/lib/types'
import { fmtCompact, fmtDateTime, fmtInt, fmtRelative, pct } from '@/lib/utils'

export function ApiKeysPage() {
  const keys = useApiKeys()
  const toggle = useToggleApiKey()
  const remove = useRemoveApiKey()
  const resetUsage = useResetApiKeyUsage()
  const resetKey = useResetApiKey()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ApiKey | null>(null)
  const [confirm, setConfirm] = useState<ApiKey | null>(null)
  const [rotate, setRotate] = useState<ApiKey | null>(null)
  const [secret, setSecret] = useState('')

  return (
    <>
      <PageHeader
        title="API Key"
        description="给不同客户端签发子密钥。子密钥只能调用 /v1/*，不能登录控制台。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> 新建密钥
          </Button>
        }
      />

      <Card>
        {keys.isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : !keys.data?.length ? (
          <Empty icon={<KeyRound />} title="还没有子密钥">
            客户端也可以直接用主密钥，但单独签发子密钥能限额、限模型，泄露时单独吊销。
          </Empty>
        ) : (
          <Table>
            <THead className="border-t-0">
              <tr>
                <TH>名称</TH>
                <TH>状态</TH>
                <TH className="hidden md:table-cell">限制</TH>
                <TH>窗口用量</TH>
                <TH className="hidden sm:table-cell">最近使用</TH>
                <TH className="hidden lg:table-cell">创建于</TH>
                <TH className="w-10" />
              </tr>
            </THead>
            <tbody>
              {keys.data.map((k) => {
                const expired = k.limits.expiresAt > 0 && k.limits.expiresAt < Date.now()
                const limits = [
                  k.limits.models.length ? `${k.limits.models.length} 个模型` : null,
                  k.limits.allowedIps.length ? `${k.limits.allowedIps.length} 条 IP 规则` : null,
                  k.limits.expiresAt ? `${fmtDateTime(k.limits.expiresAt)} 过期` : null,
                ].filter(Boolean)
                limits.push(`每 ${k.limits.windowHours} 小时重置`)
                return (
                  <TR key={k.id}>
                    <TD>
                      <div className="font-medium">{k.name}</div>
                      <div className="text-muted-foreground font-mono text-[11.5px]">{k.prefix}••••</div>
                    </TD>
                    <TD>
                      {expired ? (
                        <Badge tone="warning" dot>
                          已过期
                        </Badge>
                      ) : k.enabled ? (
                        <Badge tone="success" dot>
                          启用
                        </Badge>
                      ) : (
                        <Badge dot>已停用</Badge>
                      )}
                    </TD>
                    <TD className="text-muted-foreground hidden md:table-cell">
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck className="size-3.5 shrink-0" />
                        {limits.length > 1 ? limits.slice(0, -1).join(' · ') : '不限模型与来源'}
                      </div>
                      <div className="mt-0.5 pl-5 text-[11.5px]">{limits[limits.length - 1]}</div>
                    </TD>
                    <TD className="min-w-44 py-3">
                      <Quota used={k.usage.requests} max={k.limits.maxRequests} unit="次" />
                      <Quota used={k.usage.inputTokens + k.usage.outputTokens} max={k.limits.maxTokens} unit="token" compact />
                    </TD>
                    <TD className="text-muted-foreground hidden whitespace-nowrap sm:table-cell">{fmtRelative(k.lastUsedAt)}</TD>
                    <TD className="text-muted-foreground hidden whitespace-nowrap lg:table-cell">{fmtDateTime(k.createdAt)}</TD>
                    <TD>
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="更多操作">
                            <MoreHorizontal />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setEditing(k)}>
                            <Pencil /> 编辑名称与限额
                          </MenuItem>
                          <MenuItem onSelect={() => resetUsage.mutate(k)}>
                            <Eraser /> 清零窗口用量
                          </MenuItem>
                          <MenuItem onSelect={() => toggle.mutate(k)}>
                            <Power /> {k.enabled ? '停用' : '启用'}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem onSelect={() => setRotate(k)}>
                            <RotateCcw /> 重新生成密钥
                          </MenuItem>
                          <MenuItem danger onSelect={() => setConfirm(k)}>
                            <Trash2 /> 吊销并删除
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </TD>
                  </TR>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <KeyDialog open={creating} onOpenChange={setCreating} />
      <KeyDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} editing={editing ?? undefined} />
      <SecretDialog secret={secret} onClose={() => setSecret('')} />
      <Dialog
        open={!!rotate}
        onOpenChange={(o) => !o && setRotate(null)}
        title={`重新生成「${rotate?.name ?? ''}」？`}
        description="旧密钥立即失效，限额设置保留、窗口用量清零。新密钥只显示一次。"
        footer={
          <>
            <Button variant="outline" onClick={() => setRotate(null)}>
              取消
            </Button>
            <Button
              disabled={resetKey.isPending}
              onClick={() =>
                rotate &&
                resetKey.mutate(rotate, {
                  onSuccess: (r) => {
                    setRotate(null)
                    setSecret(r.key)
                  },
                })
              }
            >
              重新生成
            </Button>
          </>
        }
      />
      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`吊销「${confirm?.name ?? ''}」？`}
        description="用这把密钥的客户端会立即失败，且不可恢复。只想暂停的话请用「停用」。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => confirm && remove.mutate(confirm, { onSuccess: () => setConfirm(null) })}>
              吊销
            </Button>
          </>
        }
      />
    </>
  )
}

function Quota({ used, max, unit, compact }: { used: number; max: number; unit: string; compact?: boolean }) {
  const fmt = compact ? fmtCompact : fmtInt
  if (!max)
    return (
      <div className="tabular text-[12.5px] leading-5">
        {fmt(used)} {unit} <span className="text-muted-foreground">/ 不限</span>
      </div>
    )
  const p = pct(used, max)
  return (
    <div className="mb-1">
      <div className="tabular flex justify-between text-[12.5px]">
        <span>
          {fmt(used)} / {fmt(max)} {unit}
        </span>
      </div>
      <Progress value={p} tone={p >= 90 ? 'danger' : p >= 70 ? 'warning' : 'primary'} className="mt-1" />
    </div>
  )
}

function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Dialog
      open={!!secret}
      onOpenChange={(o) => !o && onClose()}
      title="密钥已生成"
      description="明文只显示这一次，关闭后无法再查看，请立即复制保存。"
      footer={<Button onClick={onClose}>我已保存</Button>}
    >
      <div className="bg-muted flex items-center gap-2 rounded-lg border px-3 py-2.5">
        <code className="flex-1 font-mono text-[12.5px] break-all">{secret}</code>
        <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(secret).then(() => toast.success('已复制'))}>
          <Copy /> 复制
        </Button>
      </div>
    </Dialog>
  )
}

type Form = {
  name: string
  maxRequests: string
  maxTokens: string
  windowHours: string
  models: string
  ips: string
  expires: string
}
const EMPTY: Form = {
  name: '',
  maxRequests: '',
  maxTokens: '',
  windowHours: '24',
  models: '',
  ips: '',
  expires: '',
}

/** 时间戳 ⇄ datetime-local 的值（本地时区）。 */
function toLocalInput(ts: number) {
  if (!ts) return ''
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

function formOf(k?: ApiKey): Form {
  if (!k) return EMPTY
  return {
    name: k.name,
    maxRequests: k.limits.maxRequests ? String(k.limits.maxRequests) : '',
    maxTokens: k.limits.maxTokens ? String(k.limits.maxTokens) : '',
    windowHours: String(k.limits.windowHours || 24),
    models: k.limits.models.join(', '),
    ips: k.limits.allowedIps.join(', '),
    expires: toLocalInput(k.limits.expiresAt),
  }
}

/** 新建（无 editing）或编辑子密钥。 */
function KeyDialog({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (o: boolean) => void; editing?: ApiKey }) {
  const create = useCreateApiKey()
  const update = useUpdateApiKey()
  const [form, setForm] = useState<Form>(EMPTY)
  const [secret, setSecret] = useState('')
  const [seed, setSeed] = useState<string | undefined>()
  // 打开编辑时用该密钥的现值填表（key 变了才重置，避免覆盖正在输入的内容）
  if (open && editing && seed !== editing.id) {
    setSeed(editing.id)
    setForm(formOf(editing))
  }
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  const list = (s: string) => s.split(/[\s,，]+/).filter(Boolean)
  const busy = create.isPending || update.isPending

  const close = (o: boolean) => {
    if (!o) {
      setSecret('')
      setSeed(undefined)
      setForm(EMPTY)
    }
    onOpenChange(o)
  }

  const submit = () => {
    const limits = {
      maxRequests: Number(form.maxRequests) || 0,
      maxTokens: Number(form.maxTokens) || 0,
      windowHours: Number(form.windowHours) || 24,
      models: list(form.models),
      allowedIps: list(form.ips),
      expiresAt: form.expires ? new Date(form.expires).getTime() : 0,
    }
    const name = form.name.trim() || '未命名'
    if (editing) update.mutate({ id: editing.id, name, limits }, { onSuccess: () => close(false) })
    else create.mutate({ name, limits }, { onSuccess: (r) => setSecret(r.key) })
  }

  if (secret) return <SecretDialog secret={secret} onClose={() => close(false)} />

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={editing ? `编辑「${editing.name}」` : '新建子密钥'}
      description={editing ? '修改后立即生效，不影响已有用量统计。' : '留空即不限制。限额按统计窗口滚动重置。'}
      footer={
        <>
          <Button variant="outline" onClick={() => close(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? '保存中…' : editing ? '保存' : '生成密钥'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="k-name">名称</Label>
          <Input id="k-name" value={form.name} onChange={set('name')} placeholder="例如：cursor-laptop" autoFocus />
        </div>
        <div>
          <Label htmlFor="k-req" hint="次">
            请求上限
          </Label>
          <Input id="k-req" inputMode="numeric" value={form.maxRequests} onChange={set('maxRequests')} placeholder="不限" />
        </div>
        <div>
          <Label htmlFor="k-tok" hint="token">
            Token 上限
          </Label>
          <Input id="k-tok" inputMode="numeric" value={form.maxTokens} onChange={set('maxTokens')} placeholder="不限" />
        </div>
        <div>
          <Label htmlFor="k-win" hint="小时">
            统计窗口
          </Label>
          <Input id="k-win" inputMode="numeric" value={form.windowHours} onChange={set('windowHours')} />
        </div>
        <div>
          <Label htmlFor="k-exp" hint="留空 = 永不过期">
            过期时间
          </Label>
          <Input id="k-exp" type="datetime-local" value={form.expires} onChange={set('expires')} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="k-ip" hint="逗号分隔，支持 CIDR">
            来源 IP
          </Label>
          <Input id="k-ip" value={form.ips} onChange={set('ips')} placeholder="不限，例如 203.0.113.7, 10.0.0.0/8" />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="k-models" hint="逗号或空格分隔">
            允许的模型
          </Label>
          <Input id="k-models" value={form.models} onChange={set('models')} placeholder="不限，例如 aggregate/auto, buddy/deepseek-v4.1-flash" />
        </div>
      </div>
    </Dialog>
  )
}
