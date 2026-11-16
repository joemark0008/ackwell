import type { Socket } from 'node:net';
import type { Logger } from '@nestjs/common';
import { Server, type Inbound, type InboundHandler, type InboundRequest } from 'node-hl7-server';

type AckResponder = Parameters<InboundHandler>[1];
import { Allowlist, normalizeIp } from './allowlist.js';

/** How long `close()` waits for running handlers before destroying their sockets anyway. */
const DRAIN_TIMEOUT_MS = 10_000;

export type AckCode = 'AA' | 'AE' | 'AR';

export interface InboundMessage {
  /** Exact bytes of the HL7 message as received (MLLP framing removed). */
  raw: string;
  remoteAddress: string | null;
  /** `message` for a single message; `batch` / `file` for messages unpacked from a BHS/FHS frame. */
  frameType: string;
}

/** Decides the ACK for one message. The handler must persist before returning `AA`. */
export type InboundMessageHandler = (msg: InboundMessage) => Promise<AckCode>;

export interface InboundListenerOptions {
  port: number;
  bindAddress: string;
  allowlist: readonly string[];
  /** Label for log lines. */
  name: string;
  /** PEM material for a TLS listener (never logged). `ca` + `requestCert` verify client certificates. */
  tls?: { cert: string; key: string; ca?: string; requestCert?: boolean };
}

/**
 * One MLLP listener (node-hl7-server `Inbound`) for one channel.
 *
 * - `start()` resolves once the port is bound and rejects with the socket error (e.g. EADDRINUSE) otherwise.
 * - Connections from addresses outside the allowlist are closed before any data is read.
 * - For every message the handler runs first; its ACK code is sent only after it returns, so a
 *   handler that commits to the database before returning `AA` gives persist-before-ACK.
 */
export class InboundListener {
  private readonly server: Server;
  private inbound: Inbound | null = null;
  private lastRaw: string | null = null;
  private readonly allowlist: Allowlist;
  private closed = false;
  /** Handlers still running (persist + ACK). `close()` waits for them so no sender loses its ACK. */
  private readonly inflight = new Set<Promise<void>>();
  /** Called when the listener fails after it started (socket error). */
  onCrash: ((err: Error) => void) | null = null;

  constructor(
    private readonly opts: InboundListenerOptions,
    private readonly handler: InboundMessageHandler,
    private readonly log: Logger,
  ) {
    this.allowlist = new Allowlist(opts.allowlist);
    this.server = new Server({
      bindAddress: opts.bindAddress,
      ...(opts.tls
        ? {
            tls: {
              cert: opts.tls.cert,
              key: opts.tls.key,
              ...(opts.tls.ca ? { ca: opts.tls.ca } : {}),
              requestCert: opts.tls.requestCert ?? false,
            },
          }
        : {}),
    });
  }

  get port(): number {
    return this.opts.port;
  }

  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let started = false;
      const inbound = this.server.createInbound(
        { port: this.opts.port, acceptAnyVersion: true, name: `ch_${this.opts.name}` },
        (req, res) => void this.handle(req, res),
      );
      this.inbound = inbound;

      inbound.on('listen', () => {
        started = true;
        resolve();
      });
      inbound.on('error', (err: Error) => {
        if (!started) {
          this.inbound = null;
          reject(err);
          return;
        }
        if (this.closed) return;
        this.log.error(`Listener ${this.opts.name} on :${this.opts.port} failed: ${err.message}`);
        this.onCrash?.(err);
      });
      inbound.on('client.connect', (socket: Socket) => this.onConnect(socket));
      inbound.on('client.error', (err: Error) => this.log.warn(`Client error on :${this.opts.port}: ${err.message}`));
      inbound.on('data.error', (err: Error) => this.log.warn(`Data error on :${this.opts.port}: ${err.message}`));
      // Emitted synchronously right before the handler is invoked for the frame's message(s).
      inbound.on('data.raw', (raw: string) => {
        this.lastRaw = raw;
      });
    });
  }

  /**
   * Graceful close: new connections are refused and new messages get AR (nothing stored, the sender
   * retries later), handlers already running finish and write their ACK, then the sockets are closed.
   * node-hl7-server's own `close()` destroys every socket at once, which would cut off those ACKs.
   */
  async close(): Promise<void> {
    this.closed = true;
    const inbound = this.inbound;
    this.inbound = null;
    if (!inbound) return;
    if (this.inflight.size > 0) {
      const drained = Promise.allSettled([...this.inflight]);
      const deadline = new Promise<void>((r) => setTimeout(r, DRAIN_TIMEOUT_MS).unref());
      await Promise.race([drained, deadline]);
      if (this.inflight.size > 0) {
        this.log.warn(`Closing :${this.opts.port} with ${this.inflight.size} message(s) still in flight after ${DRAIN_TIMEOUT_MS} ms`);
      }
      // Let the ACK writes reach the socket before it is destroyed.
      await new Promise<void>((r) => setImmediate(r));
    }
    await inbound.close();
  }

  private onConnect(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const ip = socket.remoteAddress ? normalizeIp(socket.remoteAddress) : undefined;
    if (!this.allowlist.allows(ip)) {
      this.log.warn(`Rejected connection from ${ip ?? 'unknown'} on :${this.opts.port} (not in allowlist)`);
      socket.destroy();
      return;
    }
    this.log.debug(`Connection from ${ip ?? 'unknown'} on :${this.opts.port}`);
  }

  private handle(req: InboundRequest, res: AckResponder): Promise<void> {
    const run = this.handleTracked(req, res).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
    return run;
  }

  private async handleTracked(req: InboundRequest, res: AckResponder): Promise<void> {
    let remoteAddress: string | null = null;
    try {
      remoteAddress = normalizeIp(req.getSocket().remoteAddress ?? '') || null;
    } catch {
      /* socket not available */
    }
    const frameType = req.getType();
    // A single-message frame is stored byte for byte; batch/file frames are unpacked by the library.
    const raw = frameType === 'message' && this.lastRaw !== null ? this.lastRaw : req.getMessage().toString();

    let code: AckCode;
    try {
      // Shutting down: nothing is stored, AR tells the sender to try again (on the next instance).
      code = this.closed ? 'AR' : await this.handler({ raw, remoteAddress, frameType });
    } catch (e) {
      this.log.error(`Handler failed on :${this.opts.port}: ${(e as Error).message}`);
      code = 'AE';
    }
    try {
      await res.sendResponse(code);
    } catch (e) {
      this.log.warn(`Could not send ${code} on :${this.opts.port}: ${(e as Error).message}`);
    }
  }
}
