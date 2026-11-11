import type { Channel, ChannelDirection } from '@ackwell/schemas';
import { ArrowDownToLine, ArrowUpFromLine, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { DirectionBadge, StatusBadge } from '@/components/badges';
import { DeleteChannelDialog } from '@/components/delete-channel-dialog';
import { StartStopMenuItem } from '@/components/start-stop-button';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { endpointLabel } from '@/lib/format';
import { useChannels, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Filter = 'all' | ChannelDirection;

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {accent && <span className={cn('size-1.5 rounded-full', accent)} />}
        {label}
      </div>
      <div className="tabular mt-1 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function NewChannelMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus /> New channel
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem asChild>
          <Link to="/channels/new?direction=inbound" className="items-start">
            <ArrowDownToLine className="mt-0.5 text-inbound" />
            <span>
              <span className="block font-medium">Inbound</span>
              <span className="block text-xs text-muted-foreground">MLLP listener → JSON webhook</span>
            </span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/channels/new?direction=outbound" className="items-start">
            <ArrowUpFromLine className="mt-0.5 text-outbound" />
            <span>
              <span className="block font-medium">Outbound</span>
              <span className="block text-xs text-muted-foreground">REST JSON → HL7 over MLLP</span>
            </span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState() {
  const cards = [
    {
      direction: 'inbound' as const,
      icon: ArrowDownToLine,
      title: 'Receive HL7',
      body: 'Open an MLLP port. Every message is stored, ACKed and delivered as JSON to your webhook.',
      tone: 'text-inbound bg-inbound/10',
    },
    {
      direction: 'outbound' as const,
      icon: ArrowUpFromLine,
      title: 'Send HL7',
      body: 'POST JSON to Ackwell. It builds HL7, sends it to your system over MLLP and tracks the ACK.',
      tone: 'text-outbound bg-outbound/10',
    },
  ];
  return (
    <div className="rounded-xl border border-dashed p-8 sm:p-12">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-lg font-semibold">Create your first channel</h2>
        <p className="mt-1 text-sm text-muted-foreground">A channel is one HL7 connection, in or out.</p>
      </div>
      <div className="mx-auto mt-8 grid max-w-2xl gap-4 sm:grid-cols-2">
        {cards.map(({ direction, icon: Icon, title, body, tone }) => (
          <Link
            key={direction}
            to={`/channels/new?direction=${direction}`}
            className="group rounded-xl border bg-card p-5 text-left transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className={cn('grid size-9 place-items-center rounded-lg', tone)}>
              <Icon className="size-4.5" />
            </span>
            <h3 className="mt-4 font-medium">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium group-hover:underline">
              New {direction} channel →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function RowActions({ channel }: { channel: Channel }) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${channel.name}`} onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <StartStopMenuItem channel={channel} />
          <DropdownMenuItem onSelect={() => navigate(`/channels/${channel.id}/edit`)}>
            <Pencil /> Edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteChannelDialog channel={channel} open={confirm} onOpenChange={setConfirm} />
    </>
  );
}

export function ChannelsListPage() {
  const { data: channels, isPending, isError, error } = useChannels();
  const settings = useSettings();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    const list = channels ?? [];
    return {
      total: list.length,
      inbound: list.filter((c) => c.direction === 'inbound').length,
      outbound: list.filter((c) => c.direction === 'outbound').length,
      running: list.filter((c) => c.status === 'running').length,
    };
  }, [channels]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (channels ?? []).filter(
      (c) =>
        (filter === 'all' || c.direction === filter) &&
        (!needle || c.name.toLowerCase().includes(needle) || endpointLabel(c, settings.data).toLowerCase().includes(needle)),
    );
  }, [channels, filter, q, settings.data]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Channels"
        description="Inbound channels listen for HL7 over MLLP and deliver JSON. Outbound channels turn JSON into HL7 and send it on."
        actions={<NewChannelMenu />}
      />

      {isError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load channels: {error.message}
        </p>
      ) : isPending ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[76px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : counts.total === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Channels" value={counts.total} />
            <Stat label="Inbound" value={counts.inbound} accent="bg-inbound" />
            <Stat label="Outbound" value={counts.outbound} accent="bg-outbound" />
            <Stat label="Running" value={`${counts.running} / ${counts.total}`} accent="bg-success" />
          </div>

          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                <TabsList>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="inbound">Inbound</TabsTrigger>
                  <TabsTrigger value="outbound">Outbound</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="relative sm:w-72">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, host or port"
                  aria-label="Search channels"
                  className="pl-8"
                />
              </div>
            </div>

            {/* Phones: stacked cards */}
            <ul className="divide-y overflow-hidden rounded-xl border bg-card sm:hidden">
              {rows.map((c) => (
                <li key={c.id} className="flex items-start gap-3 p-4">
                  <Link to={`/channels/${c.id}`} className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{c.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <DirectionBadge direction={c.direction} />
                      <span className="truncate font-mono text-xs text-muted-foreground">{endpointLabel(c, settings.data)}</span>
                    </div>
                  </Link>
                  <RowActions channel={c} />
                </li>
              ))}
              {rows.length === 0 && <li className="p-8 text-center text-sm text-muted-foreground">No channels match.</li>}
            </ul>

            <div className="hidden overflow-hidden rounded-xl border bg-card sm:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Name</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>Endpoint</TableHead>
                    <TableHead className="hidden md:table-cell">HL7</TableHead>
                    <TableHead className="hidden md:table-cell">Retention</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/channels/${c.id}`)}
                    >
                      <TableCell className="pl-4">
                        <Link
                          to={`/channels/${c.id}`}
                          className="font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <DirectionBadge direction={c.direction} />
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">{endpointLabel(c, settings.data)}</TableCell>
                      <TableCell className="hidden font-mono text-[13px] text-muted-foreground md:table-cell">
                        v{c.hl7Version}
                      </TableCell>
                      <TableCell className="tabular hidden text-muted-foreground md:table-cell">{c.retentionDays} d</TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} />
                      </TableCell>
                      <TableCell className="pr-3 text-right">
                        <RowActions channel={c} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                        No channels match.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
