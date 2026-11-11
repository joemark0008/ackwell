import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  channelSchema,
  createChannelResponseSchema,
  createChannelSchema,
  fileErrorEntrySchema,
  folderCheckRequestSchema,
  folderCheckSchema,
  messageListQuerySchema,
  messageListSchema,
  updateChannelSchema,
  type CreateChannel,
  type FolderCheckRequest,
  type MessageListQuery,
  type UpdateChannel,
} from '@ackwell/schemas';
import { z } from 'zod';
import { openApi, ZodPipe } from '../common/zod.js';
import { MessagesService } from '../messages/messages.service.js';
import { ChannelManager } from './channel-manager.service.js';
import { ChannelsService } from './channels.service.js';
import { FilesService } from './files.service.js';

@ApiTags('channels')
@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly manager: ChannelManager,
    private readonly messages: MessagesService,
    private readonly files: FilesService,
  ) {}

  @Post('check-folder')
  @HttpCode(200)
  @ApiOperation({ summary: 'File channels: check a folder inside the shared root (exists / readable / writable). Creates nothing.' })
  @ApiBody({ schema: openApi(folderCheckRequestSchema) })
  @ApiOkResponse({ schema: openApi(folderCheckSchema, 'output') })
  checkFolder(@Body(new ZodPipe(folderCheckRequestSchema)) body: FolderCheckRequest) {
    return this.files.checkFolder(body.directory);
  }

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
  @ApiOperation({ summary: 'Create a channel. Inbound channels also return their one-time webhook secret.' })
  @ApiBody({ schema: openApi(createChannelSchema) })
  @ApiOkResponse({ schema: openApi(createChannelResponseSchema, 'output') })
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

  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start the channel (inbound: bind its MLLP port). Idempotent.' })
  @ApiOkResponse({ schema: openApi(channelSchema, 'output') })
  start(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.manager.start(id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the channel (inbound: close its MLLP port). Idempotent.' })
  @ApiOkResponse({ schema: openApi(channelSchema, 'output') })
  stop(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.manager.stop(id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Message log of a channel, newest first (keyset paging with cursor).' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 50, maximum: 200 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Message type or control id prefix' })
  @ApiOkResponse({ schema: openApi(messageListSchema, 'output') })
  async listMessages(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(messageListQuerySchema)) query: MessageListQuery,
  ) {
    await this.channels.get(id); // 404 for unknown channels
    return this.messages.list(id, query);
  }

  @Get(':id/files/errors')
  @ApiOperation({ summary: 'Inbound file channels: files moved to the error folder, with the reason.' })
  @ApiOkResponse({ schema: openApi(z.array(fileErrorEntrySchema), 'output') })
  listFileErrors(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.files.listErrors(id);
  }

  @Post(':id/files/errors/:name/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inbound file channels: move an error file back into the watched folder to import it again.' })
  async retryFileError(@Param('id', new ParseUUIDPipe()) id: string, @Param('name') name: string) {
    if (!name || name.length > 255) throw new BadRequestException({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'Invalid file name' });
    return { movedTo: await this.files.retryError(id, name) };
  }
}
