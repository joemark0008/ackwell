import { z } from 'zod';

/** HL7 v2 versions a channel can be configured for. */
export const HL7_VERSIONS = ['2.1', '2.2', '2.3', '2.3.1', '2.4', '2.5', '2.5.1', '2.6', '2.7', '2.7.1', '2.8'] as const;
export const hl7VersionSchema = z.enum(HL7_VERSIONS);

export const channelDirectionSchema = z.enum(['inbound', 'outbound']);
export const channelStatusSchema = z.enum(['stopped', 'running', 'error']);
/** How a channel connects: MLLP over TCP (default) or `.hl7` files in a shared folder (see docs/PLAN-FILE-TRANSPORT.md). */
export const channelTransportSchema = z.enum(['mllp', 'file']);

const portSchema = z.number().int().min(1).max(65535);

/** An IPv4/IPv6 address or CIDR range. */
export const allowlistEntrySchema = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

const pemSchema = z
  .string()
  .max(50_000)
  .refine((v) => /-----BEGIN [A-Z0-9 ]+-----[\s\S]*-----END [A-Z0-9 ]+-----/.test(v), 'Must be a PEM block');

/**
 * TLS for an inbound listener (write shape). When `enabled`, `cert` and `key` (PEM) are required.
 * `ca` + `requestCert` turn on client-certificate verification. PATCH may omit `key` to keep the stored one.
 */
export const inboundTlsSchema = z
  .object({
    enabled: z.boolean().default(false),
    cert: pemSchema.optional(),
    key: pemSchema.optional(),
    ca: pemSchema.optional(),
    requestCert: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.enabled) return;
    if (!v.cert) ctx.addIssue({ code: 'custom', path: ['cert'], message: 'Certificate (PEM) is required when TLS is enabled' });
    if (!v.key) ctx.addIssue({ code: 'custom', path: ['key'], message: 'Private key (PEM) is required when TLS is enabled' });
    if (v.requestCert && !v.ca) {
      ctx.addIssue({ code: 'custom', path: ['ca'], message: 'A CA (PEM) is required to verify client certificates' });
    }
  });

/** Inbound TLS as returned by the API: the private key is never returned, `hasKey` says whether one is stored. */
export const inboundTlsResponseSchema = z
  .object({
    enabled: z.boolean(),
    cert: z.string().optional(),
    ca: z.string().optional(),
    requestCert: z.boolean().optional(),
    hasKey: z.boolean().optional(),
  })
  .strict();

/** TLS for outbound connections. `rejectUnauthorized` defaults to false (self-signed receivers on the LAN). */
export const outboundTlsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Optional CA PEM that signed the receiver's certificate. */
    ca: pemSchema.optional(),
    rejectUnauthorized: z.boolean().default(false),
  })
  .strict();

/** @deprecated use inboundTlsSchema / outboundTlsSchema */
export const tlsConfigSchema = inboundTlsSchema;

export const inboundConfigSchema = z
  .object({
    /** Listen port; must also be inside the server's MLLP_PORT_RANGE (checked by the API). */
    port: portSchema,
    tls: inboundTlsSchema.default({ enabled: false, requestCert: false }),
    /** Empty list = accept any source IP. */
    allowlist: z.array(allowlistEntrySchema).max(100).default([]),
  })
  .strict();

/** Inbound config as returned by the API (no private key). */
export const inboundConfigResponseSchema = z
  .object({
    port: portSchema,
    tls: inboundTlsResponseSchema,
    allowlist: z.array(allowlistEntrySchema),
  })
  .strict();

export const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(100).default(5),
    backoffSeconds: z.number().int().min(1).max(3600).default(10),
  })
  .strict();

export const outboundConfigSchema = z
  .object({
    host: z.string().trim().min(1).max(255),
    port: portSchema,
    tls: outboundTlsSchema.default({ enabled: false, rejectUnauthorized: false }),
    ackTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
    retry: retryPolicySchema.default({ maxAttempts: 5, backoffSeconds: 10 }),
  })
  .strict();

// ---- File transport ---------------------------------------------------------------------------------

/**
 * A folder inside the server's shared root (`FILE_ROOT`): relative, `/`-separated, no `..`, no hidden
 * segments. The API additionally resolves symlinks and refuses anything that lands outside the root.
 */
export const relativeFolderSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(isSafeRelativeFolder, 'Use a folder inside the shared root, e.g. RESULT or lab/RESULT (no "..", no leading "/")');

export function isSafeRelativeFolder(v: string): boolean {
  if (v.startsWith('/') || v.includes('\\') || v.includes(':') || v.includes('\0')) return false;
  return v.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.startsWith('.') && /^[\w .()-]+$/.test(seg));
}

/** Tokens allowed in an outbound file name pattern. */
export const FILE_NAME_TOKENS = ['messageType', 'trigger', 'controlId', 'timestamp', 'date', 'seq', 'id'] as const;
export type FileNameToken = (typeof FILE_NAME_TOKENS)[number];

/** Presets offered by the UI; any pattern passing `fileNamePatternSchema` is allowed. */
export const FILE_NAME_PRESETS = [
  '{messageType}_{controlId}.hl7',
  '{controlId}.hl7',
  '{messageType}_{trigger}_{timestamp}_{controlId}.hl7',
  '{date}_{seq}.hl7',
] as const;

const FORBIDDEN_FILE_CHARS = /[\/\\:*?"<>|\u0000-\u001f]/;

/**
 * File name pattern: literal text plus `{token}`s; must end in an extension (`.hl7`) and, once filled in,
 * be a plain file name (no folders, no characters Windows/SMB refuse, not hidden).
 */
export const fileNamePatternSchema = z
  .string()
  .trim()
  .min(5)
  .max(150)
  .superRefine((v, ctx) => {
    const unknown = [...v.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!).filter((t) => !(FILE_NAME_TOKENS as readonly string[]).includes(t));
    if (unknown.length) {
      ctx.addIssue({ code: 'custom', message: `Unknown token {${unknown[0]}}; use ${FILE_NAME_TOKENS.map((t) => `{${t}}`).join(' ')}` });
      return;
    }
    const literal = v.replace(/\{[^}]*\}/g, 'x');
    if (/[{}]/.test(literal) || FORBIDDEN_FILE_CHARS.test(literal)) {
      ctx.addIssue({ code: 'custom', message: 'File names cannot contain / \\ : * ? " < > | or unmatched braces' });
    } else if (literal.startsWith('.')) {
      ctx.addIssue({ code: 'custom', message: 'File names cannot start with "." (hidden file)' });
    } else if (!/\.[A-Za-z0-9]{1,10}$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'End the pattern with an extension, e.g. .hl7' });
    }
  });

/** Simple include patterns for inbound files: `*` and `?` wildcards only, e.g. `*.hl7`. */
export const includePatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[\w.*?() -]+$/, 'Use a simple pattern such as *.hl7 (only * and ? wildcards)');

/** Case-insensitive match of a file name against `*` / `?` patterns. */
export function matchesInclude(fileName: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return re.test(fileName);
  });
}

export const segmentSeparatorSchema = z.enum(['CR', 'CRLF', 'LF']);
export const SEGMENT_SEPARATORS: Record<z.infer<typeof segmentSeparatorSchema>, string> = { CR: '\r', CRLF: '\r\n', LF: '\n' };
export const fileEncodingSchema = z.enum(['utf8', 'latin1']);

/** Outbound over files: each message is written as one finished file into `directory` (atomic rename). */
export const outboundFileConfigSchema = z
  .object({
    directory: relativeFolderSchema.default('ORDER'),
    fileName: fileNamePatternSchema.default('{messageType}_{controlId}.hl7'),
    segmentSeparator: segmentSeparatorSchema.default('CR'),
    encoding: fileEncodingSchema.default('utf8'),
    /** When the name is taken: `suffix` writes `name_1.hl7`, `_2`…; `fail` fails the message. Never overwrites. */
    onExists: z.enum(['suffix', 'fail']).default('suffix'),
    retry: retryPolicySchema.default({ maxAttempts: 5, backoffSeconds: 10 }),
  })
  .strict();

/** Inbound over files: watch `directory`, import one message per file, move it to processed / error. */
export const inboundFileConfigSchema = z
  .object({
    directory: relativeFolderSchema.default('RESULT'),
    processedDirectory: relativeFolderSchema.default('PROCESSED'),
    errorDirectory: relativeFolderSchema.default('ERROR'),
    include: z.array(includePatternSchema).min(1).max(10).default(['*.hl7']),
    /** A file is read only after its size and mtime have not changed for this long. */
    stableMs: z.number().int().min(200).max(60_000).default(2000),
    /** Polling is required for network shares (no change events for files written by other machines). */
    usePolling: z.boolean().default(true),
    pollIntervalMs: z.number().int().min(200).max(60_000).default(2000),
    encoding: fileEncodingSchema.default('utf8'),
  })
  .strict()
  .superRefine((v, ctx) => {
    const dirs = [v.directory, v.processedDirectory, v.errorDirectory].map((d) => d.toLowerCase());
    if (new Set(dirs).size !== 3) {
      ctx.addIssue({ code: 'custom', path: ['processedDirectory'], message: 'The watched, processed and error folders must all differ' });
    }
    const [watch] = dirs;
    if (dirs.slice(1).some((d) => d.startsWith(watch + '/'))) {
      ctx.addIssue({ code: 'custom', path: ['processedDirectory'], message: 'Processed and error folders cannot be inside the watched folder' });
    }
  });

/**
 * What the webhook body carries besides `raw`:
 * - `both`: `json` (lossless) + `flat` (typed) — the default, and what channels created before this option send.
 * - `typed`: `flat` only. When the message's version has no typed definition, `flat` is null and `json` is sent instead.
 * - `lossless`: `json` only.
 */
export const webhookPayloadFormatSchema = z.enum(['both', 'typed', 'lossless']);
export type WebhookPayloadFormat = z.infer<typeof webhookPayloadFormatSchema>;

export const webhookDeliverySchema = z
  .object({
    type: z.literal('webhook'),
    url: z.url({ protocol: /^https?$/ }),
    payload: webhookPayloadFormatSchema.default('both'),
    timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
    maxAttempts: z.number().int().min(1).max(100).default(10),
  })
  .strict();

/** Delivery adapters for inbound channels. v1 ships webhook only; add new adapters to this union. */
export const deliverySchema = z.discriminatedUnion('type', [webhookDeliverySchema]);

const channelBase = {
  name: z.string().trim().min(1).max(100),
  hl7Version: hl7VersionSchema.default('2.5.1'),
  /** Days to keep messages. Omitted = server default (RETENTION_DEFAULT_DAYS). */
  retentionDays: z.number().int().min(1).max(3650).optional(),
};

export const createInboundMllpChannelSchema = z
  .object({
    ...channelBase,
    direction: z.literal('inbound'),
    /** Omitted = `mllp` (every channel created before the file transport). */
    transport: z.literal('mllp').default('mllp'),
    config: inboundConfigSchema,
    delivery: deliverySchema,
  })
  .strict();

export const createInboundFileChannelSchema = z
  .object({
    ...channelBase,
    direction: z.literal('inbound'),
    transport: z.literal('file'),
    config: inboundFileConfigSchema,
    delivery: deliverySchema,
  })
  .strict();

export const createOutboundMllpChannelSchema = z
  .object({
    ...channelBase,
    direction: z.literal('outbound'),
    transport: z.literal('mllp').default('mllp'),
    config: outboundConfigSchema,
  })
  .strict();

export const createOutboundFileChannelSchema = z
  .object({
    ...channelBase,
    direction: z.literal('outbound'),
    transport: z.literal('file'),
    config: outboundFileConfigSchema,
  })
  .strict();

export const createInboundChannelSchema = z.discriminatedUnion('transport', [
  createInboundMllpChannelSchema,
  createInboundFileChannelSchema,
]);
export const createOutboundChannelSchema = z.discriminatedUnion('transport', [
  createOutboundMllpChannelSchema,
  createOutboundFileChannelSchema,
]);

export const createChannelSchema = z.discriminatedUnion('direction', [
  createInboundChannelSchema,
  createOutboundChannelSchema,
]);

/**
 * PATCH body. Direction and transport cannot change. `config` / `delivery` replace the stored object
 * as a whole; the API re-validates the merged channel with the full create schema.
 */
export const updateChannelSchema = z
  .object({
    name: channelBase.name.optional(),
    hl7Version: hl7VersionSchema.optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    delivery: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const channelSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  direction: channelDirectionSchema,
  transport: channelTransportSchema,
  status: channelStatusSchema,
  hl7Version: hl7VersionSchema,
  retentionDays: z.number().int(),
  config: z.union([inboundConfigResponseSchema, outboundConfigSchema, inboundFileConfigSchema, outboundFileConfigSchema]),
  delivery: deliverySchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Hl7Version = z.infer<typeof hl7VersionSchema>;
export type ChannelDirection = z.infer<typeof channelDirectionSchema>;
export type ChannelStatus = z.infer<typeof channelStatusSchema>;
export type InboundConfig = z.infer<typeof inboundConfigSchema>;
export type InboundConfigResponse = z.infer<typeof inboundConfigResponseSchema>;
export type InboundTls = z.infer<typeof inboundTlsSchema>;
export type OutboundTls = z.infer<typeof outboundTlsSchema>;
export type OutboundConfig = z.infer<typeof outboundConfigSchema>;
export type ChannelTransport = z.infer<typeof channelTransportSchema>;
export type InboundFileConfig = z.infer<typeof inboundFileConfigSchema>;
export type OutboundFileConfig = z.infer<typeof outboundFileConfigSchema>;
export type SegmentSeparator = z.infer<typeof segmentSeparatorSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type CreateChannelInput = z.input<typeof createChannelSchema>;
export type CreateChannel = z.infer<typeof createChannelSchema>;
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
export type Channel = z.infer<typeof channelSchema>;

/**
 * Fills a file name pattern. Values are made file-name safe (anything other than letters, digits, `.`, `_`, `-`
 * becomes `_`); an empty value becomes `NA`.
 */
export function renderFileName(pattern: string, values: Partial<Record<FileNameToken, string>>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, t: string) => {
    const v = (values[t as FileNameToken] ?? '').replace(/[^\w.-]/g, '_').replace(/^\.+/, '');
    return v || 'NA';
  });
}
