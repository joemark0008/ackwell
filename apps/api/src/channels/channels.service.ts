import { ConflictException, Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  createChannelSchema,
  isPortInRange,
  type Channel,
  type CreateChannel,
  type UpdateChannel,
} from '@ackwell/schemas';
import { asc, eq } from 'drizzle-orm';
import { ENV, type Env } from '../config/env.js';
import { validationError } from '../common/zod.js';
import { DB, pgError, type Db } from '../db/db.js';
import { channels, type ChannelRow } from '../db/schema.js';

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(): Promise<Channel[]> {
    const rows = await this.db.select().from(channels).orderBy(asc(channels.name));
    return rows.map(toChannel);
  }

  async get(id: string): Promise<Channel> {
    return toChannel(await this.getRow(id));
  }

  async create(input: CreateChannel): Promise<Channel> {
    this.assertPortInRange(input);
    try {
      const [row] = await this.db
        .insert(channels)
        .values({
          name: input.name,
          direction: input.direction,
          hl7Version: input.hl7Version,
          retentionDays: input.retentionDays ?? this.env.RETENTION_DEFAULT_DAYS,
          config: input.config,
          delivery: input.direction === 'inbound' ? input.delivery : null,
        })
        .returning();
      return toChannel(row!);
    } catch (e) {
      throw mapUniqueViolation(e);
    }
  }

  async update(id: string, patch: UpdateChannel): Promise<Channel> {
    const row = await this.getRow(id);
    const changesRuntime =
      patch.config !== undefined || patch.delivery !== undefined || patch.hl7Version !== undefined;
    if (row.status === 'running' && changesRuntime) {
      throw new ConflictException({
        statusCode: 409,
        code: 'CHANNEL_RUNNING',
        message: 'Stop the channel before changing its config, delivery or HL7 version',
      });
    }

    // Re-validate the merged channel with the full create schema (applies defaults too).
    const merged = {
      name: patch.name ?? row.name,
      direction: row.direction,
      hl7Version: patch.hl7Version ?? row.hl7Version,
      retentionDays: patch.retentionDays ?? row.retentionDays,
      config: patch.config ?? row.config,
      ...(row.direction === 'inbound' ? { delivery: patch.delivery ?? row.delivery } : {}),
    };
    if (row.direction === 'outbound' && patch.delivery) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Outbound channels have no delivery',
      });
    }
    const parsed = createChannelSchema.safeParse(merged);
    if (!parsed.success) throw validationError(parsed.error);
    const next = parsed.data;
    this.assertPortInRange(next);

    try {
      const [updated] = await this.db
        .update(channels)
        .set({
          name: next.name,
          hl7Version: next.hl7Version,
          retentionDays: next.retentionDays ?? row.retentionDays,
          config: next.config,
          delivery: next.direction === 'inbound' ? next.delivery : null,
        })
        .where(eq(channels.id, id))
        .returning();
      return toChannel(updated!);
    } catch (e) {
      throw mapUniqueViolation(e);
    }
  }

  async remove(id: string): Promise<void> {
    const row = await this.getRow(id);
    if (row.status === 'running') {
      throw new ConflictException({
        statusCode: 409,
        code: 'CHANNEL_RUNNING',
        message: 'Stop the channel before deleting it',
      });
    }
    await this.db.delete(channels).where(eq(channels.id, id));
  }

  private async getRow(id: string): Promise<ChannelRow> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id)).limit(1);
    if (!row) {
      throw new NotFoundException({ statusCode: 404, code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
    }
    return row;
  }

  private assertPortInRange(input: CreateChannel): void {
    if (input.direction !== 'inbound') return;
    const range = this.env.MLLP_PORT_RANGE;
    if (!isPortInRange(input.config.port, range)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PORT_OUT_OF_RANGE',
        message: `Inbound port must be within ${range.from}-${range.to}`,
      });
    }
  }
}

function mapUniqueViolation(e: unknown): unknown {
  const pg = pgError(e);
  if (pg?.code !== '23505') return e;
  if (pg.constraint === 'channels_inbound_port_unique') {
    return new ConflictException({
      statusCode: 409,
      code: 'PORT_IN_USE',
      message: 'Another inbound channel already uses this port',
    });
  }
  if (pg.constraint === 'channels_name_unique') {
    return new ConflictException({ statusCode: 409, code: 'NAME_TAKEN', message: 'Channel name already exists' });
  }
  return new ConflictException({ statusCode: 409, code: 'CONFLICT', message: 'Duplicate value' });
}

export function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    status: row.status,
    hl7Version: row.hl7Version as Channel['hl7Version'],
    retentionDays: row.retentionDays,
    config: row.config,
    delivery: row.delivery ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
