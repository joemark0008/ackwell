import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_HEADERS } from '@ackwell/schemas';

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com/):
 *
 *   webhook-id:        <message id>  (receiver's idempotency key)
 *   webhook-timestamp: <unix seconds>
 *   webhook-signature: v1,<base64 HMAC-SHA256>  [v1,<second secret> …]
 *
 * Signed content is `${id}.${timestamp}.${body}`. The secret is `whsec_` + base64(32 random bytes);
 * the HMAC key is the decoded bytes. Receivers verify with a constant-time compare and reject
 * timestamps outside a tolerance window (5 minutes here) to block replays.
 */

export const SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64');
}

export function secretKey(secret: string): Buffer {
  const b64 = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(b64, 'base64');
}

export function sign(secret: string, id: string, timestamp: number, body: string): string {
  return createHmac('sha256', secretKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
}

/** Headers for one delivery, signed with every active secret (two during a rotation). */
export function signedHeaders(
  id: string,
  body: string,
  secrets: readonly string[],
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  if (!secrets.length) throw new Error('No webhook secret to sign with');
  return {
    [WEBHOOK_HEADERS.id]: id,
    [WEBHOOK_HEADERS.timestamp]: String(timestamp),
    [WEBHOOK_HEADERS.signature]: secrets.map((s) => `v1,${sign(s, id, timestamp, body)}`).join(' '),
  };
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing_headers' | 'timestamp' | 'signature' };

/**
 * Receiver-side verification (used by tests and documented for integrators).
 * `headers` keys are matched case-insensitively.
 */
export function verify(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  secrets: readonly string[],
  opts: { toleranceSeconds?: number; now?: number } = {},
): VerifyResult {
  const get = (name: string) => {
    const v = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = get(WEBHOOK_HEADERS.id);
  const ts = get(WEBHOOK_HEADERS.timestamp);
  const sigHeader = get(WEBHOOK_HEADERS.signature);
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_headers' };

  const timestamp = Number(ts);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > tolerance) return { ok: false, reason: 'timestamp' };

  const presented = sigHeader
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .map((s) => Buffer.from(s.slice(3), 'base64'));
  for (const secret of secrets) {
    const expected = Buffer.from(sign(secret, id, timestamp, body), 'base64');
    if (presented.some((p) => p.length === expected.length && timingSafeEqual(p, expected))) return { ok: true };
  }
  return { ok: false, reason: 'signature' };
}
