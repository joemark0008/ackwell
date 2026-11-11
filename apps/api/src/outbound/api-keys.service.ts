import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiKey, NewApiKey } from '@ackwell/schemas';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../db/db.js';
import { apiKeys, channels, type ApiKeyRow } from '../db/schema.js';

export const API_KEY_PREFIX = 'ak_';

/** Per-channel API keys for POST /channels/:id/send. Stored as SHA-256; the key is returned once. */
@Injectable()
export class ApiKeysService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(channelId: string): Promise<ApiKey[]> {
    await this.assertChannel(channelId);
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.channelId, channelId))
      .orderBy(desc(apiKeys.createdAt))
      .limit(50);
    return rows.map(toPublic);
  }

  async create(channelId: string, label: string): Promise<NewApiKey> {
    await this.assertChannel(channelId);
    const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
    const [row] = await this.db
      .insert(apiKeys)
      .values({ channelId, label, keyHash: hashKey(key), keyPrefix: key.slice(0, API_KEY_PREFIX.length + 8) })
      .returning();
    return { ...toPublic(row!), key };
  }

  async revoke(channelId: string, id: string): Promise<ApiKey> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.channelId, channelId), isNull(apiKeys.revokedAt)))
      .returning();
    if (!row) throw new NotFoundException({ statusCode: 404, code: 'API_KEY_NOT_FOUND', message: 'Active key not found' });
    return toPublic(row);
  }

  /** Resolves a bearer key for the channel; updates `lastUsedAt`. Null when unknown/revoked/wrong channel. */
  async authenticate(channelId: string, key: string): Promise<ApiKeyRow | null> {
    if (!key.startsWith(API_KEY_PREFIX)) return null;
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashKey(key)), eq(apiKeys.channelId, channelId), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row) return null;
    void this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {});
    return row;
  }

  private async assertChannel(channelId: string): Promise<void> {
    const [row] = await this.db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!row) throw new NotFoundException({ statusCode: 404, code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
  }
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function toPublic(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    channelId: row.channelId,
    label: row.label,
    prefix: row.keyPrefix,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
