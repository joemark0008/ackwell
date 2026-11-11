import { ConflictException, Inject, Injectable, Logger, type OnApplicationBootstrap, UnauthorizedException } from '@nestjs/common';
import type { CompleteSetup } from '@ackwell/schemas';
import { fromNodeHeaders } from 'better-auth/node';
import { count } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.js';
import { authUser } from '../db/schema.js';
import { AdminSeedService } from './admin-seed.service.js';
import { AUTH, type Auth } from './auth.js';

/** Crockford base32: no I, L, O, U, so the token survives being read aloud or retyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TOKEN_CHARS = 20; // 100 bits
const MAX_FAILURES = 5;

export interface SetupOutcome {
  user: { id: string; email: string; name: string };
  /** Set-Cookie headers from the automatic sign-in; empty when it did not happen. */
  setCookies: string[];
}

/** Uppercase, drop separators, fold the Crockford look-alikes. */
export function normalizeSetupToken(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * First-run setup wizard. While the user table is empty (and no SEED_ADMIN_* seed ran), a random
 * setup token is printed to the API log. `POST /api/setup/complete` with that token creates the
 * first admin and signs them in. The token lives in memory only: it changes on every restart and
 * after too many wrong attempts, and it is dropped as soon as a user exists.
 */
@Injectable()
export class SetupService implements OnApplicationBootstrap {
  private readonly log = new Logger(SetupService.name);
  private token: string | null = null;
  private failures = 0;
  private done = false;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    // Injected only so the env seed is constructed (and bootstrapped) before this service.
    private readonly _seed: AdminSeedService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (await this.isNeeded()) this.rotateToken('server started with no users');
  }

  /** True until the first user exists. Cached once it flips, users never go back to zero in practice. */
  async isNeeded(): Promise<boolean> {
    if (this.done) return false;
    const [row] = await this.db.select({ n: count() }).from(authUser);
    if ((row?.n ?? 0) > 0) {
      this.done = true;
      this.token = null;
      return false;
    }
    return true;
  }

  /** The live token, for tests and diagnostics; null once setup is done. */
  currentToken(): string | null {
    return this.token;
  }

  /** 409 when setup is done, 401 on a wrong token (rotating it after MAX_FAILURES misses). */
  async verifyToken(given: string): Promise<void> {
    if (!(await this.isNeeded())) {
      throw new ConflictException({ statusCode: 409, code: 'SETUP_DONE', message: 'Setup is already complete' });
    }
    if (!this.token) this.rotateToken('setup requested');
    const a = Buffer.from(normalizeSetupToken(given));
    const b = Buffer.from(normalizeSetupToken(this.token!));
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      this.failures += 1;
      if (this.failures >= MAX_FAILURES) this.rotateToken(`${MAX_FAILURES} wrong tokens were entered`);
      throw new UnauthorizedException({ statusCode: 401, code: 'SETUP_TOKEN_INVALID', message: 'Wrong setup token' });
    }
  }

  /** Verifies the token, creates the admin, then signs them in. Serialized so two calls cannot race. */
  complete(input: CompleteSetup, headers: IncomingHttpHeaders): Promise<SetupOutcome> {
    const run = this.pending.catch(() => undefined).then(() => this.doComplete(input, headers));
    this.pending = run;
    return run;
  }

  private async doComplete(input: CompleteSetup, headers: IncomingHttpHeaders): Promise<SetupOutcome> {
    await this.verifyToken(input.token);

    const ctx = await this.auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: input.email, name: input.name, emailVerified: true },
      { method: 'setup' },
    );
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await ctx.password.hash(input.password),
    });
    this.done = true;
    this.token = null;
    this.log.log(`First admin created by the setup wizard: ${input.email}`);

    let setCookies: string[] = [];
    try {
      const r = await this.auth.api.signInEmail({
        body: { email: input.email, password: input.password },
        headers: fromNodeHeaders(headers),
        returnHeaders: true,
      });
      setCookies = r.headers.getSetCookie();
    } catch (e) {
      this.log.warn(`Automatic sign-in after setup failed, the admin must sign in manually: ${(e as Error).message}`);
    }
    return { user: { id: user.id, email: user.email, name: user.name }, setCookies };
  }

  private rotateToken(reason: string): void {
    const bytes = randomBytes(TOKEN_CHARS);
    const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
    this.token = raw.match(/.{5}/g)!.join('-');
    this.failures = 0;
    const url = `${this.env.APP_URL.replace(/\/$/, '')}/setup`;
    this.log.warn(
      [
        '',
        '==================== Ackwell first-run setup ====================',
        '  No admin user exists yet. Open the setup wizard and enter the token:',
        `    URL:    ${url}`,
        `    Token:  ${this.token}`,
        `  Reason: ${reason}. A new token is printed at every restart.`,
        '  Set SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD to skip the wizard.',
        '=================================================================',
      ].join('\n'),
    );
  }
}
