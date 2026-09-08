import type { Entry } from '../src/i18n/translation-community.ts';

export class TranslationFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bound bytes and time without depending on cooperative stream cancellation. */
async function boundedJson(response: Request | Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new TranslationFailure('INVALID_REQUEST', 400);
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    void response.body.cancel().catch(() => {});
    throw new TranslationFailure('REQUEST_TOO_LARGE', 413);
  }
  const reader = response.body.getReader();
  let rejectTimeout: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(
    () => rejectTimeout(new TranslationFailure('REQUEST_TIMEOUT', 408)),
    10_000,
  );
  const signal = response instanceof Request ? response.signal : null;
  const abort = () => rejectTimeout(new TranslationFailure('REQUEST_CANCELLED', 408));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), stopped]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new TranslationFailure('REQUEST_TOO_LARGE', 413);
      chunks.push(chunk.value);
    }
    completed = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch (error) {
    if (error instanceof TranslationFailure) throw error;
    throw new TranslationFailure('INVALID_REQUEST', 400);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (!completed) void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* A timed-out read may retain its lock. */
    }
  }
}

export async function readTranslationRequest(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type') ?? '')) {
    throw new TranslationFailure('JSON_REQUIRED', 415);
  }
  const value = await boundedJson(request, 768 * 1024);
  if (!record(value)) throw new TranslationFailure('INVALID_REQUEST', 400);
  return value;
}

interface AssetsPort {
  fetch(request: Request): Promise<Response>;
}
function isAssetsPort(value: unknown): value is AssetsPort {
  return record(value) && typeof value.fetch === 'function';
}
const snapshots = new WeakMap<AssetsPort, Map<string, Promise<Map<string, Entry>>>>();

async function readAsset(assets: AssetsPort, pathname: string): Promise<unknown> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve()
    .then(() => assets.fetch(new Request(`https://musixquare.com${pathname}`)))
    .then(async (response) => {
      if (expired) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new Error('Expired asset request');
      }
      if (
        response.status !== 200 ||
        !/application\/json/iu.test(response.headers.get('Content-Type') ?? '')
      )
        throw new Error('Catalog asset unavailable');
      return boundedJson(response, 4 * 1024 * 1024);
    });
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('Catalog asset deadline'));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isEntry(value: unknown): value is Entry {
  return (
    record(value) &&
    (value.surface === 'app' || value.surface === 'about') &&
    typeof value.key === 'string' &&
    value.key.length > 0 &&
    value.key.length <= 200 &&
    value.id === `${value.surface}:${value.key}` &&
    [value.sourceEn, value.sourceKo, value.current].every(
      (text) => typeof text === 'string' && text.length <= 32_768,
    )
  );
}

export async function currentTranslationEntry(
  env: unknown,
  locale: string,
  surface: string,
  key: string,
): Promise<Entry | null> {
  if (!record(env) || !isAssetsPort(env.ASSETS))
    throw new TranslationFailure('TRANSLATIONS_UNAVAILABLE', 503);
  const assets = env.ASSETS;
  let cache = snapshots.get(assets);
  if (!cache) {
    cache = new Map();
    snapshots.set(assets, cache);
  }
  let flight = cache.get(locale);
  if (!flight) {
    flight = (async () => {
      const manifest = await readAsset(assets, '/translation-catalogs.json');
      const assetPath =
        record(manifest) && manifest.version === 1 && record(manifest.locales)
          ? manifest.locales[locale]
          : null;
      if (
        typeof assetPath !== 'string' ||
        !new RegExp(`^/assets/translation-catalog-${locale}-[A-Za-z0-9_-]{8}\\.json$`, 'u').test(
          assetPath,
        )
      )
        throw new Error('Invalid canonical catalog path');
      const catalog = await readAsset(assets, assetPath);
      if (
        !record(catalog) ||
        !record(catalog.locale) ||
        catalog.locale.code !== locale ||
        !Array.isArray(catalog.entries) ||
        !catalog.entries.length ||
        catalog.entries.length > 4096 ||
        !catalog.entries.every(isEntry)
      )
        throw new Error('Invalid canonical catalog');
      const entries = new Map(catalog.entries.map((entry) => [entry.id, entry]));
      if (entries.size !== catalog.entries.length) throw new Error('Duplicate canonical entry');
      return entries;
    })().catch(() => {
      cache?.delete(locale);
      throw new TranslationFailure('TRANSLATIONS_UNAVAILABLE', 503);
    });
    cache.set(locale, flight);
  }
  return (await flight).get(`${surface}:${key}`) ?? null;
}
