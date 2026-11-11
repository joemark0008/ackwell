import net from 'node:net';
import tls from 'node:tls';
import { parseHl7, fieldText, findSegment } from '@ackwell/schemas';
import type { Hl7Version } from '@ackwell/schemas';

const VT = '\x0b';
const FS = '\x1c';
const CR = '\r';

export interface SendParams {
  host: string;
  port: number;
  tls: boolean;
  /** TLS only: CA PEM that signed the receiver's certificate. */
  ca?: string | undefined;
  /** TLS only: verify the receiver's certificate (default false, LAN receivers are often self-signed). */
  rejectUnauthorized?: boolean | undefined;
  version: Hl7Version;
  /** Full HL7 message (segments separated by \r). */
  raw: string;
  /** Time budget for connect + ACK. */
  ackTimeoutMs: number;
}

export interface SendResult {
  /** MSA-1 of the ACK: AA, AE, AR, CA, CE, CR (or whatever the receiver sent). */
  ackCode: string;
  /** MSA-2 of the ACK (should echo our MSH-10). */
  ackControlId: string;
  /** The ACK message as received (MLLP framing removed). */
  ackRaw: string;
}

export type MllpErrorCode = 'ECONNREFUSED' | 'ETIMEDOUT' | 'ACK_TIMEOUT' | 'CLOSED' | 'BAD_ACK' | 'ERROR';

/** Transport-level failure (connect, timeout, socket, unparseable ACK). Retryable by the worker. */
export class MllpSendError extends Error {
  override name = 'MllpSendError';
  constructor(
    message: string,
    readonly code: MllpErrorCode = 'ERROR',
  ) {
    super(message);
  }
}

/**
 * Sends one HL7 message over MLLP and resolves with its ACK: connect → write frame → read the ACK
 * frame → destroy the socket. One short-lived connection per message keeps the worker simple and
 * leak-free (node-hl7-client 4.1 was tried first: it opened two sockets per connection and
 * `close()` left them open, so it is only used for inbound).
 *
 * TLS: `tls.connect`; `rejectUnauthorized` defaults to false (LAN receivers usually have self-signed
 * certificates) and can be switched on per channel, optionally with a `ca` PEM.
 */
export function sendHl7(p: SendParams): Promise<SendResult> {
  return new Promise<SendResult>((resolve, reject) => {
    let settled = false;
    let buf = '';
    const socket: net.Socket = p.tls
      ? tls.connect({ host: p.host, port: p.port, rejectUnauthorized: p.rejectUnauthorized ?? false, ...(p.ca ? { ca: p.ca } : {}), servername: net.isIP(p.host) ? undefined : p.host })
      : net.connect({ host: p.host, port: p.port });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const fail = (message: string, code: MllpErrorCode) => finish(() => reject(new MllpSendError(message, code)));
    const timer = setTimeout(() => fail(`No ACK within ${p.ackTimeoutMs} ms`, 'ACK_TIMEOUT'), p.ackTimeoutMs);

    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    socket.once(p.tls ? 'secureConnect' : 'connect', () => {
      socket.write(VT + p.raw + FS + CR);
    });
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const end = buf.indexOf(FS + CR);
      if (end < 0) return;
      const start = buf.indexOf(VT);
      const ackRaw = buf.slice(start >= 0 && start < end ? start + 1 : 0, end);
      finish(() => {
        try {
          const ack = parseHl7(ackRaw);
          const msa = findSegment(ack, 'MSA');
          if (!msa) throw new Error('ACK has no MSA segment');
          resolve({
            ackCode: fieldText(msa.fields[0], ack.delimiters),
            ackControlId: fieldText(msa.fields[1], ack.delimiters),
            ackRaw,
          });
        } catch (e) {
          reject(new MllpSendError(`Unreadable ACK: ${(e as Error).message}`, 'BAD_ACK'));
        }
      });
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      const code: MllpErrorCode = err.code === 'ECONNREFUSED' ? 'ECONNREFUSED' : err.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'ERROR';
      fail(`Connection error: ${err.message}`, code);
    });
    socket.on('close', () => fail('Connection closed before an ACK was received', 'CLOSED'));
  });
}
