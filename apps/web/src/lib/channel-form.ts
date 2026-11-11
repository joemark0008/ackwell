import {
  createChannelSchema,
  type Channel,
  type ChannelDirection,
  type CreateChannelInput,
  type Hl7Version,
} from '@ackwell/schemas';
import type { FieldErrors, Resolver } from 'react-hook-form';
import { ApiError } from './api';

/**
 * Flat form model. Field names mirror the API paths (`config.port`, `delivery.url`, …) so Zod
 * issues and server 400/409 errors map straight onto inputs.
 */
export interface ChannelFormValues {
  name: string;
  direction: ChannelDirection;
  hl7Version: Hl7Version;
  retentionDays: string; // '' = server default
  config: {
    port: string;
    host: string;
    tlsEnabled: boolean;
    allowlistText: string; // one IP/CIDR per line
    ackTimeoutMs: string;
    retryMaxAttempts: string;
    retryBackoffSeconds: string;
  };
  delivery: {
    url: string;
    timeoutMs: string;
    maxAttempts: string;
  };
}

export function emptyForm(direction: ChannelDirection, suggestedPort?: number): ChannelFormValues {
  return {
    name: '',
    direction,
    hl7Version: '2.5.1',
    retentionDays: '',
    config: {
      port: direction === 'inbound' && suggestedPort ? String(suggestedPort) : direction === 'outbound' ? '2575' : '',
      host: '',
      tlsEnabled: false,
      allowlistText: '',
      ackTimeoutMs: '30000',
      retryMaxAttempts: '5',
      retryBackoffSeconds: '10',
    },
    delivery: { url: '', timeoutMs: '10000', maxAttempts: '10' },
  };
}

export function formFromChannel(ch: Channel): ChannelFormValues {
  const f = emptyForm(ch.direction);
  f.name = ch.name;
  f.hl7Version = ch.hl7Version;
  f.retentionDays = String(ch.retentionDays);
  const c = ch.config as Record<string, unknown>;
  f.config.port = String(c.port ?? '');
  f.config.tlsEnabled = Boolean((c.tls as { enabled?: boolean } | undefined)?.enabled);
  if (ch.direction === 'inbound') {
    f.config.allowlistText = ((c.allowlist as string[] | undefined) ?? []).join('\n');
    if (ch.delivery) {
      f.delivery = {
        url: ch.delivery.url,
        timeoutMs: String(ch.delivery.timeoutMs),
        maxAttempts: String(ch.delivery.maxAttempts),
      };
    }
  } else {
    f.config.host = String(c.host ?? '');
    f.config.ackTimeoutMs = String(c.ackTimeoutMs ?? '');
    const retry = c.retry as { maxAttempts?: number; backoffSeconds?: number } | undefined;
    f.config.retryMaxAttempts = String(retry?.maxAttempts ?? '');
    f.config.retryBackoffSeconds = String(retry?.backoffSeconds ?? '');
  }
  return f;
}

/** '' → undefined, numeric strings → numbers, anything else passes through for Zod to reject. */
const num = (v: string): number | string | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
};

export function toPayload(v: ChannelFormValues): CreateChannelInput {
  const tls = { enabled: v.config.tlsEnabled };
  const base = {
    name: v.name,
    hl7Version: v.hl7Version,
    ...(num(v.retentionDays) !== undefined ? { retentionDays: num(v.retentionDays) } : {}),
  };
  if (v.direction === 'inbound') {
    return {
      ...base,
      direction: 'inbound',
      config: {
        port: num(v.config.port),
        tls,
        allowlist: v.config.allowlistText
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      delivery: {
        type: 'webhook',
        url: v.delivery.url.trim(),
        timeoutMs: num(v.delivery.timeoutMs),
        maxAttempts: num(v.delivery.maxAttempts),
      },
    } as CreateChannelInput;
  }
  return {
    ...base,
    direction: 'outbound',
    config: {
      host: v.config.host.trim(),
      port: num(v.config.port),
      tls,
      ackTimeoutMs: num(v.config.ackTimeoutMs),
      retry: { maxAttempts: num(v.config.retryMaxAttempts), backoffSeconds: num(v.config.retryBackoffSeconds) },
    },
  } as CreateChannelInput;
}

/** API path → form field name. */
export function fieldForPath(path: string): string {
  if (path.startsWith('config.allowlist')) return 'config.allowlistText';
  if (path === 'config.tls.enabled' || path === 'config.tls') return 'config.tlsEnabled';
  if (path === 'config.retry.maxAttempts') return 'config.retryMaxAttempts';
  if (path === 'config.retry.backoffSeconds') return 'config.retryBackoffSeconds';
  return path;
}

const friendly = (msg: string) =>
  msg
    .replace(/^Invalid input: expected number, received (string|undefined)$/, 'Enter a number')
    .replace(/^Invalid input: expected string, received undefined$/, 'Required')
    .replace(/^Too small: expected string to have >=1 characters$/, 'Required')
    .replace(/^Too small: expected number to be >=(\d+)$/, 'Must be at least $1')
    .replace(/^Too big: expected number to be <=(\d+)$/, 'Must be at most $1')
    .replace(/^Invalid URL$/, 'Enter a valid http(s) URL');

/** RHF resolver backed by the shared API schema (same rules the server enforces). */
export const channelResolver: Resolver<ChannelFormValues> = async (values) => {
  const r = createChannelSchema.safeParse(toPayload(values));
  if (r.success) return { values, errors: {} };
  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of r.error.issues) {
    const field = fieldForPath(issue.path.join('.'));
    errors[field] ??= { type: issue.code, message: friendly(issue.message) };
  }
  return { values: {}, errors: nest(errors) as FieldErrors<ChannelFormValues> };
};

/** {'config.port': e} → {config: {port: e}} for RHF. */
function nest(flat: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split('.');
    let cur = out;
    parts.slice(0, -1).forEach((p) => {
      cur = (cur[p] ??= {}) as Record<string, unknown>;
    });
    cur[parts[parts.length - 1]!] = v;
  }
  return out;
}

/** Server error → field errors (or a form-level message). */
export function serverErrors(e: unknown): { fields: Record<string, string>; form?: string } {
  if (!(e instanceof ApiError)) return { fields: {}, form: 'Something went wrong. Try again.' };
  switch (e.code) {
    case 'PORT_IN_USE':
      return { fields: { 'config.port': 'Another inbound channel already listens on this port' } };
    case 'PORT_OUT_OF_RANGE':
      return { fields: { 'config.port': e.body?.message ?? 'Port outside the allowed range' } };
    case 'NAME_TAKEN':
      return { fields: { name: 'A channel with this name already exists' } };
    case 'CHANNEL_RUNNING':
      return { fields: {}, form: 'Stop the channel before changing its connection settings.' };
    case 'VALIDATION_ERROR':
      return {
        fields: Object.fromEntries((e.body?.issues ?? []).map((i) => [fieldForPath(i.path), friendly(i.message)])),
        form: e.body?.issues?.length ? undefined : e.message,
      };
    default:
      return { fields: {}, form: e.message };
  }
}

/** Lowest free port in the range, ignoring the channel being edited. */
export function nextFreePort(range: { from: number; to: number }, channels: Channel[], exceptId?: string) {
  const used = new Set(
    channels
      .filter((c) => c.direction === 'inbound' && c.id !== exceptId)
      .map((c) => (c.config as { port: number }).port),
  );
  for (let p = range.from; p <= range.to; p++) if (!used.has(p)) return p;
  return undefined;
}
