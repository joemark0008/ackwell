import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { messageDetailSchema, messageSummarySchema } from '@ackwell/schemas';
import { openApi } from '../common/zod.js';
import { MessagesService } from './messages.service.js';

@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

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
