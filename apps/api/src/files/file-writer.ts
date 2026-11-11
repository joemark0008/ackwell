import { randomUUID } from 'node:crypto';
import { access, link, open, rename, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { SEGMENT_SEPARATORS, renderFileName, type FileNameToken, type OutboundFileConfig } from '@ackwell/schemas';
import { FileRootService, STAGING_DIR } from './file-root.service.js';

export interface WrittenFile {
  /** Relative to FILE_ROOT, e.g. `ORDER/ORM_AW123.hl7`. */
  path: string;
  bytes: number;
}

export class FileWriteError extends Error {
  override name = 'FileWriteError';
}

const MAX_SUFFIX = 999;

/** HL7 text with the configured separator; every segment is terminated (HL7 segment terminator). */
export function toFileText(raw: string, separator: OutboundFileConfig['segmentSeparator']): string {
  const segs = raw.split(/\r\n|\r|\n/).filter((s, i, a) => !(s === '' && i === a.length - 1));
  const sep = SEGMENT_SEPARATORS[separator];
  return segs.map((s) => s + sep).join('');
}

/**
 * Writes one message as a finished file (docs/PLAN-FILE-TRANSPORT.md §3a):
 * 1. write + fsync to `FILE_ROOT/.ackwell-tmp/<uuid>.part` (outside the channel folder, so the reader never sees it)
 * 2. check the size on disk
 * 3. move it into the channel folder under its final name, never overwriting an existing file
 *    (`link` fails on an existing name; filesystems without hard links fall back to check + `rename`).
 */
export async function writeHl7File(
  root: FileRootService,
  cfg: OutboundFileConfig,
  raw: string,
  values: Partial<Record<FileNameToken, string>>,
): Promise<WrittenFile> {
  const dir = await root.resolveFolder(cfg.directory, { create: true });
  const staging = await root.resolveFolder(STAGING_DIR, { create: true });
  await root.assertSameDevice([
    { rel: cfg.directory, abs: dir },
    { rel: STAGING_DIR, abs: staging },
  ]);

  const data = Buffer.from(toFileText(raw, cfg.segmentSeparator), cfg.encoding);
  const tmp = join(staging, `${randomUUID()}.part`);
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    const size = (await stat(tmp)).size;
    if (size !== data.length) throw new FileWriteError(`Staged file has ${size} bytes, expected ${data.length}`);

    const name = renderFileName(cfg.fileName, values);
    const ext = extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 0; i <= MAX_SUFFIX; i++) {
      const candidate = i === 0 ? name : `${base}_${i}${ext}`;
      const target = join(dir, candidate);
      if (await placeIfFree(tmp, target)) {
        return { path: root.toRelative(target), bytes: data.length };
      }
      if (cfg.onExists === 'fail') throw new FileWriteError(`${cfg.directory}/${candidate} already exists`);
    }
    throw new FileWriteError(`No free file name for ${name} in ${cfg.directory} (tried ${MAX_SUFFIX} suffixes)`);
  } finally {
    await unlink(tmp).catch(() => undefined); // gone after a rename; removes the staging copy after a link
  }
}

/** Puts `tmp` at `target` only if nothing is there. Returns false when the name is taken. */
async function placeIfFree(tmp: string, target: string): Promise<boolean> {
  try {
    await link(tmp, target);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw e;
  }
  // No hard links (some SMB mounts): check, then rename. Only Ackwell writes into the order folder of a
  // channel and a channel sends strictly one message at a time, so the window is not contended.
  try {
    await access(target);
    return false;
  } catch {
    await rename(tmp, target);
    return true;
  }
}
