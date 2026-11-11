import type { ChannelDirection, MessageStatus, MessageSummary } from '@ackwell/schemas';
import type { UseInfiniteQueryResult, InfiniteData } from '@tanstack/react-query';
import type { MessageList } from '@ackwell/schemas';
import { Loader2, Search } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AckBadge, DirectionBadge, MessageStatusBadge } from '@/components/badges';
import { MessageDialog } from '@/components/message-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtNum, formatLogTime } from '@/lib/format';
import { useChannels, type LogFilters } from '@/lib/queries';

const STATUSES: MessageStatus[] = ['received', 'queued', 'processing', 'delivered', 'sent', 'rejected', 'failed'];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type LogQuery = UseInfiniteQueryResult<InfiniteData<MessageList>, Error>;

/**
 * Message log table with filters and "Load older" paging. Shared by the channel card and the global page.
 * Rows carry only summaries; raw/JSON load in the dialog.
 * `useData` must be a stable hook (module-level function), called with the debounced filters.
 */
export function MessageLog({
  useData,
  scope = false,
  empty,
  hint,
}: {
  useData: (filters: LogFilters) => LogQuery;
  /** Global mode: adds Channel column plus channel and direction filters. */
  scope?: boolean;
  /** Shown when there are no messages and no filter is active. */
  empty: ReactNode;
  hint?: ReactNode;
}) {
  const [status, setStatus] = useState<MessageStatus | 'all'>('all');
  const [channelId, setChannelId] = useState('all');
  const [direction, setDirection] = useState<ChannelDirection | 'all'>('all');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const filters: LogFilters = useMemo(
    () => ({
      ...(status !== 'all' ? { status } : {}),
      ...(dq ? { q: dq } : {}),
      ...(channelId !== 'all' ? { channelId } : {}),
      ...(direction !== 'all' ? { direction } : {}),
    }),
    [status, dq, channelId, direction],
  );
  const query = useData(filters);
  const channels = useChannels();
  const channelsById = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const [open, setOpen] = useState<string | null>(null);

  const items: MessageSummary[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const filtered = Object.keys(filters).length > 0;

  return (
    <div className="space-y-3">
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
        {scope && (
          <>
            <Select value={channelId} onValueChange={setChannelId}>
              <SelectTrigger className="sm:w-48" aria-label="Filter by channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                {(channels.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={direction} onValueChange={(v) => setDirection(v as ChannelDirection | 'all')}>
              <SelectTrigger className="sm:w-36" aria-label="Filter by direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Both directions</SelectItem>
                <SelectItem value="inbound">Inbound</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
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
        filtered ? <p className="py-8 text-center text-sm text-muted-foreground">No messages match.</p> : empty
      ) : (
        <>
          <p className="tabular text-xs text-muted-foreground">{fmtNum(total)} {total === 1 ? 'message' : 'messages'}</p>
          {/* Wide tables scroll horizontally on phones (the Table wrapper handles overflow). */}
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-3">Time</TableHead>
                  {scope && <TableHead>Channel</TableHead>}
                  <TableHead>Type</TableHead>
                  <TableHead className={scope ? undefined : 'hidden sm:table-cell'}>Control ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-14">ACK</TableHead>
                  {!scope && <TableHead className="hidden md:table-cell">From</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((m) => {
                  const ch = channelsById.get(m.channelId);
                  return (
                    <TableRow key={m.id} className="cursor-pointer" onClick={() => setOpen(m.id)}>
                      <TableCell className="tabular pl-3 whitespace-nowrap text-muted-foreground">{formatLogTime(m.createdAt)}</TableCell>
                      {scope && (
                        <TableCell>
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <Link
                              to={`/channels/${m.channelId}`}
                              className="font-medium hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {ch?.name ?? 'Deleted channel'}
                            </Link>
                            <DirectionBadge direction={m.direction} />
                          </div>
                        </TableCell>
                      )}
                      <TableCell className="font-mono text-[13px] font-medium">{m.messageType ?? <span className="text-muted-foreground">?</span>}</TableCell>
                      <TableCell className={scope ? 'font-mono text-[13px] text-muted-foreground' : 'hidden font-mono text-[13px] text-muted-foreground sm:table-cell'}>
                        {m.controlId ?? '—'}
                      </TableCell>
                      <TableCell>
                        <MessageStatusBadge status={m.status} />
                      </TableCell>
                      <TableCell>
                        <AckBadge code={m.ackCode} />
                      </TableCell>
                      {!scope && (
                        <TableCell className="hidden font-mono text-[13px] text-muted-foreground md:table-cell">{m.remoteAddress ?? '—'}</TableCell>
                      )}
                    </TableRow>
                  );
                })}
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
          {hint}
        </>
      )}
      <MessageDialog messageId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
