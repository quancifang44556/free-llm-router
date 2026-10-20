import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Label, Select, Textarea } from '@/components/ui/input'
import { ProviderAvatar, Segmented } from '@/components/ui/misc'
import { useImportAccount } from '@/lib/queries'
import type { Provider } from '@/lib/types'
import { loginKindLabel } from './LoginFlow'

/** 粘贴凭据 JSON 导入。provider 固定时不显示下拉。 */
export function ImportForm({ provider: fixed, providers, onDone }: { provider?: string; providers?: Provider[]; onDone?: () => void }) {
  const [provider, setProvider] = useState('')
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const imp = useImportAccount()
  const target = fixed ?? provider

  const submit = () => {
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      setErr('不是合法的 JSON')
      return
    }
    if (target && payload && typeof payload === 'object' && !Array.isArray(payload)) payload = { ...payload, provider: target }
    setErr('')
    imp.mutate(payload, {
      onSuccess: () => {
        setText('')
        onDone?.()
      },
    })
  }

  return (
    <div className="space-y-4">
      {!fixed && providers && (
        <div>
          <Label htmlFor="add-provider" hint="可选">
            供应商
          </Label>
          <Select id="add-provider" value={provider} onChange={(e) => setProvider(e.target.value)} className="w-full">
            <option value="">自动识别</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <Label htmlFor={`add-json-${fixed ?? 'any'}`} hint="支持数组或 {accounts:[…]} 批量导入">
          凭据 JSON
        </Label>
        <Textarea
          id={`add-json-${fixed ?? 'any'}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"uid": "...", "accessToken": "..."}'
          rows={6}
          className="font-mono text-[12.5px]"
        />
        {err && <div className="text-danger mt-1.5 text-xs">{err}</div>}
      </div>
      <div className="flex justify-end">
        <Button onClick={submit} disabled={!text.trim() || imp.isPending}>
          {imp.isPending ? '导入中…' : '导入'}
        </Button>
      </div>
    </div>
  )
}

type Mode = 'login' | 'import'

export function AddAccountDialog({
  open,
  onOpenChange,
  providers,
  onLogin,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  providers: Provider[]
  /** 选了某家的面板登录 ⇒ 交给供应商详情去走登录流程。 */
  onLogin: (p: Provider) => void
}) {
  const [mode, setMode] = useState<Mode>('login')
  const loginable = providers.filter((p) => p.capabilities.login)
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加账号"
      description={mode === 'login' ? '选一家，用设备码 / 扫码 / 短信直接登录。' : '粘贴凭据 JSON，系统会自动识别是哪一家。'}
    >
      <Segmented<Mode>
        value={mode}
        onChange={setMode}
        className="mb-4 w-full [&_button]:flex-1"
        options={[
          { value: 'login', label: `面板登录（${loginable.length} 家）` },
          { value: 'import', label: '导入凭据' },
        ]}
      />
      {mode === 'login' ? (
        <div className="-mx-1 grid max-h-[55vh] gap-1 overflow-y-auto sm:grid-cols-2">
          {loginable.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                onOpenChange(false)
                onLogin(p)
              }}
              className="hover:bg-muted/70 group flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left"
            >
              <ProviderAvatar id={p.id} name={p.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{p.name}</span>
                <span className="text-muted-foreground block text-xs">{loginKindLabel(p.id)}</span>
              </span>
              <ChevronRight className="text-muted-foreground/50 group-hover:text-muted-foreground size-4" />
            </button>
          ))}
        </div>
      ) : (
        <ImportForm providers={providers} onDone={() => onOpenChange(false)} />
      )}
    </Dialog>
  )
}
