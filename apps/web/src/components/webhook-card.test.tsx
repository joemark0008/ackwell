import type { Channel, WebhookSecret } from '@ackwell/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WebhookCard } from './webhook-card';

const channel: Channel = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Lab in',
  direction: 'inbound',
  transport: 'mllp',
  status: 'stopped',
  hl7Version: '2.5.1',
  retentionDays: 7,
  config: { port: 6100, tls: { enabled: false }, allowlist: [] },
  delivery: { type: 'webhook', url: 'https://ehr.local/hook', timeoutMs: 10000, maxAttempts: 10, payload: 'both' },
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
};

const secret = (over: Partial<WebhookSecret>): WebhookSecret => ({
  id: crypto.randomUUID(),
  channelId: channel.id,
  hint: 'AbCd',
  createdAt: '2026-11-11T01:00:00Z',
  revokedAt: null,
  ...over,
});

function mockApi(list: WebhookSecret[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/webhook-secrets/rotate') && init?.method === 'POST') {
      const s = secret({ hint: 'NEW1' });
      list.unshift(s);
      return Response.json({ ...s, secret: 'whsec_' + 'x'.repeat(40) + 'NEW1' }, { status: 201 });
    }
    if (url.endsWith('/webhook-secrets')) return Response.json(list);
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WebhookCard channel={channel} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('WebhookCard', () => {
  it('warns when there is no active secret and generates one, showing it once', async () => {
    mockApi([secret({ hint: 'OLD1', revokedAt: '2026-11-11T02:00:00Z' })]);
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent(/No active secret/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Generate secret' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByTestId('webhook-secret')).toHaveTextContent(/^whsec_x{40}NEW1$/);
    await userEvent.setup().click(dialog.getByRole('button', { name: 'I have stored the secret' }));
    expect(await screen.findByText('whsec_…NEW1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeInTheDocument();
  });

  it('lists active secrets and explains an in-progress rotation', async () => {
    mockApi([secret({ hint: 'NEW2' }), secret({ hint: 'OLD2' })]);
    renderCard();
    expect(await screen.findByText('whsec_…NEW2')).toBeInTheDocument();
    expect(screen.getByText('whsec_…OLD2')).toBeInTheDocument();
    expect(screen.getByText(/Rotation in progress/)).toBeInTheDocument();
    expect(screen.getByText('https://ehr.local/hook')).toBeInTheDocument();
  });
});
