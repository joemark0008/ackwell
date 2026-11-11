import type { Channel, MessageSummary, SendRequestInput } from '@ackwell/schemas';
import { Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useSendMessage } from '@/lib/queries';

export function sampleMessage(version: string): string {
  return [
    `MSH|^~\\&|ACKWELL|HOSP|LIS|LAB|||ADT^A01|||${version}`,
    'EVN|A01',
    'PID|1||MRN0001^^^HOSP^MR||DOE^JANE^A||19800101|F',
    'PV1|1|I|WARD1^101^A',
  ].join('\n');
}

/** A bare typed message (has msh_12) is wrapped as { flat }; anything else JSON goes as-is. */
function asSendBody(v: unknown): SendRequestInput | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if ('msh_12' in v && !('flat' in v)) return { flat: v } as SendRequestInput;
  return v as SendRequestInput;
}

/** Paste HL7 (or JSON) and send it through the channel; the result shows up in the message log. */
export function TestSendCard({ channel }: { channel: Channel }) {
  const [text, setText] = useState(() => sampleMessage(channel.hl7Version));
  const [last, setLast] = useState<MessageSummary | null>(null);
  const send = useSendMessage(channel.id);
  const running = channel.status === 'running';

  async function go() {
    const body = text.trim().startsWith('{') ? asSendBody(safeJson(text)) : { hl7: text };
    if (!body) {
      toast.error('That is not valid JSON.');
      return;
    }
    try {
      const m = await send.mutateAsync(body);
      setLast(m);
      toast.success(`Queued ${m.messageType ?? 'message'} ${m.controlId ?? ''}`.trim());
    } catch (err) {
      toast.error(err instanceof ApiError && err.body?.message ? err.body.message : 'Send failed.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test send</CardTitle>
        <CardDescription>
          Paste an HL7 message (segments on separate lines), the typed JSON (msh_9_1, msh_12, segments…) or the
          lossless JSON. Empty MSH-7, MSH-10 and MSH-12 are filled
          in. The ACK appears in the message log below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Message to send"
          spellCheck={false}
          className="min-h-36 font-mono text-[12.5px] leading-relaxed"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {running ? (
              last ? (
                <>
                  Last queued: <span className="font-mono">{last.controlId}</span>
                </>
              ) : (
                'Sent as the signed-in user; API keys are for other systems.'
              )
            ) : (
              'Start the channel to send.'
            )}
          </p>
          <Button onClick={go} disabled={!running || send.isPending || !text.trim()}>
            {send.isPending ? <Loader2 className="animate-spin" /> : <Send />}
            Send
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
