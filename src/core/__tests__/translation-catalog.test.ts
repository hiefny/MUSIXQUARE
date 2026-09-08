import { createHash } from 'node:crypto';
import type { Connect } from 'vite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCatalogs, type Catalog } from '../../../scripts/translation-catalog.ts';
import * as catalogSource from '../../../scripts/translation-catalog.ts';
import {
  createTranslationCatalogAssets,
  translationCatalogAssets,
  TRANSLATION_CATALOG_MANIFEST,
} from '../../../scripts/translation-catalog-assets.ts';
import { loadTranslationCatalog } from '../../../.workshop/translate/catalog-client.ts';
import { LANGUAGE_OPTIONS } from '../../i18n/locales.ts';
import ko from '../../i18n/ko.ts';
import { pageAliasTarget } from '../../../vite.config.ts';

let catalogs: Map<string, Catalog>;
let assets: Map<string, string>;
beforeAll(async () => {
  catalogs = await loadCatalogs(process.cwd());
  assets = createTranslationCatalogAssets(catalogs);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function installCatalogMiddleware(): Promise<Connect.NextHandleFunction> {
  const plugin = translationCatalogAssets();
  const configure = plugin.configureServer;
  if (typeof configure !== 'function') throw new Error('Expected callable server hook.');
  let middleware: Connect.NextHandleFunction | undefined;
  await configure.call(
    {} as never,
    {
      config: { root: process.cwd() },
      middlewares: { use: (handler: Connect.NextHandleFunction) => (middleware = handler) },
    } as never,
  );
  if (!middleware) throw new Error('Catalog middleware was not installed.');
  return middleware;
}

function requestCatalogMiddleware(middleware: Connect.NextHandleFunction, url: string) {
  return new Promise<{ body?: string; next?: boolean; error?: unknown }>((resolve) => {
    middleware(
      { url, method: 'GET' } as Parameters<Connect.NextHandleFunction>[0],
      {
        setHeader: vi.fn(),
        end: (body: string) => resolve({ body }),
      } as unknown as Parameters<Connect.NextHandleFunction>[1],
      (error?: unknown) => resolve({ next: true, error }),
    );
  });
}

describe('translation catalog production packaging', () => {
  it('extracts the complete current app/About references for every supported language', () => {
    expect([...catalogs.keys()]).toEqual(LANGUAGE_OPTIONS.map(({ code }) => code));
    const aboutKeys = catalogs
      .get('en')!
      .entries.filter(({ surface }) => surface === 'about')
      .map(({ key }) => key);
    expect(aboutKeys.length).toBeGreaterThan(0);
    for (const [code, catalog] of catalogs) {
      const language = LANGUAGE_OPTIONS.find((option) => option.code === code)!;
      expect(catalog.locale).toEqual({
        code: language.code,
        nativeName: language.nativeName,
        htmlLang: language.htmlLang,
      });
      expect(
        catalog.entries.filter(({ surface }) => surface === 'app').map(({ key }) => key),
      ).toEqual(Object.keys(ko));
      expect(
        catalog.entries.filter(({ surface }) => surface === 'about').map(({ key }) => key),
      ).toEqual(aboutKeys);
      expect(new Set(catalog.entries.map(({ id }) => id)).size).toBe(catalog.entries.length);
    }
    expect(
      catalogs.get('pt-br')!.entries.find(({ id }) => id === 'app:common.close')?.current,
    ).toBe('Fechar');
  });

  it('emits a current manifest and content-addressed JSON with exact UTF-8 data', () => {
    const manifest = JSON.parse(assets.get(TRANSLATION_CATALOG_MANIFEST)!);
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.locales)).toEqual([...catalogs.keys()]);
    expect(assets.size).toBe(catalogs.size + 1);
    for (const [code, catalog] of catalogs) {
      const url = manifest.locales[code] as string;
      const source = assets.get(url.slice(1))!;
      const hash = createHash('sha256').update(source).digest('base64url').slice(0, 8);
      expect(url).toBe(`/assets/translation-catalog-${code}-${hash}.json`);
      expect(JSON.parse(source)).toEqual(catalog);
    }
    const changed = new Map(catalogs);
    const portuguese = structuredClone(catalogs.get('pt-br')!);
    portuguese.entries[0]!.current += ' updated';
    changed.set('pt-br', portuguese);
    const changedManifest = JSON.parse(
      createTranslationCatalogAssets(changed).get(TRANSLATION_CATALOG_MANIFEST)!,
    );
    expect(changedManifest.locales['pt-br']).not.toBe(manifest.locales['pt-br']);
    expect(changedManifest.locales.ko).toBe(manifest.locales.ko);
  });

  it('the build hook publishes the generated files without a runtime catalog endpoint', async () => {
    const plugin = translationCatalogAssets();
    const resolveConfig = plugin.configResolved;
    const buildStart = plugin.buildStart;
    if (typeof resolveConfig !== 'function' || typeof buildStart !== 'function')
      throw new Error('Expected callable plugin hooks.');
    await resolveConfig.call({} as never, { root: process.cwd(), command: 'build' } as never);
    const emitFile = vi.fn();
    await buildStart.call({ emitFile } as never, {} as never);
    expect(emitFile).toHaveBeenCalledTimes(assets.size);
    for (const [fileName, source] of assets)
      expect(emitFile).toHaveBeenCalledWith({ type: 'asset', fileName, source });
    expect(
      [...assets.keys()].some(
        (name) => name.includes('.ts') || name.startsWith('translation-preview/'),
      ),
    ).toBe(false);
  });

  it('does not parse catalogs while installing dev middleware or handling unrelated requests', async () => {
    const load = vi.spyOn(catalogSource, 'loadCatalogs').mockResolvedValue(catalogs);
    const middleware = await installCatalogMiddleware();
    expect(load).not.toHaveBeenCalled();
    for (const url of ['/', '/ui-kit.js', '/translate', '/assets/unrelated.json']) {
      await expect(requestCatalogMiddleware(middleware, url)).resolves.toEqual({
        next: true,
        error: undefined,
      });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('shares lazy catalog generation and retries after a handled generation failure', async () => {
    let rejectLoad: (error: Error) => void = () => {};
    const failedLoad = new Promise<Map<string, Catalog>>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const load = vi
      .spyOn(catalogSource, 'loadCatalogs')
      .mockReturnValueOnce(failedLoad)
      .mockResolvedValue(catalogs);
    const middleware = await installCatalogMiddleware();
    const catalogUrl = JSON.parse(assets.get(TRANSLATION_CATALOG_MANIFEST)!).locales['pt-br'];
    const first = requestCatalogMiddleware(middleware, `/${TRANSLATION_CATALOG_MANIFEST}`);
    const concurrent = requestCatalogMiddleware(middleware, catalogUrl);
    expect(load).toHaveBeenCalledOnce();
    const failure = new Error('Source temporarily unavailable');
    rejectLoad(failure);
    for (const response of await Promise.all([first, concurrent]))
      expect(response).toEqual({ next: true, error: failure });
    await expect(
      requestCatalogMiddleware(middleware, `/${TRANSLATION_CATALOG_MANIFEST}`),
    ).resolves.toEqual({ body: assets.get(TRANSLATION_CATALOG_MANIFEST) });
    await expect(requestCatalogMiddleware(middleware, catalogUrl)).resolves.toEqual({
      body: assets.get(catalogUrl.slice(1)),
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(['/translate', '/translate/', '/TRANSLATE', '/translate.html'])(
    'maps %s to the same independent dev/built document',
    (url) => {
      expect(pageAliasTarget(`${url}?locale=ko`)).toBe(
        '/.workshop/translate/translate.html?locale=ko',
      );
      expect(pageAliasTarget(url, true)).toBe('/translate.html');
    },
  );

  it('reads current manifest then only the requested catalog with no-store freshness', async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      const source = assets.get(url.slice(1));
      return new Response(source, {
        status: source === undefined ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(loadTranslationCatalog('pt-br', controller.signal)).resolves.toEqual(
      catalogs.get('pt-br'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/translation-catalogs.json');
    for (const call of fetchMock.mock.calls)
      expect(call[1]).toEqual({
        cache: 'no-store',
        credentials: 'omit',
        signal: expect.any(AbortSignal),
      });
  });

  it.each([
    'https://attacker.invalid/catalog.json',
    '/assets/translation-catalog-en-aBcD1234.json',
    '/api/auth/google/start',
  ])('rejects an unexpected catalog URL %s before a second request', async (url) => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ version: 1, locales: { 'pt-br': url } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadTranslationCatalog('pt-br')).rejects.toThrow(
      'Unsupported catalog locale or asset URL.',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects malformed catalogs instead of admitting duplicate/missing translation fields', async () => {
    const manifest = assets.get(TRANSLATION_CATALOG_MANIFEST)!;
    const malformed = structuredClone(catalogs.get('pt-br')!);
    malformed.entries.push(malformed.entries[0]!);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(manifest))
      .mockResolvedValueOnce(new Response(JSON.stringify(malformed)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadTranslationCatalog('pt-br')).rejects.toThrow('Invalid translation catalog.');
  });

  it('bounds the combined manifest and catalog download to 15 seconds', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');
    const fetchMock = vi.fn(
      (url: string, options?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
          if (url === '/translation-catalogs.json')
            setTimeout(
              () => resolve(new Response(assets.get(TRANSLATION_CATALOG_MANIFEST)!)),
              10_000,
            );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    let settled = false;
    const result = loadTranslationCatalog('pt-br', caller.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(caller.signal.aborted).toBe(false);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards caller cancellation and clears the timeout and listener', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');
    const fetchMock = vi.fn(
      (_url: string, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = loadTranslationCatalog('pt-br', caller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await rejected;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
