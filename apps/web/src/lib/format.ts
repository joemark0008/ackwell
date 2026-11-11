import type { AppSettings, Channel } from '@ackwell/schemas';

/** Inbound: where senders connect. Outbound: where Ackwell sends. */
export function endpointLabel(c: Channel, settings?: AppSettings): string {
  const cfg = c.config as { port: number; host?: string };
  if (c.direction === 'inbound') return `${settings?.mllp.host ?? 'server'}:${cfg.port}`;
  return `→ ${cfg.host}:${cfg.port}`;
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export const fmtNum = (n: number | undefined) => (n === undefined ? '—' : new Intl.NumberFormat().format(n));

/** Time with seconds for the message log; adds the date when it is not today. */
export function formatLogTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(undefined, today ? { timeStyle: 'medium' } : { dateStyle: 'short', timeStyle: 'medium' }).format(d);
}
