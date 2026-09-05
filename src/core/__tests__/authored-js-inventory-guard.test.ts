import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INVENTORY_PATH,
  type AuthoredJavaScriptManifest,
  checkCurrentInventory,
  checkInlineNodeJavaScript,
  checkRepositoryInlineNodeJavaScript,
  checkMonotonicProgress,
  isAuthoredJavaScriptPath,
  listCurrentAuthoredJavaScriptSources,
  runInventoryGuard,
  summarizeSources,
  validateManifest,
} from '../../../scripts/check-authored-js-inventory.mts';

function readManifest(): AuthoredJavaScriptManifest {
  return JSON.parse(readFileSync(DEFAULT_INVENTORY_PATH, 'utf8')) as AuthoredJavaScriptManifest;
}

function cloneManifest(manifest: AuthoredJavaScriptManifest): AuthoredJavaScriptManifest {
  return structuredClone(manifest);
}

function refreshRemainingSummary(manifest: AuthoredJavaScriptManifest): void {
  manifest.remaining = summarizeSources(
    manifest.sources.filter((source) => source.status === 'remaining'),
  );
}

function manifestWithOneRemainingSource(): {
  manifest: AuthoredJavaScriptManifest;
  sourcePath: string;
} {
  const manifest = cloneManifest(readManifest());
  const source = manifest.sources.find((candidate) => candidate.status === 'retired');
  if (!source) throw new Error('The inventory fixture requires one historical source.');
  source.status = 'remaining';
  refreshRemainingSummary(manifest);
  return { manifest, sourcePath: source.path };
}

describe('authored JavaScript inventory shrink-only guard', () => {
  it('keeps the canonical baseline machine-readable and synchronized with the working tree', () => {
    const manifest = readManifest();
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.historical).toEqual({
      totalFiles: 107,
      totalLines: 77_793,
      jsMjsFiles: 98,
      jsMjsLines: 77_491,
      jsxFiles: 9,
      jsxLines: 302,
    });

    const currentPaths = listCurrentAuthoredJavaScriptSources();
    expect(checkCurrentInventory(manifest, currentPaths)).toEqual([]);
    expect(runInventoryGuard().errors).toEqual([]);
  });

  it('recognizes every authored JavaScript-family extension and excludes TypeScript', () => {
    expect(isAuthoredJavaScriptPath('cloudflare/worker.js')).toBe(true);
    expect(isAuthoredJavaScriptPath('scripts/release.mjs')).toBe(true);
    expect(isAuthoredJavaScriptPath('config.cjs')).toBe(true);
    expect(isAuthoredJavaScriptPath('design/App.jsx')).toBe(true);
    expect(isAuthoredJavaScriptPath('cloudflare/worker.ts')).toBe(false);
    expect(isAuthoredJavaScriptPath('scripts/release.mts')).toBe(false);
    expect(isAuthoredJavaScriptPath('design/App.tsx')).toBe(false);
  });

  it('rejects inline Node.js JavaScript in package and workflow commands', () => {
    for (const command of [
      'node -e "console.log(1)"',
      'node --eval="console.log(1)"',
      'node -p "require(\'pkg\').version"',
      'node --input-type=module -e "await import(\'./tool.js\')"',
      'node --no-warnings -e "console.log(1)"',
      'node --trace-warnings --input-type module --eval="console.log(1)"',
      'node.exe --no-deprecation --print "1"',
    ]) {
      expect(checkInlineNodeJavaScript('package.json', command)).toEqual([
        'Inline Node.js JavaScript is forbidden in package.json; use a typed script file.',
      ]);
    }
    expect(checkInlineNodeJavaScript('package.json', 'node scripts/check.mts')).toEqual([]);
    expect(
      checkInlineNodeJavaScript('package.json', 'node --no-warnings scripts/check.mts --eval text'),
    ).toEqual([]);
    expect(
      checkInlineNodeJavaScript('package.json', 'node --title=--eval scripts/check.mts -p text'),
    ).toEqual([]);
    expect(checkInlineNodeJavaScript('release.yml', 'npm exec wrangler --version')).toEqual([]);
  });

  it('ignores a tracked workflow that was deleted from the working tree', () => {
    const repository = mkdtempSync(join(tmpdir(), 'mxqr-authored-js-'));
    try {
      execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
      const workflowDirectory = join(repository, '.github', 'workflows');
      const workflowPath = join(workflowDirectory, 'retired.yml');
      mkdirSync(workflowDirectory, { recursive: true });
      writeFileSync(join(repository, 'package.json'), '{"scripts":{}}\n', 'utf8');
      writeFileSync(workflowPath, 'name: retired\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'ignore' });
      unlinkSync(workflowPath);

      expect(checkRepositoryInlineNodeJavaScript(repository)).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects a new JavaScript path even when the total count does not grow', () => {
    const { manifest, sourcePath } = manifestWithOneRemainingSource();
    const currentPaths = [sourcePath];
    const replaced = currentPaths.slice(1).concat('cloudflare/new-worker.js');

    const errors = checkCurrentInventory(manifest, replaced);
    expect(errors).toContain(
      'New authored JavaScript-family source is outside the baseline: cloudflare/new-worker.js.',
    );
    expect(errors.some((error) => error.startsWith('Remaining baseline path is absent:'))).toBe(
      true,
    );
  });

  it('allows only an atomic remaining-to-retired shrink', () => {
    const { manifest: previous, sourcePath } = manifestWithOneRemainingSource();
    const current = cloneManifest(previous);
    const source = current.sources.find((candidate) => candidate.path === sourcePath);
    if (!source) throw new Error(`The synthetic remaining source is missing: ${sourcePath}.`);

    source.status = 'retired';
    refreshRemainingSummary(current);
    const currentPaths = listCurrentAuthoredJavaScriptSources();

    expect(validateManifest(current)).toEqual([]);
    expect(checkMonotonicProgress(previous, current)).toEqual([]);
    expect(checkCurrentInventory(current, currentPaths)).toEqual([]);
  });

  it('fails a retired-to-remaining baseline increase', () => {
    const previous = readManifest();
    const current = cloneManifest(previous);
    const retired = current.sources.find((source) => source.status === 'retired');
    expect(retired).toBeDefined();
    if (!retired) return;

    retired.status = 'remaining';
    refreshRemainingSummary(current);
    expect(checkMonotonicProgress(previous, current)).toContain(
      `Shrink-only baseline regressed from retired to remaining: ${retired.path}.`,
    );
  });

  it('fails if a historical source entry or its line snapshot is rewritten', () => {
    const previous = readManifest();
    const current = cloneManifest(previous);
    const [first] = current.sources;
    expect(first).toBeDefined();
    if (!first) return;
    first.baselineLines += 1;

    expect(checkMonotonicProgress(previous, current)).toContain(
      `Historical baselineLines changed for ${first.path}.`,
    );
  });
});
