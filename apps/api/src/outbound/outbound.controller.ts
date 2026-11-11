import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  apiKeySchema,
  createApiKeySchema,
  newApiKeySchema,
  sendRequestSchema,
  sendResponseSchema,
  type CreateApiKey,
  type SendRequest,
} from '@ackwell/schemas';
import { z } from 'zod';
import { Public } from '../auth/public.decorator.js';
import { openApi, ZodPipe } from '../common/zod.js';
import { ApiKeysService } from './api-keys.service.js';
import { OutboundService } from './outbound.service.js';
import { SendAuthGuard } from './send-auth.guard.js';

@ApiTags('outbound')
@Controller('channels/:id')
export class OutboundController {
  constructor(
    private readonly outbound: OutboundService,
    private readonly keys: ApiKeysService,
  ) {}

  @Post('send')
  @Public()
  @UseGuards(SendAuthGuard)
  @HttpCode(201)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Queue a message on an outbound channel',
    description:
      'Body: `{ "hl7": "MSH|^~\\\\&|…" }` (raw text, segments separated by \\r or \\n) or the generic JSON ' +
      '`{ "segments": [{ "id": "MSH", "fields": [...] }, …] }`. Empty MSH-7 / MSH-10 / MSH-12 are filled in. ' +
      'Auth: `Authorization: Bearer <api key>` for the channel, or a dashboard session. ' +
      'Returns the queued message; poll GET /api/messages/:id for the ACK.',
  })
  @ApiBody({ schema: openApi(sendRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(sendResponseSchema, 'output') })
  send(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(sendRequestSchema)) body: SendRequest) {
    return this.outbound.send(id, body);
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'API keys of an outbound channel (values are never returned).' })
  @ApiOkResponse({ schema: openApi(z.array(apiKeySchema), 'output') })
  listKeys(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.keys.list(id);
  }

  @Post('api-keys')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an API key (shown once).' })
  @ApiBody({ schema: openApi(createApiKeySchema) })
  @ApiCreatedResponse({ schema: openApi(newApiKeySchema, 'output') })
  createKey(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(createApiKeySchema)) body: CreateApiKey) {
    return this.keys.create(id, body.label);
  }

  @Delete('api-keys/:keyId')
  @ApiOperation({ summary: 'Revoke an API key.' })
  @ApiOkResponse({ schema: openApi(apiKeySchema, 'output') })
  revokeKey(@Param('id', new ParseUUIDPipe()) id: string, @Param('keyId', new ParseUUIDPipe()) keyId: string) {
    return this.keys.revoke(id, keyId);
  }
}
