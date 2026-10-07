import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

describe('local large-audio diagnostics', () => {
  it.each(['tracks', 'readers', 'playbacks', 'workerCalls'] as const)(
    'balances %s and makes release idempotent',
    async (kind) => {
      const { beginLargeAudioResource, getLargeAudioDiagnostics } =
        await import('../diagnostics.ts');
      const releaseFirst = beginLargeAudioResource(kind);
      const releaseSecond = beginLargeAudioResource(kind);
      expect(getLargeAudioDiagnostics().resources[kind]).toEqual({
        live: 2,
        peak: 2,
        opened: 2,
        closed: 0,
      });
      releaseFirst();
      releaseFirst();
      expect(getLargeAudioDiagnostics().resources[kind]).toEqual({
        live: 1,
        peak: 2,
        opened: 2,
        closed: 1,
      });
      releaseSecond();
      releaseSecond();
      expect(getLargeAudioDiagnostics().resources[kind]).toEqual({
        live: 0,
        peak: 2,
        opened: 2,
        closed: 2,
      });
    },
  );

  it('returns detached nested numeric snapshots without retaining resource objects', async () => {
    const { beginLargeAudioResource, getLargeAudioDiagnostics } = await import('../diagnostics.ts');
    const release = beginLargeAudioResource('tracks');
    const historical = getLargeAudioDiagnostics();
    const edited = getLargeAudioDiagnostics();
    for (const counters of Object.values(edited.resources)) {
      counters.live = 999;
      counters.closed = 999;
    }
    edited.output.supplyGaps = 999;
    release();
    const current = getLargeAudioDiagnostics();
    expect(historical.resources.tracks.live).toBe(1);
    expect(current.resources.tracks).toEqual({ live: 0, peak: 1, opened: 1, closed: 1 });
    expect(current.resources.readers.live).toBe(0);
    expect(current.output.supplyGaps).toBe(0);
    expect(Object.keys(current)).toEqual(['resources', 'output']);
    expect(Object.keys(current.resources)).toEqual([
      'tracks',
      'readers',
      'playbacks',
      'workerCalls',
    ]);
    const leaves = [
      ...Object.values(current.resources).flatMap(Object.values),
      ...Object.values(current.output),
    ];
    expect(leaves.every((value) => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    expect(JSON.parse(JSON.stringify(current))).toEqual(current);
  });

  it('counts gap episodes separately from their ongoing duration and aggregates maxima', async () => {
    const diagnostics = await import('../diagnostics.ts');
    diagnostics.recordLargeAudioSupplyGap(0.2, true);
    diagnostics.recordLargeAudioSupplyGap(0.8, false);
    diagnostics.recordLargeAudioSupplyGap(0.4, false);
    diagnostics.recordLargeAudioSupplyGap(0.1, true);
    diagnostics.recordLargeAudioRead(40);
    diagnostics.recordLargeAudioRead(20);
    diagnostics.recordLargeAudioPcm(1024);
    diagnostics.recordLargeAudioPcm(512);
    diagnostics.recordLargeAudioReaderRestart();
    diagnostics.recordLargeAudioReaderRestart();
    expect(diagnostics.getLargeAudioDiagnostics().output).toEqual({
      supplyGaps: 2,
      longestSupplyGapMs: 800,
      readerRestarts: 2,
      longestReadMs: 40,
      peakPlaybackPcmBytes: 1024,
    });
  });

  it('ignores invalid observations without poisoning an exported snapshot', async () => {
    const diagnostics = await import('../diagnostics.ts');
    const before = diagnostics.getLargeAudioDiagnostics();
    for (const value of [NaN, Infinity, -Infinity, -1]) {
      diagnostics.recordLargeAudioSupplyGap(value, true);
      diagnostics.recordLargeAudioRead(value);
      diagnostics.recordLargeAudioPcm(value);
    }
    diagnostics.recordLargeAudioSupplyGap(0, true);
    diagnostics.recordLargeAudioRead(0);
    diagnostics.recordLargeAudioPcm(0.5);
    diagnostics.recordLargeAudioPcm(Number.MAX_SAFE_INTEGER + 1);
    expect(diagnostics.getLargeAudioDiagnostics()).toEqual(before);
  });
});
