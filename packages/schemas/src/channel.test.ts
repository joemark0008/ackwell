import { describe, expect, it } from 'vitest';
import { createChannelSchema, updateChannelSchema } from './channel';
import { isPortInRange, parsePortRange } from './port-range';

const inbound = {
  name: 'Lab results in',
  direction: 'inbound',
  config: { port: 6001, allowlist: ['10.0.0.0/8', '192.168.1.20'] },
  delivery: { type: 'webhook', url: 'https://example.test/hook' },
};

const outbound = {
  name: 'Orders to LIS',
  direction: 'outbound',
  hl7Version: '2.3',
  config: { host: 'lis.local', port: 2575 },
};

describe('createChannelSchema', () => {
  it('accepts an inbound channel and applies defaults', () => {
    const r = createChannelSchema.parse(inbound);
    expect(r.hl7Version).toBe('2.5.1');
    expect(r.direction === 'inbound' && r.config.tls.enabled).toBe(false);
    expect(r.direction === 'inbound' && r.delivery.timeoutMs).toBe(10_000);
  });

  it('accepts an outbound channel and applies retry defaults', () => {
    const r = createChannelSchema.parse(outbound);
    expect(r.direction === 'outbound' && r.config.retry).toEqual({ maxAttempts: 5, backoffSeconds: 10 });
  });

  it('rejects an inbound channel without delivery', () => {
    const { delivery: _d, ...rest } = inbound;
    expect(createChannelSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects unknown fields, bad IPs, bad ports and bad versions', () => {
    expect(createChannelSchema.safeParse({ ...inbound, extra: 1 }).success).toBe(false);
    expect(createChannelSchema.safeParse({ ...inbound, config: { port: 6001, allowlist: ['not-an-ip'] } }).success).toBe(false);
    expect(createChannelSchema.safeParse({ ...outbound, config: { host: 'x', port: 70000 } }).success).toBe(false);
    expect(createChannelSchema.safeParse({ ...outbound, hl7Version: '3.0' }).success).toBe(false);
    expect(createChannelSchema.safeParse({ ...inbound, delivery: { type: 'webhook', url: 'ftp://x' } }).success).toBe(false);
  });

  it('update schema rejects a direction change', () => {
    expect(updateChannelSchema.safeParse({ direction: 'outbound' }).success).toBe(false);
  });
});

describe('port range', () => {
  it('parses ranges and single ports', () => {
    expect(parsePortRange('6000-6050')).toEqual({ from: 6000, to: 6050 });
    expect(parsePortRange('7000')).toEqual({ from: 7000, to: 7000 });
    expect(isPortInRange(6050, parsePortRange('6000-6050'))).toBe(true);
    expect(isPortInRange(6051, parsePortRange('6000-6050'))).toBe(false);
  });
  it('rejects bad ranges', () => {
    expect(() => parsePortRange('6050-6000')).toThrow();
    expect(() => parsePortRange('abc')).toThrow();
    expect(() => parsePortRange('0-10')).toThrow();
  });
});

describe('tls config', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
  const key = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
  const ch = (tls: unknown) => ({ ...inbound, config: { port: 6001, tls } });

  it('requires cert and key when enabled', () => {
    expect(createChannelSchema.safeParse(ch({ enabled: true })).success).toBe(false);
    expect(createChannelSchema.safeParse(ch({ enabled: true, cert: pem })).success).toBe(false);
    expect(createChannelSchema.safeParse(ch({ enabled: true, cert: pem, key })).success).toBe(true);
    expect(createChannelSchema.safeParse(ch({ enabled: false })).success).toBe(true);
  });
  it('rejects non-PEM text and requestCert without ca', () => {
    expect(createChannelSchema.safeParse(ch({ enabled: true, cert: 'x', key })).success).toBe(false);
    expect(createChannelSchema.safeParse(ch({ enabled: true, cert: pem, key, requestCert: true })).success).toBe(false);
    expect(createChannelSchema.safeParse(ch({ enabled: true, cert: pem, key, requestCert: true, ca: pem })).success).toBe(true);
  });
  it('outbound tls defaults rejectUnauthorized to false', () => {
    const r = createChannelSchema.parse({ name: 'o', direction: 'outbound', config: { host: 'h', port: 1, tls: { enabled: true } } });
    expect(r.direction === 'outbound' && r.config.tls).toEqual({ enabled: true, rejectUnauthorized: false });
  });
});

describe('global message query', () => {
  it('adds channelId and direction', async () => {
    const { globalMessageListQuerySchema } = await import('./message');
    expect(globalMessageListQuerySchema.parse({ direction: 'inbound' }).limit).toBe(50);
    expect(globalMessageListQuerySchema.safeParse({ channelId: 'x' }).success).toBe(false);
  });
});
