import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let cookie: string;
const http = () => {
  const agent = request(ctx.app.getHttpServer());
  const wrap = (m: 'get' | 'post' | 'delete') => (url: string) => agent[m](url).set('Cookie', cookie);
  return { get: wrap('get'), post: wrap('post'), delete: wrap('delete') };
};

beforeAll(async () => {
  ctx = await startApp({ MLLP_PORT_RANGE: '6045-6050' });
  cookie = await signIn(ctx.app);
});
afterAll(async () => {
  await stopApp(ctx);
});

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

describe('retention', () => {
  let chShort: string;
  let chLong: string;
  const ids: Record<string, string> = {};

  it('registers the hourly schedule and reports status', async () => {
    const { QueueService } = await import('../src/queue/queue.module.js');
    const sched = await ctx.app.get(QueueService).boss.getSchedule('retention');
    expect(sched?.cron).toBe('0 * * * *');
    const s = await http().get('/api/retention').expect(200);
    expect(s.body).toMatchObject({ cron: '0 * * * *', batchSize: 1000, protectedStatuses: ['received', 'queued', 'processing'], lastRun: null });
    expect(s.body.nextRunAt === null || typeof s.body.nextRunAt === 'string').toBe(true);
  });

  it('deletes only expired, finished messages of each channel (attempts cascade)', async () => {
    chShort = (
      await http().post('/api/channels').send({ name: 'Short', direction: 'inbound', retentionDays: 1, config: { port: 6047 }, delivery: { type: 'webhook', url: 'https://x.test/h' } }).expect(201)
    ).body.id;
    chLong = (
      await http().post('/api/channels').send({ name: 'Long', direction: 'outbound', retentionDays: 30, config: { host: 'h', port: 1 } }).expect(201)
    ).body.id;

    const { DB } = await import('../src/db/db.js');
    const { messages, deliveryAttempts } = await import('../src/db/schema.js');
    const db = ctx.app.get(DB);
    const insert = async (key: string, channelId: string, direction: 'inbound' | 'outbound', status: string, createdAt: Date) => {
      const [row] = await db
        .insert(messages)
        .values({ channelId, direction, raw: 'MSH|^~\\&|x', json: null, status: status as never, createdAt })
        .returning({ id: messages.id });
      ids[key] = row!.id;
    };
    // Short channel (1 day): old finished → deleted; old pending → kept; recent → kept.
    await insert('oldDelivered', chShort, 'inbound', 'delivered', daysAgo(2));
    await insert('oldFailed', chShort, 'inbound', 'failed', daysAgo(3));
    await insert('oldReceived', chShort, 'inbound', 'received', daysAgo(5));
    await insert('oldProcessing', chShort, 'inbound', 'processing', daysAgo(5));
    await insert('recentDelivered', chShort, 'inbound', 'delivered', daysAgo(0.5));
    // Long channel (30 days): 2-day-old sent → kept; 31-day-old sent → deleted; 40-day-old queued → kept.
    await insert('longRecentSent', chLong, 'outbound', 'sent', daysAgo(2));
    await insert('longOldSent', chLong, 'outbound', 'sent', daysAgo(31));
    await insert('longOldQueued', chLong, 'outbound', 'queued', daysAgo(40));
    await db.insert(deliveryAttempts).values({ messageId: ids.oldDelivered!, attempt: 1, result: 'success', response: '200' });
    await db.insert(deliveryAttempts).values({ messageId: ids.recentDelivered!, attempt: 1, result: 'success', response: '200' });

    const r = await http().post('/api/retention/run').expect(200);
    expect(r.body.trigger).toBe('manual');
    expect(r.body.deleted).toEqual({ [chShort]: 2, [chLong]: 1 });
    expect(r.body.total).toBe(3);

    const exists = async (key: string) => (await http().get(`/api/messages/${ids[key]}`)).status === 200;
    expect(await exists('oldDelivered')).toBe(false);
    expect(await exists('oldFailed')).toBe(false);
    expect(await exists('longOldSent')).toBe(false);
    expect(await exists('oldReceived')).toBe(true);
    expect(await exists('oldProcessing')).toBe(true);
    expect(await exists('recentDelivered')).toBe(true);
    expect(await exists('longRecentSent')).toBe(true);
    expect(await exists('longOldQueued')).toBe(true);

    const attempts = await db.select().from(deliveryAttempts);
    expect(attempts.map((a: { messageId: string }) => a.messageId)).toEqual([ids.recentDelivered]);

    const s = await http().get('/api/retention').expect(200);
    expect(s.body.lastRun).toMatchObject({ total: 3, trigger: 'manual' });
    // Second run: nothing left to delete.
    expect((await http().post('/api/retention/run').expect(200)).body.total).toBe(0);
  });

  it('deletes in batches when a channel has more expired messages than the batch size', async () => {
    const { DB } = await import('../src/db/db.js');
    const { messages } = await import('../src/db/schema.js');
    const db = ctx.app.get(DB);
    const rows = Array.from({ length: 2350 }, (_, i) => ({
      channelId: chShort,
      direction: 'inbound' as const,
      raw: `MSH|^~\\&|${i}`,
      status: 'delivered' as const,
      createdAt: daysAgo(2 + (i % 7)),
    }));
    for (let i = 0; i < rows.length; i += 500) await db.insert(messages).values(rows.slice(i, i + 500));
    const r = await http().post('/api/retention/run').expect(200);
    expect(r.body.deleted[chShort]).toBe(2350);
    expect((await http().get(`/api/channels/${chShort}/messages`).expect(200)).body.total).toBe(3); // the 3 kept ones
  });

  it('requires a session', async () => {
    await request(ctx.app.getHttpServer()).post('/api/retention/run').expect(401);
    await request(ctx.app.getHttpServer()).get('/api/retention').expect(401);
  });
});
