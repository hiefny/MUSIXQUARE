import { describe, expect, it, vi } from 'vitest';
import {
  BootstrapReadinessLedger,
  formatBootstrapReadinessSummary,
  runBootstrapStepAsync,
} from '../bootstrap-readiness.ts';

describe('BootstrapReadinessLedger', () => {
  it('reports ready only after every observed step succeeds', async () => {
    const ledger = new BootstrapReadinessLedger([]);

    expect(ledger.runSync('Platform', () => 'platform')).toEqual({
      ok: true,
      value: 'platform',
    });
    const onFailure = vi.fn();
    await runBootstrapStepAsync(ledger, 'I18n', async () => undefined, onFailure);

    const snapshot = ledger.snapshot();
    expect(onFailure).not.toHaveBeenCalled();
    expect(snapshot).toEqual({
      state: 'ready',
      total: 2,
      succeeded: 2,
      failures: [],
      fallbacks: [],
      missingRequired: [],
    });
    expect(formatBootstrapReadinessSummary(snapshot)).toBe('[App] Bootstrap wiring ready (2/2)');
  });

  it('degrades when a required initializer was never observed', () => {
    const ledger = new BootstrapReadinessLedger(['Platform', 'Dialog']);

    ledger.runSync('Platform', () => undefined);

    const snapshot = ledger.snapshot();
    expect(snapshot).toMatchObject({
      state: 'degraded',
      total: 1,
      succeeded: 1,
      failures: [],
      fallbacks: [],
      missingRequired: ['Dialog'],
    });
    expect(formatBootstrapReadinessSummary(snapshot)).toBe(
      '[App] Bootstrap wiring degraded (1/1; 0 failed, 0 fallback, 1 missing): missing: Dialog',
    );
  });

  it('records a sync failure without throwing or preventing the next step', () => {
    const ledger = new BootstrapReadinessLedger([]);
    const error = new Error('dialog failed');
    const laterInit = vi.fn();

    const failed = ledger.runSync('Dialog', () => {
      throw error;
    });
    ledger.runSync('Tabs', laterInit);

    expect(failed).toEqual({ ok: false, error });
    expect(laterInit).toHaveBeenCalledOnce();
    expect(ledger.snapshot()).toEqual({
      state: 'degraded',
      total: 2,
      succeeded: 1,
      failures: [{ name: 'Dialog', phase: 'sync', status: 'failure' }],
      fallbacks: [],
      missingRequired: [],
    });
  });

  it('records an async rejection and preserves failure order across phases', async () => {
    const ledger = new BootstrapReadinessLedger([]);
    const asyncError = new Error('i18n failed');
    const onFailure = vi.fn();

    ledger.runSync('Platform', () => {
      throw new Error('platform failed');
    });
    await runBootstrapStepAsync(
      ledger,
      'I18n',
      async () => {
        throw asyncError;
      },
      onFailure,
    );
    ledger.runSync('Setup', () => undefined);

    const snapshot = ledger.snapshot();
    expect(onFailure).toHaveBeenCalledWith(asyncError);
    expect(snapshot.failures).toEqual([
      { name: 'Platform', phase: 'sync', status: 'failure' },
      { name: 'I18n', phase: 'async', status: 'failure' },
    ]);
    expect(snapshot.total).toBe(3);
    expect(snapshot.succeeded).toBe(1);
    expect(formatBootstrapReadinessSummary(snapshot)).toBe(
      '[App] Bootstrap wiring degraded (1/3; 2 failed, 0 fallback, 0 missing): ' +
        'failed: Platform[sync], I18n[async]',
    );
  });

  it('updates a successful worker to one deduplicated fallback outcome', () => {
    const ledger = new BootstrapReadinessLedger([]);

    expect(ledger.recordSuccess('SyncWorker', 'worker')).toBe(true);
    expect(ledger.recordFallback('SyncWorker', 'worker')).toBe(true);
    expect(ledger.recordFallback('SyncWorker', 'worker')).toBe(false);

    const snapshot = ledger.snapshot();
    expect(snapshot).toEqual({
      state: 'degraded',
      total: 1,
      succeeded: 0,
      failures: [],
      fallbacks: [{ name: 'SyncWorker', phase: 'worker', status: 'fallback' }],
      missingRequired: [],
    });
    expect(formatBootstrapReadinessSummary(snapshot)).toBe(
      '[App] Bootstrap wiring degraded (0/1; 0 failed, 1 fallback, 0 missing): ' +
        'fallback: SyncWorker[worker]',
    );
  });
});
