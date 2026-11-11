import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  controlIdOf,
  messageTypeOf,
  parseHl7,
  type Hl7Json,
  type MessageDetail,
  type MessageList,
  type MessageListQuery,
  type MessageSummary,
} from '@ackwell/schemas';
import { and, asc, count, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.js';
import { deliveryAttempts, messages, type ChannelRow, type DeliveryAttemptRow, type MessageRow } from '../db/schema.js';

export interface InboundRecord {
  message: MessageSummary;
  /** `AA` when stored, `AE` when the HL7 could not be parsed (stored anyway, status `failed`). */
  ack: 'AA' | 'AE';
}

@Injectable()
export class MessagesService {
  private readonly log = new Logger(MessagesService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Inbound pipeline step 1: store the raw message (and its JSON) *before* the caller ACKs.
   * Throws when the insert fails so the listener can answer `AR` (nothing was persisted).
   */
  async recordInbound(channel: ChannelRow, raw: string, remoteAddress: string | null): Promise<InboundRecord> {
    let json: Hl7Json | null = null;
    let parseError: string | null = null;
    try {
      json = parseHl7(raw);
    } catch (e) {
      parseError = (e as Error).message;
    }
    const ack = parseError ? 'AE' : 'AA';
    const [row] = await this.db
      .insert(messages)
      .values({
        channelId: channel.id,
        direction: 'inbound',
        raw,
        json,
        messageType: json ? messageTypeOf(json) : null,
        controlId: json ? controlIdOf(json) : null,
        status: parseError ? 'failed' : 'received',
        ackCode: ack,
        error: parseError,
        remoteAddress,
      })
      .returning();
    const message = toSummary(row!);
    if (parseError) {
      this.log.warn({ channelId: channel.id, messageId: message.id }, `Unparseable HL7 stored: ${parseError}`);
    } else {
      this.log.log(
        { channelId: channel.id, messageId: message.id },
        `Received ${message.messageType ?? '?'} ${message.controlId ?? ''} from ${remoteAddress ?? '?'}`,
      );
    }
    return { message, ack };
  }

  async list(channelId: string, q: MessageListQuery): Promise<MessageList> {
    const filters = [eq(messages.channelId, channelId)];
    if (q.status) filters.push(eq(messages.status, q.status));
    if (q.q) {
      const needle = `${escapeLike(q.q)}%`;
      filters.push(or(ilike(messages.messageType, needle), ilike(messages.controlId, needle))!);
    }
    const where = and(...filters);

    const pageFilters = [where];
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (cursor) {
      pageFilters.push(
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
        )!,
      );
    }

    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(messages)
        .where(and(...pageFilters))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(q.limit + 1),
      this.db.select({ n: count() }).from(messages).where(where),
    ]);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(toSummary),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      total: total?.n ?? 0,
    };
  }

  async get(id: string): Promise<MessageDetail> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    if (!row) {
      throw new NotFoundException({ statusCode: 404, code: 'MESSAGE_NOT_FOUND', message: 'Message not found' });
    }
    const attempts = await this.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.messageId, id))
      .orderBy(asc(deliveryAttempts.attempt));
    return {
      ...toSummary(row),
      raw: row.raw,
      json: (row.json as Hl7Json | null) ?? null,
      attempts: attempts.map(toAttempt),
    };
  }

  /** Number of messages per channel (for list badges). */
  async countByChannel(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ channelId: messages.channelId, n: count() })
      .from(messages)
      .groupBy(messages.channelId);
    return Object.fromEntries(rows.map((r) => [r.channelId, r.n]));
  }

  /** Raw SQL helper for tests / health: total rows. */
  async total(): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(messages);
    return r?.n ?? 0;
  }
}

export function toSummary(row: MessageRow): MessageSummary {
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

function toAttempt(row: DeliveryAttemptRow) {
  return {
    id: row.id,
    attempt: row.attempt,
    result: row.result,
    response: row.response,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

function encodeCursor(row: MessageRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = text.indexOf('|');
  if (sep < 0) return null;
  const createdAt = new Date(text.slice(0, sep));
  const id = text.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { createdAt, id };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
