import type { Channel, ChannelStatus, MessageList, MessageSummary } from '@ackwell/schemas';
import type { InfiniteData, Query, QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { rememberLiveRow, setLiveStatus } from './live-state';
import { keys, type LogFilters } from './queries';

type MessagePages = InfiniteData<MessageList>;
type ChannelStatusEvent = { channelId: string; status: ChannelStatus; error?: string };

/** Which cached message list a query key is, plus the channel it is scoped to. */
function listInfo(key: readonly unknown[]): { channelId?: string; filters: LogFilters } | null {
  if (key[0] === 'channels' && key[2] === 'messages' && typeof key[1] === 'string') {
    return { channelId: key[1], filters: (key[3] ?? {}) as LogFilters };
  }
  if (key[0] === 'messages' && key[1] === 'all') return { filters: (key[2] ?? {}) as LogFilters };
  return null;
}

function matches(m: MessageSummary, scope: string | undefined, f: LogFilters): boolean {
  if (scope && m.channelId !== scope) return false;
  if (f.channelId && m.channelId !== f.channelId) return false;
  if (f.direction && m.direction !== f.direction) return false;
  if (f.status && m.status !== f.status) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!(m.messageType ?? '').toLowerCase().startsWith(q) && !(m.controlId ?? '').toLowerCase().startsWith(q)) return false;
  }
  return true;
}

function patchPages(data: MessagePages, m: MessageSummary, scope: string | undefined, f: LogFilters): MessagePages {
  const ok = matches(m, scope, f);
  const pageIdx = data.pages.findIndex((p) => p.items.some((i) => i.id === m.id));
  if (pageIdx >= 0) {
    const pages = data.pages.map((p, i) => {
      if (i !== pageIdx) return p;
      const items = ok ? p.items.map((it) => (it.id === m.id ? m : it)) : p.items.filter((it) => it.id !== m.id);
      return { ...p, items };
    });
    if (!ok && pages[0]) pages[0] = { ...pages[0], total: Math.max(0, pages[0].total - 1) };
    return { ...data, pages };
  }
  if (!ok || data.pages.length === 0) return data;
  const [first, ...rest] = data.pages;
  return { ...data, pages: [{ ...first!, items: [m, ...first!.items], total: first!.total + 1 }, ...rest] };
}

/** Apply one `message` event to every cached message list and the open detail. */
export function applyMessageEvent(qc: QueryClient, m: MessageSummary) {
  rememberLiveRow(m);
  const lists = qc.getQueryCache().findAll({
    predicate: (q: Query) => listInfo(q.queryKey) !== null,
  });
  for (const q of lists) {
    const info = listInfo(q.queryKey)!;
    qc.setQueryData<MessagePages>(q.queryKey, (old) => (old ? patchPages(old, m, info.channelId, info.filters) : old));
  }
  if (qc.getQueryState(keys.message(m.id))) void qc.invalidateQueries({ queryKey: keys.message(m.id) });
}

export function applyChannelStatus(qc: QueryClient, ev: ChannelStatusEvent) {
  const patch = (c: Channel): Channel => (c.id === ev.channelId ? { ...c, status: ev.status } : c);
  qc.setQueryData<Channel>(keys.channel(ev.channelId), (c) => (c ? patch(c) : c));
  qc.setQueryData<Channel[]>(keys.channels, (l) => (l ? l.map(patch) : l));
}

export interface LiveOptions {
  url?: string;
  createSource?: (url: string) => EventSource;
  /** Probe used when the browser gives up (HTTP error). Resolves false on 401. */
  checkAuth?: () => Promise<boolean>;
  minDelayMs?: number;
  maxDelayMs?: number;
}

const defaultCheckAuth = async () => {
  try {
    return (await fetch('/api/settings', { credentials: 'same-origin' })).status !== 401;
  } catch {
    return true; // network down: keep retrying
  }
};

/** One EventSource for the app. Returns a stop function. */
export function startLiveEvents(qc: QueryClient, opts: LiveOptions = {}): () => void {
  const url = opts.url ?? '/api/events';
  const create = opts.createSource ?? ((u: string) => new EventSource(u));
  const checkAuth = opts.checkAuth ?? defaultCheckAuth;
  const min = opts.minDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;

  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = min;
  let stopped = false;
  let hadConnection = false;

  const catchUp = () => {
    void qc.invalidateQueries({ queryKey: keys.channels });
    void qc.invalidateQueries({ queryKey: ['messages', 'all'] });
    void qc.invalidateQueries({ queryKey: ['channels'], predicate: (q) => q.queryKey[2] === 'messages' });
  };

  const parse = <T,>(e: MessageEvent): T | null => {
    try {
      return JSON.parse(e.data as string) as T;
    } catch {
      return null;
    }
  };

  const connect = () => {
    if (stopped) return;
    const source = create(url);
    es = source;
    source.onopen = () => {
      delay = min;
      setLiveStatus('live');
      if (hadConnection) catchUp(); // the server does not replay events missed while disconnected
      hadConnection = true;
    };
    source.addEventListener('message', (e) => {
      const m = parse<MessageSummary>(e as MessageEvent);
      if (m) applyMessageEvent(qc, m);
    });
    source.addEventListener('channel.status', (e) => {
      const ev = parse<ChannelStatusEvent>(e as MessageEvent);
      if (ev) applyChannelStatus(qc, ev);
    });
    source.onerror = () => {
      if (stopped) return;
      setLiveStatus('reconnecting');
      if (source.readyState === 2 /* CLOSED: browser will not retry */) {
        source.close();
        void checkAuth().then((ok) => {
          if (stopped) return;
          if (!ok) return setLiveStatus('off');
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, max);
        });
      }
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    es?.close();
    setLiveStatus('off');
  };
}

/** Mount once inside the authenticated shell. */
export function useLiveEvents(qc: QueryClient) {
  useEffect(() => startLiveEvents(qc), [qc]);
}
