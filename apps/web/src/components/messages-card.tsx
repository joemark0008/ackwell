import type { Channel, MessageStatus, MessageSummary } from '@ackwell/schemas';
import { Inbox, Loader2, RadioTower, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AckBadge, MessageStatusBadge } from '@/components/badges';
import { MessageDialog } from '@/components/message-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtNum, formatLogTime } from '@/lib/format';
import { useMessages, type MessageFilters } from '@/lib/queries';
import { cn } from '@/lib/utils';

const STATUSES: MessageStatus[] = ['received', 'queued', 'processing', 'delivered', 'sent', 'rejected', 'failed'];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Empty({ channel }: { channel: Channel }) {
  const running = channel.status === 'running';
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-muted">
        <Inbox className="size-5 text-muted-foreground" />
      </span>
      <p className="mt-3 text-sm font-medium">No messages yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {channel.direction === 'inbound'
          ? running
            ? 'The channel is listening. Messages appear here as soon as a sender delivers one.'
            : 'Start the channel, then send an HL7 message to its MLLP address.'
          : 'Messages sent through this channel will be listed here.'}
      </p>
    </div>
  );
}

export function MessagesCard({ channel }: { channel: Channel }) {
  const [status, setStatus] = useState<MessageStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const filters: MessageFilters = useMemo(
    () => ({ ...(status !== 'all' ? { status } : {}), ...(dq ? { q: dq } : {}) }),
    [status, dq],
  );
  const live = channel.status === 'running';
  const query = useMessages(channel.id, filters, live);
  const [open, setOpen] = useState<string | null>(null);

  const items: MessageSummary[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const filtered = status !== 'all' || dq !== '';

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              Messages
              {total > 0 && <span className="tabular text-sm font-normal text-muted-foreground">{fmtNum(total)}</span>}
            </CardTitle>
            <CardDescription>Raw HL7, parsed JSON, ACK and delivery attempts for every message.</CardDescription>
          </div>
          {live && (
            <span className="inline-flex items-center gap-1.5 text-xs text-success">
              <RadioTower className="size-3.5" /> Live
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Type or control ID, e.g. ORU or MSG0001"
              aria-label="Search messages"
              className="pl-8"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as MessageStatus | 'all')}>
            <SelectTrigger className="sm:w-40" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {query.isPending ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : query.isError ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Could not load messages: {query.error.message}
          </p>
        ) : items.length === 0 ? (
          filtered ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No messages match.</p>
          ) : (
            <Empty channel={channel} />
          )
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-3">Time</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="hidden sm:table-cell">Control ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-14">ACK</TableHead>
                    <TableHead className="hidden md:table-cell">From</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((m) => (
                    <TableRow key={m.id} className="cursor-pointer" onClick={() => setOpen(m.id)}>
                      <TableCell className="tabular pl-3 whitespace-nowrap text-muted-foreground">{formatLogTime(m.createdAt)}</TableCell>
                      <TableCell className="font-mono text-[13px] font-medium">{m.messageType ?? <span className="text-muted-foreground">?</span>}</TableCell>
                      <TableCell className="hidden font-mono text-[13px] text-muted-foreground sm:table-cell">{m.controlId ?? '—'}</TableCell>
                      <TableCell>
                        <MessageStatusBadge status={m.status} />
                      </TableCell>
                      <TableCell>
                        <AckBadge code={m.ackCode} />
                      </TableCell>
                      <TableCell className="hidden font-mono text-[13px] text-muted-foreground md:table-cell">{m.remoteAddress ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {query.hasNextPage && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                  {query.isFetchingNextPage && <Loader2 className="animate-spin" />}
                  Load older messages
                </Button>
              </div>
            )}
            <p className={cn('text-xs text-muted-foreground', !live && 'hidden')}>Refreshes every few seconds while the channel runs.</p>
          </>
        )}
      </CardContent>
      <MessageDialog messageId={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
