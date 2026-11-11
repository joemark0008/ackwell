import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { NewWebhookSecret, WebhookSecret } from '@ackwell/schemas';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../db/db.js';
import { channels, webhookSecrets, type WebhookSecretRow } from '../db/schema.js';
import { generateSecret } from './standard-webhooks.js';

/** Anything that can run Drizzle queries: the db or a transaction. */
type Executor = Pick<Db, 'select' | 'insert' | 'update'>;

/**
 * Webhook signing secrets per inbound channel. At most two are active at a time: rotating creates a
 * new one and keeps only the previous newest active, so receivers can switch without downtime.
 * The secret value is returned exactly once (create/rotate) and never logged.
 */
@Injectable()
export class WebhookSecretsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Active secrets, newest first (the signing order). */
  async activeSecrets(channelId: string): Promise<string[]> {
    const rows = await this.db
      .select({ secret: webhookSecrets.secret })
      .from(webhookSecrets)
      .where(and(eq(webhookSecrets.channelId, channelId), isNull(webhookSecrets.revokedAt)))
      .orderBy(desc(webhookSecrets.createdAt));
    return rows.map((r) => r.secret);
  }

  async list(channelId: string): Promise<WebhookSecret[]> {
    await this.assertChannel(channelId);
    const rows = await this.db
      .select()
      .from(webhookSecrets)
      .where(eq(webhookSecrets.channelId, channelId))
      .orderBy(desc(webhookSecrets.createdAt))
      .limit(20);
    return rows.map(toPublic);
  }

  /** First secret for a new inbound channel (inside the channel's insert transaction). */
  async createInitial(channelId: string, tx: Executor = this.db): Promise<NewWebhookSecret> {
    const [row] = await tx.insert(webhookSecrets).values({ channelId, secret: generateSecret() }).returning();
    return { ...toPublic(row!), secret: row!.secret };
  }

  /** New secret; keeps the previous newest active, revokes anything older. */
  async rotate(channelId: string): Promise<NewWebhookSecret> {
    await this.assertChannel(channelId);
    return this.db.transaction(async (tx) => {
      const active = await tx
        .select({ id: webhookSecrets.id })
        .from(webhookSecrets)
        .where(and(eq(webhookSecrets.channelId, channelId), isNull(webhookSecrets.revokedAt)))
        .orderBy(desc(webhookSecrets.createdAt));
      for (const old of active.slice(1)) {
        await tx.update(webhookSecrets).set({ revokedAt: new Date() }).where(eq(webhookSecrets.id, old.id));
      }
      return this.createInitial(channelId, tx);
    });
  }

  async revoke(channelId: string, id: string): Promise<WebhookSecret> {
    const [row] = await this.db
      .update(webhookSecrets)
      .set({ revokedAt: new Date() })
      .where(and(eq(webhookSecrets.id, id), eq(webhookSecrets.channelId, channelId), isNull(webhookSecrets.revokedAt)))
      .returning();
    if (!row) {
      throw new NotFoundException({ statusCode: 404, code: 'SECRET_NOT_FOUND', message: 'Active secret not found' });
    }
    return toPublic(row);
  }

  private async assertChannel(channelId: string): Promise<void> {
    const [row] = await this.db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!row) {
      throw new NotFoundException({ statusCode: 404, code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
    }
  }
}

function toPublic(row: WebhookSecretRow): WebhookSecret {
  return {
    id: row.id,
    channelId: row.channelId,
    hint: row.secret.slice(-4),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
