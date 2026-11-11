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
import type { Channel, ChannelStatus, InboundConfig } from '@ackwell/schemas';
import { eq, inArray } from 'drizzle-orm';
import { AppEvents } from '../common/events.js';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.js';
import { channels, type ChannelRow } from '../db/schema.js';
import { MessagesService } from '../messages/messages.service.js';
import { toChannel } from './channels.service.js';
import { InboundListener } from './inbound-listener.js';

/**
 * Owns the runtime side of channels: one MLLP listener per running inbound channel.
 *
 * - `start` / `stop` are called by the API; the channel row's `status` mirrors the runtime state.
 * - On boot every channel that was `running` is started again (status `error` if its port is gone).
 * - On shutdown listeners are closed, but statuses are left as `running` so the next boot restores them.
 * - Outbound channels have no listener; starting one only flips its status (the send worker arrives in Phase 3).
 */
@Injectable()
export class ChannelManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(ChannelManager.name);
  private readonly listeners = new Map<string, InboundListener>();
  private readonly busy = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly messages: MessagesService,
    private readonly events: AppEvents,
  ) {}

  isRunning(channelId: string): boolean {
    return this.listeners.has(channelId);
  }

  /** Channel ids with a live listener (inbound) — for health/metrics. */
  get runningIds(): string[] {
    return [...this.listeners.keys()];
  }

  async start(id: string): Promise<Channel> {
    const row = await this.getRow(id);
    if (row.direction === 'inbound' && this.listeners.has(id)) return toChannel(await this.setStatus(id, 'running'));
    if (row.direction === 'outbound' && row.status === 'running') return toChannel(row);
    return this.withLock(id, async () => {
      if (row.direction === 'inbound') await this.startListener(row);
      return toChannel(await this.setStatus(id, 'running'));
    });
  }

  async stop(id: string): Promise<Channel> {
    const row = await this.getRow(id);
    return this.withLock(id, async () => {
      await this.closeListener(id);
      return toChannel(await this.setStatus(id, 'stopped'));
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.db.select().from(channels).where(inArray(channels.status, ['running']));
    for (const row of rows) {
      if (row.direction !== 'inbound') continue;
      try {
        await this.startListener(row);
      } catch (e) {
        this.log.warn({ channelId: row.id }, `Could not restore listener for "${row.name}": ${(e as Error).message}`);
        await this.setStatus(row.id, 'error');
      }
    }
    if (rows.length) this.log.log(`Restored ${this.listeners.size}/${rows.length} running channel(s)`);
  }

  async onApplicationShutdown(): Promise<void> {
    const open = [...this.listeners.entries()];
    this.listeners.clear();
    await Promise.allSettled(open.map(([, l]) => l.close()));
    if (open.length) this.log.log(`Closed ${open.length} listener(s)`);
  }

  // ---- internals ----------------------------------------------------------------------------------

  private async startListener(row: ChannelRow): Promise<void> {
    const cfg = row.config as InboundConfig;
    const listener = new InboundListener(
      { port: cfg.port, bindAddress: this.env.MLLP_BIND_ADDRESS, allowlist: cfg.allowlist, name: row.id.slice(0, 8) },
      async ({ raw, remoteAddress }) => {
        // Persist first; only a committed row earns an AA. A failed insert → AR (nothing stored).
        let rec;
        try {
          rec = await this.messages.recordInbound(row, raw, remoteAddress);
        } catch (e) {
          this.log.error({ channelId: row.id }, `Could not store inbound message: ${(e as Error).message}`);
          return 'AR';
        }
        this.events.emit('message', rec.message);
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
    this.log.log({ channelId: row.id }, `Listening for "${row.name}" on ${this.env.MLLP_BIND_ADDRESS}:${cfg.port}`);
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
