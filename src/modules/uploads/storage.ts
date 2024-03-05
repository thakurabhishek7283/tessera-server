import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where uploaded bytes live. Local disk today; the interface is the seam for S3-style storage. */
export interface UploadStorage {
  /** Persists `data` under a server-generated file name. */
  save(name: string, data: Buffer): Promise<void>;
}

/** Stores uploads as plain files inside `dir` (created on startup). */
export function createDiskStorage(dir: string): UploadStorage {
  mkdirSync(dir, { recursive: true });
  return {
    // `wx` fails instead of overwriting, so a (practically impossible) id clash is not silent.
    save: (name, data) => writeFile(join(dir, name), data, { flag: 'wx' }),
  };
}
