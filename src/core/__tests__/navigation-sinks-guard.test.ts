import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  analyzeNavigationSinks,
  assertNavigationSinks,
  loadNavigationSinksInput,
  type NavigationSinksInput,
} from '../../../scripts/check-navigation-sinks.mts';

// The guard runs on the real tree; every seeded violation below edits an
// in-memory copy of it (or a temporary directory), never a checked-in file.
let baseline: NavigationSinksInput | null = null;

function realInput(): NavigationSinksInput {
  baseline ??= loadNavigationSinksInput(process.cwd());
  return baseline;
}

function withSources(edit: (sources: Map<string, string>) => void): NavigationSinksInput {
  const sources = new Map(realInput().sources);
  edit(sources);
  return { sources };
}

function replaceIn(sources: Map<string, string>, file: string, from: string, to: string): void {
  const source = sources.get(file) ?? '';
  expect(source).toContain(from);
  sources.set(file, source.replace(from, to));
}

function findingsOf(input: NavigationSinksInput): string {
  return analyzeNavigationSinks(input).findings.join('\n');
}

function runGuard(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/check-navigation-sinks.mts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('navigation-sink guard (C6-14)', { timeout: 60_000 }, () => {
  it('passes on the real tree', () => {
    const report = assertNavigationSinks(realInput());
    expect(report.findings).toEqual([]);
    expect(report.counts['location navigation']).toBe(6);
  });

  it('runs from CI as an npm guard and fails a broken tree with exit 1', () => {
    const passing = runGuard();
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toContain('[navigation-sinks] OK');

    const root = mkdtempSync(join(tmpdir(), 'navigation-sinks-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'stray.ts'),
        "export function leave(): void {\n  window.location.href = '/';\n}\n",
      );
      const failing = runGuard(`--root=${root}`);
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain(
        'UNSANCTIONED location navigation: src/stray.ts :: leave has 1',
      );
      expect(failing.stderr).toContain(
        'STALE BASELINE location navigation: src/core/navigation.ts :: navigateToAppHome has 0',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['guard:navigation-sinks']).toBe(
      'node scripts/check-navigation-sinks.mts',
    );
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain(
      'npm run guard:navigation-sinks',
    );
  });

  it('pins each location sink to its function, including writes and every receiver form', () => {
    const findings = findingsOf(
      withSources((sources) => {
        sources.set(
          'src/ui/rogue.ts',
          [
            'export function a(): void { location.replace("/"); }',
            'export function b(): void { window.location.assign("/x"); }',
            'export const c = (): void => { globalThis.location.hash = "#y"; };',
            'export function d(): void { location = "/z" as never; }',
          ].join('\n'),
        );
      }),
    );
    expect(findings).toContain('UNSANCTIONED location navigation: src/ui/rogue.ts :: a has 1');
    expect(findings).toContain('UNSANCTIONED location navigation: src/ui/rogue.ts :: b has 1');
    expect(findings).toContain('UNSANCTIONED location navigation: src/ui/rogue.ts :: c has 1');
    expect(findings).toContain('UNSANCTIONED location navigation: src/ui/rogue.ts :: d has 1');
  });

  it('rejects a second sink in an allowed function and a sink moved to another function', () => {
    const findings = findingsOf(
      withSources((sources) => {
        replaceIn(
          sources,
          'src/core/navigation.ts',
          "  location.replace('/');",
          "  location.replace('/');\n  location.replace('/');",
        );
        replaceIn(
          sources,
          'src/core/session-reset.ts',
          'function startQueuedReload(): void {',
          'function stray(): void {\n  window.location.reload();\n}\n\nfunction startQueuedReload(): void {',
        );
      }),
    );
    expect(findings).toMatch(
      /RATCHET REGRESSION location navigation: src\/core\/navigation\.ts :: navigateToAppHome has 2, baseline 1/u,
    );
    expect(findings).toMatch(
      /UNSANCTIONED location navigation: src\/core\/session-reset\.ts :: stray has 1/u,
    );
  });

  it('keeps the locale navigation allow-listed with its owner decision', () => {
    const report = analyzeNavigationSinks(
      withSources((sources) =>
        replaceIn(
          sources,
          'src/i18n/localized-app-document.ts',
          '    window.location.assign(href);',
          '    void href;',
        ),
      ),
    );
    expect(report.findings.join('\n')).toMatch(
      /STALE BASELINE location navigation: src\/i18n\/localized-app-document\.ts :: requestFullDocumentNavigation has 0, baseline 1/u,
    );
    const guardSource = readFileSync('scripts/check-navigation-sinks.mts', 'utf8');
    expect(guardSource).toContain('owner decision 7 (2026-10-23)');
  });

  it('allows SKIP_WAITING only in the update machine and the hard-reset promotion', () => {
    const findings = findingsOf(
      withSources((sources) =>
        sources.set(
          'src/ui/rogue-update.ts',
          "export function promote(worker: ServiceWorker): void { worker.postMessage({ type: 'SKIP_WAITING' }); }",
        ),
      ),
    );
    expect(findings).toContain(
      'UNSANCTIONED SKIP_WAITING send: src/ui/rogue-update.ts :: promote has 1',
    );
  });

  it('allows history traversal only in the Back guard and its leave', () => {
    const findings = findingsOf(
      withSources((sources) =>
        sources.set(
          'src/ui/rogue-back.ts',
          'export function goBack(): void { window.history.back(); }',
        ),
      ),
    );
    expect(findings).toContain(
      'UNSANCTIONED history traversal: src/ui/rogue-back.ts :: goBack has 1',
    );
  });

  it('lists every requester of the owner and every unload-exemption claimer', () => {
    const findings = findingsOf(
      withSources((sources) => {
        sources.set(
          'src/ui/rogue-requester.ts',
          [
            "import { scheduleDocumentReload } from '../core/session-reset.ts';",
            "import { claimUnloadExemption } from '../core/page-lifecycle.ts';",
            "export function refresh(): void { scheduleDocumentReload('Refreshing'); }",
            "export function quiet(): void { claimUnloadExemption('navigation'); }",
          ].join('\n'),
        );
        replaceIn(
          sources,
          'src/ui/keep-open-notice.ts',
          "scheduleDocumentReload(t('dialog.leaving_session'))",
          "scheduleDocumentReload(t('dialog.leaving_session')); scheduleDocumentReload('again')",
        );
      }),
    );
    expect(findings).toContain(
      'UNSANCTIONED navigation owner requester: src/ui/rogue-requester.ts has 1',
    );
    expect(findings).toContain(
      'UNSANCTIONED unload-exemption claim: src/ui/rogue-requester.ts has 1',
    );
    expect(findings).toMatch(
      /RATCHET REGRESSION navigation owner requester: src\/ui\/keep-open-notice\.ts has 2, baseline 1/u,
    );
  });

  it('keeps the names the Phase 2 owner replaced out of production code', () => {
    const findings = findingsOf(
      withSources((sources) => {
        replaceIn(
          sources,
          'src/core/session-reset.ts',
          '/** Whether this document currently owns a blocking hard-reset attempt. */',
          'export function restoreSessionReset(): void {}\n\n/** Whether this document currently owns a blocking hard-reset attempt. */',
        );
        sources.set('src/core/flag.ts', 'export const markIntentionalNav = (): void => undefined;');
      }),
    );
    expect(findings).toMatch(/RETIRED NAME: src\/core\/session-reset\.ts:\d+ restoreSessionReset/u);
    expect(findings).toMatch(/RETIRED NAME: src\/core\/flag\.ts:1 markIntentionalNav/u);
  });

  it('ignores comments, strings and tests', () => {
    const findings = findingsOf(
      withSources((sources) => {
        sources.set(
          'src/ui/quiet.ts',
          [
            '// location.reload() and history.back() in a comment',
            'export const text = \'location.href = "/"; SKIP-WAITING\';',
          ].join('\n'),
        );
      }),
    );
    expect(findings).toBe('');
    expect([...realInput().sources.keys()].some((file) => file.includes('__tests__'))).toBe(false);
  });
});
