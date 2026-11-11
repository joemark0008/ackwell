import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import { AUTH, type Auth } from './auth/auth.js';

/**
 * Shared app setup for main.ts and tests. The app must be created with `bodyParser: false`:
 * Better Auth reads the raw request body, so its handler is mounted before the JSON parser.
 */
export function configureApp(app: NestExpressApplication): void {
  const auth = app.get<Auth>(AUTH);
  app.getHttpAdapter().getInstance().all('/api/auth/{*splat}', toNodeHandler(auth));
  app.useBodyParser('json', { limit: '5mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });

  app.set('trust proxy', 1); // Traefik in front (Cloudflare IP comes via cf-connecting-ip)
  app.setGlobalPrefix('api', { exclude: ['health', 'metrics'] });
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Ackwell API')
      .setDescription(
        'HL7 v2 channels: inbound MLLP → JSON, outbound JSON → HL7. ' +
          'UI routes need a session cookie from POST /api/auth/sign-in/email.',
      )
      .setVersion('0.1.0')
      .addCookieAuth('better-auth.session_token')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, doc);
}
