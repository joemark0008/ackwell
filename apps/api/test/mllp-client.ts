import net from 'node:net';

const VT = '\x0b';
const FS = '\x1c';
const CR = '\r';

export class MllpClosedError extends Error {
  override name = 'MllpClosedError';
}

/**
 * Minimal raw MLLP client for tests: opens a TCP connection, sends one framed message and
 * resolves with the un-framed ACK. Rejects with MllpClosedError when the server closes the
 * connection without answering (e.g. allowlist rejection) and on timeout.
 */
export function sendMllp(
  port: number,
  message: string,
  opts: { host?: string; timeoutMs?: number } = {},
): Promise<string> {
  const { host = '127.0.0.1', timeoutMs = 5000 } = opts;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buf = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`MLLP timeout after ${timeoutMs} ms`))), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(VT + message + FS + CR));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const end = buf.indexOf(FS + CR);
      if (end >= 0) {
        const start = buf.indexOf(VT);
        finish(() => resolve(buf.slice(start + 1, end)));
      }
    });
    socket.on('error', (err) => finish(() => reject(err)));
    socket.on('close', () => finish(() => reject(new MllpClosedError('Connection closed without an ACK'))));
  });
}

/** Resolves true when something accepts TCP connections on the port. */
export function isListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

export const SAMPLE_ORU = [
  'MSH|^~\\&|LAB|HOSP|ACKWELL|HOSP|20261111120000||ORU^R01^ORU_R01|MSG00001|P|2.5.1',
  'PID|1||123456^^^HOSP^MR||DOE^JANE^A||19800101|F',
  'OBR|1|ORD123|FIL456|CBC^COMPLETE BLOOD COUNT^L|||20261111113000',
  'OBX|1|NM|WBC^WBC^L||5.5|10*3/uL|4.0-11.0|N|||F',
].join(CR);

export const SAMPLE_ADT = [
  'MSH|^~\\&|REG|HOSP|ACKWELL|HOSP|20261111080000||ADT^A01|000002|P|2.3',
  'EVN|A01|20261111080000',
  'PID|||MRN001^^^HOSP^MR||SMITH^JOHN||19700707|M',
].join(CR);
