import type { Channel, InboundFileConfig } from '@ackwell/schemas';
import { AlertTriangle, CheckCircle2, Loader2, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api';
import { formatDateTime, fmtNum } from '@/lib/format';
import { useFileErrors, useRetryFileError } from '@/lib/queries';

/** Inbound file channel: files rejected into the error folder, with the reason and a Retry button. */
export function FileErrorsCard({ channel }: { channel: Channel }) {
  const cfg = channel.config as InboundFileConfig;
  const { data, isPending, isError, error } = useFileErrors(channel.id);
  const retry = useRetryFileError(channel.id);

  async function go(name: string) {
    try {
      const r = await retry.mutateAsync(name);
      toast.success(`Moved back to ${r.movedTo}; it is imported again shortly`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Retry failed');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Error files</CardTitle>
        <CardDescription>
          Files in <span className="font-mono">{cfg.errorDirectory}/</span> that could not be imported. Fix the file there (or
          not), then Retry moves it back to <span className="font-mono">{cfg.directory}/</span>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">{error instanceof ApiError ? error.message : 'Could not read the error folder.'}</p>
        ) : !data.length ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" /> No error files.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {data.map((f) => (
              <li key={f.name} className="flex items-start gap-3 px-3 py-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px]">{f.name}</div>
                  <div className="text-xs text-muted-foreground">{f.reason}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {fmtNum(f.size)} bytes · {formatDateTime(f.modifiedAt)}
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => go(f.name)} disabled={retry.isPending || channel.status !== 'running'}>
                  {retry.isPending && retry.variables === f.name ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  Retry
                </Button>
              </li>
            ))}
          </ul>
        )}
        {data && data.length > 0 && channel.status !== 'running' && (
          <p className="mt-2 text-xs text-muted-foreground">Start the channel to retry.</p>
        )}
      </CardContent>
    </Card>
  );
}
