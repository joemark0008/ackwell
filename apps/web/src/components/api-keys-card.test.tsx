import type { ApiKey, Channel } from '@ackwell/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiKeysCard } from './api-keys-card';

const channel: Channel = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'To LIS',
  direction: 'outbound',
  status: 'running',
  hl7Version: '2.5.1',
  retentionDays: 7,
  config: { host: 'lis.local', port: 2575, tls: { enabled: false }, ackTimeoutMs: 30000, retry: { maxAttempts: 5, backoffSeconds: 10 } },
  delivery: null,
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
};

const key = (over: Partial<ApiKey>): ApiKey => ({
  id: crypto.randomUUID(),
  channelId: channel.id,
  label: 'LIS',
  prefix: 'ak_abcdefgh',
  lastUsedAt: null,
  revokedAt: null,
  createdAt: '2026-11-11T01:00:00Z',
  ...over,
});

function mockApi(list: ApiKey[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api-keys') && init?.method === 'POST') {
        const { label } = JSON.parse(String(init.body)) as { label: string };
        const k = key({ label, prefix: 'ak_newkey12' });
        list.unshift(k);
        return Response.json({ ...k, key: 'ak_newkey12' + 'x'.repeat(35) }, { status: 201 });
      }
      if (url.endsWith('/api-keys')) return Response.json(list);
      return Response.json({}, { status: 404 });
    }),
  );
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ApiKeysCard channel={channel} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ApiKeysCard', () => {
  it('lists active keys with prefix and usage', async () => {
    mockApi([key({ label: 'LIS', lastUsedAt: '2026-11-11T05:00:00Z' }), key({ label: 'Old', revokedAt: '2026-11-11T02:00:00Z' })]);
    renderCard();
    expect(await screen.findByText('LIS')).toBeInTheDocument();
    expect(screen.queryByText('Old')).not.toBeInTheDocument();
    expect(screen.getByText('ak_abcdefgh…')).toBeInTheDocument();
    expect(screen.getByText(/Last used/)).toBeInTheDocument();
    expect(screen.getByText('1 active key')).toBeInTheDocument();
  });

  it('creates a key and shows it once', async () => {
    mockApi([]);
    renderCard();
    expect(await screen.findByText(/No keys yet/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(await screen.findByLabelText('Label'), 'Pharmacy');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByTestId('api-key')).toHaveTextContent(/^ak_newkey12x{35}$/);
    await user.click(dialog.getByRole('button', { name: 'I have stored the key' }));
    expect(await screen.findByText('Pharmacy')).toBeInTheDocument();
  });
});
