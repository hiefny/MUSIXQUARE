import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RemoteFileSharePayload } from '../../types/index.ts';

vi.mock('../r2-client.ts', () => ({
  resolveRemoteDownloadUrl: vi.fn((roomId: string, objectId: string, value?: string) => {
    const expected = `https://share.example/download/${encodeURIComponent(roomId)}/${encodeURIComponent(objectId)}`;
    if (value !== expected) throw new Error('REMOTE_SHARE_BAD_DOWNLOAD_URL');
    return expected;
  }),
}));

import {
  createRemoteMediaFile,
  createRemoteMediaSourceForTests,
  ensureRemoteMediaServiceWorkerForTests,
  isRemoteMediaFile,
  releaseRemoteMediaFile,
} from '../remote-media.ts';

const ORIGIN = 'https://musixquare.test';
const DOWNLOAD_URL = 'https://share.example/download/123456/11111111-1111-4111-8111-111111111111';
const OPAQUE_ID = 'abcdefghijklmnopqrstuvwx';
const CHUNK_BYTES = 8 * 1024 * 1024;
const TAG_BYTES = 16;

type Listener = (event: any) => void;

class FakeWorker {
  state: ServiceWorkerState;
  readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly supported: boolean;
  private readonly onSkipWaiting?: () => void;

  constructor(state: ServiceWorkerState, supported: boolean, onSkipWaiting?: () => void) {
    this.state = state;
    this.supported = supported;
    this.onSkipWaiting = onSkipWaiting;
  }

  postMessage(data: any, transfer?: Transferable[]): void {
    this.messages.push(data);
    if (data?.type === 'MXQR_REMOTE_MEDIA_PING' && this.supported) {
      const port = transfer?.[0] as MessagePort | undefined;
      port?.postMessage({ type: 'MXQR_REMOTE_MEDIA_PONG', protocolVersion: 1 });
    } else if (data?.type === 'SKIP_WAITING') {
      this.onSkipWaiting?.();
    }
  }

  addEventListener(type: string, listener: Listener): void {
    const entries = this.listeners.get(type) ?? new Set<Listener>();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
}

class FakeServiceWorkerContainer {
  controller: FakeWorker | null;
  readonly registration: {
    active: FakeWorker | null;
    waiting: FakeWorker | null;
    installing: FakeWorker | null;
    update: ReturnType<typeof vi.fn>;
  };
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(oldWorker: FakeWorker) {
    this.controller = oldWorker;
    this.registration = {
      active: oldWorker,
      waiting: null,
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
    };
  }

  getRegistration(): Promise<typeof this.registration> {
    return Promise.resolve(this.registration);
  }

  addEventListener(type: string, listener: Listener): void {
    const entries = this.listeners.get(type) ?? new Set<Listener>();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function descriptor(overrides: Partial<RemoteFileSharePayload> = {}): RemoteFileSharePayload {
  const size = CHUNK_BYTES + 37;
  return {
    roomId: '123456',
    objectId: '11111111-1111-4111-8111-111111111111',
    downloadUrl: DOWNLOAD_URL,
    keyB64: base64(new Uint8Array(32).fill(7)),
    ivB64: base64(new Uint8Array(8).fill(9)),
    name: 'remote song.flac',
    mime: 'audio/flac',
    size,
    encryptedSize: size + TAG_BYTES * 2,
    index: 0,
    sessionId: 1,
    expiresAt: Date.now() + 60_000,
    cryptoVersion: 2,
    chunkSize: CHUNK_BYTES,
    chunkCount: 2,
    tagBytes: TAG_BYTES,
    ...overrides,
  };
}

let pageContainer: FakeServiceWorkerContainer;
let pageWorker: FakeWorker;
let originalNavigator: PropertyDescriptor | undefined;
let originalLocation: PropertyDescriptor | undefined;

beforeAll(() => {
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const oldWorker = new FakeWorker('activated', false);
  pageContainer = new FakeServiceWorkerContainer(oldWorker);
  pageWorker = new FakeWorker('installed', true, () => {
    pageWorker.state = 'activated';
    pageContainer.registration.waiting = null;
    pageContainer.registration.active = pageWorker;
    pageContainer.controller = pageWorker;
    pageContainer.dispatch('controllerchange');
  });
  pageContainer.registration.waiting = pageWorker;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: pageContainer },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL(`${ORIGIN}/app`),
  });
});

afterAll(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete (globalThis as { navigator?: Navigator }).navigator;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else delete (globalThis as { location?: Location }).location;
});

describe('page-memory remote media vault', () => {
  it('forces an old controlling worker through the feature handshake', async () => {
    await expect(ensureRemoteMediaServiceWorkerForTests()).resolves.toBeUndefined();
    expect(pageContainer.registration.update).toHaveBeenCalledOnce();
    expect(pageWorker.messages).toContainEqual({ type: 'SKIP_WAITING' });
    expect(pageContainer.controller).toBe(pageWorker);
  });

  it('returns a non-extractable key only to the current controller and releases it', async () => {
    const source = await createRemoteMediaSourceForTests(descriptor());
    expect(source.url).toMatch(
      new RegExp(`^${ORIGIN}/__mxqr_media/[A-Za-z0-9_-]{32}/remote%20song\\.flac$`),
    );
    expect(source.url).not.toContain('key');
    expect(source.url).not.toContain(descriptor().ivB64);

    const before = pageWorker.messages.length;
    const rogueWorker = new FakeWorker('activated', true);
    pageContainer.dispatch('message', {
      data: {
        type: 'MXQR_REMOTE_MEDIA_RESOLVE',
        protocolVersion: 1,
        requestId: 'rogue-request',
        opaqueId: source.opaqueId,
      },
      source: rogueWorker,
    });
    expect(pageWorker.messages.length).toBe(before);
    expect(rogueWorker.messages).toHaveLength(0);

    pageContainer.dispatch('message', {
      data: {
        type: 'MXQR_REMOTE_MEDIA_RESOLVE',
        protocolVersion: 1,
        requestId: 'request-1',
        opaqueId: source.opaqueId,
      },
      source: pageWorker,
    });
    const response = pageWorker.messages.at(-1) as any;
    expect(pageWorker.messages.length).toBe(before + 1);
    expect(response.type).toBe('MXQR_REMOTE_MEDIA_SESSION');
    expect(response.session.key.extractable).toBe(false);
    expect(response.session.key.usages).toEqual(['decrypt']);
    expect(JSON.stringify(response)).not.toContain(descriptor().keyB64);

    source.release();
    source.release();
    expect(source.released).toBe(true);
    const afterRelease = pageWorker.messages.length;
    pageContainer.dispatch('message', {
      data: {
        type: 'MXQR_REMOTE_MEDIA_RESOLVE',
        protocolVersion: 1,
        requestId: 'request-after-release',
        opaqueId: source.opaqueId,
      },
      source: pageWorker,
    });
    expect(pageWorker.messages.length).toBe(afterRelease);
  });

  it('aborts the page-side lease and exposes only a zero-payload Blob facade', async () => {
    const abortController = new AbortController();
    const source = await createRemoteMediaSourceForTests(descriptor(), {
      signal: abortController.signal,
    });
    abortController.abort();
    expect(source.released).toBe(true);

    const file = await createRemoteMediaFile(descriptor());
    expect(file).toBeInstanceOf(Blob);
    expect(isRemoteMediaFile(file)).toBe(true);
    expect(file.size).toBe(CHUNK_BYTES + 37);
    expect(file.type).toBe('audio/flac');
    expect(file.name).toBe('remote song.flac');
    expect((await file.arrayBuffer()).byteLength).toBe(0);
    releaseRemoteMediaFile(file);
    expect(isRemoteMediaFile(file)).toBe(true);
  });

  it('rejects a download URL that is not bound to the descriptor object', async () => {
    await expect(
      createRemoteMediaSourceForTests(
        descriptor({ downloadUrl: 'https://attacker.example/proxy' }),
      ),
    ).rejects.toThrow('REMOTE_SHARE_BAD_DOWNLOAD_URL');
  });

  it('never exposes an active-content MIME through the virtual URL', async () => {
    const source = await createRemoteMediaSourceForTests(descriptor({ mime: 'text/html' }));
    expect(source.mime).toBe('application/octet-stream');
    source.release();
  });
});

interface EncryptedFixture {
  readonly plain: Uint8Array;
  readonly cipherChunks: Uint8Array[];
  readonly key: CryptoKey;
  readonly noncePrefix: Uint8Array;
  readonly encryptedSize: number;
}

function chunkIv(prefix: Uint8Array, index: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
}

function chunkAad(plainSize: number, chunkCount: number, index: number): Uint8Array {
  const aad = new Uint8Array(28);
  const view = new DataView(aad.buffer);
  view.setUint32(0, 0x4d585132, false);
  view.setUint32(4, 2, false);
  view.setUint32(8, Math.floor(plainSize / 0x1_0000_0000), false);
  view.setUint32(12, plainSize >>> 0, false);
  view.setUint32(16, CHUNK_BYTES, false);
  view.setUint32(20, chunkCount, false);
  view.setUint32(24, index, false);
  return aad;
}

async function encryptedFixture(): Promise<EncryptedFixture> {
  const plain = new Uint8Array(CHUNK_BYTES + 37);
  for (let index = 0; index < plain.byteLength; index += 1) plain[index] = index % 251;
  const rawKey = new Uint8Array(32);
  crypto.getRandomValues(rawKey);
  const encryptionKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  rawKey.fill(0);
  const noncePrefix = new Uint8Array(8);
  crypto.getRandomValues(noncePrefix);
  const cipherChunks: Uint8Array[] = [];
  const chunkCount = Math.ceil(plain.byteLength / CHUNK_BYTES);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * CHUNK_BYTES;
    const end = Math.min(plain.byteLength, start + CHUNK_BYTES);
    const cipher = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: chunkIv(noncePrefix, index).buffer as ArrayBuffer,
        additionalData: chunkAad(plain.byteLength, chunkCount, index).buffer as ArrayBuffer,
        tagLength: 128,
      },
      encryptionKey,
      plain.slice(start, end),
    );
    cipherChunks.push(new Uint8Array(cipher));
  }
  return {
    plain,
    cipherChunks,
    key,
    noncePrefix,
    encryptedSize: plain.byteLength + chunkCount * TAG_BYTES,
  };
}

interface WorkerRuntime {
  readonly fetchEncrypted: ReturnType<typeof vi.fn>;
  readonly cacheOpen: ReturnType<typeof vi.fn>;
  readonly cacheMatch: ReturnType<typeof vi.fn>;
  readonly resolveCount: () => number;
  dispatchFetch(request: Request, clientId?: string): Promise<Response>;
  dispatchMessage(data: unknown, clientId?: string): void;
}

async function loadWorkerRuntime(
  fixture: EncryptedFixture,
  fetchOverride?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  sessionMime = 'audio/flac',
): Promise<WorkerRuntime> {
  const source = await readFile(
    new URL('../../../public/service-worker.js', import.meta.url),
    'utf8',
  );
  const listeners = new Map<string, Listener[]>();
  let resolveMessages = 0;
  const cacheOpen = vi.fn();
  const cacheMatch = vi.fn();
  const client = {
    id: 'client-a',
    postMessage(data: any) {
      if (data?.type !== 'MXQR_REMOTE_MEDIA_RESOLVE') return;
      resolveMessages += 1;
      for (const listener of listeners.get('message') ?? []) {
        listener({
          data: {
            type: 'MXQR_REMOTE_MEDIA_SESSION',
            protocolVersion: 1,
            requestId: data.requestId,
            opaqueId: data.opaqueId,
            session: {
              key: fixture.key,
              noncePrefix: fixture.noncePrefix.buffer.slice(0),
              downloadUrl: DOWNLOAD_URL,
              roomId: '123456',
              objectId: '11111111-1111-4111-8111-111111111111',
              plainSize: fixture.plain.byteLength,
              encryptedSize: fixture.encryptedSize,
              chunkSize: CHUNK_BYTES,
              chunkCount: fixture.cipherChunks.length,
              tagBytes: TAG_BYTES,
              mime: sessionMime,
            },
          },
          source: client,
          ports: [],
        });
      }
    },
  };

  const fetchEncrypted = vi.fn(
    fetchOverride ??
      (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const range = new Headers(init?.headers).get('range');
        const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
        if (!match) throw new Error(`unexpected range: ${range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const index = start === 0 ? 0 : 1;
        const expectedStart = index * (CHUNK_BYTES + TAG_BYTES);
        const cipher = fixture.cipherChunks[index];
        if (start !== expectedStart || end !== expectedStart + cipher.byteLength - 1) {
          throw new Error(`unexpected encrypted range: ${range}`);
        }
        return new Response(cipher.slice(), {
          status: 206,
          headers: {
            'Content-Length': String(cipher.byteLength),
            'Content-Range': `bytes ${start}-${end}/${fixture.encryptedSize}`,
          },
        });
      }),
  );
  const workerSelf: any = {
    location: { origin: ORIGIN, href: `${ORIGIN}/service-worker.js` },
    crypto,
    clients: {
      get: vi.fn(async (clientId: string) => (clientId === client.id ? client : null)),
      claim: vi.fn(),
    },
    skipWaiting: vi.fn(),
    addEventListener(type: string, listener: Listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
  };
  const caches = {
    open: cacheOpen,
    match: cacheMatch,
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
  };
  runInNewContext(source, {
    self: workerSelf,
    caches,
    fetch: fetchEncrypted,
    crypto,
    Request,
    Response,
    Headers,
    URL,
    ReadableStream,
    AbortController,
    ArrayBuffer,
    Uint8Array,
    DataView,
    TextEncoder,
    setTimeout,
    clearTimeout,
  });

  return {
    fetchEncrypted,
    cacheOpen,
    cacheMatch,
    resolveCount: () => resolveMessages,
    async dispatchFetch(request: Request, clientId = client.id): Promise<Response> {
      let response: Promise<Response> | Response | undefined;
      const event = {
        request,
        clientId,
        respondWith(value: Promise<Response> | Response) {
          response = value;
        },
        waitUntil: vi.fn(),
      };
      for (const listener of listeners.get('fetch') ?? []) listener(event);
      if (!response) throw new Error('service worker did not intercept request');
      return await response;
    },
    dispatchMessage(data: unknown, clientId = client.id): void {
      for (const listener of listeners.get('message') ?? []) {
        listener({ data, source: { id: clientId }, ports: [] });
      }
    },
  };
}

function virtualRequest(range?: string, method = 'GET'): Request {
  return new Request(`${ORIGIN}/__mxqr_media/${OPAQUE_ID}/song.flac`, {
    method,
    headers: range ? { Range: range } : undefined,
  });
}

describe('service-worker bounded encrypted media ranges', () => {
  let fixture: EncryptedFixture;

  beforeAll(async () => {
    fixture = await encryptedFixture();
  }, 30_000);

  it('serves WebKit probe and seek ranges with exact authenticated chunks', async () => {
    const runtime = await loadWorkerRuntime(fixture);
    const probe = await runtime.dispatchFetch(virtualRequest('bytes=0-1'));
    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe(`bytes 0-1/${fixture.plain.byteLength}`);
    expect(probe.headers.get('content-length')).toBe('2');
    expect(probe.headers.get('cache-control')).toBe('no-store');
    expect([...new Uint8Array(await probe.arrayBuffer())]).toEqual([...fixture.plain.slice(0, 2)]);
    expect(new Headers(runtime.fetchEncrypted.mock.calls[0]?.[1]?.headers).get('range')).toBe(
      `bytes=0-${CHUNK_BYTES + TAG_BYTES - 1}`,
    );

    const seekStart = CHUNK_BYTES + 5;
    const seekEnd = CHUNK_BYTES + 12;
    const seek = await runtime.dispatchFetch(virtualRequest(`bytes=${seekStart}-${seekEnd}`));
    expect([...new Uint8Array(await seek.arrayBuffer())]).toEqual([
      ...fixture.plain.slice(seekStart, seekEnd + 1),
    ]);
    expect(new Headers(runtime.fetchEncrypted.mock.calls[1]?.[1]?.headers).get('range')).toBe(
      `bytes=${CHUNK_BYTES + TAG_BYTES}-${fixture.encryptedSize - 1}`,
    );
    expect(runtime.cacheOpen).not.toHaveBeenCalled();
    expect(runtime.cacheMatch).not.toHaveBeenCalled();
  });

  it('handles HEAD and 416 without downloading and binds a session to its client', async () => {
    const runtime = await loadWorkerRuntime(fixture);
    const head = await runtime.dispatchFetch(virtualRequest('bytes=0-1', 'HEAD'));
    expect(head.status).toBe(206);
    expect(head.headers.get('content-range')).toBe(`bytes 0-1/${fixture.plain.byteLength}`);
    expect(await head.text()).toBe('');

    const invalid = await runtime.dispatchFetch(virtualRequest('bytes=999999999-'));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe(`bytes */${fixture.plain.byteLength}`);
    const forbidden = await runtime.dispatchFetch(virtualRequest('bytes=0-1'), 'client-b');
    expect(forbidden.status).toBe(403);
    expect(runtime.fetchEncrypted).not.toHaveBeenCalled();
    expect(runtime.resolveCount()).toBe(1);
  });

  it('forces non-audio session MIME metadata to an inert type', async () => {
    const runtime = await loadWorkerRuntime(fixture, undefined, 'text/html');
    const head = await runtime.dispatchFetch(virtualRequest(undefined, 'HEAD'));
    expect(head.headers.get('content-type')).toBe('application/octet-stream');
    expect(head.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('recovers its key session on demand after a worker restart', async () => {
    const first = await loadWorkerRuntime(fixture);
    const firstResponse = await first.dispatchFetch(virtualRequest('bytes=0-1'));
    await firstResponse.arrayBuffer();
    expect(first.resolveCount()).toBe(1);

    const restarted = await loadWorkerRuntime(fixture);
    const recovered = await restarted.dispatchFetch(virtualRequest('bytes=0-1'));
    expect([...new Uint8Array(await recovered.arrayBuffer())]).toEqual([
      ...fixture.plain.slice(0, 2),
    ]);
    expect(restarted.resolveCount()).toBe(1);
  });

  it('aborts an in-flight encrypted chunk fetch when the owner releases it', async () => {
    let observedSignal: AbortSignal | undefined;
    const runtime = await loadWorkerRuntime(
      fixture,
      async (_input, init): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          observedSignal?.addEventListener(
            'abort',
            () => reject(observedSignal?.reason ?? new Error('aborted')),
            { once: true },
          );
        }),
    );
    const response = await runtime.dispatchFetch(virtualRequest('bytes=0-1'));
    const body = response.arrayBuffer();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    runtime.dispatchMessage({
      type: 'MXQR_REMOTE_MEDIA_RELEASE',
      protocolVersion: 1,
      opaqueId: OPAQUE_ID,
    });
    await expect(body).rejects.toMatchObject({ message: 'REMOTE_MEDIA_RELEASED' });
    expect(observedSignal?.aborted).toBe(true);
  });
});
