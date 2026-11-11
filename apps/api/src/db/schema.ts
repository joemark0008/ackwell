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
import type { Delivery, InboundConfig, InboundFileConfig, OutboundConfig, OutboundFileConfig } from '@ackwell/schemas';

export const channelDirection = pgEnum('channel_direction', ['inbound', 'outbound']);
export const channelStatus = pgEnum('channel_status', ['stopped', 'running', 'error']);
export const channelTransport = pgEnum('channel_transport', ['mllp', 'file']);
export const fileImportStatus = pgEnum('file_import_status', ['imported', 'error', 'duplicate']);
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
    /** MLLP (default, every channel before the file transport) or shared-folder files. Cannot change. */
    transport: channelTransport('transport').notNull().default('mllp'),
    status: channelStatus('status').notNull().default('stopped'),
    hl7Version: text('hl7_version').notNull(),
    retentionDays: integer('retention_days').notNull(),
    config: jsonb('config').$type<InboundConfig | OutboundConfig | InboundFileConfig | OutboundFileConfig>().notNull(),
    delivery: jsonb('delivery').$type<Delivery>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('channels_name_unique').on(t.name),
    // One inbound listener per port.
    uniqueIndex('channels_inbound_port_unique')
      .on(sql`((${t.config} ->> 'port'))`)
      .where(sql`${t.direction} = 'inbound' and ${t.transport} = 'mllp'`),
    // One inbound file channel per watched folder (case-insensitive, like SMB shares).
    uniqueIndex('channels_inbound_folder_unique')
      .on(sql`(lower(${t.config} ->> 'directory'))`)
      .where(sql`${t.direction} = 'inbound' and ${t.transport} = 'file'`),
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
    /** Sender IP for inbound messages. */
    remoteAddress: text('remote_address'),
    /** File transport: file name relative to FILE_ROOT (inbound: where it came from; outbound: what was written). */
    sourceFile: text('source_file'),
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
    /** First characters of the key (`ak_xxxxxxxx`) for display. */
    keyPrefix: text('key_prefix').notNull().default(''),
    label: text('label').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_keys_hash_unique').on(t.keyHash), index('api_keys_channel_idx').on(t.channelId)],
);

/**
 * Webhook signing secrets. Stored in clear (the app must sign with them; the DB is LAN-only, see PLAN),
 * never returned by the API after creation, never logged. At most two are active (revoked_at null)
 * per channel during a rotation.
 */
export const webhookSecrets = pgTable(
  'webhook_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('webhook_secrets_channel_idx').on(t.channelId, t.createdAt)],
);

export type ChannelRow = typeof channels.$inferSelect;
export type WebhookSecretRow = typeof webhookSecrets.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewChannelRow = typeof channels.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;

// ---- Better Auth tables (see auth-schema.ts) ----
export * from './auth-schema.js';

/**
 * Inbound file channels: one row per file seen in the watched folder. The sha256 makes imports idempotent
 * (a crash between "stored" and "moved", or the same file dropped twice, never creates a second message).
 */
export const fileImports = pgTable(
  'file_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    status: fileImportStatus('status').notNull(),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    /** Where the file was moved (relative to FILE_ROOT), or null if the move failed. */
    movedTo: text('moved_to'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('file_imports_channel_sha_imported_unique')
      .on(t.channelId, t.sha256)
      .where(sql`${t.status} = 'imported'`),
    index('file_imports_channel_created_idx').on(t.channelId, t.createdAt),
  ],
);

export type FileImportRow = typeof fileImports.$inferSelect;
