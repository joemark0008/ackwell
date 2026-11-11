import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module.js';
import { ChannelManager } from './channel-manager.service.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelsService } from './channels.service.js';

@Module({
  imports: [MessagesModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelManager],
  exports: [ChannelsService, ChannelManager],
})
export class ChannelsModule {}
