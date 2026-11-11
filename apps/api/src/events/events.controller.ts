import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { MessageSummary } from '@ackwell/schemas';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppEvents, type AppEventMap } from '../common/events.js';
import { ZodPipe } from '../common/zod.js';

const eventsQuerySchema = z.object({ channelId: z.uuid().optional() });

export const SSE_HEARTBEAT_MS = 15_000;

/**
 * Server-sent events. Session-cookie auth comes from the global SessionGuard (the check runs
 * before the stream opens, so an unauthenticated request gets a normal 401 JSON response).
 */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: AppEvents) {}

  @Get()
  @ApiOperation({
    summary: 'Live event stream (text/event-stream)',
    description:
      'Named events: `message` (data = MessageSummary JSON; created or changed status) and ' +
      '`channel.status` (data = {channelId, status, error?}). A `: ping` comment is sent every 15 s. ' +
      'With `channelId`, only that channel\'s `message` events are sent; `channel.status` is always sent.',
  })
  @ApiQuery({ name: 'channelId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiProduces('text/event-stream')
  stream(
    @Query(new ZodPipe(eventsQuerySchema)) query: z.infer<typeof eventsQuerySchema>,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', // no-transform: keeps proxies/compression from buffering
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMessage = (m: MessageSummary) => {
      if (query.channelId && m.channelId !== query.channelId) return;
      send('message', m);
    };
    const onStatus = (s: AppEventMap['channel.status'][0]) => send('channel.status', s);

    this.events.on('message', onMessage);
    this.events.on('channel.status', onStatus);
    res.write('retry: 3000\n: connected\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      this.events.off('message', onMessage);
      this.events.off('channel.status', onStatus);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }
}

