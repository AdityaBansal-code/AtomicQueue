

import { cn } from '@/lib/utils'

export function LogoGlyph({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className={className ?? 'size-8'}
      fill="none"
    >
      <path fill="#00E5FF" d="M 3.5 13 L 11.5 13 L 21.5 24 L 11.5 35 L 3.5 35 L 13.5 24 Z" />
      <path fill="#00E5FF" d="M 15.5 13 L 23.5 13 L 29.86 20 L 34.5 20 L 34.5 28 L 29.86 28 L 23.5 35 L 15.5 35 L 25.5 24 Z" />
      <path stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="miter" d="M 31.9 18 L 33 16.2 L 42 16.2 L 46.5 24 L 42 31.8 L 33 31.8 L 31.9 30" />
    </svg>
  )
}

export function Wordmark({
  className,
  showGlyph = true,
}: {
  className?: string
  showGlyph?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {showGlyph && <LogoGlyph className="size-7" />}
      <span className="text-[0.95rem] font-semibold tracking-tight">
        Atomic<span className="text-primary">Queue</span>
      </span>
    </span>
  )
}
