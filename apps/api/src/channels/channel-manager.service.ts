import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Channel, ChannelStatus, InboundConfig, InboundFileConfig, OutboundFileConfig } from '@ackwell/schemas';
import { eq, inArray } from 'drizzle-orm';
import { AppEvents } from '../common/events.js';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.js';
import { channels, type ChannelRow } from '../db/schema.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { FileRootError, FileRootService, STAGING_DIR } from '../files/file-root.service.js';
import { InboundFileWatcher } from '../files/inbound-file-watcher.js';
import { toChannel } from './channels.service.js';
import { FileImportService } from './file-import.service.js';
import { InboundListener } from './inbound-listener.js';

/**
 * Owns the runtime side of channels: one MLLP listener per running inbound MLLP channel, one folder
 * watcher per running inbound file channel.
 *
 * - `start` / `stop` are called by the API; the channel row's `status` mirrors the runtime state.
 * - On boot every channel that was `running` is started again (status `error` if its port is gone).
 * - On shutdown listeners are closed, but statuses are left as `running` so the next boot restores them.
 * - Outbound channels have no listener; starting one flips its status (file channels first check their folder).
 * - A file watcher whose folder becomes unreachable sets the channel to `error` and back to `running` when the
 *   folder is reachable again.
 */
@Injectable()
export class ChannelManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(ChannelManager.name);
  private readonly listeners = new Map<string, InboundListener>();
  private readonly watchers = new Map<string, InboundFileWatcher>();
  private readonly busy = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly messages: MessagesService,
    private readonly events: AppEvents,
    private readonly metrics: MetricsService,
    private readonly files: FileRootService,
    private readonly fileImport: FileImportService,
  ) {}

  isRunning(channelId: string): boolean {
    return this.listeners.has(channelId) || this.watchers.has(channelId);
  }

  /** Channel ids with a live listener or folder watcher (inbound) — for health/metrics. */
  get runningIds(): string[] {
    return [...this.listeners.keys(), ...this.watchers.keys()];
  }

  /** The live watcher of an inbound file channel (tests use it to trigger a rescan). */
  watcher(channelId: string): InboundFileWatcher | undefined {
    return this.watchers.get(channelId);
  }

  async start(id: string): Promise<Channel> {
    const row = await this.getRow(id);
    if (row.direction === 'inbound' && this.isRunning(id)) return toChannel(await this.setStatus(id, 'running'));
    if (row.direction === 'outbound' && row.status === 'running') return toChannel(row);
    return this.withLock(id, async () => {
      if (row.direction === 'inbound' && row.transport === 'file') await this.startWatcher(row);
      else if (row.direction === 'inbound') await this.startListener(row);
      else if (row.transport === 'file') await this.checkOutboundFolder(row);
      return toChannel(await this.setStatus(id, 'running'));
    });
  }

  async stop(id: string): Promise<Channel> {
    const row = await this.getRow(id);
    return this.withLock(id, async () => {
      await this.closeListener(id);
      await this.closeWatcher(id);
      return toChannel(await this.setStatus(id, 'stopped'));
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const rows = (await this.db.select().from(channels).where(inArray(channels.status, ['running']))).filter(
      (r) => r.direction === 'inbound', // outbound channels have no listener; their status is enough
    );
    for (const row of rows) {
      try {
        if (row.transport === 'file') await this.startWatcher(row);
        else await this.startListener(row);
      } catch (e) {
        this.log.warn({ channelId: row.id }, `Could not restore listener for "${row.name}": ${(e as Error).message}`);
        await this.setStatus(row.id, 'error');
      }
    }
    if (rows.length) {
      this.log.log(`Restored ${this.listeners.size + this.watchers.size}/${rows.length} running inbound listener(s)/watcher(s)`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const open = [...this.listeners.values(), ...this.watchers.values()];
    this.listeners.clear();
    this.watchers.clear();
    await Promise.allSettled(open.map((l) => l.close()));
    if (open.length) this.log.log(`Closed ${open.length} listener(s)/watcher(s)`);
  }

  // ---- internals ----------------------------------------------------------------------------------

  private async startListener(row: ChannelRow): Promise<void> {
    const cfg = row.config as InboundConfig;
    const listener = new InboundListener(
      {
        port: cfg.port,
        bindAddress: this.env.MLLP_BIND_ADDRESS,
        allowlist: cfg.allowlist,
        name: row.id.slice(0, 8),
        ...(cfg.tls?.enabled && cfg.tls.cert && cfg.tls.key
          ? { tls: { cert: cfg.tls.cert, key: cfg.tls.key, ca: cfg.tls.ca, requestCert: cfg.tls.requestCert } }
          : {}),
      },
      async ({ raw, remoteAddress }) => {
        // Persist first; only a committed row earns an AA. A failed insert → AR (nothing stored).
        let rec;
        try {
          rec = await this.messages.recordInbound(row, raw, remoteAddress);
        } catch (e) {
          this.log.error({ channelId: row.id }, `Could not store inbound message: ${(e as Error).message}`);
          this.metrics.ackFailure(row.id, 'inbound', 'AR');
          return 'AR';
        }
        this.events.emit('message', rec.message);
        if (rec.message.status === 'received') this.metrics.messageReceived(rec.message);
        if (rec.ack !== 'AA') this.metrics.ackFailure(row.id, 'inbound', rec.ack);
        return rec.ack;
      },
      this.log,
    );
    listener.onCrash = (err) => {
      this.listeners.delete(row.id);
      void this.setStatus(row.id, 'error', err.message);
    };
    try {
      await listener.start();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      await this.setStatus(row.id, 'error', err.message);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        throw new ConflictException({
          statusCode: 409,
          code: 'PORT_UNAVAILABLE',
          message: `Port ${cfg.port} is not available on the server (${err.code})`,
        });
      }
      throw new InternalServerErrorException({
        statusCode: 500,
        code: 'LISTENER_ERROR',
        message: `Listener could not start: ${err.message}`,
      });
    }
    this.listeners.set(row.id, listener);
    this.log.log({ channelId: row.id }, `Listening for "${row.name}" on ${this.env.MLLP_BIND_ADDRESS}:${cfg.port}${cfg.tls?.enabled ? ' (TLS)' : ''}`);
  }

  /** Inbound file channel: create/check its folders, then watch the inbound one. */
  private async startWatcher(row: ChannelRow): Promise<void> {
    const cfg = row.config as InboundFileConfig;
    let folders;
    try {
      folders = await this.fileImport.folders(cfg);
    } catch (e) {
      await this.setStatus(row.id, 'error', (e as Error).message);
      throw folderError(e);
    }
    const watcher = new InboundFileWatcher(
      { folder: folders.watch, config: cfg, name: `"${row.name}"` },
      (abs) => this.fileImport.importFile(row, folders, abs),
      this.log,
    );
    watcher.onHealth = (ok, error) => void this.setStatus(row.id, ok ? 'running' : 'error', error);
    await watcher.start();
    this.watchers.set(row.id, watcher);
    this.log.log({ channelId: row.id }, `Watching ${cfg.directory} for "${row.name}" (→ ${cfg.processedDirectory} / ${cfg.errorDirectory})`);
  }

  /** Outbound file channel: the order folder and the staging folder must exist on one filesystem. */
  private async checkOutboundFolder(row: ChannelRow): Promise<void> {
    const cfg = row.config as OutboundFileConfig;
    try {
      const dir = await this.files.resolveFolder(cfg.directory, { create: true });
      const staging = await this.files.resolveFolder(STAGING_DIR, { create: true });
      await this.files.assertSameDevice([
        { rel: cfg.directory, abs: dir },
        { rel: STAGING_DIR, abs: staging },
      ]);
    } catch (e) {
      await this.setStatus(row.id, 'error', (e as Error).message);
      throw folderError(e);
    }
  }

  private async closeWatcher(id: string): Promise<void> {
    const watcher = this.watchers.get(id);
    if (!watcher) return;
    this.watchers.delete(id);
    await watcher.close();
    this.log.log({ channelId: id }, `Stopped watching ${this.files.toRelative(watcher.folder)}`);
  }

  private async closeListener(id: string): Promise<void> {
    const listener = this.listeners.get(id);
    if (!listener) return;
    this.listeners.delete(id);
    await listener.close();
    this.log.log({ channelId: id }, `Stopped listener on :${listener.port}`);
  }

  private async setStatus(id: string, status: ChannelStatus, error?: string): Promise<ChannelRow> {
    const [row] = await this.db.update(channels).set({ status }).where(eq(channels.id, id)).returning();
    this.events.emit('channel.status', { channelId: id, status, ...(error ? { error } : {}) });
    return row!;
  }

  private async getRow(id: string): Promise<ChannelRow> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id)).limit(1);
    if (!row) {
      throw new NotFoundException({ statusCode: 404, code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
    }
    return row;
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) {
      throw new ConflictException({
        statusCode: 409,
        code: 'CHANNEL_BUSY',
        message: 'The channel is already starting or stopping',
      });
    }
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }
}

/** Maps folder problems to API errors: no FILE_ROOT → 400, anything else → 409 FOLDER_UNAVAILABLE. */
function folderError(e: unknown): Error {
  if (e instanceof FileRootError && e.code === 'NO_FILE_ROOT') {
    return new ConflictException({ statusCode: 409, code: 'FILES_DISABLED', message: e.message });
  }
  return new ConflictException({
    statusCode: 409,
    code: 'FOLDER_UNAVAILABLE',
    message: `Folder not usable: ${(e as Error).message}`,
  });
}
