import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  INITIAL_TRANSFER_BUDGET,
  assertInitialTransferBudget,
  collectEagerAssetUrls,
  measureInitialTransfer,
} from '../../../scripts/check-initial-transfer-budget.mjs';

const temporaryDirectories: string[] = [];

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mxqr-transfer-budget-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'assets'));
  writeFileSync(
    join(directory, 'index.html'),
    [
      '<!doctype html>',
      '<script src="/bootstrap.js?cache=v1"></script>',
      '<link rel="stylesheet" href="/assets/main.css">',
      '<link rel="modulepreload" href="/assets/runtime.js">',
      '<script type="module" src="/assets/main.js"></script>',
      '<audio src="/dummy_audio.mp3" preload="auto"></audio>',
    ].join('\n'),
  );
  writeFileSync(join(directory, 'bootstrap.js'), 'bootstrap();');
  writeFileSync(join(directory, 'assets', 'main.css'), 'body{color:red}');
  writeFileSync(join(directory, 'assets', 'runtime.js'), 'export const runtime=1;');
  writeFileSync(join(directory, 'assets', 'main.js'), 'import"./runtime.js";start();');
  writeFileSync(join(directory, 'dummy_audio.mp3'), Buffer.from([0x49, 0x44, 0x33, 0x04]));
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('initial transfer budget', () => {
  it('collects only HTML-declared eager assets and identifies the module entry', () => {
    expect(
      collectEagerAssetUrls(`
        <link rel="stylesheet" href="/main.css">
        <link rel="preload" as="font" href="/font.woff2">
        <link rel="preload" as="image" imagesrcset="/preload-small.webp 1x, /preload-big.webp 2x">
        <link rel="icon" href="/icon.png">
        <script src="/boot.js"></script>
        <script type="module" src="/main.js"></script>
        <picture>
          <source type="image/avif" srcset="/hero.avif 1x, /hero-2x.avif 2x">
          <source type="image/webp" srcset="/hero.webp 1x, /hero-2x.webp 2x">
        </picture>
        <img src="/hero.png" srcset="/hero-2x.png 2x, /hero-wide.png 1200w">
        <img src="/lazy.png" loading="lazy">
        <img alt="runtime-populated">
        <audio src="/unlock.mp3" preload="auto"></audio>
        <audio src="/empty-preload.mp3" preload></audio>
        <video src="/autoplay-none.mp4" preload="none" autoplay></video>
        <video src="/intro.mp4" poster="/poster.jpg" preload="metadata"></video>
        <audio src="/none.mp3" preload="none"></audio>
        <video src="/deferred.mp4"></video>
      `),
    ).toEqual({
      urls: [
        '/main.css',
        '/font.woff2',
        '/preload-small.webp',
        '/preload-big.webp',
        '/boot.js',
        '/main.js',
        '/hero.avif',
        '/hero-2x.avif',
        '/hero.webp',
        '/hero-2x.webp',
        '/hero.png',
        '/hero-2x.png',
        '/hero-wide.png',
        '/unlock.mp3',
        '/empty-preload.mp3',
        '/autoplay-none.mp4',
        '/poster.jpg',
      ],
      entryScriptUrl: '/main.js',
    });
  });

  it('fails closed when eager media has no directly measurable source', () => {
    expect(() =>
      collectEagerAssetUrls(`
        <script type="module" src="/main.js"></script>
        <video autoplay preload="none"></video>
      `),
    ).toThrow('directly measurable src');
  });

  it('measures raw and deterministic gzip bytes across the eager graph', async () => {
    const directory = fixture();
    const measurement = await measureInitialTransfer(directory);

    expect(measurement.entryScriptUrl).toBe('/assets/main.js');
    expect(measurement.entryScriptRawBytes).toBe(
      Buffer.byteLength('import"./runtime.js";start();'),
    );
    expect(measurement.entryScriptGzipBytes).toBe(
      gzipSync('import"./runtime.js";start();', { level: 9 }).byteLength,
    );
    expect(measurement.entries.map(({ url }) => url)).toEqual([
      '/index.html',
      '/bootstrap.js?cache=v1',
      '/assets/main.css',
      '/assets/runtime.js',
      '/assets/main.js',
      '/dummy_audio.mp3',
    ]);
    expect(measurement.entries.find(({ url }) => url === '/dummy_audio.mp3')?.rawBytes).toBe(4);
    expect(measurement.eagerFontBytes).toBe(0);
  });

  it('rejects every metric independently and keeps the checked build wired', () => {
    const passing = { ...INITIAL_TRANSFER_BUDGET };
    expect(() => assertInitialTransferBudget(passing)).not.toThrow();

    for (const metric of Object.keys(INITIAL_TRANSFER_BUDGET) as Array<
      keyof typeof INITIAL_TRANSFER_BUDGET
    >) {
      const limit = INITIAL_TRANSFER_BUDGET[metric];
      expect(() => assertInitialTransferBudget({ ...passing, [metric]: limit + 1 })).toThrow(
        metric,
      );
    }

    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['guard:initial-transfer-budget']).toContain(
      'check-initial-transfer-budget.mjs',
    );
    expect(packageJson.scripts['build:checked']).toContain('guard:initial-transfer-budget');
  });

  it('fails closed when an eager transfer is cross-origin, data-backed, or missing', async () => {
    const externalDirectory = fixture();
    writeFileSync(
      join(externalDirectory, 'index.html'),
      '<script type="module" src="https://cdn.example/main.js"></script>',
    );
    await expect(measureInitialTransfer(externalDirectory)).rejects.toThrow('Cross-origin');

    const externalStyleDirectory = fixture();
    writeFileSync(
      join(externalStyleDirectory, 'index.html'),
      [
        '<link rel="stylesheet" href="https://cdn.example/theme.css">',
        '<script type="module" src="/assets/main.js"></script>',
      ].join('\n'),
    );
    await expect(measureInitialTransfer(externalStyleDirectory)).rejects.toThrow('Cross-origin');

    const dataPreloadDirectory = fixture();
    writeFileSync(
      join(dataPreloadDirectory, 'index.html'),
      [
        '<link rel="preload" as="style" href="data:text/css,body{}">',
        '<script type="module" src="/assets/main.js"></script>',
      ].join('\n'),
    );
    await expect(measureInitialTransfer(dataPreloadDirectory)).rejects.toThrow('data');

    const missingDirectory = fixture();
    writeFileSync(
      join(missingDirectory, 'index.html'),
      '<script type="module" src="/assets/missing.js"></script>',
    );
    await expect(measureInitialTransfer(missingDirectory)).rejects.toThrow('missing from dist');
  });
});
