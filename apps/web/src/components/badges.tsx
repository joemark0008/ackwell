import type { ChannelDirection, ChannelStatus, MessageStatus } from '@ackwell/schemas';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { cn } from '@/lib/utils';

export function DirectionBadge({ direction, className }: { direction: ChannelDirection; className?: string }) {
  const inbound = direction === 'inbound';
  const Icon = inbound ? ArrowDownToLine : ArrowUpFromLine;
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium',
        inbound
          ? 'border-inbound/25 bg-inbound/8 text-inbound'
          : 'border-outbound/25 bg-outbound/8 text-outbound',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {inbound ? 'Inbound' : 'Outbound'}
    </span>
  );
}

const statusStyle: Record<ChannelStatus, { dot: string; label: string; text: string }> = {
  running: { dot: 'bg-success shadow-[0_0_0_3px] shadow-success/20', label: 'Running', text: 'text-foreground' },
  stopped: { dot: 'bg-muted-foreground/40', label: 'Stopped', text: 'text-muted-foreground' },
  error: { dot: 'bg-destructive shadow-[0_0_0_3px] shadow-destructive/20', label: 'Error', text: 'text-destructive' },
};

export function StatusBadge({ status, className }: { status: ChannelStatus; className?: string }) {
  const s = statusStyle[status];
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', s.text, className)}>
      <span className={cn('size-2 rounded-full', s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}

const messageStatusStyle: Record<MessageStatus, { label: string; cls: string }> = {
  received: { label: 'Received', cls: 'border-inbound/25 bg-inbound/8 text-inbound' },
  queued: { label: 'Queued', cls: 'border-border bg-muted text-muted-foreground' },
  processing: { label: 'Processing', cls: 'border-warning/30 bg-warning/10 text-warning' },
  delivered: { label: 'Delivered', cls: 'border-success/30 bg-success/10 text-success' },
  sent: { label: 'Sent', cls: 'border-success/30 bg-success/10 text-success' },
  rejected: { label: 'Rejected', cls: 'border-destructive/30 bg-destructive/10 text-destructive' },
  failed: { label: 'Failed', cls: 'border-destructive/30 bg-destructive/10 text-destructive' },
};

export function MessageStatusBadge({ status, className }: { status: MessageStatus; className?: string }) {
  const s = messageStatusStyle[status];
  return (
    <span className={cn('inline-flex h-5 items-center rounded-md border px-1.5 text-[11px] font-medium', s.cls, className)}>
      {s.label}
    </span>
  );
}

/** AA / AE / AR … coloured by meaning. */
export function AckBadge({ code }: { code: string | null }) {
  if (!code) return <span className="text-muted-foreground">—</span>;
  const ok = code === 'AA' || code === 'CA';
  return (
    <span className={cn('font-mono text-xs font-semibold', ok ? 'text-success' : 'text-destructive')}>{code}</span>
  );
}
