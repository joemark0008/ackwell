import { Inbox, RadioTower, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { MessageLog } from '@/components/message-log';
import { PageHeader } from '@/components/page-header';
import { useLiveStatus } from '@/lib/live-state';
import { useAllMessages } from '@/lib/queries';

function Empty() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-14 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-muted">
        <Inbox className="size-5 text-muted-foreground" />
      </span>
      <p className="mt-3 text-sm font-medium">No messages yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Messages from every channel show up here as they arrive or are sent.{' '}
        <Link to="/channels" className="underline">
          Go to channels
        </Link>
      </p>
    </div>
  );
}

export function MessagesPage() {
  const stream = useLiveStatus();
  return (
    <div className="space-y-8">
      <PageHeader
        title="Messages"
        description="Every message across all channels, newest first. Open one to see raw HL7, JSON, ACK and delivery attempts."
        actions={
          stream === 'live' ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-success">
              <RadioTower className="size-3.5" /> Live
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="size-3.5" /> {stream === 'reconnecting' ? 'Reconnecting' : 'Refreshing periodically'}
            </span>
          )
        }
      />
      <MessageLog useData={useAllMessages} scope empty={<Empty />} />
    </div>
  );
}
