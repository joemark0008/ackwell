import { z } from 'zod';
import { channelDirectionSchema } from './channel';
import { hl7JsonSchema } from './hl7';

export const messageStatusSchema = z.enum([
  'received', // inbound: stored, ACK sent
  'queued', // outbound: accepted, waiting for the worker
  'processing', // being delivered / sent
  'delivered', // inbound: delivered to the adapter target
  'sent', // outbound: AA received
  'rejected', // outbound: AE/AR received
  'failed', // gave up after retries
]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/** One row of the message log (no raw/JSON payload). */
export const messageSummarySchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  direction: channelDirectionSchema,
  status: messageStatusSchema,
  /** e.g. "ORU^R01" (MSH-9) */
  messageType: z.string().nullable(),
  /** MSH-10 */
  controlId: z.string().nullable(),
  /** ACK we sent (inbound) or received (outbound): AA / AE / AR … */
  ackCode: z.string().nullable(),
  error: z.string().nullable(),
  /** Sender address (inbound) */
  remoteAddress: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MessageSummary = z.infer<typeof messageSummarySchema>;

export const deliveryAttemptSchema = z.object({
  id: z.uuid(),
  attempt: z.number().int(),
  result: z.enum(['success', 'failure']),
  response: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type DeliveryAttempt = z.infer<typeof deliveryAttemptSchema>;

export const messageDetailSchema = messageSummarySchema.extend({
  raw: z.string().nullable(),
  json: hl7JsonSchema.nullable(),
  attempts: z.array(deliveryAttemptSchema),
});
export type MessageDetail = z.infer<typeof messageDetailSchema>;

/** Query string for GET /channels/:id/messages. Newest first, keyset paging with `cursor`. */
export const messageListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** `nextCursor` from the previous page. */
  cursor: z.string().max(200).optional(),
  status: messageStatusSchema.optional(),
  /** Matches message type or control id (prefix, case-insensitive). */
  q: z.string().trim().max(100).optional(),
});
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

export const messageListSchema = z.object({
  items: z.array(messageSummarySchema),
  /** Pass as `cursor` to fetch the next (older) page; null when there is none. */
  nextCursor: z.string().nullable(),
  /** Messages matching the filters (all pages). */
  total: z.number().int(),
});
export type MessageList = z.infer<typeof messageListSchema>;
