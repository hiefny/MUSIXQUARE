import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DIAGNOSTIC_BASELINE_PATH,
  type StrictDiagnosticAllowance,
  type StrictDiagnosticBaseline,
  checkBaselineMonotonicProgress,
  compareDiagnosticsToBaseline,
  createDiagnosticBaseline,
  runDiagnosticRatchet,
  validateDiagnosticBaseline,
} from '../../../scripts/check-typescript-diagnostic-ratchet.mts';

function allowance(path: string, code: number, count: number): StrictDiagnosticAllowance {
  return { path, code, count };
}

function fixtureBaseline(): StrictDiagnosticBaseline {
  return createDiagnosticBaseline(
    ['cloudflare/example.js'],
    [allowance('cloudflare/example.js', 7006, 3)],
    '2026-08-17',
  );
}

describe('strict TypeScript diagnostic shrink-only ratchet', () => {
  it('keys debt only by source path and TypeScript code, without message or location data', () => {
    const baseline = fixtureBaseline();
    expect(baseline.identity).toEqual({
      algorithm: 'repository path + TypeScript diagnostic code',
      aggregatesCount: true,
      storesMessageText: false,
      storesSourceText: false,
      storesLocation: false,
    });
    expect(baseline.diagnostics).toEqual([{ path: 'cloudflare/example.js', code: 7006, count: 3 }]);
  });

  it('allows the aggregated count for an existing path and code to shrink', () => {
    const baseline = fixtureBaseline();
    const comparison = compareDiagnosticsToBaseline(baseline, baseline.scope.sources, [
      allowance('cloudflare/example.js', 7006, 1),
    ]);

    expect(comparison.errors).toEqual([]);
    expect(comparison.reducedDiagnostics).toBe(2);
  });

  it('allows a source to retire but rejects a new JavaScript source path', () => {
    const baseline = fixtureBaseline();
    const retired = compareDiagnosticsToBaseline(baseline, [], []);
    expect(retired.errors).toEqual([]);
    expect(retired.retiredSources).toBe(1);

    const added = compareDiagnosticsToBaseline(baseline, ['cloudflare/new-worker.js'], []);
    expect(added.errors).toContain('New authored JavaScript source: cloudflare/new-worker.js.');
  });

  it('blocks both a new diagnostic code and an increase of an existing code count', () => {
    const baseline = fixtureBaseline();
    const comparison = compareDiagnosticsToBaseline(baseline, baseline.scope.sources, [
      allowance('cloudflare/example.js', 7006, 4),
      allowance('cloudflare/example.js', 2322, 1),
    ]);

    expect(comparison.errors).toContain(
      'Strict diagnostic count increased: cloudflare/example.js TS7006 3 -> 4.',
    );
    expect(comparison.errors).toContain(
      'New strict diagnostic identity: cloudflare/example.js TS2322.',
    );
  });

  it('prevents the machine baseline itself from being widened', () => {
    const previous = fixtureBaseline();
    const reduced = structuredClone(previous);
    reduced.diagnostics[0].count = 1;
    reduced.totalDiagnostics = 1;
    expect(checkBaselineMonotonicProgress(previous, reduced)).toEqual([]);

    const widened = structuredClone(previous);
    widened.diagnostics.push(allowance('cloudflare/example.js', 2322, 1));
    widened.totalDiagnostics += 1;
    expect(checkBaselineMonotonicProgress(previous, widened)).toContain(
      'Diagnostic baseline added a new identity: cloudflare/example.js TS2322.',
    );
  });

  it('forbids raw diagnostic messages, source snippets, and locations in the baseline', () => {
    const baseline = fixtureBaseline();
    const unsafe = structuredClone(baseline) as unknown as Record<string, unknown> & {
      diagnostics: Array<Record<string, unknown>>;
    };
    unsafe.diagnostics[0].message = 'source-derived diagnostic text';
    unsafe.sourceText = 'source body';

    const errors = validateDiagnosticBaseline(unsafe);
    expect(errors).toContain(
      'Diagnostic baseline contains fields outside the privacy-preserving schema.',
    );
    expect(errors).toContain(
      'diagnostics[0] may contain only path, code, and count; message text, source text, and locations are forbidden.',
    );
  });

  it('keeps the checked-in baseline valid and synchronized with current strict diagnostics', () => {
    const baseline = JSON.parse(
      readFileSync(DEFAULT_DIAGNOSTIC_BASELINE_PATH, 'utf8'),
    ) as StrictDiagnosticBaseline;
    expect(validateDiagnosticBaseline(baseline)).toEqual([]);

    const result = runDiagnosticRatchet();
    expect(result.errors).toEqual([]);
    expect(result.currentDiagnostics.every((entry) => Object.keys(entry).length === 3)).toBe(true);
  });
});
