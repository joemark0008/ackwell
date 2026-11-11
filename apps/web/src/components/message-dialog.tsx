import type { MessageDetail } from '@ackwell/schemas';
import { AlertCircle, Loader2, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { AckBadge, MessageStatusBadge } from '@/components/badges';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime } from '@/lib/format';
import { ApiError } from '@/lib/api';
import { useMessage, useResendMessage } from '@/lib/queries';

/** Raw HL7 with one segment per line (segments are \r separated on the wire). */
export function hl7Lines(raw: string): string {
  return raw.replace(/\r\n|\r|\n/g, '\n').replace(/\n$/, '');
}

function Pane({ title, text, lang }: { title: string; text: string; lang: 'hl7' | 'json' }) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 py-1 pr-1 pl-3 text-xs text-zinc-400 [&_button]:text-zinc-300 [&_button:hover]:bg-white/10">
        {title}
        <CopyButton value={text} label={`Copy ${title}`} />
      </div>
      <pre
        data-lang={lang}
        className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre text-zinc-200"
      >
        {text}
      </pre>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="truncate text-sm">{children}</div>
    </div>
  );
}

function ResendButton({ m }: { m: MessageDetail }) {
  const resend = useResendMessage();
  async function go() {
    try {
      await resend.mutateAsync(m.id);
      toast.success('Queued for delivery again');
    } catch (err) {
      toast.error(err instanceof ApiError && err.body?.message ? err.body.message : 'Could not resend.');
    }
  }
  const busy = resend.isPending || m.status === 'processing';
  return (
    <Button variant="outline" size="sm" onClick={go} disabled={busy}>
      {resend.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
      Resend
    </Button>
  );
}

function Body({ m }: { m: MessageDetail }) {
  const raw = m.raw ? hl7Lines(m.raw) : '';
  const json = m.json ? JSON.stringify(m.json, null, 2) : '';
  return (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
        <Meta label="Status">
          <MessageStatusBadge status={m.status} />
        </Meta>
        <Meta label="ACK">
          <AckBadge code={m.ackCode} />
        </Meta>
        <Meta label="From">
          <span className="font-mono text-[13px]">{m.remoteAddress ?? '—'}</span>
        </Meta>
        <Meta label="Received">{formatDateTime(m.createdAt)}</Meta>
        {m.direction === 'inbound' && m.json && (
          <div className="col-span-2 flex items-end justify-start sm:col-span-1 sm:justify-end">
            <ResendButton m={m} />
          </div>
        )}
      </div>
      {m.error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" /> {m.error}
        </p>
      )}
      {m.attempts.length > 0 && (
        <div className="rounded-lg border">
          <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">Delivery attempts</div>
          <ul className="divide-y text-sm">
            {m.attempts.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-1.5">
                <span className="w-6 font-mono text-xs text-muted-foreground">#{a.attempt}</span>
                <span className={a.result === 'success' ? 'text-success' : 'text-destructive'}>{a.result}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{a.error ?? a.response ?? ''}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Wide screens: side by side. Narrow: tabs. */}
      <div className="hidden min-h-0 flex-1 grid-cols-2 gap-3 lg:grid">
        <Pane title="Raw HL7" text={raw} lang="hl7" />
        <Pane title="JSON" text={json} lang="json" />
      </div>
      <Tabs defaultValue="hl7" className="flex min-h-0 flex-1 flex-col lg:hidden">
        <TabsList>
          <TabsTrigger value="hl7">Raw HL7</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="hl7" className="flex min-h-0 flex-1 flex-col">
          <Pane title="Raw HL7" text={raw} lang="hl7" />
        </TabsContent>
        <TabsContent value="json" className="flex min-h-0 flex-1 flex-col">
          <Pane title="JSON" text={json} lang="json" />
        </TabsContent>
      </Tabs>
    </>
  );
}

export function MessageDialog({ messageId, onClose }: { messageId: string | null; onClose: () => void }) {
  const { data, isPending, isError } = useMessage(messageId);
  const title = data ? `${data.messageType ?? 'Message'}${data.controlId ? ` · ${data.controlId}` : ''}` : 'Message';
  return (
    <Dialog open={messageId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{title}</DialogTitle>
          <DialogDescription>Raw HL7 as received and its lossless JSON. Escapes are kept as sent.</DialogDescription>
        </DialogHeader>
        {messageId && isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-64" />
          </div>
        ) : isError || !data ? (
          <p className="text-sm text-destructive">Could not load this message.</p>
        ) : (
          <Body m={data} />
        )}
      </DialogContent>
    </Dialog>
  );
}
