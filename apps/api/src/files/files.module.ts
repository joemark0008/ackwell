import { Global, Module } from '@nestjs/common';
import { FileRootService } from './file-root.service.js';

/** Shared-root access for file channels (outbound writer, inbound watchers, retention). */
@Global()
@Module({
  providers: [FileRootService],
  exports: [FileRootService],
})
export class FilesModule {}
