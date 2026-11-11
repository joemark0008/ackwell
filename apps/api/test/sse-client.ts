import http from 'node:http';

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseConnection {
  status: number;
  headers: http.IncomingHttpHeaders;
  events: SseEvent[];
  /** Raw text received so far (comments included). */
  text: () => string;
  waitFor: (pred: (e: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent>;
  close: () => void;
}

/** Minimal EventSource-like client for tests. */
export function openSse(port: number, path: string, cookie?: string): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { ...(cookie ? { Cookie: cookie } : {}), Accept: 'text/event-stream' } }, (res) => {
      let raw = '';
      const events: SseEvent[] = [];
      const waiters: Array<() => void> = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        for (;;) {
          const end = raw.indexOf('\n\n');
          if (end < 0) break;
          const block = raw.slice(0, end);
          raw = raw.slice(end + 2);
          full += block + '\n\n';
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) events.push({ event, data: JSON.parse(data) });
        }
        waiters.splice(0).forEach((w) => w());
      });
      let full = '';
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        events,
        text: () => full + raw,
        waitFor: (pred, timeoutMs = 10_000) =>
          new Promise<SseEvent>((ok, fail) => {
            const until = Date.now() + timeoutMs;
            const check = () => {
              const hit = events.find(pred);
              if (hit) return ok(hit);
              if (Date.now() > until) return fail(new Error('SSE waitFor timed out'));
              waiters.push(check);
              setTimeout(check, 200);
            };
            check();
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}
