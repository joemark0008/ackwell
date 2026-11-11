import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Logger } from '@nestjs/common';
import { matchesInclude, type InboundFileConfig } from '@ackwell/schemas';
import { watch, type FSWatcher } from 'chokidar';

/** What the import step did with one file. `retry` = not finished yet (still changing), look again later. */
export type FileOutcome = 'imported' | 'duplicate' | 'error' | 'retry' | 'gone';

export type FileHandler = (absPath: string) => Promise<FileOutcome>;

export interface InboundFileWatcherOptions {
  /** Absolute watched folder. */
  folder: string;
  config: InboundFileConfig;
  /** Label for log lines. */
  name: string;
  /** Full rescan interval (safety net for missed events and share outages). */
  rescanMs?: number;
}

/**
 * Watches one inbound folder (chokidar) and feeds finished files to the handler, one at a time, oldest
 * first. Polling is the default because network shares do not report files written by other machines.
 *
 * - Files already in the folder at start are picked up (backlog).
 * - chokidar's `awaitWriteFinish` holds `add` until the size stops changing; the handler double-checks
 *   and answers `retry` if the file is still being written.
 * - A periodic rescan re-queues anything still in the folder and reports reachability through `onHealth`.
 */
export class InboundFileWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private draining = false;
  private closed = false;
  private healthy = true;
  /** Called when the folder becomes unreachable (`ok: false`) or reachable again. */
  onHealth: ((ok: boolean, error?: string) => void) | null = null;

  constructor(
    private readonly opts: InboundFileWatcherOptions,
    private readonly handler: FileHandler,
    private readonly log: Logger,
  ) {}

  get folder(): string {
    return this.opts.folder;
  }

  /** Resolves once chokidar finished the initial scan. */
  async start(): Promise<void> {
    const cfg = this.opts.config;
    const w = watch(this.opts.folder, {
      depth: 0,
      ignoreInitial: false,
      usePolling: cfg.usePolling,
      interval: cfg.pollIntervalMs,
      binaryInterval: cfg.pollIntervalMs,
      awaitWriteFinish: { stabilityThreshold: cfg.stableMs, pollInterval: Math.min(500, cfg.stableMs) },
      ignored: (p, stats) => p !== this.opts.folder && (basename(p).startsWith('.') || (stats?.isFile() === true && !this.wanted(p))),
    });
    this.watcher = w;
    w.on('add', (p) => this.enqueue(p));
    w.on('error', (err) => this.setHealth(false, (err as Error).message));
    await new Promise<void>((resolve) => w.once('ready', () => resolve()));
    this.timer = setInterval(() => void this.rescan(), this.opts.rescanMs ?? 60_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.queue.length = 0;
    this.queued.clear();
    await this.watcher?.close();
    this.watcher = null;
  }

  /** Lists the folder and queues every matching file (also used right after start and by tests). */
  async rescan(): Promise<void> {
    if (this.closed) return;
    let names: string[];
    try {
      names = await readdir(this.opts.folder);
    } catch (e) {
      this.setHealth(false, `Folder not reachable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      return;
    }
    this.setHealth(true);
    for (const n of names.sort()) {
      const p = join(this.opts.folder, n);
      if (!n.startsWith('.') && this.wanted(p)) this.enqueue(p);
    }
  }

  private wanted(p: string): boolean {
    return matchesInclude(basename(p), this.opts.config.include);
  }

  private enqueue(p: string): void {
    if (this.closed || this.queued.has(p)) return;
    this.queued.add(p);
    this.queue.push(p);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.length) {
        const p = this.queue.shift()!;
        let outcome: FileOutcome;
        try {
          outcome = await this.handler(p);
        } catch (e) {
          // Unexpected (DB down, share gone mid-move): leave the file, the next rescan tries again.
          this.log.warn(`File ${basename(p)} on ${this.opts.name} not processed: ${(e as Error).message}`);
          outcome = 'gone';
        }
        this.queued.delete(p);
        if (outcome === 'retry') this.retryLater(p);
      }
    } finally {
      this.draining = false;
    }
  }

  private retryLater(p: string): void {
    const t = setTimeout(() => {
      this.retryTimers.delete(t);
      this.enqueue(p);
    }, this.opts.config.stableMs);
    t.unref?.();
    this.retryTimers.add(t);
  }

  private setHealth(ok: boolean, error?: string): void {
    if (this.closed || ok === this.healthy) return;
    this.healthy = ok;
    if (!ok) this.log.warn(`Inbound folder for ${this.opts.name} unavailable: ${error}`);
    else this.log.log(`Inbound folder for ${this.opts.name} reachable again`);
    this.onHealth?.(ok, error);
  }
}
