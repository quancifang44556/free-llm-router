import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Table = ({ className, ...p }: HTMLAttributes<HTMLTableElement>) => (
  <div className="overflow-x-auto">
    <table className={cn('w-full border-collapse text-[13px]', className)} {...p} />
  </div>
)
export const THead = ({ className, ...p }: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('bg-muted/50 text-muted-foreground border-y text-xs', className)} {...p} />
)
export const TR = ({ className, ...p }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn('hover:bg-muted/40 border-b transition-colors last:border-b-0', className)} {...p} />
)
export const TH = ({ className, ...p }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('h-9 px-4 text-left font-medium whitespace-nowrap first:pl-5 last:pr-5', className)} {...p} />
)
export const TD = ({ className, ...p }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('h-12 px-4 align-middle first:pl-5 last:pr-5', className)} {...p} />
)
