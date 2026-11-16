import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/** Shared helpers for the QA gap tests (qa-gaps / qa-logs). */

const VT = '\x0b';
const FS = '\x1c';
const CR = '\r';

export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Field `n` (1-based, MSH-1 = the separator) of the MSH line, using the message's own field separator. */
export function mshField(msg: string, n: number): string {
  const msh = msg.split(/\r\n|\r|\n/)[0]!;
  const sep = msh[3]!;
  if (n === 1) return sep;
  return msh.split(sep)[n - 1] ?? '';
}

/** `{ code, controlId }` from an ACK's MSA segment (MSA-1 / MSA-2). */
export function ackOf(ack: string): { code: string; controlId: string } {
  const sep = ack[3] ?? '|';
  const msa = ack.split(/\r\n|\r|\n/).find((l) => l.startsWith('MSA'));
  if (!msa) return { code: '', controlId: '' };
  const f = msa.split(sep);
  return { code: f[1] ?? '', controlId: f[2] ?? '' };
}

export interface MllpFrame {
  at: number;
  controlId: string;
  raw: string;
  /** ACK code we answered, or null when we stayed silent. */
  answered: string | null;
}

/**
 * MLLP receiver for outbound tests. Answer per MSH-10 prefix:
 * `AE…` → AE, `AR…` → AR, `SILENT…` → never answers, `FLAKY…` → silent the first time that exact
 * control id is seen and AA afterwards, anything else → AA.
 */
export function mllpReceiver() {
  const frames: MllpFrame[] = [];
  const seen = new Map<string, number>();
  let server: net.Server | null = null;
  const sockets = new Set<net.Socket>();
  const handle = (sock: net.Socket) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        const end = buf.indexOf(FS + CR);
        if (end < 0) return;
        const raw = buf.slice(buf.indexOf(VT) + 1, end);
        buf = buf.slice(end + 2);
        const ctrl = mshField(raw, 10);
        const n = (seen.get(ctrl) ?? 0) + 1;
        seen.set(ctrl, n);
        let code: string | null = 'AA';
        if (ctrl.startsWith('AE')) code = 'AE';
        else if (ctrl.startsWith('AR')) code = 'AR';
        else if (ctrl.startsWith('SILENT')) code = null;
        else if (ctrl.startsWith('FLAKY') && n === 1) code = null;
        frames.push({ at: Date.now(), controlId: ctrl, raw, answered: code });
        if (code) {
          sock.write(VT + `MSH|^~\\&|LIS|LAB|ACKWELL|HOSP|20260101000000||ACK|${ctrl}R|P|2.5` + CR + `MSA|${code}|${ctrl}` + FS + CR);
        }
      }
    });
  };
  return {
    frames,
    start: (port?: number) =>
      new Promise<number>((r) => {
        server = net.createServer(handle);
        server.listen(port ?? 0, '127.0.0.1', () => r((server!.address() as AddressInfo).port));
      }),
    stop: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        if (!server) return r();
        server.close(() => r());
        server = null;
      }),
  };
}

export interface WebhookHit {
  at: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Webhook receiver. `plan` = HTTP statuses to answer in order (the last one repeats). */
export function webhookReceiver() {
  const hits: WebhookHit[] = [];
  let plan: number[] = [200];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ at: Date.now(), headers: req.headers, body });
      const status = plan.length > 1 ? plan.shift()! : plan[0]!;
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status >= 500 ? 'boom' : 'thanks');
    });
  });
  return {
    hits,
    setPlan: (p: number[]) => (plan = [...p]),
    start: () =>
      new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`))),
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
