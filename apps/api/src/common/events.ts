import { EventEmitter } from 'node:events';
import { Global, Injectable, Module } from '@nestjs/common';
import type { ChannelStatus, MessageSummary } from '@ackwell/schemas';

export interface AppEventMap {
  /** A message row was created or changed status (inbound receipt, delivery result, resend). */
  message: [MessageSummary];
  /** A channel changed status. */
  'channel.status': [{ channelId: string; status: ChannelStatus; error?: string }];
}

/** Process-wide event bus (feeds SSE later). */
@Injectable()
export class AppEvents extends EventEmitter<AppEventMap> {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
}

@Global()
@Module({ providers: [AppEvents], exports: [AppEvents] })
export class EventsModule {}
