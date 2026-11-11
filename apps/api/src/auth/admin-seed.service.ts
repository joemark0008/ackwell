import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { count } from 'drizzle-orm';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.js';
import { authUser } from '../db/schema.js';
import { AUTH, type Auth } from './auth.js';

/**
 * First-run seed: when the user table is empty and SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD are set,
 * create one admin with an email/password credential. Never runs again once any user exists,
 * so a changed password is not overwritten on restart.
 */
@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  private readonly log = new Logger(AdminSeedService.name);

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = this.env;
    if (!email || !password) return;
    const [row] = await this.db.select({ n: count() }).from(authUser);
    if ((row?.n ?? 0) > 0) return;

    const ctx = await this.auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email, name: 'Admin', emailVerified: true },
      { method: 'admin' },
    );
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await ctx.password.hash(password),
    });
    this.log.log('Seeded the first admin user (SEED_ADMIN_EMAIL)');
  }
}
