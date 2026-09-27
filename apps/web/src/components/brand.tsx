

import { cn } from '@/lib/utils'

export function LogoGlyph({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground',
        className ?? 'size-8',
      )}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 48 48"
        className="size-[60%]"
        fill="none"
      >
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <ellipse cx="24" cy="24" rx="7.5" ry="21" transform="rotate(30 24 24)" />
          <ellipse cx="24" cy="24" rx="7.5" ry="21" transform="rotate(90 24 24)" />
          <ellipse cx="24" cy="24" rx="7.5" ry="21" transform="rotate(150 24 24)" />
        </g>
        <path
          fill="currentColor"
          d="M17 13h14v2.5H17z M17 32.5h14V35H17z M19 16.5h10l-4.5 7.5 4.5 7.5H19l4.5-7.5l-4.5-7.5z"
        />
      </svg>
    </span>
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
