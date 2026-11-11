import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service.js';
import { OutboundController } from './outbound.controller.js';
import { OutboundService } from './outbound.service.js';
import { SendAuthGuard } from './send-auth.guard.js';

@Module({
  controllers: [OutboundController],
  providers: [OutboundService, ApiKeysService, SendAuthGuard],
  exports: [OutboundService, ApiKeysService],
})
export class OutboundModule {}
