import { ArrowRight } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface FlowStep {
  label: string;
  detail?: ReactNode;
  tone?: 'brand' | 'inbound' | 'outbound' | 'muted';
}

const tones = {
  brand: 'border-brand/30 bg-brand/8',
  inbound: 'border-inbound/30 bg-inbound/8',
  outbound: 'border-outbound/30 bg-outbound/8',
  muted: 'bg-muted/50',
};

/** A small left-to-right (stacked on narrow screens) pipeline diagram. */
export function Flow({ steps, className }: { steps: FlowStep[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col gap-2', className)}>
      {steps.map((s, i) => (
        <Fragment key={s.label}>
          <li className={cn('rounded-lg border px-3 py-2', tones[s.tone ?? 'muted'])}>
            <div className="text-xs font-medium">{s.label}</div>
            {s.detail && <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{s.detail}</div>}
          </li>
          {i < steps.length - 1 && (
            <li aria-hidden className="flex justify-center text-muted-foreground/60">
              <ArrowRight className="size-3.5 rotate-90" />
            </li>
          )}
        </Fragment>
      ))}
    </ol>
  );
}

export function inboundFlow(endpoint: string, webhook?: string): FlowStep[] {
  return [
    { label: 'HL7 sender', detail: `MLLP → ${endpoint}`, tone: 'inbound' },
    { label: 'Ackwell stores, then ACKs', detail: 'MSA|AA after the DB write', tone: 'brand' },
    { label: 'Parsed to JSON', detail: 'segments → fields → components' },
    { label: 'Webhook', detail: webhook || 'https://…', tone: 'muted' },
  ];
}

export function outboundFlow(target: string, sendUrl = 'POST /api/channels/:id/send'): FlowStep[] {
  return [
    { label: 'Your system', detail: sendUrl, tone: 'outbound' },
    { label: 'Ackwell queues + builds HL7', detail: 'in order, with retries', tone: 'brand' },
    { label: 'HL7 receiver', detail: `MLLP → ${target}`, tone: 'muted' },
    { label: 'ACK recorded', detail: 'AA · AE · AR' },
  ];
}
