import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

const ANALYTICS_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
const SOURCE_ROOTS = ['public', '.workshop', 'browser/classic-runtime'];
const STATIC_ANALYTICS_PAGES = [
  '.workshop/developers/developers.html',
  '.workshop/faq/faq.html',
  '.workshop/landing/landing.html',
  '.workshop/privacy/privacy.html',
  '.workshop/terms/terms.html',
  'public/blog/index.html',
  'public/designsystem/index.html',
  'public/history/index.html',
];

interface FakeScript {
  async?: boolean;
  crossOrigin?: string;
  integrity?: string;
  src?: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

function portablePath(path: string): string {
  return path.split(sep).join('/');
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && ['.html', '.js', '.ts'].includes(extname(entry.name)) ? [path] : [];
  });
}

async function runStandaloneAnalyticsLoader({
  hash = '',
  hostname = 'musixquare.com',
  pathname = '/privacy',
  referrer = '',
  search = '',
}: {
  hash?: string;
  hostname?: string;
  pathname?: string;
  referrer?: string;
  search?: string;
} = {}): Promise<FakeScript[]> {
  const appendedScripts: FakeScript[] = [];
  const location = { hash, hostname, pathname, search };
  const document = {
    referrer,
    head: {
      appendChild(script: FakeScript) {
        appendedScripts.push(script);
        return script;
      },
    },
    createElement(tagName: string): FakeScript {
      expect(tagName).toBe('script');
      return {
        attributes: {},
        setAttribute(name: string, value: string) {
          this.attributes[name] = value;
        },
      };
    },
  };
  const windowObject = { document, location };
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'analytics-bootstrap.js',
  );
  if (!asset) throw new Error('Classic analytics runtime is missing from the manifest.');
  const { code: source } = await compileClassicRuntimeAsset(resolve('.'), asset);
  vm.runInContext(source, vm.createContext({ URL, document, location, window: windowObject }));
  return appendedScripts;
}

describe('Cloudflare Web Analytics loading boundary', () => {
  const repositoryRoot = resolve('.');
  const files = SOURCE_ROOTS.flatMap((root) => sourceFiles(resolve(root)));
  const analyticsFiles = files.filter((path) => readFileSync(path, 'utf8').includes(ANALYTICS_SRC));

  it('routes every standalone analytics page through the first-party guard', () => {
    const htmlFiles = files.filter((path) => extname(path) === '.html');
    const loaderPages = htmlFiles
      .filter((path) => readFileSync(path, 'utf8').includes('/analytics-bootstrap.js'))
      .map((path) => portablePath(relative(repositoryRoot, path)))
      .sort();

    expect(loaderPages).toEqual([...STATIC_ANALYTICS_PAGES].sort());
    for (const path of htmlFiles) {
      const source = readFileSync(path, 'utf8');
      expect(source, portablePath(relative(repositoryRoot, path))).not.toContain(ANALYTICS_SRC);
    }
    for (const relativePath of STATIC_ANALYTICS_PAGES) {
      expect(readFileSync(resolve(relativePath), 'utf8')).toMatch(
        /<script\s+defer\s+src="\/analytics-bootstrap\.js"><\/script>/u,
      );
    }

    const accountComplete = readFileSync(resolve('public/account-complete.html'), 'utf8');
    expect(accountComplete).not.toContain(ANALYTICS_SRC);
    expect(accountComplete).not.toContain('/analytics-bootstrap.js');
  });

  it('allows only the guarded first-party loader to inject the approved script', async () => {
    const runtimeSourceFiles = analyticsFiles
      .filter((path) => ['.js', '.ts'].includes(extname(path)))
      .map((path) => portablePath(relative(repositoryRoot, path)))
      .sort();
    expect(runtimeSourceFiles).toEqual(['browser/classic-runtime/analytics-bootstrap.ts']);

    for (const path of runtimeSourceFiles) {
      const source = readFileSync(resolve(path), 'utf8');
      expect(source).not.toContain('script.integrity');
      expect(source).not.toContain('script.crossOrigin');
      expect(source).toContain('JSON.stringify({ token: ANALYTICS_TOKEN, spa: false })');
    }

    const bootstrapAsset = CLASSIC_RUNTIME_ASSETS.find(
      (candidate) => candidate.outputPath === 'bootstrap.js',
    );
    if (!bootstrapAsset) throw new Error('Classic bootstrap runtime is missing from the manifest.');
    const appBootstrap = (await compileClassicRuntimeAsset(repositoryRoot, bootstrapAsset)).code;
    expect(appBootstrap).not.toContain(ANALYTICS_SRC);
    expect(appBootstrap).not.toContain('data-cf-beacon');
  });

  it.each([
    ['musixquare.com', '/privacy'],
    ['listen.musixquare.com', '/blog'],
  ])('loads on production queryless non-room URL %s%s', async (hostname, pathname) => {
    const scripts = await runStandaloneAnalyticsLoader({ hostname, pathname, search: '' });

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      async: true,
      src: ANALYTICS_SRC,
    });
    expect(scripts[0]?.crossOrigin).toBeUndefined();
    expect(scripts[0]?.integrity).toBeUndefined();
    expect(JSON.parse(scripts[0]?.attributes['data-cf-beacon'] || '{}')).toEqual({
      token: '80608f4cdc3849d589d14bdcf48f19f9',
      spa: false,
    });
  });

  it.each([
    ['musixquare.com', '/000001', '', ''],
    ['musixquare.com', '/000001/', '', ''],
    ['musixquare.com', '/privacy', '?lang=ko', ''],
    ['musixquare.com', '/privacy', '?claim_token=secret', ''],
    ['musixquare.com', '/privacy', '', '#claim_token=secret'],
    ['localhost', '/privacy', '', ''],
    ['preview.example.com', '/privacy', '', ''],
  ])(
    'fails closed on host=%s path=%s search=%s hash=%s',
    async (hostname, pathname, search, hash) => {
      expect(await runStandaloneAnalyticsLoader({ hash, hostname, pathname, search })).toEqual([]);
    },
  );

  it.each([
    'https://musixquare.com/000001',
    'https://musixquare.com/000001/',
    'https://musixquare.com/about?claim_token=secret',
  ])(
    'fails closed when the document referrer can expose room or query state: %s',
    async (referrer) => {
      expect(await runStandaloneAnalyticsLoader({ referrer })).toEqual([]);
    },
  );

  it('allows a path-only non-room referrer', async () => {
    expect(
      await runStandaloneAnalyticsLoader({ referrer: 'https://musixquare.com/about' }),
    ).toHaveLength(1);
  });

  it('keeps the pinned analytics endpoints explicit in the static CSP contract', () => {
    const headers = readFileSync(resolve('cloudflare/app-static-assets/_headers'), 'utf8');
    const csp = headers
      .split(/\r?\n/u)
      .find((line) => line.trimStart().startsWith('Content-Security-Policy:'));

    expect(csp).toContain('script-src');
    expect(csp).toContain('https://static.cloudflareinsights.com');
    expect(csp).toContain('connect-src');
    expect(csp).toContain('https://cloudflareinsights.com');
  });
});
