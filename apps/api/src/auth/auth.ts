import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Env } from '../config/env.js';
import type { Db } from '../db/db.js';
import * as schema from '../db/schema.js';

export const AUTH = Symbol('AUTH');

/**
 * People (UI) auth. Email + password only, public sign-up disabled: users are created by the
 * first-run admin seed (and later by an admin screen). Machines use per-channel API keys instead.
 */
export function createAuth(db: Db, env: Pick<Env, 'APP_URL' | 'BETTER_AUTH_SECRET' | 'NODE_ENV'>) {
  return betterAuth({
    appName: 'Ackwell',
    baseURL: env.APP_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.authUser,
        session: schema.authSession,
        account: schema.authAccount,
        verification: schema.authVerification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 12, // 12 h
      updateAge: 60 * 60, // refresh at most hourly
    },
    rateLimit: {
      enabled: env.NODE_ENV !== 'test',
      storage: 'memory',
    },
    advanced: {
      // Better Auth skips origin/CSRF checks when NODE_ENV=test; keep them on so tests match prod.
      disableOriginCheck: false,
      // Behind Cloudflare + Traefik: take the client IP from the proxy headers.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
