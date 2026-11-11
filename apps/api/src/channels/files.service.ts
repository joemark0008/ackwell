import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FileErrorEntry, FolderCheck } from '@ackwell/schemas';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.js';
import { channels, type ChannelRow } from '../db/schema.js';
import { FileRootError, FileRootService } from '../files/file-root.service.js';
import { ChannelManager } from './channel-manager.service.js';
import { FileImportService } from './file-import.service.js';

/** API side of file channels: folder check, error folder list and retry. */
@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly root: FileRootService,
    private readonly imports: FileImportService,
    private readonly manager: ChannelManager,
  ) {}

  async checkFolder(directory: string): Promise<FolderCheck> {
    this.root.assertEnabled();
    const out: FolderCheck = { directory, exists: false, readable: false, writable: false, entries: null, error: null };
    let abs: string;
    try {
      abs = await this.root.resolveFolder(directory);
    } catch (e) {
      const err = e as FileRootError;
      out.error = err.code === 'UNREACHABLE' && /does not exist/.test(err.message) ? 'Does not exist yet; it is created when the channel starts' : err.message;
      return out;
    }
    out.exists = (await stat(abs)).isDirectory();
    try {
      await access(abs, constants.R_OK);
      out.readable = true;
      out.entries = (await readdir(abs)).filter((n) => !n.startsWith('.')).length;
    } catch {
      out.error = 'Not readable by the Ackwell server';
    }
    try {
      await access(abs, constants.W_OK);
      out.writable = true;
    } catch {
      out.error ??= 'Not writable by the Ackwell server';
    }
    return out;
  }

  async listErrors(channelId: string): Promise<FileErrorEntry[]> {
    const row = await this.inboundFileChannel(channelId);
    try {
      return await this.imports.listErrors(row);
    } catch (e) {
      throw new BadRequestException({ statusCode: 400, code: 'FOLDER_UNAVAILABLE', message: (e as Error).message });
    }
  }

  async retryError(channelId: string, name: string): Promise<string> {
    const row = await this.inboundFileChannel(channelId);
    let movedTo: string;
    try {
      movedTo = await this.imports.retryError(row, name);
    } catch (e) {
      throw new BadRequestException({ statusCode: 400, code: 'RETRY_FAILED', message: (e as Error).message });
    }
    void this.manager.watcher(channelId)?.rescan();
    return movedTo;
  }

  private async inboundFileChannel(id: string): Promise<ChannelRow> {
    this.root.assertEnabled();
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id)).limit(1);
    if (!row) throw new NotFoundException({ statusCode: 404, code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
    if (row.direction !== 'inbound' || row.transport !== 'file') {
      throw new BadRequestException({ statusCode: 400, code: 'NOT_FILE_CHANNEL', message: 'Only inbound file channels have an error folder' });
    }
    return row;
  }
}
