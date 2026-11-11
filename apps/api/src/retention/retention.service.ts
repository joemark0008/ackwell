import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { RETENTION_PROTECTED_STATUSES, type RetentionRun, type RetentionStatus } from '@ackwell/schemas';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.js';
import { channels } from '../db/schema.js';
import { QueueService } from '../queue/queue.module.js';

export const RETENTION_QUEUE = 'retention';
/** Top of every hour, UTC. */
export const RETENTION_CRON = '0 * * * *';
export const RETENTION_BATCH = 1000;

/**
 * Deletes messages (and, by cascade, their delivery attempts) older than each channel's
 * `retentionDays`. Runs hourly through a pg-boss schedule (singleton queue: never two runs at once)
 * and on demand via POST /api/retention/run.
 *
 * Messages still `received` / `queued` / `processing` (pending delivery, send or retry) are never
 * deleted, whatever their age. Deletes go in batches of RETENTION_BATCH per channel so the table
 * lock stays short.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap {
  private readonly log = new Logger(RetentionService.name);
  private lastRun: RetentionRun | null = null;
  private running: Promise<RetentionRun> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queue: QueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.ensureQueue(RETENTION_QUEUE, { policy: 'singleton', retryLimit: 2, retryDelay: 60, expireInSeconds: 3600 });
    await this.queue.boss.schedule(RETENTION_QUEUE, RETENTION_CRON, {}, { tz: 'UTC' });
    await this.queue.boss.work(RETENTION_QUEUE, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
      await this.run('schedule');
    });
    this.log.log(`Retention schedule "${RETENTION_CRON}" (UTC) registered`);
  }

  async status(): Promise<RetentionStatus> {
    let nextRunAt: string | null = null;
    try {
      const [next] = this.queue.boss.previewSchedule(RETENTION_CRON, { tz: 'UTC', count: 1 });
      nextRunAt = next?.toISOString() ?? null;
    } catch {
      /* preview unavailable: leave null */
    }
    return {
      cron: RETENTION_CRON,
      batchSize: RETENTION_BATCH,
      protectedStatuses: [...RETENTION_PROTECTED_STATUSES],
      lastRun: this.lastRun,
      nextRunAt,
    };
  }

  /** Runs a cleanup now. Concurrent calls share the in-flight run. */
  run(trigger: RetentionRun['trigger'] = 'manual'): Promise<RetentionRun> {
    if (this.running) return this.running;
    this.running = this.execute(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async execute(trigger: RetentionRun['trigger']): Promise<RetentionRun> {
    const started = new Date();
    const deleted: Record<string, number> = {};
    const rows = await this.db.select({ id: channels.id, name: channels.name, days: channels.retentionDays }).from(channels);
    for (const ch of rows) {
      const cutoff = new Date(started.getTime() - ch.days * 86_400_000);
      let n = 0;
      for (;;) {
        const batch = await this.deleteBatch(ch.id, cutoff);
        n += batch;
        if (batch < RETENTION_BATCH) break;
      }
      if (n > 0) {
        deleted[ch.id] = n;
        this.log.log({ channelId: ch.id }, `Retention: deleted ${n} message(s) of "${ch.name}" older than ${ch.days} day(s)`);
      }
    }
    const finished = new Date();
    const run: RetentionRun = {
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      deleted,
      total: Object.values(deleted).reduce((a, b) => a + b, 0),
      trigger,
    };
    this.lastRun = run;
    if (run.total === 0) this.log.debug(`Retention (${trigger}): nothing to delete`);
    return run;
  }

  private async deleteBatch(channelId: string, cutoff: Date): Promise<number> {
    const protectedList = sql.join(
      RETENTION_PROTECTED_STATUSES.map((s) => sql`${s}::message_status`),
      sql`, `,
    );
    const res = await this.db.execute(sql`
      delete from messages where id in (
        select id from messages
        where channel_id = ${channelId}
          and created_at < ${cutoff}
          and status not in (${protectedList})
        order by created_at
        limit ${RETENTION_BATCH}
      )`);
    return res.rowCount ?? 0;
  }
}
