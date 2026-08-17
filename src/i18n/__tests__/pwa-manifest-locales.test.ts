import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import { compileServiceWorkerAsset } from '../../../scripts/service-worker-asset.ts';
import { LANGUAGE_OPTIONS } from '../index.ts';

interface AppManifest {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly lang: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly handle_links: string;
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly Record<string, string>[];
}

const REPOSITORY_ROOT = resolve('.');
const MANIFEST_DIRECTORY = resolve('public/manifests');
const INDEX_SOURCE = readFileSync(resolve('index.html'), 'utf8');
const BOOTSTRAP_ASSET = CLASSIC_RUNTIME_ASSETS.find(
  (candidate) => candidate.outputPath === 'bootstrap.js',
);
if (!BOOTSTRAP_ASSET) throw new Error('Classic bootstrap runtime is missing from the manifest.');
const BOOTSTRAP_SOURCE = (await compileClassicRuntimeAsset(REPOSITORY_ROOT, BOOTSTRAP_ASSET)).code;
const SERVICE_WORKER_SOURCE = (await compileServiceWorkerAsset(REPOSITORY_ROOT)).code;

const openDoms: JSDOM[] = [];

interface BootstrapSurfaceFailures {
  readonly storage?: boolean;
  readonly navigatorLanguages?: boolean;
  readonly navigatorLanguage?: boolean;
}

function readManifest(path: string): AppManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as AppManifest;
}

function stableManifestFields(manifest: AppManifest): Omit<AppManifest, 'description' | 'lang'> {
  const { description: _description, lang: _lang, ...stable } = manifest;
  return stable;
}

function bootstrapDom(
  savedLanguage: string,
  systemLanguages: readonly string[],
  failures: BootstrapSurfaceFailures = {},
): JSDOM {
  const dom = new JSDOM(
    '<!doctype html><html lang="ko"><head><link id="app-manifest" rel="manifest"></head><body></body></html>',
    { runScripts: 'outside-only', url: 'https://musixquare.com/' },
  );
  openDoms.push(dom);
  if (failures.storage) {
    Object.defineProperty(dom.window, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('storage denied');
        },
      },
    });
  } else {
    dom.window.localStorage.setItem('musixquare-lang', savedLanguage);
  }
  Object.defineProperty(dom.window.navigator, 'languages', {
    configurable: true,
    ...(failures.navigatorLanguages
      ? {
          get() {
            throw new Error('navigator.languages denied');
          },
        }
      : { value: [...systemLanguages] }),
  });
  Object.defineProperty(dom.window.navigator, 'language', {
    configurable: true,
    ...(failures.navigatorLanguage
      ? {
          get() {
            throw new Error('navigator.language denied');
          },
        }
      : { value: systemLanguages[0] ?? '' }),
  });
  dom.window.eval(BOOTSTRAP_SOURCE);
  return dom;
}

afterEach(() => {
  while (openDoms.length > 0) openDoms.pop()?.window.close();
});

describe('localized PWA install metadata', () => {
  it('ships one structurally identical manifest for every supported app locale', () => {
    const expectedCodes = LANGUAGE_OPTIONS.map(({ code }) => code).sort();
    const actualCodes = readdirSync(MANIFEST_DIRECTORY)
      .filter((file) => file.endsWith('.webmanifest'))
      .map((file) => file.replace(/\.webmanifest$/u, ''))
      .sort();
    expect(actualCodes).toEqual(expectedCodes);

    const fallback = readManifest(resolve('public/manifest.webmanifest'));
    const english = readManifest(resolve(MANIFEST_DIRECTORY, 'en.webmanifest'));
    expect(fallback).toEqual(english);
    expect(fallback.lang).toBe('en');

    const descriptions = new Set<string>();
    for (const { code, htmlLang } of LANGUAGE_OPTIONS) {
      const manifest = readManifest(resolve(MANIFEST_DIRECTORY, `${code}.webmanifest`));
      expect(manifest.lang, code).toBe(htmlLang);
      expect(manifest.description.trim().length, code).toBeGreaterThan(30);
      expect(manifest.description, code).not.toMatch(/<[^>]+>/u);
      expect(stableManifestFields(manifest), code).toEqual(stableManifestFields(english));
      descriptions.add(manifest.description);
    }
    expect(descriptions.size).toBe(LANGUAGE_OPTIONS.length);
  });

  it('keeps the href-less link before bootstrap so locale resolution wins the first fetch', () => {
    const manifestIndex = INDEX_SOURCE.indexOf('<link id="app-manifest" rel="manifest" />');
    const bootstrapIndex = INDEX_SOURCE.indexOf('<script src="/bootstrap.js?cache=');
    expect(manifestIndex).toBeGreaterThan(-1);
    expect(manifestIndex).toBeLessThan(bootstrapIndex);
    expect(INDEX_SOURCE.match(/<link\b[^>]*\brel="manifest"[^>]*>/gu)).toHaveLength(1);
    expect(INDEX_SOURCE.slice(manifestIndex, bootstrapIndex)).not.toMatch(/\bhref=/u);
  });

  it('selects saved or system install metadata and follows later UI-language changes', async () => {
    const saved = bootstrapDom('ja', ['ko-KR']);
    const savedLink = saved.window.document.querySelector<HTMLLinkElement>('#app-manifest');
    expect(saved.window.document.documentElement.lang).toBe('ja');
    expect(savedLink?.getAttribute('href')).toBe('/manifests/ja.webmanifest');

    saved.window.document.documentElement.lang = 'zh-Hant';
    await new Promise<void>((resolveMutation) => saved.window.setTimeout(resolveMutation, 0));
    expect(savedLink?.getAttribute('href')).toBe('/manifests/zh-hant.webmanifest');

    const system = bootstrapDom('system', ['pt-PT', 'en-US']);
    expect(system.window.document.documentElement.lang).toBe('pt-BR');
    expect(
      system.window.document.querySelector<HTMLLinkElement>('#app-manifest')?.getAttribute('href'),
    ).toBe('/manifests/pt-br.webmanifest');

    const restricted = bootstrapDom('system', ['ko-KR'], { storage: true });
    const restrictedLink =
      restricted.window.document.querySelector<HTMLLinkElement>('#app-manifest');
    expect(restricted.window.document.documentElement.lang).toBe('ko');
    expect(restrictedLink?.getAttribute('href')).toBe('/manifests/ko.webmanifest');

    restricted.window.document.documentElement.lang = 'ja';
    await new Promise<void>((resolveMutation) => restricted.window.setTimeout(resolveMutation, 0));
    expect(restrictedLink?.getAttribute('href')).toBe('/manifests/ja.webmanifest');
  });

  it('isolates navigator getter failures and always keeps manifest observation alive', async () => {
    const languagesDenied = bootstrapDom('system', ['ja-JP'], {
      navigatorLanguages: true,
    });
    expect(languagesDenied.window.document.documentElement.lang).toBe('ja');
    expect(
      languagesDenied.window.document
        .querySelector<HTMLLinkElement>('#app-manifest')
        ?.getAttribute('href'),
    ).toBe('/manifests/ja.webmanifest');

    const navigatorDenied = bootstrapDom('system', [], {
      navigatorLanguages: true,
      navigatorLanguage: true,
    });
    const navigatorDeniedLink =
      navigatorDenied.window.document.querySelector<HTMLLinkElement>('#app-manifest');
    expect(navigatorDenied.window.document.documentElement.lang).toBe('en');
    expect(navigatorDeniedLink?.getAttribute('href')).toBe('/manifests/en.webmanifest');

    navigatorDenied.window.document.documentElement.lang = 'ko';
    await new Promise<void>((resolveMutation) =>
      navigatorDenied.window.setTimeout(resolveMutation, 0),
    );
    expect(navigatorDeniedLink?.getAttribute('href')).toBe('/manifests/ko.webmanifest');
  });

  it('precaches every localized manifest plus the legacy English fallback', () => {
    expect(SERVICE_WORKER_SOURCE).toContain('./manifest.webmanifest');
    for (const { code } of LANGUAGE_OPTIONS) {
      expect(SERVICE_WORKER_SOURCE, code).toContain(`./manifests/${code}.webmanifest`);
    }
  });
});
