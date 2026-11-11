import type { Channel, NewWebhookSecret, WebhookSecret } from '@ackwell/schemas';
import { KeyRound, Loader2, RefreshCw, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { WebhookSecretDialog } from '@/components/webhook-secret-dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtNum, formatDateTime } from '@/lib/format';
import { useRevokeWebhookSecret, useRotateWebhookSecret, useWebhookSecrets } from '@/lib/queries';

function SecretRow({ s, onRevoke, revoking }: { s: WebhookSecret; onRevoke: () => void; revoking: boolean }) {
  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-mono">whsec_…{s.hint}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">since {formatDateTime(s.createdAt)}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Revoke secret ending ${s.hint}`} onClick={onRevoke} disabled={revoking}>
            {revoking ? <Loader2 className="animate-spin" /> : <ShieldOff />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Revoke</TooltipContent>
      </Tooltip>
    </li>
  );
}

export function WebhookCard({ channel }: { channel: Channel }) {
  const secrets = useWebhookSecrets(channel.id);
  const rotate = useRotateWebhookSecret(channel.id);
  const revoke = useRevokeWebhookSecret(channel.id);
  const [shown, setShown] = useState<NewWebhookSecret | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [toRevoke, setToRevoke] = useState<WebhookSecret | null>(null);

  const active = (secrets.data ?? []).filter((s) => !s.revokedAt);
  const delivery = channel.delivery;

  async function doRotate() {
    try {
      const s = await rotate.mutateAsync();
      setConfirmRotate(false);
      setShown(s);
    } catch {
      toast.error('Could not create a new secret.');
    }
  }

  async function doRevoke() {
    if (!toRevoke) return;
    try {
      await revoke.mutateAsync(toRevoke.id);
      toast.success(`Revoked secret ending ${toRevoke.hint}`);
    } catch {
      toast.error('Could not revoke the secret.');
    } finally {
      setToRevoke(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook</CardTitle>
        <CardDescription>Where parsed messages are POSTed, signed with the active secrets.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="divide-y">
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 py-2 text-sm">
            <dt className="text-muted-foreground">URL</dt>
            <dd className="font-mono text-[13px] break-all">{delivery?.url}</dd>
          </div>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 py-2 text-sm">
            <dt className="text-muted-foreground">Retries</dt>
            <dd>
              {delivery?.maxAttempts} attempts · {fmtNum(delivery?.timeoutMs)} ms timeout
            </dd>
          </div>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 py-2 text-sm">
            <dt className="text-muted-foreground">JSON</dt>
            <dd>
              {{ both: 'Typed (flat) + lossless (json)', typed: 'Typed only (flat)', lossless: 'Lossless only (json)' }[delivery?.payload ?? 'both']}
            </dd>
          </div>
        </dl>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium">Signing secrets</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => (active.length ? setConfirmRotate(true) : void doRotate())}
              disabled={rotate.isPending || secrets.isPending}
            >
              {rotate.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {active.length ? 'Rotate' : 'Generate secret'}
            </Button>
          </div>
          {secrets.isPending ? (
            <Skeleton className="h-10" />
          ) : secrets.isError ? (
            <p className="text-sm text-destructive">Could not load secrets.</p>
          ) : active.length === 0 ? (
            <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              No active secret: deliveries fail until you generate one.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border px-3">
              {active.map((s) => (
                <SecretRow key={s.id} s={s} onRevoke={() => setToRevoke(s)} revoking={revoke.isPending && toRevoke?.id === s.id} />
              ))}
            </ul>
          )}
          {active.length === 2 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Rotation in progress: both secrets sign every delivery. Revoke the old one once your receiver uses the new
              secret.
            </p>
          )}
        </div>
      </CardContent>

      <WebhookSecretDialog secret={shown} onClose={() => setShown(null)} />

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the signing secret?</AlertDialogTitle>
            <AlertDialogDescription>
              A new secret is created and shown once. The current secret keeps working until you revoke it, so you can
              update the receiver without downtime.{active.length >= 2 ? ' The oldest active secret is revoked now.' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotate.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doRotate();
              }}
              disabled={rotate.isPending}
            >
              {rotate.isPending && <Loader2 className="animate-spin" />}
              Rotate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={toRevoke !== null} onOpenChange={(o) => !o && setToRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke secret ending {toRevoke?.hint}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deliveries are no longer signed with it.
              {active.length <= 1 ? ' This is the last active secret: deliveries will fail until you generate a new one.' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void doRevoke();
              }}
              disabled={revoke.isPending}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
