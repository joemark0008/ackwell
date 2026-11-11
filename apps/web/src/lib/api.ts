import type {
  ApiKey,
  AppSettings,
  Channel,
  CreateChannelInput,
  CreateChannelResponse,
  MessageDetail,
  MessageList,
  MessageListQuery,
  MessageSummary,
  NewApiKey,
  NewWebhookSecret,
  SendRequestInput,
  UpdateChannel,
  WebhookSecret,
} from '@ackwell/schemas';

export interface ApiErrorBody {
  statusCode?: number;
  code?: string;
  message?: string;
  issues?: { path: string; message: string }[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? `Request failed (HTTP ${status})`);
  }
  get code() {
    return this.body?.code;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null)) as ApiErrorBody | null);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ status: string; db: string }>('GET', '/health'),
  settings: () => request<AppSettings>('GET', '/api/settings'),
  channels: {
    list: () => request<Channel[]>('GET', '/api/channels'),
    get: (id: string) => request<Channel>('GET', `/api/channels/${id}`),
    create: (input: CreateChannelInput) => request<CreateChannelResponse>('POST', '/api/channels', input),
    update: (id: string, patch: UpdateChannel) => request<Channel>('PATCH', `/api/channels/${id}`, patch),
    remove: (id: string) => request<void>('DELETE', `/api/channels/${id}`),
    start: (id: string) => request<Channel>('POST', `/api/channels/${id}/start`),
    stop: (id: string) => request<Channel>('POST', `/api/channels/${id}/stop`),
    messages: (id: string, query: Partial<MessageListQuery> = {}) =>
      request<MessageList>('GET', `/api/channels/${id}/messages${toQuery(query)}`),
    send: (id: string, body: SendRequestInput) => request<MessageSummary>('POST', `/api/channels/${id}/send`, body),
  },
  apiKeys: {
    list: (channelId: string) => request<ApiKey[]>('GET', `/api/channels/${channelId}/api-keys`),
    create: (channelId: string, label: string) => request<NewApiKey>('POST', `/api/channels/${channelId}/api-keys`, { label }),
    revoke: (channelId: string, id: string) => request<ApiKey>('DELETE', `/api/channels/${channelId}/api-keys/${id}`),
  },
  messages: {
    get: (id: string) => request<MessageDetail>('GET', `/api/messages/${id}`),
    resend: (id: string) => request<MessageSummary>('POST', `/api/messages/${id}/resend`),
  },
  webhookSecrets: {
    list: (channelId: string) => request<WebhookSecret[]>('GET', `/api/channels/${channelId}/webhook-secrets`),
    rotate: (channelId: string) => request<NewWebhookSecret>('POST', `/api/channels/${channelId}/webhook-secrets/rotate`),
    revoke: (channelId: string, id: string) =>
      request<WebhookSecret>('DELETE', `/api/channels/${channelId}/webhook-secrets/${id}`),
  },
};

function toQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
