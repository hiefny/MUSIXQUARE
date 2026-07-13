import { describe, expect, it } from 'vitest';

import {
  AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
  AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES,
  AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS,
  AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES,
  aacCoreSampleRateHz,
  aacGenerationTimestampMicroseconds,
  snapshotAacDecoderBackendGenerationOptions,
  type AacDecoderBackendId,
} from '../decoder-backend.ts';

const STEREO_44K = Object.freeze({
  mpegId: 0 as const,
  profile: 1 as const,
  coreAudioObjectType: 2 as const,
  sampleRateIndex: 4 as const,
  channelConfiguration: 2 as const,
  protectionAbsent: true as const,
  rawDataBlocks: 1 as const,
});

describe('AAC decoder backend contract', () => {
  it('keeps the batch and core-frame bounds arithmetically exact', () => {
    expect(AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES).toBe(1_024);
    expect(AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS).toBe(8);
    expect(AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES).toBe(
      8 * AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES,
    );
  });

  it('snapshots a strict scanner configuration and generation origin', () => {
    const input = {
      coreConfiguration: { ...STEREO_44K },
      firstAccessUnitOrdinal: Number.MAX_SAFE_INTEGER - 7,
    };
    const snapshot = snapshotAacDecoderBackendGenerationOptions(input);
    input.firstAccessUnitOrdinal = 0;
    (input.coreConfiguration as { sampleRateIndex: number }).sampleRateIndex = 3;

    expect(snapshot).toEqual({
      coreConfiguration: STEREO_44K,
      firstAccessUnitOrdinal: Number.MAX_SAFE_INTEGER - 7,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.coreConfiguration)).toBe(true);
    expect(aacCoreSampleRateHz(snapshot.coreConfiguration)).toBe(44_100);
  });

  it.each([
    [{ ...STEREO_44K, mpegId: 1 }],
    [{ ...STEREO_44K, profile: 0 }],
    [{ ...STEREO_44K, coreAudioObjectType: 5 }],
    [{ ...STEREO_44K, sampleRateIndex: 13 }],
    [{ ...STEREO_44K, channelConfiguration: 3 }],
    [{ ...STEREO_44K, protectionAbsent: false }],
    [{ ...STEREO_44K, rawDataBlocks: 2 }],
  ])('rejects an unsupported core configuration %#', (coreConfiguration) => {
    expect(() =>
      snapshotAacDecoderBackendGenerationOptions({
        coreConfiguration,
        firstAccessUnitOrdinal: 0,
      }),
    ).toThrow();
  });

  it('rejects accessors, extra fields, and unsafe generation ordinals', () => {
    expect(() =>
      snapshotAacDecoderBackendGenerationOptions({
        get coreConfiguration() {
          return STEREO_44K;
        },
        firstAccessUnitOrdinal: 0,
      }),
    ).toThrow(/data fields/i);
    expect(() =>
      snapshotAacDecoderBackendGenerationOptions({
        coreConfiguration: STEREO_44K,
        firstAccessUnitOrdinal: 0,
        extra: true,
      }),
    ).toThrow(/unexpected|missing/i);
    for (const ordinal of [-0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() =>
        snapshotAacDecoderBackendGenerationOptions({
          coreConfiguration: STEREO_44K,
          firstAccessUnitOrdinal: ordinal,
        }),
      ).toThrow(/ordinal/i);
    }
  });

  it('uses drift-free floor-rational timestamps at awkward rates', () => {
    expect(aacGenerationTimestampMicroseconds(100, 100, 44_100)).toBe(0);
    expect(aacGenerationTimestampMicroseconds(101, 100, 44_100)).toBe(23_219);
    expect(aacGenerationTimestampMicroseconds(102, 100, 44_100)).toBe(46_439);
    expect(aacGenerationTimestampMicroseconds(50, 48, 48_000)).toBe(42_666);
  });

  it.each([
    [0, 96_000],
    [1, 88_200],
    [2, 64_000],
    [3, 48_000],
    [4, 44_100],
    [5, 32_000],
    [6, 24_000],
    [7, 22_050],
    [8, 16_000],
    [9, 12_000],
    [10, 11_025],
    [11, 8_000],
    [12, 7_350],
  ] as const)('uses the canonical ADTS rate lookup for index %i', (sampleRateIndex, expected) => {
    expect(
      aacCoreSampleRateHz({
        ...STEREO_44K,
        sampleRateIndex,
      }),
    ).toBe(expected);
  });

  it('cancels large absolute ordinals before timestamp conversion', () => {
    const first = Number.MAX_SAFE_INTEGER - 7;
    expect(aacGenerationTimestampMicroseconds(first, first, 44_100)).toBe(0);
    expect(aacGenerationTimestampMicroseconds(Number.MAX_SAFE_INTEGER, first, 44_100)).toBe(
      162_539,
    );
    expect(() => aacGenerationTimestampMicroseconds(first - 1, first, 44_100)).toThrow(/precedes/i);
  });

  it('re-exports the wire protocol backend identity instead of defining a second union', () => {
    const ids: readonly AacDecoderBackendId[] = ['webcodecs', 'symphonia-wasm'];
    expect(ids).toEqual(['webcodecs', 'symphonia-wasm']);
  });
});
