import { parseHl7, type Channel, type MessageDetail, type MessageList } from '@ackwell/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setLiveStatus } from '@/lib/live-state';
import { MessagesCard } from './messages-card';

// Monaco needs a real browser; the dialog's editor is replaced by a <pre>.
vi.mock('@/components/code-editor', () => ({
  default: ({ value, language }: { value: string; language: string }) => <pre data-lang={language}>{value}</pre>,
}));

const channel: Channel = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Lab in',
  direction: 'inbound',
  transport: 'mllp',
  status: 'running',
  hl7Version: '2.5.1',
  retentionDays: 7,
  config: { port: 6100, tls: { enabled: false }, allowlist: [] },
  delivery: { type: 'webhook', url: 'https://x.test', timeoutMs: 10000, maxAttempts: 10, payload: 'both' },
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
};

const RAW = 'MSH|^~\\&|LAB|HOSP|ACKWELL|HOSP|20261111120000||ORU^R01|MSG00001|P|2.5.1\rPID|1||123^^^HOSP^MR||DOE^JANE';

const detail: MessageDetail = {
  id: '22222222-2222-4222-8222-222222222222',
  channelId: channel.id,
  direction: 'inbound',
  status: 'received',
  messageType: 'ORU^R01',
  controlId: 'MSG00001',
  ackCode: 'AA',
  error: null,
  remoteAddress: '172.16.10.5',
  sourceFile: null,
  createdAt: '2026-11-11T12:00:00Z',
  updatedAt: '2026-11-11T12:00:00Z',
  raw: RAW,
  json: parseHl7(RAW),
  attempts: [],
};

function mockApi(list: MessageList) {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.startsWith(`/api/channels/${channel.id}/messages`) ? list : url === '/api/channels' ? [] : url.startsWith('/api/messages/') ? detail : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MessagesCard channel={channel} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLiveStatus('off');
});

describe('MessagesCard', () => {
  it('shows the running empty state', async () => {
    mockApi({ items: [], nextCursor: null, total: 0 });
    setLiveStatus('live');
    renderCard();
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
    expect(screen.getByText(/channel is listening/)).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('shows the fallback indicator while the stream is down', async () => {
    mockApi({ items: [], nextCursor: null, total: 0 });
    renderCard();
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    expect(screen.getByText(/Refreshing periodically/)).toBeInTheDocument();
  });

  it('lists messages and opens the raw/JSON dialog on click', async () => {
    const { raw: _r, json: _j, attempts: _a, ...summary } = detail;
    const fetchMock = mockApi({ items: [summary], nextCursor: 'abc', total: 51 });
    renderCard();
    const table = within(await screen.findByRole('table'));
    expect(table.getByText('ORU^R01')).toBeInTheDocument();
    expect(table.getByText('MSG00001')).toBeInTheDocument();
    expect(table.getByText('AA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load older messages' })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/channels/${channel.id}/messages?limit=50`);

    await userEvent.setup().click(table.getByText('ORU^R01'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('ORU^R01 · MSG00001')).toBeInTheDocument();
    const raw = dialog.getAllByText((_, el) => el?.tagName === 'PRE' && (el.textContent ?? '').startsWith('MSH|^~\\&|LAB'));
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[0]!.textContent).toContain('\nPID|1||123^^^HOSP^MR||DOE^JANE');
    expect(dialog.getByText('172.16.10.5')).toBeInTheDocument();

    // JSON pane: typed (flat) by default for a supported version, lossless on demand.
    const jsonPre = () =>
      dialog.getAllByText((_, el) => el?.tagName === 'PRE' && (el.textContent ?? '').trimStart().startsWith('{'))[0]!;
    await userEvent.setup().click(dialog.getByRole('tab', { name: 'JSON' })); // narrow layout: tabs
    expect(await dialog.findByText('JSON · typed HL7 2.5.1')).toBeInTheDocument();
    expect(jsonPre().textContent).toContain('"msh_9_1": "ORU"');
    expect(jsonPre().textContent).toContain('"pid_5_1_1": "DOE"');
    await userEvent.setup().click(dialog.getByRole('radio', { name: 'lossless' }));
    expect(dialog.getByText('JSON · lossless')).toBeInTheDocument();
    expect(jsonPre().textContent).toContain('"id": "MSH"');
  });
});
