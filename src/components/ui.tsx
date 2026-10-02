import { cn } from '../lib/utils'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'info' | 'easy'

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-[#0a3d26] shadow-sm',
  secondary: 'bg-white text-ink border border-stone-300 hover:bg-stone-50 shadow-sm',
  ghost: 'text-ink-soft hover:bg-stone-200/60',
  danger: 'bg-[#b42318] text-white hover:bg-[#941c13]',
  warning: 'bg-[#b54708] text-white hover:bg-[#933a06]',
  info: 'bg-[#175cd3] text-white hover:bg-[#124bab]',
  easy: 'bg-[#17803d] text-white hover:bg-[#116631]',
}

export function Button({
  className,
  variant = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2',
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_3px_rgba(28,25,23,0.05)]', className)}>
      {children}
    </div>
  )
}

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
      <div
        className="h-full rounded-full bg-brand transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal open={open} onClose={onCancel} className="max-w-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-stone-500">{message}</p>
      <div className="mt-5 flex gap-2.5">
        <Button className="flex-1" variant="secondary" onClick={onCancel}>
          取消
        </Button>
        <Button className="flex-1" variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmText}
        </Button>
      </div>
    </Modal>
  )
}

export function Modal({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-stone-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          'animate-fade-up max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-paper p-5 shadow-2xl sm:rounded-3xl sm:p-6',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
