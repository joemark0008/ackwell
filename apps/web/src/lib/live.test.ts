import type { Channel, MessageList, MessageSummary } from '@ackwell/schemas';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLiveRows, getLiveStatus, overlayLiveRows } from './live-state';
import { startLiveEvents } from './live';
import { keys } from './queries';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '33333333-3333-4333-8333-333333333333';

const msg = (id: string, over: Partial<MessageSummary> = {}): MessageSummary => ({
  id,
  channelId: C1,
  direction: 'inbound',
  status: 'received',
  messageType: 'ORU^R01',
  controlId: 'MSG1',
  ackCode: 'AA',
  error: null,
  remoteAddress: null,
  sourceFile: null,
  createdAt: '2026-11-11T12:00:00Z',
  updatedAt: '2026-11-11T12:00:00Z',
  ...over,
});

class FakeSource {
  static instances: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeSource.instances.push(this);
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.forEach((fn) => fn({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const page = (items: MessageSummary[], total: number) => ({ pages: [{ items, nextCursor: null, total } satisfies MessageList], pageParams: [undefined] });

let qc: QueryClient;
let stop: () => void;
const start = (checkAuth = async () => true) =>
  (stop = startLiveEvents(qc, { createSource: (u) => new FakeSource(u) as unknown as EventSource, checkAuth, minDelayMs: 10 }));

beforeEach(() => {
  FakeSource.instances = [];
  forgetLiveRows();
  qc = new QueryClient();
});
afterEach(() => stop?.());

describe('startLiveEvents', () => {
  it('reports live once open and off after stop', () => {
    start();
    expect(FakeSource.instances[0]!.url).toBe('/api/events');
    FakeSource.instances[0]!.open();
    expect(getLiveStatus()).toBe('live');
    stop();
    expect(getLiveStatus()).toBe('off');
    expect(FakeSource.instances[0]!.closed).toBe(true);
  });

  it('inserts a new message at the top of matching cached lists only', () => {
    const old = msg('a1111111-1111-4111-8111-111111111111', { createdAt: '2026-11-11T11:00:00Z' });
    qc.setQueryData(keys.messages(C1, {}), page([old], 1));
    qc.setQueryData(keys.messages(C1, { status: 'failed' }), page([], 0));
    qc.setQueryData(keys.messages(C2, {}), page([], 0));
    qc.setQueryData(keys.allMessages({}), page([old], 1));
    qc.setQueryData(keys.allMessages({ direction: 'outbound' }), page([], 0));
    start();
    const fresh = msg('b2222222-2222-4222-8222-222222222222');
    FakeSource.instances[0]!.emit('message', fresh);

    const get = (k: readonly unknown[]) => (qc.getQueryData(k) as ReturnType<typeof page>).pages[0]!;
    expect(get(keys.messages(C1, {})).items.map((i) => i.id)).toEqual([fresh.id, old.id]);
    expect(get(keys.messages(C1, {})).total).toBe(2);
    expect(get(keys.allMessages({})).items[0]!.id).toBe(fresh.id);
    expect(get(keys.messages(C1, { status: 'failed' })).items).toHaveLength(0); // status filter mismatch
    expect(get(keys.messages(C2, {})).items).toHaveLength(0); // other channel
    expect(get(keys.allMessages({ direction: 'outbound' })).items).toHaveLength(0);
  });

  it('replaces an existing row on a status change without changing total', () => {
    const row = msg('a1111111-1111-4111-8111-111111111111', { status: 'queued', ackCode: null });
    qc.setQueryData(keys.allMessages({}), page([row], 1));
    start();
    FakeSource.instances[0]!.emit('message', { ...row, status: 'sent', ackCode: 'AA' });
    const p = (qc.getQueryData(keys.allMessages({})) as ReturnType<typeof page>).pages[0]!;
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ status: 'sent', ackCode: 'AA' });
    expect(p.total).toBe(1);
  });

  it('keeps a newer streamed row when a list fetched earlier resolves later', () => {
    start();
    FakeSource.instances[0]!.open();
    const row = msg('m1', { direction: 'outbound', status: 'processing', ackCode: null, updatedAt: '2026-11-11T12:00:01Z' });
    const sent = { ...row, status: 'sent' as const, ackCode: 'AA', updatedAt: '2026-11-11T12:00:02Z' };
    FakeSource.instances[0]!.emit('message', sent);
    // A GET that started before the ACK comes back with the stale status → the streamed row wins.
    expect(overlayLiveRows([row, msg('m2')])).toEqual([sent, msg('m2')]);
    // A fetched row that is newer than the streamed one is kept as fetched.
    const newer = { ...row, status: 'failed' as const, updatedAt: '2026-11-11T12:00:03Z' };
    const out = [newer];
    expect(overlayLiveRows(out)).toBe(out);
  });

  it('patches channel status in the list and detail caches', () => {
    const ch = { id: C1, name: 'x', status: 'stopped' } as Channel;
    qc.setQueryData(keys.channels, [ch]);
    qc.setQueryData(keys.channel(C1), ch);
    start();
    FakeSource.instances[0]!.emit('channel.status', { channelId: C1, status: 'running' });
    expect((qc.getQueryData(keys.channels) as Channel[])[0]!.status).toBe('running');
    expect((qc.getQueryData(keys.channel(C1)) as Channel).status).toBe('running');
  });

  it('reconnects with backoff after the browser gives up', async () => {
    start();
    const first = FakeSource.instances[0]!;
    first.close();
    first.onerror?.();
    expect(getLiveStatus()).toBe('reconnecting');
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(2));
    FakeSource.instances[1]!.open();
    expect(getLiveStatus()).toBe('live');
  });

  it('invalidates message lists and channels after a reconnect, not on first connect', () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    start();
    FakeSource.instances[0]!.open();
    expect(spy).not.toHaveBeenCalled();
    FakeSource.instances[0]!.onerror?.(); // browser-level retry: readyState stays CONNECTING
    expect(getLiveStatus()).toBe('reconnecting');
    FakeSource.instances[0]!.open();
    const keysCalled = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown }).queryKey));
    expect(keysCalled).toEqual(expect.arrayContaining([JSON.stringify(['channels']), JSON.stringify(['messages', 'all'])]));
    expect(getLiveStatus()).toBe('live');
  });

  it('stops on 401', async () => {
    start(async () => false);
    const first = FakeSource.instances[0]!;
    first.close();
    first.onerror?.();
    await vi.waitFor(() => expect(getLiveStatus()).toBe('off'));
    await new Promise((r) => setTimeout(r, 40));
    expect(FakeSource.instances).toHaveLength(1);
  });
});
