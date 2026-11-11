import { Injectable } from '@nestjs/common';
import type { Delivery } from '@ackwell/schemas';
import type { ChannelRow, MessageRow } from '../db/schema.js';

export interface DeliveryContext<D extends Delivery = Delivery> {
  channel: ChannelRow;
  delivery: D;
  message: MessageRow;
  /** 1-based attempt number for this message (across resends). */
  attempt: number;
}

export type DeliveryResult =
  | { ok: true; response: string }
  | { ok: false; error: string; response?: string; retryable: boolean };

/**
 * One delivery target type (webhook in v1; NATS etc. later). Adapters are stateless: everything they
 * need comes from the channel's `delivery` config and the message. Register new ones in DeliveryModule.
 */
export interface DeliveryAdapter<D extends Delivery = Delivery> {
  readonly type: D['type'];
  deliver(ctx: DeliveryContext<D>): Promise<DeliveryResult>;
}

@Injectable()
export class DeliveryRegistry {
  private readonly adapters = new Map<string, DeliveryAdapter>();

  register(adapter: DeliveryAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  get(type: string): DeliveryAdapter | undefined {
    return this.adapters.get(type);
  }

  get types(): string[] {
    return [...this.adapters.keys()];
  }
}
