import { z } from 'zod';

/** HL7 v2 versions a channel can be configured for. */
export const HL7_VERSIONS = ['2.1', '2.2', '2.3', '2.3.1', '2.4', '2.5', '2.5.1', '2.6', '2.7', '2.7.1', '2.8'] as const;
export const hl7VersionSchema = z.enum(HL7_VERSIONS);

export const channelDirectionSchema = z.enum(['inbound', 'outbound']);
export const channelStatusSchema = z.enum(['stopped', 'running', 'error']);

const portSchema = z.number().int().min(1).max(65535);

/** An IPv4/IPv6 address or CIDR range. */
export const allowlistEntrySchema = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

export const tlsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();

export const inboundConfigSchema = z
  .object({
    /** Listen port; must also be inside the server's MLLP_PORT_RANGE (checked by the API). */
    port: portSchema,
    tls: tlsConfigSchema.default({ enabled: false }),
    /** Empty list = accept any source IP. */
    allowlist: z.array(allowlistEntrySchema).max(100).default([]),
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
    tls: tlsConfigSchema.default({ enabled: false }),
    ackTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
    retry: retryPolicySchema.default({ maxAttempts: 5, backoffSeconds: 10 }),
  })
  .strict();

export const webhookDeliverySchema = z
  .object({
    type: z.literal('webhook'),
    url: z.url({ protocol: /^https?$/ }),
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

export const createInboundChannelSchema = z
  .object({
    ...channelBase,
    direction: z.literal('inbound'),
    config: inboundConfigSchema,
    delivery: deliverySchema,
  })
  .strict();

export const createOutboundChannelSchema = z
  .object({
    ...channelBase,
    direction: z.literal('outbound'),
    config: outboundConfigSchema,
  })
  .strict();

export const createChannelSchema = z.discriminatedUnion('direction', [
  createInboundChannelSchema,
  createOutboundChannelSchema,
]);

/**
 * PATCH body. Direction cannot change. `config` / `delivery` replace the stored object
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
  status: channelStatusSchema,
  hl7Version: hl7VersionSchema,
  retentionDays: z.number().int(),
  config: z.union([inboundConfigSchema, outboundConfigSchema]),
  delivery: deliverySchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Hl7Version = z.infer<typeof hl7VersionSchema>;
export type ChannelDirection = z.infer<typeof channelDirectionSchema>;
export type ChannelStatus = z.infer<typeof channelStatusSchema>;
export type InboundConfig = z.infer<typeof inboundConfigSchema>;
export type OutboundConfig = z.infer<typeof outboundConfigSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type CreateChannelInput = z.input<typeof createChannelSchema>;
export type CreateChannel = z.infer<typeof createChannelSchema>;
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
export type Channel = z.infer<typeof channelSchema>;
