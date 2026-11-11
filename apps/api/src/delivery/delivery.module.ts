import { Module } from '@nestjs/common';
import { DeliveryRegistry } from './delivery-adapter.js';
import { DeliveryService } from './delivery.service.js';
import { WebhookSecretsController } from './webhook-secrets.controller.js';
import { WebhookSecretsService } from './webhook-secrets.service.js';
import { WebhookAdapter } from './webhook.adapter.js';

/** Delivery adapters + the queue worker. Add new adapters here and register them in DeliveryService. */
@Module({
  controllers: [WebhookSecretsController],
  providers: [DeliveryRegistry, WebhookSecretsService, WebhookAdapter, DeliveryService],
  exports: [DeliveryService, WebhookSecretsService, DeliveryRegistry],
})
export class DeliveryModule {}
