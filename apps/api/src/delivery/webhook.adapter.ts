import { Injectable } from '@nestjs/common';
import { tryToFlat, type Hl7Json, type WebhookPayload } from '@ackwell/schemas';
import { z } from 'zod';
import type { DeliveryAdapter, DeliveryContext, DeliveryResult } from './delivery-adapter.js';
import { signedHeaders } from './standard-webhooks.js';
import { WebhookSecretsService } from './webhook-secrets.service.js';

type WebhookDelivery = Extract<DeliveryContext['delivery'], { type: 'webhook' }>;

const USER_AGENT = 'Ackwell-Webhook/0.1';
const RESPONSE_SNIPPET = 500;

/** POSTs the message as JSON, signed per Standard Webhooks with every active secret of the channel. */
@Injectable()
export class WebhookAdapter implements DeliveryAdapter<WebhookDelivery> {
  readonly type = 'webhook' as const;

  constructor(private readonly secrets: WebhookSecretsService) {}

  async deliver({ channel, delivery, message }: DeliveryContext<WebhookDelivery>): Promise<DeliveryResult> {
    const secrets = await this.secrets.activeSecrets(channel.id);
    if (!secrets.length) {
      return {
        ok: false,
        retryable: false,
        error: 'No active webhook secret. Generate one on the channel page, then resend.',
      };
    }
    if (!message.raw || !message.json) {
      return { ok: false, retryable: false, error: 'Message has no parsed JSON to deliver' };
    }

    const format = delivery.payload ?? 'both';
    const json = message.json as Hl7Json;
    const flat = format === 'lossless' ? undefined : tryToFlat(json);
    const payload: WebhookPayload = {
      id: message.id,
      channelId: channel.id,
      channelName: channel.name,
      direction: 'inbound',
      receivedAt: message.createdAt.toISOString(),
      messageType: message.messageType,
      controlId: message.controlId,
      remoteAddress: message.remoteAddress,
      raw: message.raw,
      // typed: only `flat`, but fall back to `json` when the version has no typed definition (flat null).
      ...(format !== 'typed' || flat === null ? { json } : {}),
      ...(format !== 'lossless' ? { flat } : {}),
    };
    const body = JSON.stringify(payload);
    const headers = {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      ...signedHeaders(message.id, body, secrets),
    };

    let res: Response;
    try {
      res = await fetch(delivery.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(delivery.timeoutMs) });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const detail = err.name === 'TimeoutError' ? `timeout after ${delivery.timeoutMs} ms` : err.cause?.code ?? err.message;
      return { ok: false, retryable: true, error: `Request failed: ${detail}` };
    }
    const text = await res.text().catch(() => '');
    const response = `${res.status} ${res.statusText}`.trim() + (text ? `\n${text.slice(0, RESPONSE_SNIPPET)}` : '');
    if (res.ok) return { ok: true, response };
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    return { ok: false, retryable, error: `HTTP ${res.status}`, response };
  }
}

/** Exported for Swagger / docs: what receivers get. */
export const webhookRequestDoc = z.object({
  headers: z.object({
    'content-type': z.literal('application/json'),
    'webhook-id': z.string(),
    'webhook-timestamp': z.string(),
    'webhook-signature': z.string(),
  }),
});
