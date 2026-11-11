import { z } from 'zod';
import { channelSchema } from './channel';
import { hl7JsonSchema } from './hl7';
import { hl7FlatSchema } from './hl7-flat';

/** A webhook signing secret as listed by the API (the secret itself is never returned after creation). */
export const webhookSecretSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  /** Last 4 characters of the secret, to tell two active secrets apart. */
  hint: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type WebhookSecret = z.infer<typeof webhookSecretSchema>;

/** Returned once, when a secret is created or rotated. */
export const newWebhookSecretSchema = webhookSecretSchema.extend({
  /** `whsec_` + base64 of 32 random bytes. Shown once. */
  secret: z.string(),
});
export type NewWebhookSecret = z.infer<typeof newWebhookSecretSchema>;

/**
 * POST /channels response: the channel, plus the one-time webhook secret for inbound channels.
 */
export const createChannelResponseSchema = channelSchema.extend({
  webhookSecret: newWebhookSecretSchema.optional(),
});
export type CreateChannelResponse = z.infer<typeof createChannelResponseSchema>;

/** Body of every webhook POST (JSON). Signed per Standard Webhooks. */
export const webhookPayloadSchema = z.object({
  /** Message id; also sent as `webhook-id` (idempotency key). */
  id: z.uuid(),
  channelId: z.uuid(),
  channelName: z.string(),
  direction: z.literal('inbound'),
  receivedAt: z.string(),
  messageType: z.string().nullable(),
  controlId: z.string().nullable(),
  remoteAddress: z.string().nullable(),
  raw: z.string(),
  /** Lossless JSON. Left out when the channel's payload format is `typed` (unless `flat` is null). */
  json: hl7JsonSchema.optional(),
  /**
   * Typed flat JSON (`msh_9_1`, `pid_5[0].pid_5_1_1`, …) when MSH-12 is a version with a flat
   * definition (2.3, 2.5.1, 2.7) and every non-Z segment is defined in it; otherwise null.
   */
  flat: hl7FlatSchema.nullable().optional(),
});
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/** Header names used by Standard Webhooks (https://www.standardwebhooks.com). */
export const WEBHOOK_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;
