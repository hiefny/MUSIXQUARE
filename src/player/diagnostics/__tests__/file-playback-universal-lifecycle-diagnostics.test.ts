import { describe, expect, it } from 'vitest';

import {
  FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS,
  createFilePlaybackUniversalLifecycleDiagnostics,
  type FilePlaybackUniversalLifecycleKind,
  type FilePlaybackUniversalLifecycleSnapshot,
} from '../file-playback-universal-lifecycle-diagnostics.ts';

function outstanding(
  snapshot: FilePlaybackUniversalLifecycleSnapshot,
  kind: FilePlaybackUniversalLifecycleKind,
) {
  const counters = snapshot.kinds[kind];
  return counters.live + counters.retiring + counters.unconfirmed;
}

function expectAccountingInvariant(snapshot: FilePlaybackUniversalLifecycleSnapshot): void {
  for (const kind of FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS) {
    const counters = snapshot.kinds[kind];
    expect(counters.acquiredTotal).toBe(counters.releasedTotal + outstanding(snapshot, kind));
  }
}

function expectOnlyNumericMetricsAndQuiescentBoolean(value: unknown, path: string[] = []): void {
  if (typeof value === 'object' && value !== null) {
    expect(Array.isArray(value)).toBe(false);
    for (const [key, child] of Object.entries(value)) {
      expectOnlyNumericMetricsAndQuiescentBoolean(child, [...path, key]);
    }
    return;
  }

  if (path.at(-1) === 'quiescent') {
    expect(typeof value).toBe('boolean');
    return;
  }

  expect(typeof value).toBe('number');
  expect(Number.isSafeInteger(value)).toBe(true);
}

describe('file playback universal lifecycle diagnostics', () => {
  it('publishes one deeply frozen, numeric-only, JSON-safe snapshot with fixed kinds', () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    const snapshot = diagnostics.snapshot();

    expect(Object.keys(snapshot.kinds)).toEqual(FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS);
    expect(snapshot).toMatchObject({
      sequence: 0,
      invariantFaults: 0,
      forcedRetirements: 0,
      quiescent: true,
    });
    for (const kind of FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS) {
      expect(snapshot.kinds[kind]).toEqual({
        live: 0,
        retiring: 0,
        unconfirmed: 0,
        acquiredTotal: 0,
        releasedTotal: 0,
        highWater: 0,
      });
      expect(Object.isFrozen(snapshot.kinds[kind])).toBe(true);
    }
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.kinds)).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expectOnlyNumericMetricsAndQuiescentBoolean(snapshot);
    expectAccountingInvariant(snapshot);
  });

  it('tracks live, retiring, confirmed release, high-water, and quiescence', () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    const first = diagnostics.acquire('workers');
    const second = diagnostics.acquire('workers');
    const acquired = diagnostics.snapshot();

    expect(acquired.kinds.workers).toEqual({
      live: 2,
      retiring: 0,
      unconfirmed: 0,
      acquiredTotal: 2,
      releasedTotal: 0,
      highWater: 2,
    });
    expect(acquired.sequence).toBe(2);
    expect(acquired.quiescent).toBe(false);

    const firstRetirement = first.beginRetire();
    expect(diagnostics.snapshot().kinds.workers).toMatchObject({ live: 1, retiring: 1 });
    firstRetirement.release();
    second.beginRetire().release();

    const released = diagnostics.snapshot();
    expect(released.kinds.workers).toEqual({
      live: 0,
      retiring: 0,
      unconfirmed: 0,
      acquiredTotal: 2,
      releasedTotal: 2,
      highWater: 2,
    });
    expect(released.sequence).toBe(6);
    expect(released.invariantFaults).toBe(0);
    expect(released.quiescent).toBe(true);
    expectAccountingInvariant(released);
  });

  it('keeps ownership retiring until an awaited acknowledgement is followed by release', async () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    const retirement = diagnostics.acquire('ports').beginRetire();
    let resolveAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    const releaseAfterAcknowledgement = acknowledgement.then(() => retirement.release());

    expect(diagnostics.snapshot().kinds.ports).toMatchObject({
      live: 0,
      retiring: 1,
      releasedTotal: 0,
    });

    resolveAcknowledgement();
    await releaseAfterAcknowledgement;

    expect(diagnostics.snapshot().kinds.ports).toMatchObject({
      retiring: 0,
      releasedTotal: 1,
    });
  });

  it('counts re-entry and double transitions without changing valid accounting', () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    const lease = diagnostics.acquire('rings');
    const retirement = lease.beginRetire();

    expect(lease.beginRetire()).toBe(retirement);
    retirement.release();
    retirement.release();
    lease.forceUnconfirmed();

    const snapshot = diagnostics.snapshot();
    expect(snapshot.kinds.rings).toEqual({
      live: 0,
      retiring: 0,
      unconfirmed: 0,
      acquiredTotal: 1,
      releasedTotal: 1,
      highWater: 1,
    });
    expect(snapshot.invariantFaults).toBe(3);
    expect(snapshot.sequence).toBe(6);
    expect(snapshot.quiescent).toBe(true);
    expectAccountingInvariant(snapshot);
  });

  it('makes timeout or forced cleanup sticky-unconfirmed from live or retiring', () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    const liveLease = diagnostics.acquire('pendingReads');
    const retiringLease = diagnostics.acquire('timers');
    const retirement = retiringLease.beginRetire();

    liveLease.forceUnconfirmed();
    retirement.forceUnconfirmed();
    const invalidRetirement = liveLease.beginRetire();
    invalidRetirement.release();
    liveLease.forceUnconfirmed();
    retirement.release();

    const snapshot = diagnostics.snapshot();
    expect(snapshot.kinds.pendingReads).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 1,
      acquiredTotal: 1,
      releasedTotal: 0,
      highWater: 1,
    });
    expect(snapshot.kinds.timers).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 1,
      acquiredTotal: 1,
      releasedTotal: 0,
      highWater: 1,
    });
    expect(snapshot.forcedRetirements).toBe(2);
    expect(snapshot.invariantFaults).toBe(4);
    expect(snapshot.quiescent).toBe(false);
    expectAccountingInvariant(snapshot);
  });

  it('refuses invalid kinds without adding dynamic or identifying snapshot data', () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    const identifyingValue = 'listener-email@example.invalid';

    expect(() =>
      diagnostics.acquire(identifyingValue as FilePlaybackUniversalLifecycleKind),
    ).toThrow(RangeError);

    const snapshot = diagnostics.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(Object.keys(snapshot.kinds)).toEqual(FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS);
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.invariantFaults).toBe(1);
    expect(serialized).not.toContain(identifyingValue);
    expect(serialized).not.toMatch(/(?:id|label|error|stack|message)/i);
    expectOnlyNumericMetricsAndQuiescentBoolean(snapshot);
    expectAccountingInvariant(snapshot);
  });

  it('refuses counter overflow while preserving acquired = released + outstanding', () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics({ counterLimit: 2 });
    const first = diagnostics.acquire('decoderGenerations');
    const second = diagnostics.acquire('decoderGenerations');

    expect(() => diagnostics.acquire('decoderGenerations')).toThrow(RangeError);
    let snapshot = diagnostics.snapshot();
    expect(snapshot.kinds.decoderGenerations).toMatchObject({
      live: 2,
      acquiredTotal: 2,
      releasedTotal: 0,
      highWater: 2,
    });
    expect(snapshot.sequence).toBe(2);
    expect(snapshot.invariantFaults).toBe(1);
    expectAccountingInvariant(snapshot);

    first.beginRetire().release();
    second.beginRetire().release();
    expect(() => diagnostics.acquire('decoderGenerations')).toThrow(RangeError);

    snapshot = diagnostics.snapshot();
    expect(snapshot.kinds.decoderGenerations).toMatchObject({
      live: 0,
      retiring: 0,
      unconfirmed: 0,
      acquiredTotal: 2,
      releasedTotal: 2,
      highWater: 2,
    });
    expect(snapshot.sequence).toBe(2);
    expect(snapshot.invariantFaults).toBe(2);
    expect(snapshot.quiescent).toBe(true);
    expectOnlyNumericMetricsAndQuiescentBoolean(snapshot);
    expectAccountingInvariant(snapshot);
  });

  it('accounts for every fixed lifecycle kind independently', () => {
    const diagnostics = createFilePlaybackUniversalLifecycleDiagnostics();
    for (const kind of FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS) diagnostics.acquire(kind);

    const snapshot = diagnostics.snapshot();
    for (const kind of FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS) {
      expect(snapshot.kinds[kind]).toMatchObject({
        live: 1,
        acquiredTotal: 1,
        releasedTotal: 0,
        highWater: 1,
      });
    }
    expect(snapshot.sequence).toBe(FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS.length);
    expect(snapshot.invariantFaults).toBe(0);
    expectAccountingInvariant(snapshot);
  });
});
