import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { messageDetailSchema } from '@ackwell/schemas';
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
}
