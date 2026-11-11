import { parsePortRange, type PortRange } from '@ackwell/schemas';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: z.string().default('http://localhost:3000'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  /** First-run admin (only used while the user table is empty). */
  SEED_ADMIN_EMAIL: z.email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(12, 'SEED_ADMIN_PASSWORD must be at least 12 characters').optional(),
  MLLP_PORT_RANGE: z
    .string()
    .default('6100-6150')
    .transform((v, ctx): PortRange => {
      try {
        return parsePortRange(v);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message });
        return z.NEVER;
      }
    }),
  /** Host/IP shown to users as the MLLP address senders connect to (the published LAN IP). */
  MLLP_ADVERTISED_HOST: z.string().default('localhost'),
  /** Address the MLLP listeners bind inside the container/host. */
  MLLP_BIND_ADDRESS: z.string().default('0.0.0.0'),
  RETENTION_DEFAULT_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

/** Validates process env once at startup; throws with a readable list of problems. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = envSchema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${lines}`);
  }
  return r.data;
}
