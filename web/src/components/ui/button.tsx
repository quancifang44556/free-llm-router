import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const variants = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
  outline: 'border border-input bg-card shadow-xs hover:bg-muted',
  secondary: 'bg-muted text-foreground hover:bg-muted/70',
  ghost: 'hover:bg-muted text-muted-foreground hover:text-foreground',
  destructive: 'bg-danger text-white shadow-sm hover:bg-danger/90',
}
const sizes = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-4 gap-2',
  icon: 'size-9',
  'icon-sm': 'size-8',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
}

/** 按钮外观的 class（也给需要长得像按钮的 `<a>` 用，避免把 button 嵌进 a）。 */
export function buttonClass(variant: keyof typeof variants = 'default', size: keyof typeof sizes = 'md', className?: string) {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors',
    'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    variants[variant],
    sizes[size],
    className,
  )
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...props} />
  ),
)
Button.displayName = 'Button'
