import type { Channel } from '@ackwell/schemas';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { channelResolver, emptyForm, formFromChannel, nextFreePort, serverErrors, toPayload } from './channel-form';

const resolve = (v: ReturnType<typeof emptyForm>) =>
  channelResolver(v, undefined, { fields: {}, shouldUseNativeValidation: false });

describe('channel form', () => {
  it('builds an inbound payload: numbers, allowlist lines, default retention omitted', () => {
    const f = emptyForm('inbound', 6101);
    f.name = 'Lab in';
    f.config.allowlistText = '10.0.0.0/8\n\n 192.168.1.5 ';
    f.delivery.url = 'https://x.test/hook';
    expect(toPayload(f)).toEqual({
      name: 'Lab in',
      hl7Version: '2.5.1',
      direction: 'inbound',
      config: { port: 6101, tls: { enabled: false }, allowlist: ['10.0.0.0/8', '192.168.1.5'] },
      delivery: { type: 'webhook', url: 'https://x.test/hook', timeoutMs: 10000, maxAttempts: 10 },
    });
  });

  it('maps schema issues onto form fields', async () => {
    const f = emptyForm('inbound', 6101);
    f.config.allowlistText = 'not-an-ip';
    f.config.port = 'abc';
    const r = await resolve(f);
    const e = r.errors as Record<string, any>;
    expect(e.name.message).toBe('Required');
    expect(e.config.port.message).toBe('Enter a number');
    expect(e.config.allowlistText).toBeDefined();
    expect(e.delivery.url).toBeDefined();
  });

  it('accepts a valid outbound form', async () => {
    const f = emptyForm('outbound');
    f.name = 'Orders out';
    f.config.host = 'lis.local';
    const r = await resolve(f);
    expect(r.errors).toEqual({});
  });

  it('round-trips a stored channel back into the form', () => {
    const ch: Channel = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Out',
      direction: 'outbound',
      status: 'stopped',
      hl7Version: '2.3',
      retentionDays: 30,
      config: { host: 'h', port: 2575, tls: { enabled: true }, ackTimeoutMs: 5000, retry: { maxAttempts: 3, backoffSeconds: 20 } },
      delivery: null,
      createdAt: '',
      updatedAt: '',
    };
    const f = formFromChannel(ch);
    expect(f.config).toMatchObject({ host: 'h', port: '2575', tlsEnabled: true, retryMaxAttempts: '3', retryBackoffSeconds: '20' });
    expect(toPayload(f)).toMatchObject({ retentionDays: 30, config: { retry: { maxAttempts: 3, backoffSeconds: 20 } } });
  });

  it('suggests the lowest free inbound port, ignoring the channel being edited', () => {
    const mk = (id: string, port: number) => ({ id, direction: 'inbound', config: { port } }) as unknown as Channel;
    const list = [mk('a', 6100), mk('b', 6101)];
    expect(nextFreePort({ from: 6100, to: 6150 }, list)).toBe(6102);
    expect(nextFreePort({ from: 6100, to: 6150 }, list, 'a')).toBe(6100);
    expect(nextFreePort({ from: 6100, to: 6101 }, list)).toBeUndefined();
  });

  it('maps server conflicts to fields', () => {
    expect(serverErrors(new ApiError(409, { code: 'PORT_IN_USE' })).fields['config.port']).toMatch(/already listens/);
    expect(serverErrors(new ApiError(409, { code: 'NAME_TAKEN' })).fields.name).toMatch(/already exists/);
    expect(serverErrors(new ApiError(400, { code: 'VALIDATION_ERROR', issues: [{ path: 'config.allowlist.0', message: 'bad' }] })).fields).toEqual({
      'config.allowlistText': 'bad',
    });
  });
});
