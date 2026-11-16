import 'reflect-metadata';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { runMigrations } from './db/db.js';
import { configureApp } from './setup.js';

/**
 * Production image: the API also serves the built dashboard (apps/web/dist, or WEB_DIST). Static files first,
 * then index.html for any other GET that is not an API route, so client-side routes survive a reload.
 * In development the folder usually does not exist and Vite serves the app instead.
 */
function serveWebApp(app: NestExpressApplication): string | undefined {
  const dir = process.env.WEB_DIST || path.resolve(import.meta.dirname, '..', '..', 'web', 'dist');
  const index = path.join(dir, 'index.html');
  if (!existsSync(index)) return undefined;
  app.useStaticAssets(dir, { index: false, maxAge: '1h' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isApi = /^\/(api|health|metrics)(\/|$)/.test(req.path);
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApi) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return dir;
}

async function bootstrap() {
  const env = loadEnv();
  // Migrations run before the app accepts traffic.
  await runMigrations(env.DATABASE_URL);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  configureApp(app);
  const webDist = serveWebApp(app);
  if (webDist) app.get(Logger).log(`Serving the web app from ${webDist}`);
  await app.listen(env.PORT, '0.0.0.0');
  app.get(Logger).log(`Ackwell API listening on :${env.PORT} (MLLP range ${env.MLLP_PORT_RANGE.from}-${env.MLLP_PORT_RANGE.to})`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
