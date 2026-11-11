import { z } from 'zod';

/** GET /api/settings — server facts the UI needs (no secrets). */
export const appSettingsSchema = z.object({
  mllp: z.object({
    host: z.string(),
    portRange: z.object({ from: z.number().int(), to: z.number().int() }),
  }),
  retentionDefaultDays: z.number().int(),
  /** File transport: `enabled` when the server has a shared root (`FILE_ROOT`) mounted. */
  files: z.object({ enabled: z.boolean() }),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;
