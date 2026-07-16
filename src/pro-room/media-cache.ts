import { resolveAudioMime } from '../media/audio-file.ts';
import { PRO_ROOM_MAX_ASSET_BYTES, type ProRoomR2Source } from './contracts.ts';

function proRoomAssetCacheKey(source: Pick<ProRoomR2Source, 'assetId' | 'version'>): string {
  return `${source.assetId}:${source.version}`;
}

export { proRoomAssetCacheKey as proRoomAssetCacheKeyForTests };

interface CacheEntry {
  source: ProRoomR2Source;
  file: File;
}

function effectiveMime(name: string, mime: string): string {
  return resolveAudioMime(name, mime) || 'application/octet-stream';
}

function copyWithName(file: File, name: string, mime: string): File {
  if (file.name === name && file.type === mime) return file;
  return new File([file], name, { type: mime, lastModified: file.lastModified });
}

/**
 * Session-scoped, RAM-only LRU for immutable PRO assets.
 *
 * The default total budget intentionally equals the per-object product limit,
 * so caching multiple tracks can never silently multiply the 200 MiB encoded
 * memory bound. This module has no persistent-storage imports or fallback.
 */
export class ProRoomAssetCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #maxTotalBytes: number;
  #totalBytes = 0;

  constructor(maxTotalBytes = PRO_ROOM_MAX_ASSET_BYTES) {
    if (
      !Number.isSafeInteger(maxTotalBytes) ||
      maxTotalBytes <= 0 ||
      maxTotalBytes > PRO_ROOM_MAX_ASSET_BYTES
    ) {
      throw new Error('PRO_ROOM_CACHE_INVALID_BUDGET');
    }
    this.#maxTotalBytes = maxTotalBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get maxTotalBytes(): number {
    return this.#maxTotalBytes;
  }

  get(source: ProRoomR2Source, name?: string): File | null {
    const key = proRoomAssetCacheKey(source);
    const entry = this.#entries.get(key);
    if (!entry || !this.#matchesSource(entry, source)) {
      if (entry) this.#deleteKey(key);
      return null;
    }

    // Map insertion order is the LRU clock.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    const requestedName = name ?? entry.file.name;
    return copyWithName(entry.file, requestedName, effectiveMime(requestedName, source.mime));
  }

  put(source: ProRoomR2Source, file: File): void {
    if (
      !Number.isSafeInteger(source.byteLength) ||
      source.byteLength <= 0 ||
      source.byteLength > PRO_ROOM_MAX_ASSET_BYTES ||
      file.size !== source.byteLength
    ) {
      throw new Error('PRO_ROOM_CACHE_SIZE_MISMATCH');
    }
    if (file.size > this.#maxTotalBytes) throw new Error('PRO_ROOM_CACHE_BUDGET_EXCEEDED');

    const key = proRoomAssetCacheKey(source);
    this.#deleteKey(key);
    while (this.#totalBytes + file.size > this.#maxTotalBytes) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.#deleteKey(oldestKey);
    }

    const normalizedFile = copyWithName(
      file,
      file.name,
      effectiveMime(file.name, source.mime || file.type),
    );
    this.#entries.set(key, { source: { ...source }, file: normalizedFile });
    this.#totalBytes += normalizedFile.size;
  }

  /**
   * Evict before a whole response body is assembled. Waiting until put()
   * would briefly retain the old LRU bytes and the incoming ArrayBuffer/File
   * at the same time, defeating the cache's peak-memory bound.
   */
  prepareForIncoming(byteLength: number, retainedBytesOutsideCache = 0): void {
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      byteLength > PRO_ROOM_MAX_ASSET_BYTES ||
      !Number.isSafeInteger(retainedBytesOutsideCache) ||
      retainedBytesOutsideCache < 0 ||
      retainedBytesOutsideCache + byteLength > PRO_ROOM_MAX_ASSET_BYTES
    ) {
      throw new Error('PRO_ROOM_CACHE_BUDGET_EXCEEDED');
    }
    while (this.#totalBytes + retainedBytesOutsideCache + byteLength > this.#maxTotalBytes) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.#deleteKey(oldestKey);
    }
  }

  delete(source: Pick<ProRoomR2Source, 'assetId' | 'version'>): boolean {
    return this.#deleteKey(proRoomAssetCacheKey(source));
  }

  deleteAsset(assetId: string): number {
    let deleted = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.source.assetId === assetId && this.#deleteKey(key)) deleted += 1;
    }
    return deleted;
  }

  clear(): void {
    this.#entries.clear();
    this.#totalBytes = 0;
  }

  #matchesSource(entry: CacheEntry, source: ProRoomR2Source): boolean {
    return (
      entry.source.assetId === source.assetId &&
      entry.source.version === source.version &&
      entry.source.byteLength === source.byteLength &&
      entry.source.mime === source.mime &&
      entry.source.sha256 === source.sha256 &&
      entry.file.size === source.byteLength
    );
  }

  #deleteKey(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#totalBytes -= entry.file.size;
    return true;
  }
}
