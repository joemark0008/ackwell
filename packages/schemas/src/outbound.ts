import { z } from 'zod';
import { hl7JsonSchema } from './hl7';
import { hl7FlatSchema } from './hl7-flat';
import { messageSummarySchema } from './message';

/**
 * Body of POST /channels/:id/send. One of:
 * - raw HL7 text: `{ hl7: "MSH|^~\\&|…" }`
 * - the generic lossless JSON: `{ segments: [...] }` (see hl7.ts)
 * - the typed flat JSON: `{ flat: { msh_9_1: 'ADT', msh_12: '2.7', segments: [...] } }` (see hl7-flat)
 * Empty MSH-7 (timestamp), MSH-10 (control id) and MSH-12 (version) are filled in by the server.
 */
export const sendRequestSchema = z.union([
  z.object({ hl7: z.string().trim().min(8, 'HL7 text is required') }).strict(),
  hl7JsonSchema,
  z.object({ flat: hl7FlatSchema }).strict(),
]);
export type SendRequest = z.infer<typeof sendRequestSchema>;
export type SendRequestInput = z.input<typeof sendRequestSchema>;

/** 201 response: the queued message. Poll GET /messages/:id for the ACK result. */
export const sendResponseSchema = messageSummarySchema;

/** API key as listed (the key itself is never returned after creation). */
export const apiKeySchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  label: z.string(),
  /** First characters of the key, to tell keys apart (`ak_xxxxxxxx`). */
  prefix: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const newApiKeySchema = apiKeySchema.extend({
  /** `ak_` + 32 random bytes (base64url). Shown once. */
  key: z.string(),
});
export type NewApiKey = z.infer<typeof newApiKeySchema>;

export const createApiKeySchema = z.object({ label: z.string().trim().min(1).max(60) }).strict();
export type CreateApiKey = z.infer<typeof createApiKeySchema>;
