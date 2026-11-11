import type { Channel } from '@ackwell/schemas';
import { ArrowLeft, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { DirectionBadge, StatusBadge } from '@/components/badges';
import { CopyButton } from '@/components/copy-button';
import { DeleteChannelDialog } from '@/components/delete-channel-dialog';
import { Flow, inboundFlow, outboundFlow } from '@/components/flow';
import { MessagesCard } from '@/components/messages-card';
import { PageHeader } from '@/components/page-header';
import { StartStopButton } from '@/components/start-stop-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { fmtNum, formatDateTime } from '@/lib/format';
import { useChannel, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-[13px] break-all' : ''}>{children}</dd>
    </div>
  );
}

function Endpoint({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <code className={cn('min-w-0 font-mono font-medium', value.length > 28 ? 'text-sm break-all' : 'text-base')}>{value}</code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

function CodeBlock({ code, title }: { code: string; title: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 py-1 pr-1 pl-3 text-xs text-zinc-400 [&_button]:text-zinc-300 [&_button:hover]:bg-white/10">
        {title}
        <CopyButton value={code} label="Copy example" />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-zinc-200">{code}</pre>
    </div>
  );
}

function ConnectionCard({ channel }: { channel: Channel }) {
  const settings = useSettings();
  const host = settings.data?.mllp.host ?? 'server';
  const cfg = channel.config as { port: number; host?: string };

  if (channel.direction === 'inbound') {
    const endpoint = `${host}:${cfg.port}`;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Point your HL7 sender (or HAPI TestPanel) at this address. It is reachable on the local network only.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
          <div className="space-y-3">
            <Endpoint label="MLLP address" value={endpoint} />
            <p className="text-xs text-muted-foreground">
              Ackwell replies <span className="font-mono">MSA|AA</span> only after the message is saved, so a sender that
              gets an ACK never loses a message.
            </p>
          </div>
          <Flow steps={inboundFlow(endpoint, channel.delivery?.url)} />
        </CardContent>
      </Card>
    );
  }

  const sendPath = `/api/channels/${channel.id}/send`;
  const sendUrl = `${window.location.origin}${sendPath}`;
  const example = `curl -X POST ${sendUrl} \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{ "MSH": { "9": "ADT^A01" }, "PID": { "5": "DOE^JANE" } }'`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection</CardTitle>
        <CardDescription>POST JSON here; Ackwell converts it to HL7 and sends it to the target.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
          <div className="min-w-0 space-y-3">
            <Endpoint label="Send endpoint" value={sendUrl} />
            <p className="text-xs text-muted-foreground">
              The send endpoint and per-channel API keys arrive with outbound sending. The JSON shape follows the generic
              segment → field → component format.
            </p>
          </div>
          <Flow steps={outboundFlow(`${cfg.host}:${cfg.port}`, `POST …/${channel.id.slice(0, 8)}/send`)} />
        </div>
        <CodeBlock title="Example · curl" code={example} />
      </CardContent>
    </Card>
  );
}

function ConfigCard({ channel }: { channel: Channel }) {
  const c = channel.config as Record<string, unknown>;
  const tls = (c.tls as { enabled?: boolean } | undefined)?.enabled;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="HL7 version" mono>
            {channel.hl7Version}
          </Row>
          <Row label="Retention">{channel.retentionDays} days</Row>
          <Row label="TLS">{tls ? 'On' : 'Off'}</Row>
          {channel.direction === 'inbound' ? (
            <>
              <Row label="Allowed IPs" mono>
                {((c.allowlist as string[]) ?? []).length ? (c.allowlist as string[]).join(', ') : <span className="font-sans text-muted-foreground">Any</span>}
              </Row>
              <Row label="Webhook" mono>
                {channel.delivery?.url}
              </Row>
              <Row label="Delivery">
                {channel.delivery?.maxAttempts} attempts · {fmtNum(channel.delivery?.timeoutMs)} ms timeout
              </Row>
            </>
          ) : (
            <>
              <Row label="Target" mono>
                {String(c.host)}:{String(c.port)}
              </Row>
              <Row label="ACK timeout">{fmtNum(c.ackTimeoutMs as number)} ms</Row>
              <Row label="Retries">
                {(c.retry as { maxAttempts: number }).maxAttempts} attempts · every {(c.retry as { backoffSeconds: number }).backoffSeconds} s
              </Row>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

export function ChannelDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: channel, isPending, error } = useChannel(id);
  const [confirm, setConfirm] = useState(false);

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (!channel) {
    const notFound = error instanceof ApiError && (error.status === 404 || error.status === 400);
    return (
      <div className="py-20 text-center">
        <p className="font-medium">{notFound ? 'Channel not found' : 'Could not load the channel'}</p>
        <Link to="/channels" className="mt-2 inline-block text-sm text-muted-foreground underline">
          Back to channels
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link to="/channels" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Channels
          </Link>
        }
        title={channel.name}
        description={
          <span className="flex flex-wrap items-center gap-3">
            <DirectionBadge direction={channel.direction} />
            <StatusBadge status={channel.status} />
          </span>
        }
        actions={
          <>
            <StartStopButton channel={channel} />
            <Button variant="outline" onClick={() => navigate(`/channels/${channel.id}/edit`)}>
              <Pencil /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                  <Trash2 /> Delete channel
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <ConnectionCard channel={channel} />
          <MessagesCard channel={channel} />
        </div>
        <div className="space-y-6">
          <ConfigCard channel={channel} />
          <Card size="sm">
            <CardContent>
              <dl className="divide-y">
                <Row label="Channel ID" mono>
                  <span className="inline-flex items-center gap-1">
                    {channel.id.slice(0, 8)}…
                    <CopyButton value={channel.id} label="Copy channel ID" />
                  </span>
                </Row>
                <Row label="Created">{formatDateTime(channel.createdAt)}</Row>
                <Row label="Updated">{formatDateTime(channel.updatedAt)}</Row>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <DeleteChannelDialog channel={channel} open={confirm} onOpenChange={setConfirm} redirectTo="/channels" />
    </div>
  );
}
