import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  currentTranslationEntry,
  readTranslationRequest,
  record,
  TranslationFailure,
} from '../../../cloudflare/translation-community-catalog.ts';
import type { Entry } from '../../i18n/translation-community.ts';

const ENDPOINT = 'https://musixquare.com/api/translations/suggestions';
const MAX_REQUEST_BYTES = 768 * 1024;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

type StreamingRequestInit = RequestInit & { duplex: 'half' };

function jsonRequest(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body,
  });
}

function streamingRequest(
  stream: ReadableStream<Uint8Array>,
  init: Omit<StreamingRequestInit, 'body' | 'duplex' | 'method'> = {},
): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: JSON_HEADERS,
    ...init,
    body: stream,
    duplex: 'half',
  } as StreamingRequestInit);
}

/** A request body that never produces a chunk or closes. */
function openStream(cancel = vi.fn()): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ cancel });
}

function failure(code: string, status: number) {
  return expect.objectContaining({ code, status });
}

const flushTasks = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('translation suggestion request body', () => {
  it('requires a JSON content type', async () => {
    const rejected = readTranslationRequest(jsonRequest('{}', { 'Content-Type': 'text/plain' }));
    await expect(rejected).rejects.toBeInstanceOf(TranslationFailure);
    await expect(rejected).rejects.toEqual(failure('JSON_REQUIRED', 415));
    await expect(
      readTranslationRequest(
        jsonRequest('{"a":1}', { 'Content-Type': 'application/json; charset=utf-8' }),
      ),
    ).resolves.toEqual({ a: 1 });
  });

  it('rejects a request without a body', async () => {
    await expect(readTranslationRequest(jsonRequest(null))).rejects.toEqual(
      failure('INVALID_REQUEST', 400),
    );
  });

  it('accepts a body at the 768 KiB limit', async () => {
    const atLimit = `{"a":"${'x'.repeat(MAX_REQUEST_BYTES - 8)}"}`;
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(MAX_REQUEST_BYTES);
    const parsed = await readTranslationRequest(
      jsonRequest(atLimit, { 'Content-Length': String(MAX_REQUEST_BYTES) }),
    );
    expect(String(parsed.a)).toHaveLength(MAX_REQUEST_BYTES - 8);
  });

  it.each([String(MAX_REQUEST_BYTES + 1), 'abc', '-1', '1e3'])(
    'rejects declared Content-Length %s before reading',
    async (length) => {
      await expect(
        readTranslationRequest(jsonRequest('{}', { 'Content-Length': length })),
      ).rejects.toEqual(failure('REQUEST_TOO_LARGE', 413));
    },
  );

  it('stops reading an undeclared stream once it exceeds the limit', async () => {
    const cancel = vi.fn();
    let produced = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
      cancel,
    });
    await expect(readTranslationRequest(streamingRequest(endless))).rejects.toEqual(
      failure('REQUEST_TOO_LARGE', 413),
    );
    await flushTasks();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(produced).toBeLessThan(MAX_REQUEST_BYTES * 2);
  });

  it.each([
    ['a JSON array', '[1]'],
    ['malformed JSON', '{'],
    ['invalid UTF-8', new Uint8Array([0xff])],
  ])('rejects %s', async (_label, body) => {
    await expect(readTranslationRequest(jsonRequest(body))).rejects.toEqual(
      failure('INVALID_REQUEST', 400),
    );
  });

  it('stops waiting for an open body when the request is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancel = vi.fn();
    await expect(
      readTranslationRequest(streamingRequest(openStream(cancel), { signal: controller.signal })),
    ).rejects.toEqual(failure('REQUEST_CANCELLED', 408));
    await flushTasks();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for an open body when the request is cancelled mid-read', async () => {
    const controller = new AbortController();
    const pending = readTranslationRequest(
      streamingRequest(openStream(), { signal: controller.signal }),
    );
    const rejected = expect(pending).rejects.toEqual(failure('REQUEST_CANCELLED', 408));
    await flushTasks();
    controller.abort();
    await rejected;
  });

  it('times out an open body after ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cancel = vi.fn();
    const pending = readTranslationRequest(streamingRequest(openStream(cancel)));
    const rejected = expect(pending).rejects.toEqual(failure('REQUEST_TIMEOUT', 408));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await flushTasks();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

const LOCALE = 'es';
const MANIFEST_PATH = '/translation-catalogs.json';
const CATALOG_PATH = `/assets/translation-catalog-${LOCALE}-AbCd12_-.json`;
const APP_ENTRY: Entry = {
  id: 'app:player.play',
  surface: 'app',
  key: 'player.play',
  sourceEn: 'Play',
  sourceKo: '재생',
  current: 'Reproducir',
};
const ABOUT_ENTRY: Entry = {
  id: 'about:hero.title',
  surface: 'about',
  key: 'hero.title',
  sourceEn: 'Listen together',
  sourceKo: '함께 듣기',
  current: 'Escuchar juntos',
};

const VALID_MANIFEST = { version: 1, locales: { [LOCALE]: CATALOG_PATH } };
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 4096;
const MAX_KEY_LENGTH = 200;
const MAX_TEXT_LENGTH = 32_768;

type AssetHandler = () => Response | Promise<Response>;

function jsonAsset(value: unknown, contentType = 'application/json; charset=utf-8'): AssetHandler {
  return () =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': contentType } });
}

/** The valid manifest, padded with trailing JSON whitespace to exactly `bytes`. */
function paddedManifest(bytes: number): string {
  const json = JSON.stringify(VALID_MANIFEST);
  return json + ' '.repeat(bytes - json.length);
}

function catalogOf(entries: readonly unknown[]) {
  return { locale: { code: LOCALE }, entries };
}

function entryWithKey(key: string): Entry {
  return { ...APP_ENTRY, id: `app:${key}`, key };
}

function numberedEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_unused, index) => entryWithKey(`generated.${index}`));
}

function catalogAssets({
  manifest = jsonAsset(VALID_MANIFEST),
  catalog = jsonAsset(catalogOf([APP_ENTRY, ABOUT_ENTRY])),
}: { manifest?: AssetHandler; catalog?: AssetHandler } = {}) {
  const handlers = new Map<string, AssetHandler>([
    [MANIFEST_PATH, manifest],
    [CATALOG_PATH, catalog],
  ]);
  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const handler = handlers.get(new URL(request.url).pathname);
    return handler
      ? handler()
      : new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  });
  return { env: { ASSETS: { fetch } }, fetch, handlers };
}

const UNAVAILABLE = failure('TRANSLATIONS_UNAVAILABLE', 503);

describe('canonical translation catalog lookup', () => {
  it('recognizes only plain objects as records', () => {
    expect(record({})).toBe(true);
    expect(record([])).toBe(false);
    expect(record(null)).toBe(false);
    expect(record('entry')).toBe(false);
  });

  it.each([
    ['no environment', null],
    ['no ASSETS binding', {}],
    ['an ASSETS binding without fetch', { ASSETS: {} }],
  ])('is unavailable with %s', async (_label, env) => {
    await expect(currentTranslationEntry(env, LOCALE, 'app', 'player.play')).rejects.toEqual(
      UNAVAILABLE,
    );
  });

  it('returns the canonical entry or null and caches the snapshot per binding', async () => {
    const { env, fetch } = catalogAssets();
    await expect(currentTranslationEntry(env, LOCALE, 'app', 'player.play')).resolves.toEqual(
      APP_ENTRY,
    );
    await expect(currentTranslationEntry(env, LOCALE, 'about', 'hero.title')).resolves.toEqual(
      ABOUT_ENTRY,
    );
    await expect(currentTranslationEntry(env, LOCALE, 'app', 'missing.key')).resolves.toBeNull();
    expect(fetch.mock.calls.map(([request]) => request.url)).toEqual([
      `https://musixquare.com${MANIFEST_PATH}`,
      `https://musixquare.com${CATALOG_PATH}`,
    ]);
  });

  it('shares one in-flight load between concurrent lookups', async () => {
    const { env, fetch } = catalogAssets();
    const [first, second] = await Promise.all([
      currentTranslationEntry(env, LOCALE, 'app', 'player.play'),
      currentTranslationEntry(env, LOCALE, 'about', 'hero.title'),
    ]);
    expect(first).toEqual(APP_ENTRY);
    expect(second).toEqual(ABOUT_ENTRY);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(currentTranslationEntry(env, LOCALE, 'app', 'player.play')).resolves.toEqual(
      APP_ENTRY,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a path for another locale', '/assets/translation-catalog-fr-AbCd1234.json'],
    ['a short content hash', `/assets/translation-catalog-${LOCALE}-AbCd123.json`],
    ['a traversal path', `/assets/../translation-catalog-${LOCALE}-AbCd1234.json`],
    ['a non-string path', 7],
  ])('rejects %s in the manifest and retries on the next lookup', async (_label, assetPath) => {
    const { env, fetch, handlers } = catalogAssets({
      manifest: jsonAsset({ version: 1, locales: { [LOCALE]: assetPath } }),
    });
    await expect(currentTranslationEntry(env, LOCALE, 'app', 'player.play')).rejects.toEqual(
      UNAVAILABLE,
    );
    expect(fetch).toHaveBeenCalledTimes(1);

    handlers.set(MANIFEST_PATH, jsonAsset(VALID_MANIFEST));
    await expect(currentTranslationEntry(env, LOCALE, 'app', 'player.play')).resolves.toEqual(
      APP_ENTRY,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  // Each manifest case serves a body that would otherwise be accepted, so only
  // the named gate can reject it and the catalog asset is never requested.
  it.each([
    [
      'a manifest with another version',
      jsonAsset({ version: 2, locales: { [LOCALE]: CATALOG_PATH } }),
    ],
    [
      'a manifest with a non-200 status',
      () => new Response(JSON.stringify(VALID_MANIFEST), { status: 404, headers: JSON_HEADERS }),
    ],
    ['a manifest with a non-JSON content type', jsonAsset(VALID_MANIFEST, 'text/html')],
    [
      'a manifest declaring a length over 4 MiB',
      () =>
        new Response(JSON.stringify(VALID_MANIFEST), {
          status: 200,
          headers: { ...JSON_HEADERS, 'Content-Length': String(MAX_ASSET_BYTES + 1) },
        }),
    ],
    [
      'an undeclared manifest body over 4 MiB',
      () =>
        new Response(paddedManifest(MAX_ASSET_BYTES + 1), { status: 200, headers: JSON_HEADERS }),
    ],
  ])('is unavailable for %s', async (_label, manifest) => {
    const { env, fetch } = catalogAssets({ manifest });
    await expect(currentTranslationEntry(env, LOCALE, 'app', 'player.play')).rejects.toEqual(
      UNAVAILABLE,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a manifest of exactly 4 MiB, declared or not', async () => {
    const atLimit = paddedManifest(MAX_ASSET_BYTES);
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(MAX_ASSET_BYTES);
    for (const headers of [
      JSON_HEADERS,
      { ...JSON_HEADERS, 'Content-Length': String(MAX_ASSET_BYTES) },
    ]) {
      const { env } = catalogAssets({
        manifest: () => new Response(atLimit, { status: 200, headers }),
      });
      await expect(currentTranslationEntry(env, LOCALE, 'app', 'player.play')).resolves.toEqual(
        APP_ENTRY,
      );
    }
  });

  // Each catalog case keeps one valid entry beside the rejected one, so only the
  // named validator can reject it.
  it.each([
    ['a duplicate entry id', catalogOf([APP_ENTRY, APP_ENTRY])],
    ['a catalog for another locale', { locale: { code: 'fr' }, entries: [APP_ENTRY] }],
    ['an empty catalog', catalogOf([])],
    [
      'an entry whose id does not match its key',
      catalogOf([APP_ENTRY, { ...ABOUT_ENTRY, id: 'about:other.key' }]),
    ],
    [
      'an entry for an unknown surface',
      catalogOf([APP_ENTRY, { ...ABOUT_ENTRY, surface: 'other', id: 'other:hero.title' }]),
    ],
    [
      'a key over 200 characters',
      catalogOf([APP_ENTRY, entryWithKey('k'.repeat(MAX_KEY_LENGTH + 1))]),
    ],
    ...(['sourceEn', 'sourceKo', 'current'] as const).map(
      (field): [string, ReturnType<typeof catalogOf>] => [
        `a ${field} text over 32,768 characters`,
        catalogOf([APP_ENTRY, { ...ABOUT_ENTRY, [field]: 'x'.repeat(MAX_TEXT_LENGTH + 1) }]),
      ],
    ),
    ['more than 4,096 entries', catalogOf([APP_ENTRY, ...numberedEntries(MAX_CATALOG_ENTRIES)])],
  ])('is unavailable for %s', async (_label, catalog) => {
    const { env, fetch } = catalogAssets({ catalog: jsonAsset(catalog) });
    await expect(currentTranslationEntry(env, LOCALE, 'app', 'player.play')).rejects.toEqual(
      UNAVAILABLE,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts a catalog at every entry and size limit', async () => {
    const longKey = entryWithKey('k'.repeat(MAX_KEY_LENGTH));
    const longText = 'x'.repeat(MAX_TEXT_LENGTH);
    const largest = { ...ABOUT_ENTRY, sourceEn: longText, sourceKo: longText, current: longText };
    const entries = [APP_ENTRY, largest, longKey, ...numberedEntries(MAX_CATALOG_ENTRIES - 3)];
    expect(entries).toHaveLength(MAX_CATALOG_ENTRIES);
    const { env } = catalogAssets({ catalog: jsonAsset(catalogOf(entries)) });
    await expect(currentTranslationEntry(env, LOCALE, 'about', 'hero.title')).resolves.toEqual(
      largest,
    );
    await expect(currentTranslationEntry(env, LOCALE, 'app', longKey.key)).resolves.toEqual(
      longKey,
    );
  });

  it('abandons a slow asset at its deadline and cancels the late body', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let deliver: (response: Response) => void = () => {};
    const lateResponse = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    const { env } = catalogAssets({ manifest: () => lateResponse });
    const pending = currentTranslationEntry(env, LOCALE, 'app', 'player.play');
    const rejected = expect(pending).rejects.toEqual(UNAVAILABLE);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;

    const cancel = vi.fn();
    deliver(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 200,
        headers: JSON_HEADERS,
      }),
    );
    await flushTasks();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
