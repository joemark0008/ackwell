import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Delivery, MessageSummary } from '@ackwell/schemas';
import { desc, eq, sql } from 'drizzle-orm';
import { fromDrizzle, type Job } from 'pg-boss';
import { AppEvents } from '../common/events.js';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.js';
import { channels, deliveryAttempts, messages, type MessageRow } from '../db/schema.js';
import { QueueService } from '../queue/queue.module.js';
import { DeliveryRegistry } from './delivery-adapter.js';
import { WebhookAdapter } from './webhook.adapter.js';

export const DELIVERY_QUEUE = 'delivery';

export interface DeliveryJob {
  messageId: string;
}

/** Anything that can run Drizzle queries: the db or a transaction (for enqueue-with-insert). */
type Executor = Pick<Db, 'execute'>;

/**
 * Inbound delivery pipeline step 2: a pg-boss job per message, processed by the channel's
 * `DeliveryAdapter`. Retries are pg-boss's (exponential backoff), capped by the channel's
 * `delivery.maxAttempts`; every attempt is recorded in `delivery_attempts`.
 *
 * Message status: `received` (queued, not tried yet) → `processing` (tried, waiting for a retry)
 * → `delivered` | `failed`.
 */
@Injectable()
export class DeliveryService implements OnApplicationBootstrap {
  private readonly log = new Logger(DeliveryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly queue: QueueService,
    private readonly registry: DeliveryRegistry,
    private readonly events: AppEvents,
    webhook: WebhookAdapter,
  ) {
    this.registry.register(webhook);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.ensureQueue(DELIVERY_QUEUE, {
      retryLimit: 9,
      retryDelay: this.env.DELIVERY_RETRY_DELAY_SECONDS,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 120,
      deleteAfterSeconds: 7 * 24 * 3600,
    });
    await this.queue.boss.work<DeliveryJob>(
      DELIVERY_QUEUE,
      { batchSize: 1, localConcurrency: 4, pollingIntervalSeconds: this.env.QUEUE_POLL_SECONDS },
      async ([job]) => {
        if (job) await this.process(job);
      },
    );
    this.log.log(`Delivery worker started (adapters: ${this.registry.types.join(', ')})`);
  }

  /**
   * Queues a delivery. Pass the Drizzle transaction that inserted the message so the job is
   * committed together with the row.
   */
  async enqueue(messageId: string, delivery: Delivery, tx?: Executor): Promise<void> {
    await this.queue.boss.send(
      DELIVERY_QUEUE,
      { messageId } satisfies DeliveryJob,
      {
        retryLimit: Math.max(0, delivery.maxAttempts - 1),
        retryDelay: this.env.DELIVERY_RETRY_DELAY_SECONDS,
        retryBackoff: true,
        retryDelayMax: 600,
        expireInSeconds: Math.ceil(('timeoutMs' in delivery ? delivery.timeoutMs : 30_000) / 1000) + 30,
        ...(tx ? { db: fromDrizzle(tx, sql) } : {}),
      },
    );
  }

  /** Re-queues a message (any status). Attempt numbering continues. */
  async resend(messageId: string): Promise<MessageSummary> {
    const row = await this.load(messageId);
    if (!row) throw new Error('Message not found');
    if (row.channel.direction !== 'inbound' || !row.channel.delivery) throw new Error('Channel has no delivery');
    const [updated] = await this.db
      .update(messages)
      .set({ status: 'received', error: null })
      .where(eq(messages.id, messageId))
      .returning();
    await this.enqueue(messageId, row.channel.delivery);
    const summary = toSummary(updated!);
    this.events.emit('message', summary);
    return summary;
  }

  // ---- worker ----------------------------------------------------------------------------------

  private async process(job: Job<DeliveryJob>): Promise<void> {
    const { messageId } = job.data;
    const row = await this.load(messageId);
    if (!row) {
      this.log.warn({ messageId }, 'Delivery job for a missing message (deleted?) — dropped');
      return;
    }
    const { channel, message } = row;
    const delivery = channel.delivery;
    if (!delivery) {
      await this.finish(message, 'failed', 'Channel has no delivery configured');
      return;
    }
    const adapter = this.registry.get(delivery.type);
    if (!adapter) {
      await this.finish(message, 'failed', `No adapter for delivery type "${delivery.type}"`);
      return;
    }

    const [prev] = await this.db
      .select({ n: sql<number>`coalesce(max(${deliveryAttempts.attempt}), 0)::int` })
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.messageId, messageId));
    const attempt = (prev?.n ?? 0) + 1;
    const triesThisJob = job.retryCount + 1;

    const [processing] = await this.db
      .update(messages)
      .set({ status: 'processing' })
      .where(eq(messages.id, messageId))
      .returning();
    if (processing) this.events.emit('message', toSummary(processing));
    const result = await adapter.deliver({ channel, delivery, message, attempt });
    await this.db.insert(deliveryAttempts).values({
      messageId,
      attempt,
      result: result.ok ? 'success' : 'failure',
      response: result.response ?? null,
      error: result.ok ? null : result.error,
    });

    if (result.ok) {
      await this.finish(message, 'delivered', null);
      this.log.log({ channelId: channel.id, messageId }, `Delivered via ${delivery.type} (attempt ${attempt})`);
      return;
    }
    const exhausted = triesThisJob >= delivery.maxAttempts;
    if (!result.retryable || exhausted) {
      await this.finish(message, 'failed', result.error);
      this.log.warn(
        { channelId: channel.id, messageId },
        `Delivery failed permanently after ${attempt} attempt(s): ${result.error}`,
      );
      return;
    }
    await this.finish(message, 'processing', result.error);
    this.log.warn({ channelId: channel.id, messageId }, `Delivery attempt ${attempt} failed, will retry: ${result.error}`);
    // Throwing hands the job back to pg-boss for its next backoff slot.
    throw new Error(result.error);
  }

  private async finish(message: MessageRow, status: MessageRow['status'], error: string | null): Promise<void> {
    const [updated] = await this.db.update(messages).set({ status, error }).where(eq(messages.id, message.id)).returning();
    if (updated) this.events.emit('message', toSummary(updated));
  }

  private async load(messageId: string) {
    const [row] = await this.db
      .select({ message: messages, channel: channels })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(eq(messages.id, messageId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return row;
  }
}

// Local copy to avoid importing MessagesService (module cycle).
function toSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    channelId: row.channelId,
    direction: row.direction,
    status: row.status,
    messageType: row.messageType,
    controlId: row.controlId,
    ackCode: row.ackCode,
    error: row.error,
    remoteAddress: row.remoteAddress,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
