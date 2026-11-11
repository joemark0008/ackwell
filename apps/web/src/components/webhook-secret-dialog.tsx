import type { NewWebhookSecret } from '@ackwell/schemas';
import { KeyRound } from 'lucide-react';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyAckwell(headers, rawBody, secret) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay window
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(\`\${id}.\${ts}.\${rawBody}\`).digest("base64");
  return headers["webhook-signature"].split(" ").some((s) => {
    const sig = Buffer.from(s.replace(/^v1,/, ""), "base64");
    return sig.length === expected.length && timingSafeEqual(sig, Buffer.from(expected, "base64"));
  });
}`;

/**
 * Shows a freshly created webhook secret exactly once. The API never returns it again, so the
 * dialog stays open until the user confirms they have stored it.
 */
export function WebhookSecretDialog({
  secret,
  title = 'New webhook secret',
  onClose,
}: {
  secret: NewWebhookSecret | null;
  title?: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={secret !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-inbound" /> {title}
          </DialogTitle>
          <DialogDescription>
            Store it in your webhook receiver now. For your safety it is shown <strong>only this once</strong>; if you lose
            it, rotate to get a new one.
          </DialogDescription>
        </DialogHeader>
        {secret && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Signing secret</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <code className="min-w-0 font-mono text-sm break-all select-all" data-testid="webhook-secret">
                  {secret.secret}
                </code>
                <CopyButton value={secret.secret} label="Copy secret" />
              </div>
            </div>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                Every delivery is a <span className="font-mono">POST</span> with JSON and the headers{' '}
                <span className="font-mono">webhook-id</span>, <span className="font-mono">webhook-timestamp</span> and{' '}
                <span className="font-mono">webhook-signature</span> (<span className="font-mono">v1,&lt;base64 HMAC-SHA256&gt;</span>{' '}
                over <span className="font-mono">id.timestamp.body</span>, Standard Webhooks). During a rotation two
                signatures are sent, so either secret verifies.
              </p>
            </div>
            <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
              <div className="flex items-center justify-between border-b border-zinc-800 py-1 pr-1 pl-3 text-xs text-zinc-400 [&_button]:text-zinc-300 [&_button:hover]:bg-white/10">
                Verify · Node.js
                <CopyButton value={VERIFY_SNIPPET} label="Copy example" />
              </div>
              <pre className="max-h-56 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed text-zinc-200">{VERIFY_SNIPPET}</pre>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>I have stored the secret</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
