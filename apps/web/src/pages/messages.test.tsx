import type { Channel, MessageList, MessageSummary } from '@ackwell/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MessagesPage } from './messages';

vi.mock('@/components/code-editor', () => ({ default: () => null }));

const mk = (id: string, name: string, direction: 'inbound' | 'outbound'): Channel => ({
  id,
  name,
  direction,
  status: 'running',
  hl7Version: '2.5.1',
  retentionDays: 7,
  config:
    direction === 'inbound'
      ? { port: 6100, tls: { enabled: false }, allowlist: [] }
      : { host: 'h', port: 1, tls: { enabled: false }, retry: { maxAttempts: 3, backoffMs: 1000 } },
  delivery: { type: 'webhook', url: 'https://x.test', timeoutMs: 10000, maxAttempts: 10, payload: 'both' },
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
} as unknown as Channel);

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '33333333-3333-4333-8333-333333333333';
const channels = [mk(C1, 'Lab in', 'inbound'), mk(C2, 'ADT out', 'outbound')];

const msg = (id: string, channelId: string, direction: 'inbound' | 'outbound', type: string): MessageSummary => ({
  id,
  channelId,
  direction,
  status: 'received',
  messageType: type,
  controlId: `CTL-${type}`,
  ackCode: 'AA',
  error: null,
  remoteAddress: null,
  sourceFile: null,
  createdAt: '2026-11-11T12:00:00Z',
  updatedAt: '2026-11-11T12:00:00Z',
});

function setup(list: MessageList) {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.startsWith('/api/channels') ? channels : url.startsWith('/api/messages') ? list : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter>
          <MessagesPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('MessagesPage', () => {
  it('lists messages with channel names and links', async () => {
    setup({
      items: [msg('a1111111-1111-4111-8111-111111111111', C1, 'inbound', 'ORU^R01'), msg('b2222222-2222-4222-8222-222222222222', C2, 'outbound', 'ADT^A01')],
      nextCursor: null,
      total: 2,
    });
    const table = within(await screen.findByRole('table'));
    expect(await table.findByText('Lab in')).toHaveAttribute('href', `/channels/${C1}`);
    expect(table.getByText('ADT out')).toBeInTheDocument();
    expect(table.getByText('ORU^R01')).toBeInTheDocument();
    expect(table.getByText('Channel')).toBeInTheDocument();
  });

  it('shows the empty state when there are no messages at all', async () => {
    setup({ items: [], nextCursor: null, total: 0 });
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
  });

  it('sends channelId and direction filters to the API', async () => {
    const fetchMock = setup({ items: [msg('a1111111-1111-4111-8111-111111111111', C1, 'inbound', 'ORU^R01')], nextCursor: null, total: 1 });
    const user = userEvent.setup();
    await screen.findByRole('table');
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/messages?limit=50')).toBe(true);

    await user.click(screen.getByRole('combobox', { name: 'Filter by channel' }));
    await user.click(await screen.findByRole('option', { name: 'ADT out' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(`channelId=${C2}`))).toBe(true));

    await user.click(screen.getByRole('combobox', { name: 'Filter by direction' }));
    await user.click(await screen.findByRole('option', { name: 'Inbound' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('direction=inbound') && String(c[0]).includes('channelId='))).toBe(true),
    );
  });
});
