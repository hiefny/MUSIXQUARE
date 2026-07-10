/**
 * Ephemeral bridge between a chunk-encrypted remote share and an HTML media
 * element. Keys live only in this page and in the controlling service worker;
 * neither plaintext nor ciphertext is written to browser storage.
 */

import { REMOTE_SHARE_CRYPTO_CHUNK_BYTES, REMOTE_SHARE_GCM_TAG_BYTES } from '../core/constants.ts';
import type { PreparedMediaElementSource } from '../player/media-element.ts';
import type { RemoteFileSharePayload } from '../types/index.ts';
import { validateChunkMetadata } from './crypto.ts';
import { resolveRemoteDownloadUrl } from './r2-client.ts';

const REMOTE_MEDIA_PROTOCOL_VERSION = 1;
const REMOTE_MEDIA_ROUTE = '/__mxqr_media/';
const FEATURE_PING_TIMEOUT_MS = 800;
const FEATURE_UPDATE_TIMEOUT_MS = 8_000;
const OPAQUE_BYTES = 24;
const MAX_FILE_NAME_CHARS = 180;
const AUDIO_MIME_PATTERN = /^audio\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface RemoteMediaVaultEntry {
  readonly key: CryptoKey;
  readonly noncePrefix: Uint8Array;
  readonly downloadUrl: string;
  readonly roomId: string;
  readonly objectId: string;
  readonly plainSize: number;
  readonly encryptedSize: number;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly tagBytes: number;
  readonly mime: string;
}

interface RemoteMediaResolveRequest {
  readonly type: 'MXQR_REMOTE_MEDIA_RESOLVE';
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly opaqueId: string;
}

interface RemoteMediaSource {
  readonly url: string;
  readonly opaqueId: string;
  readonly fileName: string;
  readonly mime: string;
  readonly size: number;
  readonly released: boolean;
  release(): void;
}

interface CreateRemoteMediaOptions {
  readonly signal?: AbortSignal;
}

const vault = new Map<string, RemoteMediaVaultEntry>();
const remoteMediaFiles = new WeakMap<RemoteMediaFile, RemoteMediaSource>();
const preparedRemoteMediaFiles = new WeakSet<RemoteMediaFile>();
let messageListenerInstalled = false;
let featureReadyController: ServiceWorker | null = null;
let featureReadyPromise: Promise<void> | null = null;

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID', { cause: error });
  }
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function createOpaqueId(): string {
  const bytes = new Uint8Array(OPAQUE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    output += code <= 0x1f || code === 0x7f ? '_' : character;
  }
  return output;
}

function sanitizeFileName(value: string): string {
  const leaf = value.split(/[\\/]/).pop() ?? '';
  const sanitized = replaceControlCharacters(leaf)
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, MAX_FILE_NAME_CHARS);
  return sanitized || 'remote-media';
}

function sanitizeMime(value: string): string {
  const mime = value.trim();
  return mime.length <= 200 && !hasControlCharacters(mime) && AUDIO_MIME_PATTERN.test(mime)
    ? mime.toLowerCase()
    : 'application/octet-stream';
}

function assertV2Descriptor(descriptor: RemoteFileSharePayload): void {
  if (
    descriptor.cryptoVersion !== 2 ||
    descriptor.chunkSize !== REMOTE_SHARE_CRYPTO_CHUNK_BYTES ||
    descriptor.tagBytes !== REMOTE_SHARE_GCM_TAG_BYTES ||
    !descriptor.chunkCount
  ) {
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  }
  validateChunkMetadata(
    descriptor.size,
    descriptor.encryptedSize,
    descriptor.chunkSize,
    descriptor.chunkCount,
    descriptor.tagBytes,
  );
}

function isResolveRequest(value: unknown): value is RemoteMediaResolveRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<RemoteMediaResolveRequest>;
  return (
    message.type === 'MXQR_REMOTE_MEDIA_RESOLVE' &&
    message.protocolVersion === REMOTE_MEDIA_PROTOCOL_VERSION &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0 &&
    message.requestId.length <= 160 &&
    typeof message.opaqueId === 'string' &&
    /^[A-Za-z0-9_-]{22,128}$/.test(message.opaqueId)
  );
}

function installVaultMessageListener(): void {
  if (messageListenerInstalled) return;
  const serviceWorker = navigator.serviceWorker;
  serviceWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isResolveRequest(event.data)) return;
    const controller = serviceWorker.controller;
    const source = event.source as ServiceWorker | null;
    // Only the worker currently controlling this page may request a key.
    if (!controller || source !== controller || typeof source.postMessage !== 'function') return;
    const entry = vault.get(event.data.opaqueId);
    if (!entry) return;
    source.postMessage({
      type: 'MXQR_REMOTE_MEDIA_SESSION',
      protocolVersion: REMOTE_MEDIA_PROTOCOL_VERSION,
      requestId: event.data.requestId,
      opaqueId: event.data.opaqueId,
      session: {
        key: entry.key,
        noncePrefix: copyBytes(entry.noncePrefix),
        downloadUrl: entry.downloadUrl,
        roomId: entry.roomId,
        objectId: entry.objectId,
        plainSize: entry.plainSize,
        encryptedSize: entry.encryptedSize,
        chunkSize: entry.chunkSize,
        chunkCount: entry.chunkCount,
        tagBytes: entry.tagBytes,
        mime: entry.mime,
      },
    });
  });
  serviceWorker.addEventListener('controllerchange', () => {
    if (featureReadyController !== serviceWorker.controller) featureReadyController = null;
  });
  messageListenerInstalled = true;
}

function pingServiceWorker(worker: ServiceWorker): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(supported);
    };
    const timeoutId = globalThis.setTimeout(() => finish(false), FEATURE_PING_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown; protocolVersion?: unknown } | null;
      finish(
        data?.type === 'MXQR_REMOTE_MEDIA_PONG' &&
          data.protocolVersion === REMOTE_MEDIA_PROTOCOL_VERSION,
      );
    };
    channel.port1.start();
    try {
      worker.postMessage(
        { type: 'MXQR_REMOTE_MEDIA_PING', protocolVersion: REMOTE_MEDIA_PROTOCOL_VERSION },
        [channel.port2],
      );
    } catch {
      finish(false);
    }
  });
}

function waitForWorkerState(worker: ServiceWorker): Promise<void> {
  if (worker.state === 'installed' || worker.state === 'activated') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      globalThis.clearTimeout(timeoutId);
      worker.removeEventListener('statechange', onStateChange);
    };
    const onStateChange = (): void => {
      if (worker.state === 'installed' || worker.state === 'activated') {
        cleanup();
        resolve();
      } else if (worker.state === 'redundant') {
        cleanup();
        reject(new Error('REMOTE_MEDIA_SW_UPDATE_FAILED'));
      }
    };
    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error('REMOTE_MEDIA_SW_UPDATE_TIMEOUT'));
    }, FEATURE_UPDATE_TIMEOUT_MS);
    worker.addEventListener('statechange', onStateChange);
    onStateChange();
  });
}

function waitForControllerChange(
  container: ServiceWorkerContainer,
  previous: ServiceWorker | null,
): Promise<ServiceWorker> {
  const current = container.controller;
  if (current && current !== previous) return Promise.resolve(current);
  return new Promise<ServiceWorker>((resolve, reject) => {
    const cleanup = (): void => {
      globalThis.clearTimeout(timeoutId);
      container.removeEventListener('controllerchange', onControllerChange);
    };
    const onControllerChange = (): void => {
      const next = container.controller;
      if (!next || next === previous) return;
      cleanup();
      resolve(next);
    };
    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error('REMOTE_MEDIA_SW_CONTROL_TIMEOUT'));
    }, FEATURE_UPDATE_TIMEOUT_MS);
    container.addEventListener('controllerchange', onControllerChange);
    onControllerChange();
  });
}

async function forceFeatureWorker(
  container: ServiceWorkerContainer,
  registration: ServiceWorkerRegistration,
  previous: ServiceWorker | null,
): Promise<ServiceWorker> {
  await registration.update();
  let candidate = registration.waiting ?? registration.installing;
  if (!candidate && registration.active && registration.active !== previous) {
    candidate = registration.active;
  }
  if (!candidate) throw new Error('REMOTE_MEDIA_SW_UPDATE_MISSING');
  await waitForWorkerState(candidate);
  const readyCandidate = registration.waiting ?? candidate;
  if (!(await pingServiceWorker(readyCandidate))) {
    throw new Error('REMOTE_MEDIA_SW_FEATURE_MISSING');
  }
  if (readyCandidate.state === 'installed') {
    readyCandidate.postMessage({ type: 'SKIP_WAITING' });
  }
  const controller =
    container.controller && container.controller !== previous
      ? container.controller
      : await waitForControllerChange(container, previous);
  if (!(await pingServiceWorker(controller))) {
    throw new Error('REMOTE_MEDIA_SW_FEATURE_MISSING');
  }
  return controller;
}

/** Ensure the controlling worker understands the virtual-media protocol. */
function ensureRemoteMediaServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return Promise.reject(new Error('REMOTE_MEDIA_SW_UNAVAILABLE'));
  }
  installVaultMessageListener();
  const current = navigator.serviceWorker.controller;
  if (current && current === featureReadyController) return Promise.resolve();
  if (featureReadyPromise) return featureReadyPromise;

  featureReadyPromise = (async () => {
    const container = navigator.serviceWorker;
    const controller = container.controller;
    if (controller && (await pingServiceWorker(controller))) {
      featureReadyController = controller;
      return;
    }
    const registration = await container.getRegistration();
    if (!registration) throw new Error('REMOTE_MEDIA_SW_UNAVAILABLE');
    featureReadyController = await forceFeatureWorker(container, registration, controller);
  })().finally(() => {
    featureReadyPromise = null;
  });
  return featureReadyPromise;
}

export const ensureRemoteMediaServiceWorkerForTests = ensureRemoteMediaServiceWorker;

/** Create an ephemeral same-origin URL backed by encrypted remote chunks. */
async function createRemoteMediaSource(
  descriptor: RemoteFileSharePayload,
  options: CreateRemoteMediaOptions = {},
): Promise<RemoteMediaSource> {
  assertV2Descriptor(descriptor);
  if (options.signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
  const downloadUrl = resolveRemoteDownloadUrl(
    descriptor.roomId,
    descriptor.objectId,
    descriptor.downloadUrl,
  );
  const fileName = sanitizeFileName(descriptor.name);
  const mime = sanitizeMime(descriptor.mime);
  const keyBytes = decodeBase64(descriptor.keyB64);
  const noncePrefix = decodeBase64(descriptor.ivB64);
  if (keyBytes.byteLength !== 32 || noncePrefix.byteLength !== 8) {
    keyBytes.fill(0);
    noncePrefix.fill(0);
    throw new Error('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  }

  let key: CryptoKey;
  const rawKey = copyBytes(keyBytes);
  try {
    key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  } finally {
    new Uint8Array(rawKey).fill(0);
    keyBytes.fill(0);
  }
  if (options.signal?.aborted) {
    noncePrefix.fill(0);
    throw new Error('REMOTE_SHARE_ABORTED');
  }
  await ensureRemoteMediaServiceWorker();
  if (options.signal?.aborted) {
    noncePrefix.fill(0);
    throw new Error('REMOTE_SHARE_ABORTED');
  }

  const opaqueId = createOpaqueId();
  vault.set(opaqueId, {
    key,
    noncePrefix,
    downloadUrl,
    roomId: descriptor.roomId,
    objectId: descriptor.objectId,
    plainSize: descriptor.size,
    encryptedSize: descriptor.encryptedSize,
    chunkSize: descriptor.chunkSize as number,
    chunkCount: descriptor.chunkCount as number,
    tagBytes: descriptor.tagBytes as number,
    mime,
  });
  let released = false;
  const abort = (): void => source.release();
  const source: RemoteMediaSource = {
    url: new URL(
      `${REMOTE_MEDIA_ROUTE}${opaqueId}/${encodeURIComponent(fileName)}`,
      location.origin,
    ).toString(),
    opaqueId,
    fileName,
    mime,
    size: descriptor.size,
    get released() {
      return released;
    },
    release(): void {
      if (released) return;
      released = true;
      options.signal?.removeEventListener('abort', abort);
      const entry = vault.get(opaqueId);
      entry?.noncePrefix.fill(0);
      vault.delete(opaqueId);
      navigator.serviceWorker.controller?.postMessage({
        type: 'MXQR_REMOTE_MEDIA_RELEASE',
        protocolVersion: REMOTE_MEDIA_PROTOCOL_VERSION,
        opaqueId,
      });
    },
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) {
    source.release();
    throw new Error('REMOTE_SHARE_ABORTED');
  }
  return source;
}

export const createRemoteMediaSourceForTests = createRemoteMediaSource;

/**
 * Blob-shaped compatibility object. Its native Blob payload is deliberately
 * empty; logical metadata is exposed by getters and the source lives in a
 * WeakMap, so key material never becomes an enumerable property.
 */
export class RemoteMediaFile extends Blob {
  readonly name: string;
  readonly lastModified: number;
  private readonly logicalSize: number;
  private readonly logicalType: string;

  constructor(name: string, size: number, type: string, lastModified = Date.now()) {
    super([]);
    this.name = name;
    this.logicalSize = size;
    this.logicalType = type;
    this.lastModified = lastModified;
  }

  override get size(): number {
    return this.logicalSize;
  }

  override get type(): string {
    return this.logicalType;
  }
}

export function isRemoteMediaFile(value: unknown): value is RemoteMediaFile {
  return value instanceof RemoteMediaFile;
}

export async function createRemoteMediaFile(
  descriptor: RemoteFileSharePayload,
  options: CreateRemoteMediaOptions = {},
): Promise<RemoteMediaFile> {
  const source = await createRemoteMediaSource(descriptor, options);
  try {
    const file = new RemoteMediaFile(source.fileName, source.size, source.mime);
    remoteMediaFiles.set(file, source);
    return file;
  } catch (error) {
    source.release();
    throw error;
  }
}

export function releaseRemoteMediaFile(file: RemoteMediaFile): void {
  const source = remoteMediaFiles.get(file);
  if (!source) return;
  remoteMediaFiles.delete(file);
  source.release();
}

/** Transfer the remote lease to a private media element preparation. */
export async function prepareRemoteMediaFileSource(
  file: RemoteMediaFile,
): Promise<PreparedMediaElementSource> {
  const source = remoteMediaFiles.get(file);
  if (!source || source.released) throw new Error('REMOTE_MEDIA_FILE_RELEASED');
  if (preparedRemoteMediaFiles.has(file)) throw new Error('REMOTE_MEDIA_FILE_ALREADY_PREPARED');
  preparedRemoteMediaFiles.add(file);
  const release = (): void => {
    remoteMediaFiles.delete(file);
    source.release();
  };
  try {
    const { prepareMediaElementUrlSource } = await import('../player/media-element.ts');
    return await prepareMediaElementUrlSource({
      url: source.url,
      fileName: source.fileName,
      release,
    });
  } catch (error) {
    release();
    throw error;
  }
}
