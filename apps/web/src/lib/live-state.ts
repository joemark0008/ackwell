import { useSyncExternalStore } from 'react';

/** `live`: stream open. `reconnecting`: dropped, retrying. `off`: not started or stopped (e.g. 401). */
export type LiveStatus = 'live' | 'reconnecting' | 'off';

let status: LiveStatus = 'off';
const listeners = new Set<() => void>();

export function setLiveStatus(next: LiveStatus) {
  if (next === status) return;
  status = next;
  listeners.forEach((l) => l());
}
export const getLiveStatus = () => status;

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export const useLiveStatus = (): LiveStatus => useSyncExternalStore(subscribe, getLiveStatus, getLiveStatus);

// ---- newest summary per message, as seen on the live stream -------------------------------------
// A list refetch started before a status change can resolve after the stream already patched the
// cache (send → invalidate → GET returns "processing" → AA arrives → GET resolves → row goes stale),
// and polling is off while the stream is live. Lists are therefore overlaid with anything newer.

type LiveRow = { id: string; updatedAt: string };
const LIVE_ROWS_MAX = 1000;
const liveRows = new Map<string, LiveRow>();

export function rememberLiveRow<T extends LiveRow>(m: T) {
  const known = liveRows.get(m.id);
  if (known && known.updatedAt > m.updatedAt) return;
  liveRows.delete(m.id); // re-insert so the map stays ordered by recency
  liveRows.set(m.id, m);
  if (liveRows.size > LIVE_ROWS_MAX) liveRows.delete(liveRows.keys().next().value!);
}

/** Replaces fetched rows with a newer version seen on the stream (by `updatedAt`). */
export function overlayLiveRows<T extends LiveRow>(items: T[]): T[] {
  let changed = false;
  const out = items.map((it) => {
    const known = liveRows.get(it.id) as T | undefined;
    if (known && known.updatedAt > it.updatedAt) {
      changed = true;
      return known;
    }
    return it;
  });
  return changed ? out : items;
}

export function forgetLiveRows() {
  liveRows.clear();
}
