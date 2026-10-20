import * as M from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const Menu = M.Root
export const MenuTrigger = M.Trigger

export function MenuContent({ children, align = 'end', className }: { children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={6} className={cn('bg-popover z-50 min-w-40 rounded-lg border p-1 shadow-lg', className)}>
        {children}
      </M.Content>
    </M.Portal>
  )
}

export function MenuItem({ children, onSelect, danger, active }: { children: ReactNode; onSelect?: () => void; danger?: boolean; active?: boolean }) {
  return (
    <M.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none select-none [&_svg]:size-4',
        danger ? 'text-danger data-[highlighted]:bg-danger/10' : 'data-[highlighted]:bg-muted',
        active && 'text-primary font-medium',
      )}
    >
      {children}
    </M.Item>
  )
}

export const MenuSeparator = () => <M.Separator className="bg-border -mx-1 my-1 h-px" />
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <M.Label className="text-muted-foreground px-2 py-1.5 text-xs">{children}</M.Label>
)
