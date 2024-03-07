import { fileTypeFromBuffer } from 'file-type';

export interface SniffedType {
  mime: string;
  /** File extension without the dot, safe to use in a generated file name. */
  ext: string;
}

/**
 * Identifies a file from its leading bytes. The client-supplied Content-Type is only a claim:
 * trusting it would let anyone store HTML or scripts under an image type. Text-based formats
 * have no reliable signature, so they come back undefined and are refused.
 */
export async function sniffType(data: Buffer): Promise<SniffedType | undefined> {
  const found = await fileTypeFromBuffer(data);
  if (!found || !/^[a-z0-9]{1,8}$/.test(found.ext)) return undefined;
  return { mime: found.mime, ext: found.ext };
}
