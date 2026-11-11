import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { isSafeRelativeFolder } from '@ackwell/schemas';
import { ENV, type Env } from '../config/env.js';

/** Staging folder (inside the root, outside every channel folder) for files being written. */
export const STAGING_DIR = '.ackwell-tmp';

export class FileRootError extends Error {
  override name = 'FileRootError';
  constructor(
    message: string,
    readonly code: 'NO_FILE_ROOT' | 'OUTSIDE_ROOT' | 'NOT_A_FOLDER' | 'CROSS_DEVICE' | 'UNREACHABLE',
  ) {
    super(message);
  }
}

/**
 * The shared root (`FILE_ROOT`) every file channel works in. All channel folders are relative to it;
 * `resolveFolder` refuses anything that ends up outside the root, also through symlinks.
 */
@Injectable()
export class FileRootService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return Boolean(this.env.FILE_ROOT);
  }

  /** Absolute root, or throws `NO_FILE_ROOT`. */
  get root(): string {
    if (!this.env.FILE_ROOT) {
      throw new FileRootError('File channels need FILE_ROOT (the mounted shared folder) on the server', 'NO_FILE_ROOT');
    }
    return resolve(this.env.FILE_ROOT);
  }

  /** Throws a 400 when FILE_ROOT is not configured (for create/update/check endpoints). */
  assertEnabled(): void {
    if (!this.enabled) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'FILES_DISABLED',
        message: 'File channels are not available: the server has no shared folder (FILE_ROOT) configured',
      });
    }
  }

  /**
   * Absolute path of a channel folder, creating it when `create`. Checks (after resolving symlinks) that
   * it is inside the root and is a directory.
   */
  async resolveFolder(rel: string, { create = false } = {}): Promise<string> {
    if (!isSafeRelativeFolder(rel) && rel !== STAGING_DIR) {
      throw new FileRootError(`"${rel}" is not a folder inside the shared root`, 'OUTSIDE_ROOT');
    }
    const root = this.root;
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch (e) {
      throw new FileRootError(`Shared root ${root} is not reachable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, 'UNREACHABLE');
    }
    const abs = join(realRoot, ...rel.split('/'));
    if (create) await mkdir(abs, { recursive: true });
    let real: string;
    try {
      real = await realpath(abs);
    } catch (e) {
      throw new FileRootError(`Folder ${rel} does not exist (${(e as NodeJS.ErrnoException).code ?? 'error'})`, 'UNREACHABLE');
    }
    if (!isInside(realRoot, real)) throw new FileRootError(`Folder ${rel} points outside the shared root`, 'OUTSIDE_ROOT');
    const st = await stat(real);
    if (!st.isDirectory()) throw new FileRootError(`${rel} is not a folder`, 'NOT_A_FOLDER');
    return real;
  }

  /** Path relative to the root, `/`-separated (what is stored in the DB and shown in the UI). */
  toRelative(abs: string): string {
    return relative(this.root, abs).split(sep).join('/');
  }

  /**
   * Moves within the root must be atomic renames, so all folders have to be on one filesystem (one mount).
   * Throws `CROSS_DEVICE` naming the first folder that is not.
   */
  async assertSameDevice(folders: { rel: string; abs: string }[]): Promise<void> {
    const devs = await Promise.all(folders.map(async (f) => ({ ...f, dev: (await stat(f.abs)).dev })));
    const first = devs[0];
    const other = devs.find((d) => d.dev !== first?.dev);
    if (first && other) {
      throw new FileRootError(
        `Folders ${first.rel} and ${other.rel} are on different filesystems; mount only the shared root so moves stay atomic`,
        'CROSS_DEVICE',
      );
    }
  }
}

function isInside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}
