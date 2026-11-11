import { cn } from '@/lib/utils';

/** Ackwell mark: a message frame with an ACK pulse. */
export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="grid size-7 place-items-center rounded-md bg-brand text-brand-foreground shadow-sm">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 12h4l2-5 4 10 2-5h6" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight">Ackwell</span>
    </div>
  );
}
