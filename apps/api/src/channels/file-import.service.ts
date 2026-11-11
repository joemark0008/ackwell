import { createHash } from 'node:crypto';
import { access, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { parseHl7, type FileErrorEntry, type InboundFileConfig } from '@ackwell/schemas';
import { and, eq } from 'drizzle-orm';
import { AppEvents } from '../common/events.js';
import { DB, type Db } from '../db/db.js';
import { fileImports, type ChannelRow } from '../db/schema.js';
import { FileRootService } from '../files/file-root.service.js';
import type { FileOutcome } from '../files/inbound-file-watcher.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { MessagesService } from '../messages/messages.service.js';

/** Absolute folders of one inbound file channel. */
export interface InboundFolders {
  watch: string;
  processed: string;
  error: string;
}

const ERROR_SUFFIX = '.error.txt';

/**
 * Inbound file pipeline (docs/PLAN-FILE-TRANSPORT.md §4), one file at a time:
 * finished? → hash → duplicate? → exactly one MSH + parses → store message + import row (one transaction,
 * delivery queued) → move to PROCESSED. Anything invalid → ERROR with `<name>.error.txt`.
 */
@Injectable()
export class FileImportService {
  private readonly log = new Logger(FileImportService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly root: FileRootService,
    private readonly messages: MessagesService,
    private readonly events: AppEvents,
    private readonly metrics: MetricsService,
  ) {}

  /** Resolves (creating when missing) and checks the three folders of a channel. */
  async folders(cfg: InboundFileConfig): Promise<InboundFolders> {
    const watch = await this.root.resolveFolder(cfg.directory, { create: true });
    const processed = await this.root.resolveFolder(cfg.processedDirectory, { create: true });
    const error = await this.root.resolveFolder(cfg.errorDirectory, { create: true });
    await this.root.assertSameDevice([
      { rel: cfg.directory, abs: watch },
      { rel: cfg.processedDirectory, abs: processed },
      { rel: cfg.errorDirectory, abs: error },
    ]);
    return { watch, processed, error };
  }

  async importFile(channel: ChannelRow, folders: InboundFolders, abs: string): Promise<FileOutcome> {
    const cfg = channel.config as InboundFileConfig;
    const name = basename(abs);
    const rel = this.root.toRelative(abs);

    // 1. Finished? (unchanged for stableMs, and unchanged while we read it)
    let before;
    try {
      before = await stat(abs);
    } catch {
      return 'gone';
    }
    if (!before.isFile()) return 'gone';
    if (Date.now() - before.mtimeMs < cfg.stableMs) return 'retry';
    const buf = await readFile(abs);
    const after = await stat(abs).catch(() => null);
    if (!after) return 'gone';
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || buf.length !== after.size) return 'retry';

    const sha256 = createHash('sha256').update(buf).digest('hex');

    // 2. Same content already imported for this channel → just file it away.
    const [dup] = await this.db
      .select({ id: fileImports.id, messageId: fileImports.messageId })
      .from(fileImports)
      .where(and(eq(fileImports.channelId, channel.id), eq(fileImports.sha256, sha256), eq(fileImports.status, 'imported')))
      .limit(1);
    if (dup) {
      const movedTo = await this.moveTo(abs, folders.processed);
      await this.db.insert(fileImports).values({
        channelId: channel.id,
        fileName: rel,
        size: buf.length,
        sha256,
        status: 'duplicate',
        messageId: dup.messageId,
        movedTo,
        error: 'Same content was already imported',
      });
      this.metrics.fileOutcome(channel.id, 'duplicate');
      this.log.log({ channelId: channel.id }, `Duplicate ${rel} moved to ${movedTo} (already imported)`);
      return 'duplicate';
    }

    // 3. One message per file.
    const text = buf.toString(cfg.encoding).replace(/^﻿/, '');
    const segments = text.split(/\r\n|\r|\n/).filter((s) => s.trim() !== '');
    const raw = segments.join('\r');
    const problem = checkOneMessage(segments, raw);
    if (problem) return this.reject(channel, folders, abs, rel, buf.length, sha256, problem);

    // 4. Store (message + import row + delivery job in one transaction), then move.
    const rec = await this.messages.recordInbound(channel, raw, null, {
      sourceFile: rel,
      onInserted: async (tx, row) => {
        await tx.insert(fileImports).values({
          channelId: channel.id,
          fileName: rel,
          size: buf.length,
          sha256,
          status: 'imported',
          messageId: row.id,
        });
      },
    });
    this.events.emit('message', rec.message);
    this.metrics.messageReceived(rec.message);
    this.metrics.fileOutcome(channel.id, 'imported');

    try {
      const movedTo = await this.moveTo(abs, folders.processed);
      await this.db
        .update(fileImports)
        .set({ movedTo })
        .where(and(eq(fileImports.channelId, channel.id), eq(fileImports.sha256, sha256), eq(fileImports.status, 'imported')));
      this.log.log({ channelId: channel.id, messageId: rec.message.id }, `Imported ${rel} → ${movedTo}`);
    } catch (e) {
      // Stored but still in the folder: the next scan sees the same hash and files it as a duplicate.
      this.log.warn({ channelId: channel.id }, `Imported ${rel} but could not move it: ${(e as Error).message}`);
    }
    return 'imported';
  }

  /** Files in the channel's error folder that belong to this channel (from their `.error.txt`). */
  async listErrors(channel: ChannelRow): Promise<FileErrorEntry[]> {
    const cfg = channel.config as InboundFileConfig;
    const dir = await this.root.resolveFolder(cfg.errorDirectory, { create: true });
    const names = (await readdir(dir)).filter((n) => n.endsWith(ERROR_SUFFIX));
    const out: FileErrorEntry[] = [];
    for (const n of names) {
      const note = await readFile(join(dir, n), 'utf8').catch(() => '');
      if (!note.includes(`Channel-Id: ${channel.id}`)) continue;
      const file = n.slice(0, -ERROR_SUFFIX.length);
      const st = await stat(join(dir, file)).catch(() => null);
      if (!st) continue;
      out.push({
        name: file,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        reason: /^Reason: (.*)$/m.exec(note)?.[1] ?? 'Unknown',
      });
    }
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** Moves a file from the error folder back into the watched folder (it is imported again). */
  async retryError(channel: ChannelRow, name: string): Promise<string> {
    const cfg = channel.config as InboundFileConfig;
    if (name !== basename(name) || name.startsWith('.') || name.endsWith(ERROR_SUFFIX)) throw new Error('Invalid file name');
    const errorDir = await this.root.resolveFolder(cfg.errorDirectory);
    const note = await readFile(join(errorDir, name + ERROR_SUFFIX), 'utf8').catch(() => '');
    if (!note.includes(`Channel-Id: ${channel.id}`)) throw new Error(`${name} is not an error file of this channel`);
    const watch = await this.root.resolveFolder(cfg.directory, { create: true });
    const movedTo = await this.moveTo(join(errorDir, name), watch);
    await unlink(join(errorDir, name + ERROR_SUFFIX)).catch(() => undefined);
    this.log.log({ channelId: channel.id }, `Retry: ${cfg.errorDirectory}/${name} moved back to ${movedTo}`);
    return movedTo;
  }

  private async reject(
    channel: ChannelRow,
    folders: InboundFolders,
    abs: string,
    rel: string,
    size: number,
    sha256: string,
    reason: string,
  ): Promise<FileOutcome> {
    const movedTo = await this.moveTo(abs, folders.error);
    const note = [
      `File: ${rel}`,
      `Reason: ${reason}`,
      `Channel: ${channel.name}`,
      `Channel-Id: ${channel.id}`,
      `Time: ${new Date().toISOString()}`,
      '',
      'Fix the file and use Retry on the channel page (or move it back into the watched folder).',
      '',
    ].join('\n');
    await writeFile(join(folders.error, basename(movedTo) + ERROR_SUFFIX), note, 'utf8');
    await this.db.insert(fileImports).values({ channelId: channel.id, fileName: rel, size, sha256, status: 'error', movedTo, error: reason });
    this.metrics.fileOutcome(channel.id, 'error');
    this.log.warn({ channelId: channel.id }, `Rejected ${rel} → ${movedTo}: ${reason}`);
    return 'error';
  }

  /** Atomic move into `dir`, keeping the name or adding `_1`, `_2`… Returns the new path relative to the root. */
  private async moveTo(abs: string, dir: string): Promise<string> {
    const name = basename(abs);
    const ext = extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 0; i < 1000; i++) {
      const target = join(dir, i === 0 ? name : `${base}_${i}${ext}`);
      const taken = await access(target).then(
        () => true,
        () => false,
      );
      if (taken) continue;
      await rename(abs, target);
      return this.root.toRelative(target);
    }
    throw new Error(`No free name for ${name} in ${this.root.toRelative(dir)}`);
  }
}

/** One message per file: null when OK, otherwise the reason. */
export function checkOneMessage(segments: string[], raw: string): string | null {
  if (!segments.length) return 'The file is empty';
  const msh = segments.filter((s) => s.startsWith('MSH')).length;
  if (msh === 0) return 'No MSH segment: this is not an HL7 v2 message';
  if (msh > 1) return `The file holds ${msh} messages (MSH segments); one message per file is expected`;
  if (!segments[0]!.startsWith('MSH')) return `The file must start with MSH (found ${segments[0]!.slice(0, 3)})`;
  try {
    parseHl7(raw);
  } catch (e) {
    return `Not valid HL7: ${(e as Error).message}`;
  }
  return null;
}
