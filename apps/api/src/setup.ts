import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Shared app setup for main.ts and tests. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Ackwell API')
      .setDescription('HL7 v2 channels: inbound MLLP → JSON, outbound JSON → HL7')
      .setVersion('0.1.0')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, doc);
}
