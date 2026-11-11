import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  globalMessageListQuerySchema,
  messageDetailSchema,
  messageListSchema,
  messageSummarySchema,
  type GlobalMessageListQuery,
} from '@ackwell/schemas';
import { openApi, ZodPipe } from '../common/zod.js';
import { MessagesService } from './messages.service.js';

@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  @ApiOperation({ summary: 'Message log across all channels, newest first (keyset paging with cursor).' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 50, maximum: 200 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Message type or control id prefix' })
  @ApiQuery({ name: 'channelId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'direction', required: false, schema: { type: 'string', enum: ['inbound', 'outbound'] } })
  @ApiOkResponse({ schema: openApi(messageListSchema, 'output') })
  list(@Query(new ZodPipe(globalMessageListQuerySchema)) query: GlobalMessageListQuery) {
    return this.messages.query(query);
  }

  @Get(':id')
  @ApiOkResponse({ schema: openApi(messageDetailSchema, 'output') })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.messages.get(id);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Queue the message again: inbound → webhook delivery, outbound → MLLP send (attempt numbering continues).' })
  @ApiOkResponse({ schema: openApi(messageSummarySchema, 'output') })
  resend(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.messages.resend(id);
  }
}
