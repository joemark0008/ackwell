import { describe, expect, it } from 'vitest';
import { generateSecret, secretKey, sign, signedHeaders, verify } from './standard-webhooks.js';

const body = JSON.stringify({ id: 'm1', raw: 'MSH|^~\\&|A' });
const id = '11111111-1111-4111-8111-111111111111';

describe('standard webhooks', () => {
  it('generates whsec_ secrets with 32 random bytes', () => {
    const s = generateSecret();
    expect(s.startsWith('whsec_')).toBe(true);
    expect(secretKey(s)).toHaveLength(32);
    expect(generateSecret()).not.toBe(s);
  });

  it('signs and verifies', () => {
    const secret = generateSecret();
    const now = 1_762_800_000;
    const headers = signedHeaders(id, body, [secret], now);
    expect(headers['webhook-id']).toBe(id);
    expect(headers['webhook-timestamp']).toBe(String(now));
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
    expect(verify(headers, body, [secret], { now })).toEqual({ ok: true });
    // Header lookup is case-insensitive (Node lower-cases incoming headers).
    const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]));
    expect(verify(upper, body, [secret], { now })).toEqual({ ok: true });
  });

  it('matches the reference HMAC construction', () => {
    const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
    const ts = 1700000000;
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const expected = createHmac('sha256', Buffer.alloc(32, 7)).update(`${id}.${ts}.${body}`).digest('base64');
    expect(sign(secret, id, ts, body)).toBe(expected);
  });

  it('rejects a tampered body, a wrong secret, and missing headers', () => {
    const secret = generateSecret();
    const now = 1_762_800_000;
    const headers = signedHeaders(id, body, [secret], now);
    expect(verify(headers, body + ' ', [secret], { now })).toEqual({ ok: false, reason: 'signature' });
    expect(verify(headers, body, [generateSecret()], { now })).toEqual({ ok: false, reason: 'signature' });
    expect(verify({ ...headers, 'webhook-id': 'other' }, body, [secret], { now })).toEqual({ ok: false, reason: 'signature' });
    expect(verify({}, body, [secret], { now })).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects timestamps outside the replay window', () => {
    const secret = generateSecret();
    const now = 1_762_800_000;
    const headers = signedHeaders(id, body, [secret], now - 301);
    expect(verify(headers, body, [secret], { now })).toEqual({ ok: false, reason: 'timestamp' });
    expect(verify(headers, body, [secret], { now, toleranceSeconds: 400 })).toEqual({ ok: true });
    const future = signedHeaders(id, body, [secret], now + 301);
    expect(verify(future, body, [secret], { now })).toEqual({ ok: false, reason: 'timestamp' });
  });

  it('sends both signatures during a rotation so either secret verifies', () => {
    const oldSecret = generateSecret();
    const newSecret = generateSecret();
    const now = 1_762_800_000;
    const headers = signedHeaders(id, body, [newSecret, oldSecret], now);
    expect(headers['webhook-signature']!.split(' ')).toHaveLength(2);
    expect(verify(headers, body, [oldSecret], { now })).toEqual({ ok: true });
    expect(verify(headers, body, [newSecret], { now })).toEqual({ ok: true });
    expect(verify(headers, body, [generateSecret()], { now })).toEqual({ ok: false, reason: 'signature' });
    expect(() => signedHeaders(id, body, [])).toThrow(/No webhook secret/);
  });
});
