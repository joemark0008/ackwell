import type { AppSettings, Channel, CreateChannelInput, UpdateChannel } from '@ackwell/schemas';

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
    create: (input: CreateChannelInput) => request<Channel>('POST', '/api/channels', input),
    update: (id: string, patch: UpdateChannel) => request<Channel>('PATCH', `/api/channels/${id}`, patch),
    remove: (id: string) => request<void>('DELETE', `/api/channels/${id}`),
  },
};
