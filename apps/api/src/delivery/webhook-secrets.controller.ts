import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { newWebhookSecretSchema, webhookSecretSchema } from '@ackwell/schemas';
import { z } from 'zod';
import { openApi } from '../common/zod.js';
import { WebhookSecretsService } from './webhook-secrets.service.js';

@ApiTags('webhook-secrets')
@Controller('channels/:id/webhook-secrets')
export class WebhookSecretsController {
  constructor(private readonly secrets: WebhookSecretsService) {}

  @Get()
  @ApiOperation({ summary: 'Signing secrets of an inbound channel (values are never returned).' })
  @ApiOkResponse({ schema: openApi(z.array(webhookSecretSchema), 'output') })
  list(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.secrets.list(id);
  }

  @Post('rotate')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a new secret (shown once). The previous newest secret stays active; older ones are revoked.',
  })
  @ApiOkResponse({ schema: openApi(newWebhookSecretSchema, 'output') })
  rotate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.secrets.rotate(id);
  }

  @Delete(':secretId')
  @ApiOperation({ summary: 'Revoke a secret.' })
  @ApiOkResponse({ schema: openApi(webhookSecretSchema, 'output') })
  revoke(@Param('id', new ParseUUIDPipe()) id: string, @Param('secretId', new ParseUUIDPipe()) secretId: string) {
    return this.secrets.revoke(id, secretId);
  }
}
