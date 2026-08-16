import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APP_INDEX_MAX_BYTES,
  APP_GENERATION_REQUEST_TIMEOUT_MS,
  APP_GENERATION_TIMEOUT_MS,
  extractMainScript,
  expectedAppAssetGraph,
  expectedMainAsset,
  expectedMainScript,
  readPublicIndex,
  readPublicMainAsset,
  verifyPublicAppGeneration,
} from '../../../scripts/live-app-generation-smoke.mts';

const EXPECTED_MAIN = '/assets/main-Cand1234.js';
const EXPECTED_ASSET = new TextEncoder().encode('console.log("candidate");');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('live app generation smoke', () => {
  it('extracts the candidate main asset and rejects an invalid dist shell', async () => {
    expect(extractMainScript(`<script type="module" src="${EXPECTED_MAIN}"></script>`)).toBe(
      EXPECTED_MAIN,
    );
    await expect(
      expectedMainScript({ read: async () => '<html><body>missing</body></html>' }),
    ).rejects.toThrow('candidate dist');
  });

  it('selects exactly one canonical module script instead of a data-src lookalike', () => {
    expect(
      extractMainScript(
        `<div data-src="${EXPECTED_MAIN}"></div><script type="module" src="/assets/main-Stal1234.js"></script>`,
      ),
    ).toBe('/assets/main-Stal1234.js');
    expect(extractMainScript(`<script src="${EXPECTED_MAIN}"></script>`)).toBeNull();
    expect(
      extractMainScript('<script type="module" src="/assets/main-production.js"></script>'),
    ).toBeNull();
    expect(
      extractMainScript(
        `<script type="module" src="${EXPECTED_MAIN}"></script><script type="module" src="/assets/main-Secd1234.js"></script>`,
      ),
    ).toBeNull();
  });

  it('ignores candidate-looking scripts in every inert or foreign HTML context', () => {
    for (const html of [
      `<!-- <script type="module" src="${EXPECTED_MAIN}"></script> -->`,
      `<template><script type="module" src="${EXPECTED_MAIN}"></script></template>`,
      `<script>const inert = '<script type="module" src="${EXPECTED_MAIN}">';</script>`,
      `<noscript><script type="module" src="${EXPECTED_MAIN}"></script></noscript>`,
      `<svg><script type="module" src="${EXPECTED_MAIN}"></script></svg>`,
      `<math><script type="module" src="${EXPECTED_MAIN}"></script></math>`,
    ]) {
      expect(extractMainScript(html)).toBeNull();
    }
  });

  it('builds the candidate eager graph and follows every static module import', async () => {
    const html = `<!doctype html><html><head>
      <!-- <script type="module" src="/assets/main-Inert123.js"></script> -->
      <template><script type="module" src="/assets/main-Inert456.js"></script></template>
      <script>const inert = '<script type="module" src="/assets/main-Inert789.js">';</script>
      <script src="/bootstrap.js"></script>
      <link rel="stylesheet" href="/assets/main-Style123.css">
      <link rel="modulepreload" href="/assets/preload-Prel1234.js">
      <script type="module" src="${EXPECTED_MAIN}"></script>
    </head><body><audio preload src="dummy_audio.mp3"></audio></body></html>`;
    const files = new Map<string, string | Uint8Array>([
      ['dist/index.html', html],
      ['dist/bootstrap.js', 'globalThis.bootstrap = true;'],
      ['dist/assets/main-Style123.css', 'body { color: black; }'],
      ['dist/assets/preload-Prel1234.js', 'export {};'],
      ['dist/assets/main-Cand1234.js', 'import "./dep-Dep12345.js";'],
      ['dist/assets/dep-Dep12345.js', 'export const ready = true;'],
      ['dist/dummy_audio.mp3', new Uint8Array([1, 2, 3])],
    ]);
    const read = vi.fn(async (path: string) => {
      const normalized = path.replaceAll('\\', '/');
      const distOffset = normalized.lastIndexOf('/dist/');
      const key = distOffset >= 0 ? normalized.slice(distOffset + 1) : normalized;
      const value = files.get(key);
      if (value === undefined) throw new Error(`unexpected candidate path: ${key}`);
      return value;
    });

    const graph = await expectedAppAssetGraph({ read });
    expect(graph.mainScript).toBe(EXPECTED_MAIN);
    expect(graph.assets.map(({ url }) => url)).toEqual([
      '/assets/dep-Dep12345.js',
      '/assets/main-Cand1234.js',
      '/assets/main-Style123.css',
      '/assets/preload-Prel1234.js',
      '/bootstrap.js',
      '/dummy_audio.mp3',
    ]);
    expect(graph.indexByteLength).toBe(new TextEncoder().encode(html).byteLength);
  });

  it('requires consecutive matching HTTP reads and resets on a stale generation', async () => {
    const sequence = [
      EXPECTED_MAIN,
      '/assets/main-stale.js',
      EXPECTED_MAIN,
      EXPECTED_MAIN,
      EXPECTED_MAIN,
    ];
    const read = vi.fn(async () => ({ status: 200, mainScript: sequence.shift() ?? null }));
    const expectedAsset = await expectedMainAsset({
      mainScript: EXPECTED_MAIN,
      read: async () => EXPECTED_ASSET,
    });
    const readAsset = vi.fn(async () => ({
      assetUrl: EXPECTED_MAIN,
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      byteLength: expectedAsset.byteLength,
      sha256: expectedAsset.sha256,
    }));

    await expect(
      verifyPublicAppGeneration({
        expectedMain: EXPECTED_MAIN,
        expectedAssetBytes: expectedAsset.byteLength,
        expectedAssetSha256: expectedAsset.sha256,
        read,
        readAsset,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({
      expectedMain: EXPECTED_MAIN,
      consecutiveReads: 3,
      mainAssetBytes: EXPECTED_ASSET.byteLength,
      verifiedAssetCount: 1,
    });
    expect(read).toHaveBeenCalledTimes(5);
    expect(readAsset).toHaveBeenCalledOnce();
    expect(readAsset).toHaveBeenCalledWith({
      assetUrl: EXPECTED_MAIN,
      timeoutMs: APP_GENERATION_REQUEST_TIMEOUT_MS,
    });
  });

  it('bounds each request by the remaining overall deadline and fails closed', async () => {
    let clock = 0;
    const requestedTimeouts: number[] = [];
    const read = vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
      requestedTimeouts.push(timeoutMs);
      clock += 30;
      return { status: 503, mainScript: null };
    });

    await expect(
      verifyPublicAppGeneration({
        expectedMain: EXPECTED_MAIN,
        read,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        timeoutMs: 100,
        requestTimeoutMs: 80,
        pollMs: 10,
      }),
    ).rejects.toThrow('observed=http-503');
    expect(requestedTimeouts).toEqual([80, 60, 20]);
    expect(APP_GENERATION_REQUEST_TIMEOUT_MS).toBeLessThan(APP_GENERATION_TIMEOUT_MS);
  });

  it('GETs and hashes the same-origin JavaScript asset with a bounded body', async () => {
    const expectedAsset = await expectedMainAsset({
      mainScript: EXPECTED_MAIN,
      read: async () => EXPECTED_ASSET,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(EXPECTED_ASSET, {
          status: 200,
          headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      readPublicMainAsset({ mainScript: EXPECTED_MAIN, timeoutMs: 1_000 }),
    ).resolves.toEqual({
      assetUrl: EXPECTED_MAIN,
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      byteLength: expectedAsset.byteLength,
      sha256: expectedAsset.sha256,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://musixquare.com${EXPECTED_MAIN}`,
      expect.objectContaining({ cache: 'no-store', redirect: 'error' }),
    );
  });

  it('cancels non-200 and oversized index bodies without buffering them', async () => {
    const nonSuccessCancel = vi.fn();
    const oversizedCancel = vi.fn();
    const responses = [
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('unavailable'));
          },
          cancel: nonSuccessCancel,
        }),
        { status: 503 },
      ),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(APP_INDEX_MAX_BYTES + 1));
          },
          cancel: oversizedCancel,
        }),
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      ),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    );

    await expect(readPublicIndex({ timeoutMs: 1_000 })).resolves.toEqual({
      status: 503,
      mainScript: null,
      byteLength: null,
      sha256: null,
    });
    await expect(readPublicIndex({ timeoutMs: 1_000 })).rejects.toThrow('exceeds');
    await Promise.resolve();
    expect(nonSuccessCancel).toHaveBeenCalledOnce();
    expect(oversizedCancel).toHaveBeenCalledOnce();
  });

  it('fails closed when the converged main asset is missing, non-JavaScript, or mismatched', async () => {
    let clock = 0;
    const read = vi.fn(async () => ({ status: 200, mainScript: EXPECTED_MAIN }));
    const readAsset = vi.fn(async ({ assetUrl }: { assetUrl: string }) => {
      clock += 30;
      return {
        assetUrl,
        status: 404,
        contentType: 'text/html',
        byteLength: null,
        sha256: null,
      };
    });

    await expect(
      verifyPublicAppGeneration({
        expectedMain: EXPECTED_MAIN,
        expectedAssetBytes: EXPECTED_ASSET.byteLength,
        expectedAssetSha256: 'a'.repeat(64),
        read,
        readAsset,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        timeoutMs: 100,
        pollMs: 10,
        requiredConsecutiveReads: 1,
      }),
    ).rejects.toThrow('invalid projection');
    expect(readAsset).toHaveBeenCalled();
  });

  it('rejects a non-canonical expected asset before issuing a request', async () => {
    const read = vi.fn();
    await expect(
      verifyPublicAppGeneration({ expectedMain: 'https://example.com/main.js', read }),
    ).rejects.toThrow('canonical hashed asset path');
    expect(read).not.toHaveBeenCalled();
  });
});
