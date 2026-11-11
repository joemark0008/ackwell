import { z } from 'zod';
import { relativeFolderSchema } from './channel';

/** A file an inbound file channel moved to its error folder (GET /channels/:id/files/errors). */
export const fileErrorEntrySchema = z.object({
  /** File name inside the error folder. */
  name: z.string(),
  size: z.number().int(),
  modifiedAt: z.string(),
  /** Why it was rejected (from `<name>.error.txt`). */
  reason: z.string(),
});
export type FileErrorEntry = z.infer<typeof fileErrorEntrySchema>;

/** POST /channels/check-folder body. */
export const folderCheckRequestSchema = z.object({ directory: relativeFolderSchema }).strict();
export type FolderCheckRequest = z.infer<typeof folderCheckRequestSchema>;

/** Result of checking a folder inside the shared root. Nothing is created. */
export const folderCheckSchema = z.object({
  directory: z.string(),
  exists: z.boolean(),
  readable: z.boolean(),
  writable: z.boolean(),
  /** Number of entries (files and folders) when readable. */
  entries: z.number().int().nullable(),
  /** Why it is not usable, when it is not. A missing folder is created when the channel starts. */
  error: z.string().nullable(),
});
export type FolderCheck = z.infer<typeof folderCheckSchema>;
