import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INLINE_INVENTORY_PATH,
  type AuthoredInlineManifest,
  checkCurrentInlineInventory,
  checkInlineMonotonicProgress,
  countExecutableInlineScripts,
  listCurrentInlineSources,
  runInlineInventoryGuard,
  validateInlineManifest,
} from '../../../scripts/check-authored-inline-js-inventory.mts';

function readManifest(): AuthoredInlineManifest {
  return JSON.parse(readFileSync(DEFAULT_INLINE_INVENTORY_PATH, 'utf8')) as AuthoredInlineManifest;
}

describe('authored inline JavaScript shrink-only guard', () => {
  it('keeps every historical inline block synchronized with the working tree', () => {
    const manifest = readManifest();
    expect(validateInlineManifest(manifest)).toEqual([]);
    expect(manifest.historicalBlocks).toBe(8);
    expect(checkCurrentInlineInventory(manifest, listCurrentInlineSources())).toEqual([]);
    expect(runInlineInventoryGuard().errors).toEqual([]);
  });

  it('counts executable inline scripts but ignores external and data scripts', () => {
    const html = `
      <script src="/external.js"></script>
      <script type="application/ld+json">{"name":"MUSIXQUARE"}</script>
      <script type="importmap">{"imports":{}}</script>
      <script type="module">boot()</script>
      <script type="text/babel">render()</script>
    `;
    expect(countExecutableInlineScripts(html)).toBe(2);
  });

  it('detects event handlers and normalized javascript URLs without counting inert text', () => {
    expect(countExecutableInlineScripts('<button oNcLiCk=boot()>Boot</button>')).toBe(1);
    expect(
      countExecutableInlineScripts('<a href=" \nJaVa&#x53;cRiPt&colon;launch()">Launch</a>'),
    ).toBe(1);
    expect(
      countExecutableInlineScripts(
        '<svg><a XLINK:HREF="java&#115;cript:launch()">Launch</a></svg>',
      ),
    ).toBe(1);
    expect(
      countExecutableInlineScripts(
        '<!-- <button onclick="ignored()"> --><div data-example="javascript:ignored()"></div>',
      ),
    ).toBe(0);
  });

  it('discovers executable markup extensions case-insensitively', () => {
    const repository = mkdtempSync(resolve(tmpdir(), 'mxqr-inline-markup-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      const fixtures = new Map([
        ['page.HTML', '<SCRIPT>boot()</SCRIPT>'],
        ['legacy.HtM', '<a href="javascript:boot()">Boot</a>'],
        ['document.XhTmL', '<button onfocus="boot()">Boot</button>'],
        ['vector.SvG', '<svg><script>boot()</script></svg>'],
      ]);
      for (const [name, source] of fixtures) writeFileSync(resolve(repository, name), source);
      writeFileSync(resolve(repository, 'ignored.txt'), '<script>ignored()</script>');

      const current = listCurrentInlineSources(repository);
      expect(current.size).toBe(fixtures.size);
      for (const name of fixtures.keys()) expect(current.get(name)).toBe(1);
      expect(current.has('ignored.txt')).toBe(false);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it('rejects unknown paths, restored retired paths, and block-count growth', () => {
    const manifest = readManifest();
    expect(checkCurrentInlineInventory(manifest, new Map([['new.html', 1]]))).toContain(
      'New executable inline script is outside the baseline: new.html.',
    );

    const retired = structuredClone(manifest);
    retired.sources[0]!.status = 'retired';
    retired.remainingBlocks = retired.sources
      .filter((source) => source.status === 'remaining')
      .reduce((total, source) => total + source.baselineBlocks, 0);
    expect(
      checkCurrentInlineInventory(retired, new Map([[retired.sources[0]!.path, 1]])),
    ).toContain(`Retired executable inline script was restored: ${retired.sources[0]!.path}.`);

    const remaining = structuredClone(manifest);
    remaining.sources[0]!.status = 'remaining';
    remaining.remainingBlocks = remaining.sources
      .filter((source) => source.status === 'remaining')
      .reduce((total, source) => total + source.baselineBlocks, 0);
    expect(
      checkCurrentInlineInventory(remaining, new Map([[remaining.sources[0]!.path, 2]])),
    ).toContain(`${remaining.sources[0]!.path} has 2 executable inline blocks; baseline is 1.`);
  });

  it('allows only remaining-to-retired progress', () => {
    const previous = structuredClone(readManifest());
    previous.sources[0]!.status = 'remaining';
    previous.remainingBlocks = previous.sources
      .filter((source) => source.status === 'remaining')
      .reduce((total, source) => total + source.baselineBlocks, 0);
    const current = structuredClone(previous);
    current.sources[0]!.status = 'retired';
    current.remainingBlocks -= current.sources[0]!.baselineBlocks;
    expect(checkInlineMonotonicProgress(previous, current)).toEqual([]);

    const regressed = structuredClone(current);
    expect(checkInlineMonotonicProgress(current, regressed)).toEqual([]);
    regressed.sources[0]!.status = 'remaining';
    regressed.remainingBlocks += regressed.sources[0]!.baselineBlocks;
    expect(checkInlineMonotonicProgress(current, regressed)).toContain(
      `Inline baseline regressed from retired to remaining: ${regressed.sources[0]!.path}.`,
    );
  });

  it.each(['regression', 'regression-followup', 'progress'])(
    'checks committed manifest history in a clean checkout: %s',
    (scenario) => {
      const repository = mkdtempSync(resolve(tmpdir(), 'mxqr-inline-history-'));
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: repository,
          stdio: 'ignore',
        });
      const commit = (message: string) => {
        git('add', '.');
        git(
          '-c',
          'user.name=Audit Fixture',
          '-c',
          'user.email=audit@example.invalid',
          'commit',
          '-m',
          message,
        );
      };
      try {
        git('init', '--quiet');
        const manifest: AuthoredInlineManifest = {
          schemaVersion: 1,
          capturedAt: '2026-01-01',
          policy: 'authored-inline-js-shrink-only',
          historicalBlocks: 1,
          remainingBlocks: scenario === 'progress' ? 1 : 0,
          sources: [
            {
              path: 'page.html',
              baselineBlocks: 1,
              status: scenario === 'progress' ? 'remaining' : 'retired',
            },
          ],
        };
        const inventoryPath = resolve(repository, 'manifest.json');
        const writeCurrent = () => {
          writeFileSync(inventoryPath, JSON.stringify(manifest));
          writeFileSync(
            resolve(repository, 'page.html'),
            manifest.remainingBlocks ? '<script>boot()</script>' : '<p>Typed runtime</p>',
          );
        };
        writeCurrent();
        commit('initial baseline');
        manifest.remainingBlocks = scenario === 'progress' ? 0 : 1;
        manifest.sources[0]!.status = scenario === 'progress' ? 'retired' : 'remaining';
        writeCurrent();
        commit('change inline inventory');
        if (scenario === 'regression-followup') {
          writeFileSync(resolve(repository, 'README.md'), 'Unrelated follow-up');
          commit('unrelated follow-up');
        }
        const result = runInlineInventoryGuard(repository, inventoryPath);
        if (scenario === 'progress') expect(result.errors).toEqual([]);
        else
          expect(result.errors).toContain(
            'Inline baseline regressed from retired to remaining: page.html.',
          );
      } finally {
        rmSync(repository, { force: true, recursive: true });
      }
    },
  );
});
