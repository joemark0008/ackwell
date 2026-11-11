import type { Channel, FileErrorEntry } from '@ackwell/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileErrorsCard } from './file-errors-card';

const channel: Channel = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Results',
  direction: 'inbound',
  transport: 'file',
  status: 'running',
  hl7Version: '2.5.1',
  retentionDays: 7,
  config: {
    directory: 'RESULT',
    processedDirectory: 'PROCESSED',
    errorDirectory: 'ERROR',
    include: ['*.hl7'],
    stableMs: 2000,
    usePolling: true,
    pollIntervalMs: 2000,
    encoding: 'utf8',
  },
  delivery: { type: 'webhook', url: 'https://ehr.local/hook', timeoutMs: 10000, maxAttempts: 10, payload: 'both' },
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
};

function mockApi(list: FileErrorEntry[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/retry') && init?.method === 'POST') {
      const name = decodeURIComponent(url.split('/').at(-2)!);
      list.splice(list.findIndex((f) => f.name === name), 1);
      return Response.json({ movedTo: `RESULT/${name}` });
    }
    if (url.endsWith('/files/errors')) return Response.json(list);
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderCard(ch: Channel = channel) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FileErrorsCard channel={ch} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('FileErrorsCard', () => {
  it('says when there are no error files', async () => {
    mockApi([]);
    renderCard();
    expect(await screen.findByText('No error files.')).toBeInTheDocument();
  });

  it('lists error files with their reason and retries one', async () => {
    const fetchMock = mockApi([
      { name: 'two.hl7', size: 120, modifiedAt: '2026-11-11T10:00:00Z', reason: 'The file holds 2 messages (MSH segments); one message per file is expected' },
    ]);
    renderCard();
    const item = (await screen.findByText('two.hl7')).closest('li')!;
    expect(within(item).getByText(/holds 2 messages/)).toBeInTheDocument();
    await userEvent.setup().click(within(item).getByRole('button', { name: /Retry/ }));
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/files/errors/two.hl7/retry') && i?.method === 'POST')).toBe(true);
    expect(await screen.findByText('No error files.')).toBeInTheDocument();
  });

  it('disables retry while the channel is stopped', async () => {
    mockApi([{ name: 'x.hl7', size: 1, modifiedAt: '2026-11-11T10:00:00Z', reason: 'The file is empty' }]);
    renderCard({ ...channel, status: 'stopped' });
    expect(await screen.findByRole('button', { name: /Retry/ })).toBeDisabled();
    expect(screen.getByText('Start the channel to retry.')).toBeInTheDocument();
  });
});
