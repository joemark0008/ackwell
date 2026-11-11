import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const TEST_ORIGIN = 'http://127.0.0.1:3000';
export const ADMIN = { email: 'admin@ackwell.test', password: 'correct-horse-battery' };

export interface TestContext {
  app: NestExpressApplication;
  pg: StartedPostgreSqlContainer;
}

/** Starts a throwaway Postgres, runs migrations and boots the full AppModule. */
export async function startApp(
  env: Record<string, string> = {},
  opts: { pg?: StartedPostgreSqlContainer } = {},
): Promise<TestContext> {
  const pg = opts.pg ?? (await new PostgreSqlContainer('postgres:16-alpine').start());
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: pg.getConnectionUri(),
    MLLP_PORT_RANGE: '6000-6050',
    RETENTION_DEFAULT_DAYS: '7',
    APP_URL: TEST_ORIGIN,
    BETTER_AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
    SEED_ADMIN_EMAIL: ADMIN.email,
    SEED_ADMIN_PASSWORD: ADMIN.password,
    ...env,
  });
  const { runMigrations } = await import('../src/db/db.js');
  await runMigrations(process.env.DATABASE_URL!);
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/setup.js');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.init();
  return { app, pg };
}

export async function stopApp(ctx: TestContext | undefined, opts: { keepDb?: boolean } = {}): Promise<void> {
  await ctx?.app.close();
  if (!opts.keepDb) await ctx?.pg.stop();
}

/** Signs in as the seeded admin and returns the session cookie header. */
export async function signIn(app: NestExpressApplication, creds = ADMIN): Promise<string> {
  const { default: request } = await import('supertest');
  const r = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .set('Origin', TEST_ORIGIN)
    .send(creds)
    .expect(200);
  const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  return cookies.map((c) => c.split(';')[0]).join('; ');
}
