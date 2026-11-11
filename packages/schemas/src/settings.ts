import { z } from 'zod';

/** GET /api/settings — server facts the UI needs (no secrets). */
export const appSettingsSchema = z.object({
  mllp: z.object({
    host: z.string(),
    portRange: z.object({ from: z.number().int(), to: z.number().int() }),
  }),
  retentionDefaultDays: z.number().int(),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;
