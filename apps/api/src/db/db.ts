import path from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

/** apps/api/drizzle — same relative path from src/db (vitest, dev) and dist/db (build). */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', '..', 'drizzle');

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

/**
 * Runs pending migrations. Called on startup before the app accepts traffic.
 * Retries while the database is still starting (e.g. right after a deploy).
 */
export async function runMigrations(databaseUrl: string, attempts = 10, delayMs = 3000): Promise<void> {
  for (let i = 1; ; i++) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
      return;
    } catch (e) {
      const code = pgError(e)?.code;
      const retryable = !code || code.startsWith('08') || code === '57P03' || code === 'ECONNREFUSED' || code === 'ENOTFOUND';
      if (!retryable || i >= attempts) throw e;
      console.warn(`Database not ready (attempt ${i}/${attempts}), retrying in ${delayMs} ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    } finally {
      await pool.end();
    }
  }
}

/** Unwraps DrizzleQueryError to the underlying pg error, if any. */
export function pgError(e: unknown): { code?: string; constraint?: string } | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 3 && cur; i++) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === 'string') return { code: c.code, constraint: c.constraint as string | undefined };
    cur = c.cause;
  }
  return undefined;
}
