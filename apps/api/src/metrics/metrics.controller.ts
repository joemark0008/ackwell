import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Header, Inject, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator.js';
import { ENV, type Env } from '../config/env.js';
import { MetricsService } from './metrics.service.js';

/** `GET /metrics` (no /api prefix). Open unless METRICS_TOKEN is set, then `Authorization: Bearer <token>`. */
@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Req() req: Request): Promise<string> {
    const token = this.env.METRICS_TOKEN;
    if (token) {
      const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const a = Buffer.from(given);
      const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new UnauthorizedException({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Metrics token required' });
      }
    }
    return this.metrics.scrape();
  }
}
