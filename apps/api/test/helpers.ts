import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface TestContext {
  app: INestApplication;
  pg: StartedPostgreSqlContainer;
}

/** Starts a throwaway Postgres, runs migrations and boots the full AppModule. */
export async function startApp(env: Record<string, string> = {}): Promise<TestContext> {
  const pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: pg.getConnectionUri(),
    MLLP_PORT_RANGE: '6000-6050',
    RETENTION_DEFAULT_DAYS: '7',
    ...env,
  });
  const { runMigrations } = await import('../src/db/db.js');
  await runMigrations(process.env.DATABASE_URL!);
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/setup.js');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return { app, pg };
}

export async function stopApp(ctx: TestContext | undefined): Promise<void> {
  await ctx?.app.close();
  await ctx?.pg.stop();
}
