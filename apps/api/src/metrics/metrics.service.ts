import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { MessageSummary } from '@ackwell/schemas';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { AppEvents } from '../common/events.js';
import { DB, type Db } from '../db/db.js';
import { channels } from '../db/schema.js';
import { QueueService } from '../queue/queue.module.js';

const CHANNEL_STATUSES = ['stopped', 'running', 'error'] as const;
/** Status transitions counted in `ackwell_messages_total` (queued/processing are intermediate). */
const COUNTED = new Set(['delivered', 'sent', 'rejected', 'failed']);

/** Prometheus metrics. Own registry (not the global one) so several app instances can coexist in tests. */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MetricsService.name);
  readonly registry = new Registry();
  private readonly names = new Map<string, string>();
  private readonly seen = new Set<string>();

  private readonly messagesTotal = new Counter({
    name: 'ackwell_messages_total',
    help: 'Messages by channel, direction and outcome (received, delivered, sent, rejected, failed).',
    labelNames: ['channel_id', 'channel_name', 'direction', 'status'],
    registers: [this.registry],
  });
  private readonly ackFailures = new Counter({
    name: 'ackwell_ack_failures_total',
    help: 'Negative ACKs: inbound AE/AR we sent, outbound AE/AR/CE/CR received.',
    labelNames: ['channel_id', 'direction'],
    registers: [this.registry],
  });
  private readonly filesTotal = new Counter({
    name: 'ackwell_files_total',
    help: 'File channels: files imported / duplicate / moved to the error folder (inbound) and written (outbound).',
    labelNames: ['channel_id', 'outcome'],
    registers: [this.registry],
  });

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queue: QueueService,
    private readonly events: AppEvents,
  ) {
    // Gauges are filled on scrape (collect callbacks).
    const self = this;
    new Gauge({
      name: 'ackwell_queue_depth',
      help: 'Jobs waiting in a pg-boss queue.',
      labelNames: ['queue'],
      registers: [this.registry],
      async collect() {
        this.reset();
        if (!self.queue.isRunning) return;
        try {
          for (const q of await self.queue.boss.getQueues()) this.set({ queue: q.name }, q.queuedCount);
        } catch (e) {
          self.log.warn(`Queue depth unavailable: ${(e as Error).message}`);
        }
      },
    });
    new Gauge({
      name: 'ackwell_channel_status',
      help: '1 for the status a channel currently has, 0 for the others.',
      labelNames: ['channel_id', 'channel_name', 'status'],
      registers: [this.registry],
      async collect() {
        this.reset();
        try {
          const rows = await self.db.select({ id: channels.id, name: channels.name, status: channels.status }).from(channels);
          for (const r of rows) {
            self.names.set(r.id, r.name);
            for (const s of CHANNEL_STATUSES) {
              this.set({ channel_id: r.id, channel_name: r.name, status: s }, r.status === s ? 1 : 0);
            }
          }
        } catch (e) {
          self.log.warn(`Channel status unavailable: ${(e as Error).message}`);
        }
      },
    });
  }

  private readonly onMessage = (m: MessageSummary) => {
    if (!COUNTED.has(m.status)) return;
    const key = `${m.id}:${m.status}:${m.updatedAt}`; // the same transition must not count twice
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
    void this.count(m.channelId, m.direction, m.status);
    if (m.direction === 'outbound' && m.status === 'rejected') this.ackFailure(m.channelId, 'outbound', m.ackCode ?? 'AE');
  };

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
    this.events.on('message', this.onMessage);
  }

  onModuleDestroy(): void {
    this.events.off('message', this.onMessage);
  }

  /** Inbound message stored and ACKed (counted here: the bus also re-emits `received` on resend). */
  messageReceived(m: MessageSummary): void {
    void this.count(m.channelId, 'inbound', 'received');
  }

  ackFailure(channelId: string, direction: 'inbound' | 'outbound', _code: string): void {
    this.ackFailures.inc({ channel_id: channelId, direction });
  }

  fileOutcome(channelId: string, outcome: 'imported' | 'duplicate' | 'error' | 'written'): void {
    this.filesTotal.inc({ channel_id: channelId, outcome });
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  private async count(channelId: string, direction: string, status: string): Promise<void> {
    let name = this.names.get(channelId);
    if (name === undefined) {
      try {
        const rows = await this.db.select({ id: channels.id, name: channels.name }).from(channels);
        for (const r of rows) this.names.set(r.id, r.name);
      } catch {
        /* label falls back to the id */
      }
      name = this.names.get(channelId) ?? channelId;
    }
    this.messagesTotal.inc({ channel_id: channelId, channel_name: name, direction, status });
  }
}
