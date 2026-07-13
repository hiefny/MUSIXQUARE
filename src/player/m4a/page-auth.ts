import { ISO_BMFF_MAX_BOUNDED_READ_BYTES, IsoBmffBoxReader } from '../mp4/box-reader.ts';

export type M4aPageAuthenticationErrorFactory = (message: string, cause?: unknown) => Error;

/**
 * Hash one already-owned bounded metadata page while preserving abort and
 * encoded-source identity failures ahead of crypto failures.
 */
export async function digestM4aMetadataPage(
  reader: IsoBmffBoxReader,
  bytes: Uint8Array,
  signal: AbortSignal,
  label: string,
  createError: M4aPageAuthenticationErrorFactory,
): Promise<string> {
  reader.assertReadable(signal);
  if (bytes.byteLength < 1 || bytes.byteLength > ISO_BMFF_MAX_BOUNDED_READ_BYTES) {
    throw createError(`${label} must contain 1 through ${ISO_BMFF_MAX_BOUNDED_READ_BYTES} bytes`);
  }

  let digest: ArrayBuffer;
  try {
    // Keep WebCrypto isolated from caller/source aliases even though
    // IsoBmffBoxReader already returns an owned, non-shared Uint8Array.
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer);
  } catch (error) {
    reader.assertReadable(signal);
    throw createError(`${label} could not be authenticated`, error);
  }
  reader.assertReadable(signal);

  let result = '';
  for (const value of new Uint8Array(digest)) result += value.toString(16).padStart(2, '0');
  return result;
}
