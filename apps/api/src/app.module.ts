import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { ChannelsModule } from './channels/channels.module.js';
import { EventsModule } from './common/events.js';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';
import { HealthController } from './health/health.controller.js';
import { MessagesModule } from './messages/messages.module.js';
import { OutboundModule } from './outbound/outbound.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RetentionModule } from './retention/retention.module.js';
import { SettingsController } from './settings/settings.controller.js';

const pretty = process.env.NODE_ENV === 'development' && process.env.LOG_PRETTY !== 'false';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
        autoLogging: { ignore: (req) => req.url === '/health' },
        ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
      },
    }),
    DbModule,
    EventsModule,
    QueueModule,
    AuthModule,
    DeliveryModule,
    OutboundModule,
    ChannelsModule,
    MessagesModule,
    RetentionModule,
  ],
  controllers: [HealthController, SettingsController],
})
export class AppModule {}
