import type { ApiKey, Channel, NewApiKey } from '@ackwell/schemas';
import { KeyRound, Loader2, Plus, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/components/copy-button';
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime } from '@/lib/format';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/lib/queries';

function KeyRow({ k, onRevoke }: { k: ApiKey; onRevoke: () => void }) {
  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{k.label}</span>
          <span className="font-mono text-xs text-muted-foreground">{k.prefix}…</span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {k.lastUsedAt ? `Last used ${formatDateTime(k.lastUsedAt)}` : 'Never used'} · created {formatDateTime(k.createdAt)}
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Revoke key ${k.label}`} onClick={onRevoke}>
            <ShieldOff />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Revoke</TooltipContent>
      </Tooltip>
    </li>
  );
}

export function ApiKeysCard({ channel }: { channel: Channel }) {
  const keys = useApiKeys(channel.id);
  const create = useCreateApiKey(channel.id);
  const revoke = useRevokeApiKey(channel.id);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [shown, setShown] = useState<NewApiKey | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKey | null>(null);

  const active = (keys.data ?? []).filter((k) => !k.revokedAt);

  async function doCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = label.trim();
    if (!name) return;
    try {
      const k = await create.mutateAsync(name);
      setCreating(false);
      setLabel('');
      setShown(k);
    } catch {
      toast.error('Could not create the key.');
    }
  }

  async function doRevoke() {
    if (!toRevoke) return;
    try {
      await revoke.mutateAsync(toRevoke.id);
      toast.success(`Revoked “${toRevoke.label}”`);
    } catch {
      toast.error('Could not revoke the key.');
    } finally {
      setToRevoke(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          Systems call the send endpoint with <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {active.length} active {active.length === 1 ? 'key' : 'keys'}
          </span>
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus /> New key
          </Button>
        </div>
        {keys.isPending ? (
          <Skeleton className="h-12" />
        ) : keys.isError ? (
          <p className="text-sm text-destructive">Could not load keys.</p>
        ) : active.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            No keys yet. Create one to let another system send through this channel.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border px-3">
            {active.map((k) => (
              <KeyRow key={k.id} k={k} onRevoke={() => setToRevoke(k)} />
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={creating} onOpenChange={(o) => !o && setCreating(false)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={doCreate}>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>Name it after the system that will use it.</DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-2">
              <Label htmlFor="api-key-label">Label</Label>
              <Input
                id="api-key-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. LIS integration"
                maxLength={60}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)} disabled={create.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !label.trim()}>
                {create.isPending && <Loader2 className="animate-spin" />}
                Create key
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={shown !== null} onOpenChange={(o) => !o && setShown(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-outbound" /> API key “{shown?.label}”
            </DialogTitle>
            <DialogDescription>
              Copy it now. It is shown <strong>only this once</strong>; create a new key if you lose it.
            </DialogDescription>
          </DialogHeader>
          {shown && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Key</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <code className="min-w-0 font-mono text-sm break-all select-all" data-testid="api-key">
                  {shown.key}
                </code>
                <CopyButton value={shown.key} label="Copy key" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShown(null)}>I have stored the key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={toRevoke !== null} onOpenChange={(o) => !o && setToRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{toRevoke?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>Requests with this key are rejected immediately. This cannot be undone.</AlertDialogDescription>
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
