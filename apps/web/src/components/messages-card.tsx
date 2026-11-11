import type { Channel } from '@ackwell/schemas';
import { Inbox, RadioTower, RefreshCw } from 'lucide-react';
import { useCallback } from 'react';
import { MessageLog } from '@/components/message-log';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useLiveStatus } from '@/lib/live-state';
import { useMessages, type LogFilters } from '@/lib/queries';

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
  const running = channel.status === 'running';
  const stream = useLiveStatus();
  const useData = useCallback((filters: LogFilters) => useMessages(channel.id, filters, running), [channel.id, running]);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Messages</CardTitle>
            <CardDescription>Raw HL7, parsed JSON, ACK and delivery attempts for every message.</CardDescription>
          </div>
          {running &&
            (stream === 'live' ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-success">
                <RadioTower className="size-3.5" /> Live
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <RefreshCw className="size-3.5" /> {stream === 'reconnecting' ? 'Reconnecting, refreshing periodically' : 'Refreshing periodically'}
              </span>
            ))}
        </div>
      </CardHeader>
      <CardContent>
        <MessageLog useData={useData} empty={<Empty channel={channel} />} />
      </CardContent>
    </Card>
  );
}
