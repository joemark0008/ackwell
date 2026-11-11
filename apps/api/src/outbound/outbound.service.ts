import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  buildHl7,
  controlIdOf,
  messageTypeOf,
  parseHl7,
  type Hl7Json,
  type Hl7Version,
  type MessageSummary,
  type OutboundConfig,
  type SendRequest,
} from '@ackwell/schemas';
import { eq, sql } from 'drizzle-orm';
import { fromDrizzle, type Job } from 'pg-boss';
import { AppEvents } from '../common/events.js';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.js';
import { channels, deliveryAttempts, messages, type ChannelRow, type MessageRow } from '../db/schema.js';
import { QueueService } from '../queue/queue.module.js';
import { MllpSendError, sendHl7 } from './mllp-sender.js';

export const OUTBOUND_QUEUE = 'outbound';

export interface OutboundJob {
  messageId: string;
}

const ACCEPTED = new Set(['AA', 'CA']);

/**
 * Outbound pipeline: POST /channels/:id/send → message row (`queued`) + pg-boss job in one transaction
 * → worker builds/sends HL7 over MLLP → ACK recorded.
 *
 * Ordering: the `outbound` queue uses pg-boss's `key_strict_fifo` policy with the channel id as
 * `singletonKey`, so each channel sends one message at a time, in order, and a message that is
 * retrying holds back the ones behind it. Different channels run in parallel.
 *
 * Status: `queued` → `processing` (sending / waiting for a retry) → `sent` (AA/CA) | `rejected`
 * (AE/AR/CE/CR, never retried) | `failed` (transport errors after `retry.maxAttempts`).
 */
@Injectable()
export class OutboundService implements OnApplicationBootstrap {
  private readonly log = new Logger(OutboundService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly queue: QueueService,
    private readonly events: AppEvents,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.ensureQueue(OUTBOUND_QUEUE, {
      policy: 'key_strict_fifo',
      retryLimit: 4,
      retryDelay: 10,
      retryBackoff: false,
      expireInSeconds: 120,
      deleteAfterSeconds: 7 * 24 * 3600,
    });
    await this.queue.boss.work<OutboundJob>(
      OUTBOUND_QUEUE,
      { batchSize: 1, localConcurrency: 4, pollingIntervalSeconds: this.env.QUEUE_POLL_SECONDS },
      async ([job]) => {
        if (job) await this.process(job);
      },
    );
    this.log.log('Outbound worker started (strict FIFO per channel)');
  }

  /** Validates, completes the header, stores the message and queues the send. */
  async send(channelId: string, input: SendRequest): Promise<MessageSummary> {
    const channel = await this.getChannel(channelId);
    if (channel.direction !== 'outbound') {
      throw new BadRequestException({ statusCode: 400, code: 'NOT_OUTBOUND', message: 'Only outbound channels accept sends' });
    }
    if (channel.status !== 'running') {
      throw new ConflictException({ statusCode: 409, code: 'CHANNEL_STOPPED', message: 'Start the channel before sending' });
    }

    let json: Hl7Json;
    try {
      json = 'hl7' in input ? parseHl7(input.hl7) : input;
      completeHeader(json, channel.hl7Version as Hl7Version);
    } catch (e) {
      throw new BadRequestException({ statusCode: 400, code: 'INVALID_HL7', message: (e as Error).message });
    }
    const raw = buildHl7(json);
    const cfg = channel.config as OutboundConfig;

    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(messages)
        .values({
          channelId: channel.id,
          direction: 'outbound',
          raw,
          json,
          messageType: messageTypeOf(json),
          controlId: controlIdOf(json),
          status: 'queued',
        })
        .returning();
      await this.enqueue(inserted!.id, channel.id, cfg, tx);
      return inserted!;
    });
    const summary = toSummary(row);
    this.events.emit('message', summary);
    this.log.log({ channelId: channel.id, messageId: row.id }, `Queued ${summary.messageType ?? '?'} ${summary.controlId ?? ''}`);
    return summary;
  }

  /** Re-queues an outbound message as-is (attempt numbering continues). */
  async resend(messageId: string): Promise<MessageSummary> {
    const row = await this.load(messageId);
    if (!row) throw new NotFoundException({ statusCode: 404, code: 'MESSAGE_NOT_FOUND', message: 'Message not found' });
    const [updated] = await this.db
      .update(messages)
      .set({ status: 'queued', error: null, ackCode: null })
      .where(eq(messages.id, messageId))
      .returning();
    await this.enqueue(messageId, row.channel.id, row.channel.config as OutboundConfig);
    const summary = toSummary(updated!);
    this.events.emit('message', summary);
    return summary;
  }

  private async enqueue(messageId: string, channelId: string, cfg: OutboundConfig, tx?: Pick<Db, 'execute'>): Promise<void> {
    await this.queue.boss.send(
      OUTBOUND_QUEUE,
      { messageId } satisfies OutboundJob,
      {
        singletonKey: channelId,
        retryLimit: Math.max(0, cfg.retry.maxAttempts - 1),
        retryDelay: cfg.retry.backoffSeconds,
        retryBackoff: false,
        expireInSeconds: Math.ceil(cfg.ackTimeoutMs / 1000) + 30,
        ...(tx ? { db: fromDrizzle(tx, sql) } : {}),
      },
    );
  }

  // ---- worker ----------------------------------------------------------------------------------

  private async process(job: Job<OutboundJob>): Promise<void> {
    const { messageId } = job.data;
    const row = await this.load(messageId);
    const raw = row?.message.raw;
    if (!row || !raw) {
      this.log.warn({ messageId }, 'Outbound job for a missing message — dropped');
      return;
    }
    const { channel, message } = row;
    const cfg = channel.config as OutboundConfig;
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
    try {
      const res = await sendHl7({
        host: cfg.host,
        port: cfg.port,
        tls: cfg.tls.enabled,
        ca: cfg.tls.ca,
        rejectUnauthorized: cfg.tls.rejectUnauthorized,
        version: channel.hl7Version as Hl7Version,
        raw,
        ackTimeoutMs: cfg.ackTimeoutMs,
      });
      const accepted = ACCEPTED.has(res.ackCode);
      await this.db.insert(deliveryAttempts).values({
        messageId,
        attempt,
        result: accepted ? 'success' : 'failure',
        response: res.ackRaw,
        error: accepted ? null : `Receiver answered ${res.ackCode}`,
      });
      await this.finish(message, accepted ? 'sent' : 'rejected', res.ackCode, accepted ? null : `Receiver answered ${res.ackCode}`);
      this.log.log({ channelId: channel.id, messageId }, `${res.ackCode} from ${cfg.host}:${cfg.port} (attempt ${attempt})`);
    } catch (e) {
      const err = e instanceof MllpSendError ? e : new MllpSendError((e as Error).message);
      await this.db.insert(deliveryAttempts).values({ messageId, attempt, result: 'failure', response: null, error: err.message });
      if (triesThisJob >= cfg.retry.maxAttempts) {
        await this.finish(message, 'failed', null, err.message);
        this.log.warn({ channelId: channel.id, messageId }, `Send failed permanently after ${attempt} attempt(s): ${err.message}`);
        return;
      }
      await this.finish(message, 'processing', null, err.message);
      this.log.warn({ channelId: channel.id, messageId }, `Send attempt ${attempt} failed, will retry: ${err.message}`);
      throw err; // pg-boss schedules the retry; strict FIFO holds the channel's later messages
    }
  }

  private async finish(message: MessageRow, status: MessageRow['status'], ackCode: string | null, error: string | null) {
    const [updated] = await this.db.update(messages).set({ status, ackCode, error }).where(eq(messages.id, message.id)).returning();
    if (updated) this.events.emit('message', toSummary(updated));
  }

  private async load(messageId: string) {
    const [row] = await this.db
      .select({ message: messages, channel: channels })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(eq(messages.id, messageId))
      .limit(1);
    return row;
  }

  private async getChannel(id: string): Promise<ChannelRow> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id)).limit(1);
    if (!row) throw new NotFoundException({ statusCode: 404, code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
    return row;
  }
}

/** Fills empty MSH-7 (timestamp), MSH-10 (control id) and MSH-12 (version). Mutates `json`. */
export function completeHeader(json: Hl7Json, version: Hl7Version): void {
  const msh = json.segments[0];
  if (!msh || msh.id !== 'MSH') throw new Error('First segment must be MSH');
  while (msh.fields.length < 12) msh.fields.push('');
  if (!msh.fields[6]) msh.fields[6] = hl7Timestamp(new Date());
  if (!msh.fields[9]) msh.fields[9] = generateControlId();
  if (!msh.fields[11]) msh.fields[11] = version;
}

export function hl7Timestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 20 chars max (HL7 MSH-10 limit): base36 time + random. */
export function generateControlId(): string {
  return `AW${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 20);
}

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
