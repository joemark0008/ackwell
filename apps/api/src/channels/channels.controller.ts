import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  channelSchema,
  createChannelSchema,
  updateChannelSchema,
  type CreateChannel,
  type UpdateChannel,
} from '@ackwell/schemas';
import { z } from 'zod';
import { openApi, ZodPipe } from '../common/zod.js';
import { ChannelsService } from './channels.service.js';

@ApiTags('channels')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @ApiOkResponse({ schema: openApi(z.array(channelSchema), 'output') })
  list() {
    return this.channels.list();
  }

  @Get(':id')
  @ApiOkResponse({ schema: openApi(channelSchema, 'output') })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.channels.get(id);
  }

  @Post()
  @ApiBody({ schema: openApi(createChannelSchema) })
  @ApiOkResponse({ schema: openApi(channelSchema, 'output') })
  create(@Body(new ZodPipe(createChannelSchema)) body: CreateChannel) {
    return this.channels.create(body);
  }

  @Patch(':id')
  @ApiBody({ schema: openApi(updateChannelSchema) })
  @ApiOkResponse({ schema: openApi(channelSchema, 'output') })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(updateChannelSchema)) body: UpdateChannel) {
    return this.channels.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.channels.remove(id);
  }
}
