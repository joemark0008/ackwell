import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../auth/public.decorator.js';
import { DB, type Db } from '../db/db.js';
import { QueueService } from '../queue/queue.module.js';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queue: QueueService,
  ) {}

  @Get()
  async check() {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'unavailable', queue: this.queue.isRunning ? 'ok' : 'stopped' });
    }
    if (!this.queue.isRunning) {
      throw new ServiceUnavailableException({ status: 'error', db: 'ok', queue: 'stopped' });
    }
    return { status: 'ok', db: 'ok', queue: 'ok' };
  }
}
