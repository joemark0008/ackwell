import {
  createChannelSchema,
  type Channel,
  type ChannelDirection,
  type ChannelTransport,
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
  /** MLLP (network) or shared-folder files; fixed after creation. */
  transport: ChannelTransport;
  hl7Version: Hl7Version;
  retentionDays: string; // '' = server default
  config: {
    port: string;
    host: string;
    tlsEnabled: boolean;
    tlsCert: string; // inbound PEM
    tlsKey: string; // inbound PEM; empty on edit = keep the stored key
    tlsCa: string; // PEM, optional
    tlsRequestCert: boolean; // inbound: verify client certs (needs CA)
    tlsRejectUnauthorized: boolean; // outbound
    tlsHasKey: boolean; // a key is already stored (edit); never holds the key itself
    allowlistText: string; // one IP/CIDR per line
    ackTimeoutMs: string;
    retryMaxAttempts: string;
    retryBackoffSeconds: string;
    // ---- file transport ----
    directory: string; // inbound: watched (RESULT); outbound: order folder (ORDER)
    processedDirectory: string;
    errorDirectory: string;
    includeText: string; // comma/line separated patterns
    stableMs: string;
    usePolling: boolean;
    pollIntervalMs: string;
    fileName: string;
    segmentSeparator: 'CR' | 'CRLF' | 'LF';
    encoding: 'utf8' | 'latin1';
    onExists: 'suffix' | 'fail';
  };
  delivery: {
    url: string;
    timeoutMs: string;
    maxAttempts: string;
    payload: 'both' | 'typed' | 'lossless';
  };
}

export function emptyForm(direction: ChannelDirection, suggestedPort?: number, transport: ChannelTransport = 'mllp'): ChannelFormValues {
  return {
    name: '',
    direction,
    transport,
    hl7Version: '2.5.1',
    retentionDays: '',
    config: {
      port: direction === 'inbound' && suggestedPort ? String(suggestedPort) : direction === 'outbound' ? '2575' : '',
      host: '',
      tlsEnabled: false,
      tlsCert: '',
      tlsKey: '',
      tlsCa: '',
      tlsRequestCert: false,
      tlsRejectUnauthorized: false,
      tlsHasKey: false,
      allowlistText: '',
      ackTimeoutMs: '30000',
      retryMaxAttempts: '5',
      retryBackoffSeconds: '10',
      directory: direction === 'inbound' ? 'RESULT' : 'ORDER',
      processedDirectory: 'PROCESSED',
      errorDirectory: 'ERROR',
      includeText: '*.hl7',
      stableMs: '2000',
      usePolling: true,
      pollIntervalMs: '2000',
      fileName: '{messageType}_{controlId}.hl7',
      segmentSeparator: 'CR',
      encoding: 'utf8',
      onExists: 'suffix',
    },
    delivery: { url: '', timeoutMs: '10000', maxAttempts: '10', payload: 'both' },
  };
}

export function formFromChannel(ch: Channel): ChannelFormValues {
  const f = emptyForm(ch.direction, undefined, ch.transport);
  f.name = ch.name;
  f.hl7Version = ch.hl7Version;
  f.retentionDays = String(ch.retentionDays);
  const c = ch.config as Record<string, unknown>;
  if (ch.transport === 'file') {
    const str = (k: string) => (c[k] === undefined ? f.config[k as 'directory'] : String(c[k]));
    f.config.directory = str('directory');
    f.config.processedDirectory = str('processedDirectory');
    f.config.errorDirectory = str('errorDirectory');
    f.config.includeText = ((c.include as string[] | undefined) ?? ['*.hl7']).join(', ');
    f.config.stableMs = str('stableMs');
    f.config.pollIntervalMs = str('pollIntervalMs');
    f.config.usePolling = c.usePolling === undefined ? true : Boolean(c.usePolling);
    f.config.fileName = str('fileName');
    f.config.segmentSeparator = (c.segmentSeparator as ChannelFormValues['config']['segmentSeparator']) ?? 'CR';
    f.config.encoding = (c.encoding as ChannelFormValues['config']['encoding']) ?? 'utf8';
    f.config.onExists = (c.onExists as ChannelFormValues['config']['onExists']) ?? 'suffix';
    const retry = c.retry as { maxAttempts?: number; backoffSeconds?: number } | undefined;
    f.config.retryMaxAttempts = String(retry?.maxAttempts ?? '5');
    f.config.retryBackoffSeconds = String(retry?.backoffSeconds ?? '10');
    if (ch.direction === 'inbound' && ch.delivery) {
      f.delivery = { url: ch.delivery.url, timeoutMs: String(ch.delivery.timeoutMs), maxAttempts: String(ch.delivery.maxAttempts), payload: ch.delivery.payload ?? 'both' };
    }
    return f;
  }
  f.config.port = String(c.port ?? '');
  const tls = (c.tls ?? {}) as {
    enabled?: boolean;
    cert?: string;
    ca?: string;
    requestCert?: boolean;
    hasKey?: boolean;
    rejectUnauthorized?: boolean;
  };
  f.config.tlsEnabled = Boolean(tls.enabled);
  f.config.tlsCert = tls.cert ?? '';
  f.config.tlsCa = tls.ca ?? '';
  f.config.tlsRequestCert = Boolean(tls.requestCert);
  f.config.tlsRejectUnauthorized = Boolean(tls.rejectUnauthorized);
  f.config.tlsHasKey = Boolean(tls.hasKey);
  if (ch.direction === 'inbound') {
    f.config.allowlistText = ((c.allowlist as string[] | undefined) ?? []).join('\n');
    if (ch.delivery) {
      f.delivery = {
        url: ch.delivery.url,
        timeoutMs: String(ch.delivery.timeoutMs),
        maxAttempts: String(ch.delivery.maxAttempts),
        payload: ch.delivery.payload ?? 'both',
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

/** TLS block per direction. Off stays `{ enabled: false }`; the key is sent only when typed. */
function tlsPayload(v: ChannelFormValues) {
  const c = v.config;
  if (!c.tlsEnabled) return { enabled: false };
  const ca = c.tlsCa.trim();
  if (v.direction === 'outbound') {
    return { enabled: true, ...(ca ? { ca } : {}), rejectUnauthorized: c.tlsRejectUnauthorized };
  }
  const cert = c.tlsCert.trim();
  const key = c.tlsKey.trim();
  return {
    enabled: true,
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    ...(ca ? { ca } : {}),
    requestCert: c.tlsRequestCert,
  };
}

export function toPayload(v: ChannelFormValues): CreateChannelInput {
  const tls = tlsPayload(v);
  const base = {
    name: v.name,
    hl7Version: v.hl7Version,
    ...(num(v.retentionDays) !== undefined ? { retentionDays: num(v.retentionDays) } : {}),
  };
  const delivery = {
    type: 'webhook',
    url: v.delivery.url.trim(),
    timeoutMs: num(v.delivery.timeoutMs),
    maxAttempts: num(v.delivery.maxAttempts),
    payload: v.delivery.payload,
  };
  if (v.transport === 'file') {
    const c = v.config;
    if (v.direction === 'inbound') {
      return {
        ...base,
        direction: 'inbound',
        transport: 'file',
        config: {
          directory: c.directory.trim(),
          processedDirectory: c.processedDirectory.trim(),
          errorDirectory: c.errorDirectory.trim(),
          include: c.includeText
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
          stableMs: num(c.stableMs),
          usePolling: c.usePolling,
          pollIntervalMs: num(c.pollIntervalMs),
          encoding: c.encoding,
        },
        delivery,
      } as CreateChannelInput;
    }
    return {
      ...base,
      direction: 'outbound',
      transport: 'file',
      config: {
        directory: c.directory.trim(),
        fileName: c.fileName.trim(),
        segmentSeparator: c.segmentSeparator,
        encoding: c.encoding,
        onExists: c.onExists,
        retry: { maxAttempts: num(c.retryMaxAttempts), backoffSeconds: num(c.retryBackoffSeconds) },
      },
    } as CreateChannelInput;
  }
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
      delivery,
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
  if (path.startsWith('config.include')) return 'config.includeText';
  if (path === 'config.tls.enabled' || path === 'config.tls') return 'config.tlsEnabled';
  if (path === 'config.tls.cert') return 'config.tlsCert';
  if (path === 'config.tls.key') return 'config.tlsKey';
  if (path === 'config.tls.ca') return 'config.tlsCa';
  if (path === 'config.tls.requestCert') return 'config.tlsRequestCert';
  if (path === 'config.tls.rejectUnauthorized') return 'config.tlsRejectUnauthorized';
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

const KEY_PLACEHOLDER = '-----BEGIN PRIVATE KEY-----\nstored\n-----END PRIVATE KEY-----';

/** RHF resolver backed by the shared API schema (same rules the server enforces). */
export const channelResolver: Resolver<ChannelFormValues> = async (values) => {
  const payload = toPayload(values) as { direction: string; config: { tls?: Record<string, unknown> } };
  // Edit with a stored key and no new key typed: the API keeps it, so validate as if present.
  if (payload.direction === 'inbound' && payload.config.tls?.enabled && !payload.config.tls.key && values.config.tlsHasKey) {
    payload.config.tls = { ...payload.config.tls, key: KEY_PLACEHOLDER };
  }
  const r = createChannelSchema.safeParse(payload);
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
    case 'FOLDER_IN_USE':
      return { fields: { 'config.directory': 'Another inbound file channel already watches this folder' } };
    case 'FILES_DISABLED':
      return { fields: {}, form: e.message };
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
      .filter((c) => c.direction === 'inbound' && c.transport !== 'file' && c.id !== exceptId)
      .map((c) => (c.config as { port: number }).port),
  );
  for (let p = range.from; p <= range.to; p++) if (!used.has(p)) return p;
  return undefined;
}
