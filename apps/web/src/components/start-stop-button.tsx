import type { Channel } from '@ackwell/schemas';
import { Loader2, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ApiError } from '@/lib/api';
import { useStartChannel, useStopChannel } from '@/lib/queries';

function describeError(err: unknown, action: 'start' | 'stop'): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'PORT_UNAVAILABLE':
        return err.message;
      case 'CHANNEL_BUSY':
        return 'The channel is already starting or stopping. Try again in a moment.';
      case 'UNAUTHENTICATED':
        return 'Your session expired. Sign in again.';
      default:
        return err.message || `Could not ${action} the channel.`;
    }
  }
  return `Could not ${action} the channel.`;
}

export function useStartStop(channel: Channel) {
  const start = useStartChannel(channel.id);
  const stop = useStopChannel(channel.id);
  const running = channel.status === 'running';
  const pending = start.isPending || stop.isPending;

  async function toggle() {
    const action = running ? 'stop' : 'start';
    try {
      const ch = await (running ? stop.mutateAsync() : start.mutateAsync());
      toast.success(
        action === 'start'
          ? ch.direction === 'inbound'
            ? `“${ch.name}” is listening on port ${(ch.config as { port: number }).port}`
            : `“${ch.name}” started`
          : `“${ch.name}” stopped`,
      );
    } catch (err) {
      toast.error(describeError(err, action));
    }
  }

  return { running, pending, toggle };
}

export function StartStopButton({ channel }: { channel: Channel }) {
  const { running, pending, toggle } = useStartStop(channel);
  return (
    <Button variant={running ? 'outline' : 'default'} onClick={toggle} disabled={pending} aria-busy={pending}>
      {pending ? <Loader2 className="animate-spin" /> : running ? <Square /> : <Play />}
      {running ? 'Stop' : 'Start'}
    </Button>
  );
}

export function StartStopMenuItem({ channel }: { channel: Channel }) {
  const { running, pending, toggle } = useStartStop(channel);
  return (
    <DropdownMenuItem onSelect={() => void toggle()} disabled={pending}>
      {running ? <Square /> : <Play />} {running ? 'Stop' : 'Start'}
    </DropdownMenuItem>
  );
}
