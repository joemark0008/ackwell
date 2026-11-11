import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { ENV, type Env } from '../config/env.js';
import { createDb, createPool, DB, PG_POOL } from './db.js';

@Global()
@Module({
  providers: [
    { provide: PG_POOL, inject: [ENV], useFactory: (env: Env) => createPool(env.DATABASE_URL) },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool) => createDb(pool) },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
