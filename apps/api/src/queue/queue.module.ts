import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ENV, type Env } from '../config/env.js';

/**
 * pg-boss on the app's Postgres (schema `pgboss`, created/migrated by pg-boss on start).
 * Started in `onModuleInit` so every module's `onApplicationBootstrap` can register queues and workers.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(QueueService.name);
  readonly boss: PgBoss;
  private started = false;

  constructor(@Inject(ENV) env: Env) {
    this.boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: 'pgboss',
      max: 4,
      application_name: 'ackwell-queue',
    } as ConstructorParameters<typeof PgBoss>[0]);
    this.boss.on('error', (err) => this.log.error(`pg-boss: ${(err as Error).message}`));
  }

  get isRunning(): boolean {
    return this.started;
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    this.started = true;
    this.log.log('pg-boss started (schema pgboss)');
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    // Graceful: let active jobs finish (up to the timeout) before closing the pool.
    await this.boss.stop({ graceful: true, timeout: 15_000 });
    this.log.log('pg-boss stopped');
  }

  /** Creates the queue if it does not exist, otherwise applies the options (the policy is fixed at creation). */
  async ensureQueue(name: string, options: NonNullable<Parameters<PgBoss['createQueue']>[1]>): Promise<void> {
    const existing = await this.boss.getQueue(name);
    if (!existing) {
      await this.boss.createQueue(name, options);
      return;
    }
    const { policy: _fixed, ...updatable } = options;
    await this.boss.updateQueue(name, updatable);
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
