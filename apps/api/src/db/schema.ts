import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Delivery, InboundConfig, OutboundConfig } from '@ackwell/schemas';

export const channelDirection = pgEnum('channel_direction', ['inbound', 'outbound']);
export const channelStatus = pgEnum('channel_status', ['stopped', 'running', 'error']);
export const messageStatus = pgEnum('message_status', [
  'received', // inbound: stored, ACK sent
  'queued', // outbound: accepted, waiting for the worker
  'processing', // being delivered / sent
  'delivered', // inbound: delivered to the adapter target
  'sent', // outbound: AA received
  'rejected', // outbound: AE/AR received
  'failed', // gave up after retries
]);
export const attemptResult = pgEnum('attempt_result', ['success', 'failure']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    direction: channelDirection('direction').notNull(),
    status: channelStatus('status').notNull().default('stopped'),
    hl7Version: text('hl7_version').notNull(),
    retentionDays: integer('retention_days').notNull(),
    config: jsonb('config').$type<InboundConfig | OutboundConfig>().notNull(),
    delivery: jsonb('delivery').$type<Delivery>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('channels_name_unique').on(t.name),
    // One inbound listener per port.
    uniqueIndex('channels_inbound_port_unique')
      .on(sql`((${t.config} ->> 'port'))`)
      .where(sql`${t.direction} = 'inbound'`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    direction: channelDirection('direction').notNull(),
    raw: text('raw'),
    json: jsonb('json'),
    messageType: text('message_type'),
    controlId: text('control_id'),
    status: messageStatus('status').notNull(),
    ackCode: text('ack_code'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    index('messages_channel_created_idx').on(t.channelId, t.createdAt),
    index('messages_control_id_idx').on(t.channelId, t.controlId),
  ],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    result: attemptResult('result').notNull(),
    response: text('response'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('delivery_attempts_message_idx').on(t.messageId, t.attempt)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull(),
    label: text('label').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_keys_hash_unique').on(t.keyHash), index('api_keys_channel_idx').on(t.channelId)],
);

export type ChannelRow = typeof channels.$inferSelect;
export type NewChannelRow = typeof channels.$inferInsert;
