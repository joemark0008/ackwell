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
