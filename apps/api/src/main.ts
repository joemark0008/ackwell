import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { runMigrations } from './db/db.js';
import { configureApp } from './setup.js';

async function bootstrap() {
  const env = loadEnv();
  // Migrations run before the app accepts traffic.
  await runMigrations(env.DATABASE_URL);

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.listen(env.PORT, '0.0.0.0');
  app.get(Logger).log(`Ackwell API listening on :${env.PORT} (MLLP range ${env.MLLP_PORT_RANGE.from}-${env.MLLP_PORT_RANGE.to})`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
