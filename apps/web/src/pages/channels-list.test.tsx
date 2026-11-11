import type { Channel } from '@ackwell/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChannelsListPage } from './channels-list';

const settings = { mllp: { host: '172.16.10.30', portRange: { from: 6100, to: 6150 } }, retentionDefaultDays: 7 };
const ch = (over: Partial<Channel>): Channel => ({
  id: crypto.randomUUID(),
  name: 'x',
  direction: 'inbound',
  status: 'stopped',
  hl7Version: '2.5.1',
  retentionDays: 7,
  config: { port: 6100, tls: { enabled: false }, allowlist: [] },
  delivery: { type: 'webhook', url: 'https://x.test', timeoutMs: 10000, maxAttempts: 10 },
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
  ...over,
});

function mockApi(channels: Channel[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url === '/api/settings' ? settings : url === '/api/channels' ? channels : { status: 'ok', db: 'ok' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter>
          <ChannelsListPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ChannelsListPage', () => {
  it('shows the empty state with inbound and outbound starters', async () => {
    mockApi([]);
    renderPage();
    expect(await screen.findByText('Create your first channel')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Receive HL7/ })).toHaveAttribute('href', '/channels/new?direction=inbound');
    expect(screen.getByRole('link', { name: /Send HL7/ })).toHaveAttribute('href', '/channels/new?direction=outbound');
  });

  it('lists channels with endpoints and filters by direction and search', async () => {
    mockApi([
      ch({ name: 'Lab in', config: { port: 6101, tls: { enabled: false }, allowlist: [] } }),
      ch({
        name: 'Orders out',
        direction: 'outbound',
        delivery: null,
        config: { host: 'lis.local', port: 2575, tls: { enabled: false, rejectUnauthorized: true }, ackTimeoutMs: 30000, retry: { maxAttempts: 5, backoffSeconds: 10 } },
      }),
    ]);
    renderPage();
    const table = within(await screen.findByRole('table'));
    expect(table.getByText('172.16.10.30:6101')).toBeInTheDocument();
    expect(table.getByText('→ lis.local:2575')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Outbound' }));
    expect(table.queryByText('Lab in')).not.toBeInTheDocument();
    expect(table.getByText('Orders out')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'All' }));
    await user.type(screen.getByRole('textbox', { name: 'Search channels' }), '6101');
    expect(table.getByText('Lab in')).toBeInTheDocument();
    expect(table.queryByText('Orders out')).not.toBeInTheDocument();
  });
});
