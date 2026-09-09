import { readFile, stat } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { countExecutableInlineScripts } from '../../../scripts/check-authored-inline-js-inventory.mts';
import {
  AUXILIARY_BROWSER_ASSETS,
  assertAuxiliaryBrowserHtmlContract,
  assertAuxiliaryBrowserSourceCompleteness,
  auxiliaryBrowserAssetForRequestUrl,
  auxiliaryBrowserAssets,
  compileAuxiliaryBrowserAsset,
  compileAuxiliaryBrowserAssets,
  materializeFileUrlAuxiliaryAssets,
} from '../../../scripts/auxiliary-browser-assets.ts';
import { startViteMiddlewareTestServer } from './helpers/vite-middleware-test-server.ts';

const REPOSITORY = resolve(process.cwd());

async function startAuxiliaryDevServer(): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  return startViteMiddlewareTestServer(
    {
      appType: 'custom',
      configFile: false,
      publicDir: false,
      root: REPOSITORY,
      plugins: [auxiliaryBrowserAssets()],
      optimizeDeps: { include: [], noDiscovery: true },
    },
    'Auxiliary browser',
  );
}

async function requestDevServer(
  origin: string,
  pathname: string,
  method: 'GET' | 'HEAD',
): Promise<{
  readonly body: string;
  readonly cacheControl: string | undefined;
  readonly contentType: string | undefined;
  readonly status: number;
}> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = requestHttp(new URL(pathname, origin), { method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', rejectRequest);
      response.once('end', () => {
        const cacheControl = response.headers['cache-control'];
        const contentType = response.headers['content-type'];
        resolveRequest({
          body: Buffer.concat(chunks).toString('utf8'),
          cacheControl: Array.isArray(cacheControl) ? cacheControl.join(', ') : cacheControl,
          contentType: Array.isArray(contentType) ? contentType.join(', ') : contentType,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.once('error', rejectRequest);
    request.end();
  });
}

function reportFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    completed: 1,
    running: null,
    finishedAt: '2026-08-17T00:00:00.000Z',
    finalStatus: 'failed',
    durationMs: 1250,
    tests: [
      {
        title: 'interrupted playback',
        file: 'e2e/playback.test.ts',
        status: 'interrupted',
        duration: 1250,
        error: 'browser closed',
      },
    ],
    ...overrides,
  };
}

async function executeReportViewer(report: Record<string, unknown>): Promise<JSDOM> {
  const asset = AUXILIARY_BROWSER_ASSETS.find(
    (candidate) => candidate.outputPath === 'e2e/report-viewer.js',
  );
  if (!asset) throw new Error('Missing report viewer asset.');
  const [html, compiled] = await Promise.all([
    readFile(resolve(REPOSITORY, asset.htmlPath), 'utf8'),
    compileAuxiliaryBrowserAsset(REPOSITORY, asset),
  ]);
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'file:///C:/musixquare/e2e/report-viewer.html',
  });
  dom.window.eval(compiled.code);
  Reflect.set(dom.window, '__E2E_REPORT__', report);
  const reportScript = dom.window.document.getElementById('report-script');
  if (!reportScript) throw new Error('Report viewer did not create its polling script.');
  reportScript.dispatchEvent(new dom.window.Event('load'));
  return dom;
}

describe('strict TypeScript auxiliary browser assets', () => {
  it('owns the report viewer script and leaves no executable inline blocks', async () => {
    await expect(assertAuxiliaryBrowserSourceCompleteness(REPOSITORY)).resolves.toBeUndefined();
    expect(AUXILIARY_BROWSER_ASSETS.map((asset) => asset.outputPath)).toEqual([
      'e2e/report-viewer.js',
    ]);

    for (const asset of AUXILIARY_BROWSER_ASSETS) {
      const html = await readFile(resolve(REPOSITORY, asset.htmlPath), 'utf8');
      expect(countExecutableInlineScripts(html), asset.htmlPath).toBe(0);
      expect(() => assertAuxiliaryBrowserHtmlContract(asset, html)).not.toThrow();
      expect(auxiliaryBrowserAssetForRequestUrl(`/${asset.outputPath}?v=1`)).toBe(asset);
    }
  });

  it('compiles the report viewer without raw TypeScript or sourcemaps', async () => {
    const compiled = await compileAuxiliaryBrowserAssets(REPOSITORY);
    expect(compiled).toHaveLength(AUXILIARY_BROWSER_ASSETS.length);
    for (const asset of compiled) {
      expect(asset.code, asset.outputPath).not.toMatch(/sourceMappingURL/u);
      if (asset.scriptType === 'classic') {
        expect(() => Function(asset.code), asset.outputPath).not.toThrow();
      }
    }
  });

  it('serves every stable URL over GET and HEAD with exact compiler bytes', async () => {
    const server = await startAuxiliaryDevServer();
    try {
      // These assets do not share state. Verify their real HTTP responses in
      // parallel instead of accumulating independent socket delays.
      await Promise.all(
        AUXILIARY_BROWSER_ASSETS.map(async (asset) => {
          const [expected, get, head] = await Promise.all([
            compileAuxiliaryBrowserAsset(REPOSITORY, asset),
            requestDevServer(server.origin, `/${asset.outputPath}`, 'GET'),
            requestDevServer(server.origin, `/${asset.outputPath}`, 'HEAD'),
          ]);
          expect(get.status, asset.outputPath).toBe(200);
          expect(get.contentType, asset.outputPath).toBe('text/javascript; charset=utf-8');
          expect(get.cacheControl, asset.outputPath).toBe('no-cache');
          expect(get.body, asset.outputPath).toBe(expected.code);

          expect(head.status, asset.outputPath).toBe(200);
          expect(head.contentType, asset.outputPath).toBe('text/javascript; charset=utf-8');
          expect(head.body, asset.outputPath).toBe('');
        }),
      );
    } finally {
      await server.close();
    }
  });

  it('executes the compiled report polling and preserves failure semantics', async () => {
    const interrupted = await executeReportViewer(reportFixture());
    try {
      expect(interrupted.window.document.getElementById('badge')?.textContent).toBe('1 FAILED');
      expect(interrupted.window.document.getElementById('test-list')?.textContent).toContain(
        'interrupted playback',
      );
    } finally {
      interrupted.window.close();
    }

    const suiteFailure = await executeReportViewer(
      reportFixture({ failed: 0, tests: [], finalStatus: 'failed' }),
    );
    try {
      expect(suiteFailure.window.document.getElementById('badge')?.textContent).toBe('RUN FAILED');
    } finally {
      suiteFailure.window.close();
    }
  });

  it.each(['failed', 'timedout', 'interrupted', 'passed'])(
    'copies the actual %s run outcome when there are no failed test entries',
    async (finalStatus) => {
      const dom = await executeReportViewer(reportFixture({ failed: 0, tests: [], finalStatus }));
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText } });
      try {
        const button = dom.window.document.getElementById('copy-btn');
        if (!(button instanceof dom.window.HTMLElement)) throw new Error('Missing copy button.');
        button.click();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledOnce();
        const copied = writeText.mock.calls[0]?.[0];
        expect(copied).toContain(`**Run status**: ${finalStatus}`);
        if (finalStatus === 'passed') expect(copied).toContain('All tests passed.');
        else {
          expect(copied).not.toContain('All tests passed.');
          expect(copied).toContain('The test run did not pass.');
        }
      } finally {
        dom.window.close();
      }
    },
  );

  it('owns a clipboard success-continuation failure after the report button is removed', async () => {
    const dom = await executeReportViewer(reportFixture());
    let resolveWrite!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const copyFailure = vi.spyOn(dom.window.console, 'error').mockImplementation(() => undefined);
    try {
      const button = dom.window.document.getElementById('copy-btn');
      if (!(button instanceof dom.window.HTMLElement))
        throw new Error('Missing report copy button.');
      button.click();
      button.remove();
      resolveWrite();
      await Promise.resolve();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledOnce();
      expect(copyFailure).toHaveBeenCalledWith(
        '[report-viewer] Copy failed.',
        expect.objectContaining({ message: 'Missing report viewer element #copy-btn.' }),
      );
    } finally {
      dom.window.close();
    }
  });

  it('materializes byte-exact ignored JS before the direct-file viewer opens', async () => {
    const outputs = await materializeFileUrlAuxiliaryAssets(REPOSITORY);
    expect(outputs).toEqual(['e2e/report-viewer.js']);
    const asset = AUXILIARY_BROWSER_ASSETS.find((candidate) => candidate.outputPath === outputs[0]);
    if (!asset) throw new Error('Missing materialized report viewer asset.');
    const [written, compiled, ignored, batch] = await Promise.all([
      readFile(resolve(REPOSITORY, asset.outputPath), 'utf8'),
      compileAuxiliaryBrowserAsset(REPOSITORY, asset),
      readFile(resolve(REPOSITORY, '.gitignore'), 'utf8'),
      readFile(resolve(REPOSITORY, 'e2e/run-tests.bat'), 'utf8'),
    ]);
    expect(written).toBe(compiled.code);
    expect(await stat(resolve(REPOSITORY, asset.outputPath))).toBeTruthy();
    expect(ignored).toContain('e2e/report-viewer.js');
    const materialize = batch.indexOf('node scripts\\materialize-auxiliary-browser-assets.mts');
    const failClosed = batch.indexOf('if errorlevel 1 exit /b %ERRORLEVEL%');
    const open = batch.indexOf('start "" "%~dp0report-viewer.html"');
    expect(materialize).toBeGreaterThan(-1);
    expect(failClosed).toBeGreaterThan(materialize);
    expect(open).toBeGreaterThan(failClosed);
  });
});
