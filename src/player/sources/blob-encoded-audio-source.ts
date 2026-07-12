import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';

const blobIdentities = new WeakMap<Blob, string>();
let fallbackIdentityCounter = 0;

function createOpaqueIdentity(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return `blob:${randomUUID.call(globalThis.crypto)}`;
  fallbackIdentityCounter += 1;
  return `blob:runtime-${fallbackIdentityCounter.toString(36)}`;
}

/**
 * Return a runtime-stable identity for one Blob/File object.
 *
 * Two separate File objects with the same name, size, and timestamp remain
 * distinct. This identity is intentionally process-local and is never used as
 * a content hash or distributed protocol identifier.
 */
export function getBlobObjectIdentity(blob: Blob): string {
  const current = blobIdentities.get(blob);
  if (current) return current;
  const identity = createOpaqueIdentity();
  blobIdentities.set(blob, identity);
  return identity;
}

function metadataForBlob(blob: Blob, metadata?: Partial<EncodedAudioSourceMetadata>) {
  const fileName = typeof File !== 'undefined' && blob instanceof File ? blob.name : '';
  return Object.freeze({
    name: metadata?.name?.trim() || fileName || 'audio',
    mime: metadata?.mime?.trim() || blob.type || 'application/octet-stream',
  });
}

export interface BlobEncodedAudioSourceOptions {
  /** Explicit distributed identity when a queue/transfer already provides one. */
  identity?: string;
  metadata?: Partial<EncodedAudioSourceMetadata>;
}

export class BlobEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly size: number;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;

  private readonly blob: Blob;
  private closed = false;

  constructor(blob: Blob, options: BlobEncodedAudioSourceOptions = {}) {
    const identity = options.identity?.trim() || getBlobObjectIdentity(blob);
    if (!identity) throw new TypeError('Encoded audio source identity is required');
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) {
      throw new RangeError('Blob size must be a non-negative safe integer');
    }
    this.blob = blob;
    this.size = blob.size;
    this.identity = identity;
    this.metadata = metadataForBlob(blob, options.metadata);
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.closed) throw new EncodedSourceClosedError();
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    if (length === 0) return new Uint8Array(0);

    const buffer = await this.blob.slice(offset, end).arrayBuffer();

    // Blob.arrayBuffer() cannot be interrupted consistently. Recheck both the
    // source lifetime and the caller signal before publishing the bytes.
    throwIfAborted(signal);
    if (this.closed) throw new EncodedSourceClosedError();
    if (buffer.byteLength !== length) {
      throw new EncodedSourceIntegrityError(
        `Blob read returned ${buffer.byteLength} bytes; expected ${length}`,
      );
    }
    return new Uint8Array(buffer);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
