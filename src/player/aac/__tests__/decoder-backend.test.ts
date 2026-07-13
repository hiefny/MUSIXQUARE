import { describe, expect, it } from 'vitest';

import {
  AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
  AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES,
  AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS,
  AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES,
  AacDecoderBackendIntegrityError,
  aacCoreSampleRateHz,
  aacGenerationTimestampMicroseconds,
  snapshotAacDecoderBackendGenerationOptions,
  snapshotAacDecoderPcmBatch,
  type AacDecoderBackendId,
  type AacDecoderPcmBatch,
  type AacDecoderPcmBatchExpectation,
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

const MONO_48K = Object.freeze({
  ...STEREO_44K,
  sampleRateIndex: 3 as const,
  channelConfiguration: 1 as const,
});

function pcmExpectation(
  options: {
    readonly firstAccessUnitOrdinal?: number;
    readonly accessUnitCount?: number;
    readonly mono?: boolean;
  } = {},
): AacDecoderPcmBatchExpectation {
  return {
    firstAccessUnitOrdinal: options.firstAccessUnitOrdinal ?? 0,
    accessUnitCount: options.accessUnitCount ?? 1,
    coreConfiguration: options.mono ? MONO_48K : STEREO_44K,
  };
}

function finitePlane(frames: number, seed: number): Float32Array {
  return Float32Array.from({ length: frames }, (_unused, index) => (seed + index) / 32_768);
}

function pcmBatch(
  expectation: AacDecoderPcmBatchExpectation,
  planes?: readonly Float32Array[],
): AacDecoderPcmBatch {
  const frames = expectation.accessUnitCount * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
  const channels = expectation.coreConfiguration.channelConfiguration;
  const sampleRateHz = expectation.coreConfiguration.sampleRateIndex === 3 ? 48_000 : 44_100;
  const actualPlanes =
    planes ?? Array.from({ length: channels }, (_unused, index) => finitePlane(frames, index + 1));
  return {
    firstAccessUnitOrdinal: expectation.firstAccessUnitOrdinal,
    accessUnitCount: expectation.accessUnitCount,
    frameCount: frames,
    sampleRateHz,
    channels,
    planes: actualPlanes as AacDecoderPcmBatch['planes'],
  };
}

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

describe('AAC decoder PCM batch snapshot', () => {
  it('deeply detaches exact stereo PCM while preserving transferable plane ownership', () => {
    const expectation = pcmExpectation({ firstAccessUnitOrdinal: 7, accessUnitCount: 2 });
    const frames = 2 * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
    const sourcePlanes = [finitePlane(frames, 1), finitePlane(frames, 2)] as const;
    const input = pcmBatch(expectation, sourcePlanes);
    const snapshot = snapshotAacDecoderPcmBatch(
      Object.freeze({ ...input, planes: Object.freeze([...sourcePlanes]) }),
      expectation,
      new AbortController().signal,
    );

    expect(snapshot).toEqual(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.planes)).toBe(true);
    expect(Object.isFrozen(snapshot.planes[0])).toBe(false);
    expect(snapshot.planes[0]).not.toBe(sourcePlanes[0]);
    expect(snapshot.planes[0].buffer).not.toBe(sourcePlanes[0].buffer);
    expect(snapshot.planes[1].buffer).not.toBe(sourcePlanes[1].buffer);

    const retained = snapshot.planes[0][0];
    sourcePlanes[0].fill(0.75);
    sourcePlanes[1].fill(-0.75);
    expect(snapshot.planes[0][0]).toBe(retained);
    expect(snapshot.planes[1][0]).not.toBe(-0.75);
  });

  it('accepts the maximum bounded mono and stereo geometries', () => {
    for (const mono of [true, false]) {
      const expectation = pcmExpectation({ accessUnitCount: 8, mono });
      const snapshot = snapshotAacDecoderPcmBatch(
        pcmBatch(expectation),
        expectation,
        new AbortController().signal,
      );
      expect(snapshot.frameCount).toBe(8_192);
      expect(snapshot.planes).toHaveLength(mono ? 1 : 2);
      expect(snapshot.planes.reduce((bytes, plane) => bytes + plane.byteLength, 0)).toBe(
        8_192 * (mono ? 1 : 2) * Float32Array.BYTES_PER_ELEMENT,
      );
    }
  });

  it('requires exact data-only result and expectation records without invoking accessors', () => {
    const expectation = pcmExpectation();
    const valid = pcmBatch(expectation);
    let getterReads = 0;
    const accessorResult = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessorResult, 'planes', {
      enumerable: true,
      get() {
        getterReads += 1;
        return valid.planes;
      },
    });
    const accessorExpectation = {
      firstAccessUnitOrdinal: 0,
      accessUnitCount: 1,
    } as Record<string, unknown>;
    Object.defineProperty(accessorExpectation, 'coreConfiguration', {
      enumerable: true,
      get() {
        getterReads += 1;
        return STEREO_44K;
      },
    });

    const invalidResults: unknown[] = [
      { ...valid, extra: true },
      { ...valid, [Symbol('extra')]: true },
      accessorResult,
      Object.assign(Object.create({ inherited: true }), valid),
    ];
    for (const result of invalidResults) {
      expect(() =>
        snapshotAacDecoderPcmBatch(result, expectation, new AbortController().signal),
      ).toThrow(AacDecoderBackendIntegrityError);
    }
    expect(() =>
      snapshotAacDecoderPcmBatch(
        valid,
        { ...expectation, extra: true },
        new AbortController().signal,
      ),
    ).toThrow(/unexpected|missing/i);
    expect(() =>
      snapshotAacDecoderPcmBatch(valid, accessorExpectation, new AbortController().signal),
    ).toThrow(/data fields/i);
    expect(getterReads).toBe(0);

    const revocable = Proxy.revocable(valid, {});
    revocable.revoke();
    expect(() =>
      snapshotAacDecoderPcmBatch(revocable.proxy, expectation, new AbortController().signal),
    ).toThrow(AacDecoderBackendIntegrityError);
  });

  it('rejects invalid expectations before inspecting the backend result', () => {
    const valid = pcmBatch(pcmExpectation());
    let inspections = 0;
    const result = new Proxy(valid, {
      ownKeys(target) {
        inspections += 1;
        return Reflect.ownKeys(target);
      },
    });
    const invalidExpectations: unknown[] = [
      { ...pcmExpectation(), accessUnitCount: 0 },
      { ...pcmExpectation(), accessUnitCount: 9 },
      {
        ...pcmExpectation({ firstAccessUnitOrdinal: Number.MAX_SAFE_INTEGER }),
        accessUnitCount: 2,
      },
      { ...pcmExpectation(), firstAccessUnitOrdinal: -0 },
    ];
    for (const expectation of invalidExpectations) {
      expect(() =>
        snapshotAacDecoderPcmBatch(result, expectation, new AbortController().signal),
      ).toThrow();
    }
    expect(inspections).toBe(0);
  });

  it('rejects every scalar result mismatch including negative zero', () => {
    const expectation = pcmExpectation();
    const valid = pcmBatch(expectation);
    const mismatches: ReadonlyArray<readonly [string, unknown]> = [
      ['firstAccessUnitOrdinal', -0],
      ['firstAccessUnitOrdinal', 1],
      ['accessUnitCount', 2],
      ['frameCount', valid.frameCount - 1],
      ['sampleRateHz', 48_000],
      ['channels', 1],
    ];
    for (const [key, value] of mismatches) {
      expect(() =>
        snapshotAacDecoderPcmBatch(
          { ...valid, [key]: value },
          expectation,
          new AbortController().signal,
        ),
      ).toThrow(AacDecoderBackendIntegrityError);
    }
  });

  it('requires an exact dense mono or stereo plane array', () => {
    const expectation = pcmExpectation();
    const valid = pcmBatch(expectation);
    const frames = valid.frameCount;
    const left = finitePlane(frames, 1);
    const right = finitePlane(frames, 2);
    const sparse = new Array<Float32Array>(2);
    sparse[0] = left;
    let accessorReads = 0;
    const accessorPlanes = [left, right];
    Object.defineProperty(accessorPlanes, '1', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return right;
      },
    });
    const extra = [left, right] as Array<Float32Array> & { extra?: boolean };
    extra.extra = true;
    const symbolic = [left, right] as Array<Float32Array> & { [key: symbol]: unknown };
    symbolic[Symbol('extra')] = true;
    const wrongPrototype = [left, right];
    Object.setPrototypeOf(wrongPrototype, null);
    const revocable = Proxy.revocable([left, right], {});
    revocable.revoke();

    for (const planes of [
      [left],
      [left, right, finitePlane(frames, 3)],
      sparse,
      accessorPlanes,
      extra,
      symbolic,
      wrongPrototype,
      revocable.proxy,
    ]) {
      expect(() =>
        snapshotAacDecoderPcmBatch({ ...valid, planes }, expectation, new AbortController().signal),
      ).toThrow(AacDecoderBackendIntegrityError);
    }
    expect(accessorReads).toBe(0);
  });

  it('rejects non-Float32, proxied, shared, detached, and wrong-length storage', () => {
    const expectation = pcmExpectation();
    const valid = pcmBatch(expectation);
    const frames = valid.frameCount;
    const detached = finitePlane(frames, 1);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const invalidPlanes: unknown[] = [
      new Float64Array(frames),
      new Proxy(finitePlane(frames, 1), {}),
      new Float32Array(new SharedArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT)),
      detached,
      new Float32Array(frames - 1),
    ];
    for (const left of invalidPlanes) {
      expect(() =>
        snapshotAacDecoderPcmBatch(
          { ...valid, planes: [left, finitePlane(frames, 2)] },
          expectation,
          new AbortController().signal,
        ),
      ).toThrow(AacDecoderBackendIntegrityError);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite PCM %s without modifying backend-owned planes',
    (invalidSample) => {
      const expectation = pcmExpectation();
      const valid = pcmBatch(expectation);
      const first = finitePlane(valid.frameCount, 1);
      const second = finitePlane(valid.frameCount, 2);
      second[valid.frameCount - 1] = invalidSample;
      const retainedFirst = first[0];

      expect(() =>
        snapshotAacDecoderPcmBatch(
          { ...valid, planes: [first, second] },
          expectation,
          new AbortController().signal,
        ),
      ).toThrow(/non-finite/i);
      expect(first[0]).toBe(retainedFirst);
      expect(second[valid.frameCount - 1]).toBe(invalidSample);
    },
  );

  it('gives a pre-existing abort exact precedence without inspecting inputs', () => {
    const controller = new AbortController();
    const reason = Object.freeze({ code: 'pre-aborted' });
    controller.abort(reason);
    let inspected = false;
    const result = new Proxy(pcmBatch(pcmExpectation()), {
      ownKeys() {
        inspected = true;
        throw new Error('must not inspect');
      },
    });
    let caught: unknown;
    try {
      snapshotAacDecoderPcmBatch(result, pcmExpectation(), controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(inspected).toBe(false);
  });

  it('gives abort exact precedence when hostile expectation, result, or planes reenter', () => {
    const stages = ['expectation', 'result', 'planes'] as const;
    for (const stage of stages) {
      const controller = new AbortController();
      const reason = Object.freeze({ stage });
      const fail = (): never => {
        controller.abort(reason);
        throw new Error(`decoy ${stage} reflection failure`);
      };
      const expectation =
        stage === 'expectation' ? new Proxy(pcmExpectation(), { ownKeys: fail }) : pcmExpectation();
      const valid = pcmBatch(pcmExpectation());
      const result =
        stage === 'result'
          ? new Proxy(valid, { ownKeys: fail })
          : stage === 'planes'
            ? { ...valid, planes: new Proxy(valid.planes, { ownKeys: fail }) }
            : valid;

      let caught: unknown;
      try {
        snapshotAacDecoderPcmBatch(result, expectation, controller.signal);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(reason);
    }
  });

  it('stops on an aborting reflection trap even when the trap returns canonical keys', () => {
    const controller = new AbortController();
    const reason = Object.freeze({ code: 'abort-without-decoy-error' });
    const valid = pcmBatch(pcmExpectation());
    const result = new Proxy(valid, {
      ownKeys(target) {
        controller.abort(reason);
        return Reflect.ownKeys(target);
      },
    });

    let caught: unknown;
    try {
      snapshotAacDecoderPcmBatch(result, pcmExpectation(), controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  it('rejects values without an exact AbortSignal', () => {
    const expectation = pcmExpectation();
    expect(() =>
      snapshotAacDecoderPcmBatch(pcmBatch(expectation), expectation, {} as AbortSignal),
    ).toThrow(TypeError);
  });
});
