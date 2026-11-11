import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { ChannelManager } from './channel-manager.service.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelsService } from './channels.service.js';
import { FileImportService } from './file-import.service.js';
import { FilesService } from './files.service.js';

@Module({
  imports: [MessagesModule, DeliveryModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelManager, FileImportService, FilesService],
  exports: [ChannelsService, ChannelManager],
})
export class ChannelsModule {}
