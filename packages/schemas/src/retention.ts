import { z } from 'zod';

/** Message statuses that are never deleted by retention (still pending delivery, send or retry). */
export const RETENTION_PROTECTED_STATUSES = ['received', 'queued', 'processing'] as const;

/** One cleanup run (hourly schedule or manual). */
export const retentionRunSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int(),
  /** Deleted messages per channel id (channels with 0 are omitted). */
  deleted: z.record(z.string(), z.number().int()),
  total: z.number().int(),
  /** Files deleted from inbound file channels' processed folders (older than the channel's retention). */
  filesDeleted: z.number().int().default(0),
  trigger: z.enum(['schedule', 'manual']),
});
export type RetentionRun = z.infer<typeof retentionRunSchema>;

/** GET /api/retention */
export const retentionStatusSchema = z.object({
  /** Cron expression of the schedule (UTC). */
  cron: z.string(),
  batchSize: z.number().int(),
  protectedStatuses: z.array(z.string()),
  lastRun: retentionRunSchema.nullable(),
  nextRunAt: z.string().nullable(),
});
export type RetentionStatus = z.infer<typeof retentionStatusSchema>;
