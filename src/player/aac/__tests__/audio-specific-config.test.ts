import { describe, expect, it } from 'vitest';

import { adtsCoreSampleRateHzForIndex } from '../adts-header.ts';
import {
  AAC_LC_ASC_CORE_FRAMES_PER_ACCESS_UNIT,
  createAacLcAudioSpecificConfigDescription,
  parseCanonicalAacLcAudioSpecificConfig,
} from '../audio-specific-config.ts';

function description(
  sampleRateIndex: number,
  channelConfiguration: number,
  flags = 0,
  audioObjectType = 2,
): Uint8Array {
  return new Uint8Array([
    (audioObjectType << 3) | (sampleRateIndex >>> 1),
    ((sampleRateIndex & 1) << 7) | (channelConfiguration << 3) | flags,
  ]);
}

describe('canonical AAC-LC AudioSpecificConfig', () => {
  it('parses the canonical 44.1 kHz stereo 0x12 0x10 description', () => {
    const parsed = parseCanonicalAacLcAudioSpecificConfig(new Uint8Array([0x12, 0x10]));

    expect(parsed).toEqual({
      audioObjectType: 2,
      sampleRateIndex: 4,
      sampleRateHz: 44_100,
      channelConfiguration: 2,
      channelCount: 2,
      coreFramesPerAccessUnit: 1_024,
      frameLengthFlag: 0,
      dependsOnCoreCoder: 0,
      extensionFlag: 0,
      description: [0x12, 0x10],
    });
    expect(AAC_LC_ASC_CORE_FRAMES_PER_ACCESS_UNIT).toBe(1_024);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.description)).toBe(true);
    expect(Array.isArray(parsed.description)).toBe(true);
    expect(ArrayBuffer.isView(parsed.description)).toBe(false);
  });

  it.each(
    Array.from({ length: 13 }, (_unused, sampleRateIndex) =>
      ([1, 2] as const).map(
        (channelConfiguration) => [sampleRateIndex, channelConfiguration] as const,
      ),
    ).flat(),
  )(
    'admits indexed rate %i and channel configuration %i with canonical geometry',
    (sampleRateIndex, channelConfiguration) => {
      const parsed = parseCanonicalAacLcAudioSpecificConfig(
        description(sampleRateIndex, channelConfiguration),
      );

      expect(parsed.sampleRateIndex).toBe(sampleRateIndex);
      expect(parsed.sampleRateHz).toBe(adtsCoreSampleRateHzForIndex(sampleRateIndex));
      expect(parsed.channelConfiguration).toBe(channelConfiguration);
      expect(parsed.channelCount).toBe(channelConfiguration);
      expect(parsed.coreFramesPerAccessUnit).toBe(1_024);
    },
  );

  it('intrinsically copies caller bytes and ignores hostile shadow properties', () => {
    const input = new Uint8Array([0x12, 0x10]);
    Object.defineProperty(input, 'byteLength', {
      get() {
        throw new Error('caller byteLength getter must not run');
      },
    });
    Object.defineProperty(input, Symbol.iterator, {
      get() {
        throw new Error('caller iterator getter must not run');
      },
    });

    const parsed = parseCanonicalAacLcAudioSpecificConfig(input);
    input[0] = 0;
    input[1] = 0;

    expect(parsed.description).toEqual([0x12, 0x10]);
    expect(parsed.sampleRateHz).toBe(44_100);
  });

  it.each([0, 1, 3, 4, 5, 29, 31])('rejects unsupported Audio Object Type %i', (aot) => {
    expect(() => parseCanonicalAacLcAudioSpecificConfig(description(4, 2, 0, aot))).toThrow(
      /Audio Object Type|SBR|Parametric Stereo/i,
    );
  });

  it.each([
    [13, /reserved/i],
    [14, /reserved/i],
    [15, /explicit/i],
  ] as const)('rejects non-indexed or reserved sample-rate index %i', (index, message) => {
    expect(() => parseCanonicalAacLcAudioSpecificConfig(description(index, 2))).toThrow(message);
  });

  it.each([
    [0, /Program Config Element/i],
    [3, /mono or stereo/i],
    [7, /mono or stereo/i],
    [15, /mono or stereo/i],
  ] as const)('rejects unsupported channel configuration %i', (channels, message) => {
    expect(() => parseCanonicalAacLcAudioSpecificConfig(description(4, channels))).toThrow(message);
  });

  it.each([
    [0b100, /960-frame/i],
    [0b010, /core-coder/i],
    [0b001, /extensions/i],
    [0b111, /960-frame/i],
  ] as const)('rejects noncanonical GASpecificConfig flags %i', (flags, message) => {
    expect(() => parseCanonicalAacLcAudioSpecificConfig(description(4, 2, flags))).toThrow(message);
  });

  it.each([new Uint8Array(), new Uint8Array([0x12]), new Uint8Array([0x12, 0x10, 0x56])])(
    'rejects truncated or extended description bytes %#',
    (bytes) => {
      expect(() => parseCanonicalAacLcAudioSpecificConfig(bytes)).toThrow(/exactly two bytes/i);
    },
  );

  it.each([
    null,
    undefined,
    [0x12, 0x10],
    new Uint16Array([0x1012]),
    new DataView(new Uint8Array([0x12, 0x10]).buffer),
    { 0: 0x12, 1: 0x10, length: 2, [Symbol.toStringTag]: 'Uint8Array' },
    new Proxy(new Uint8Array([0x12, 0x10]), {}),
  ])('rejects non-Uint8Array input %#', (value) => {
    expect(() => parseCanonicalAacLcAudioSpecificConfig(value)).toThrow(TypeError);
  });

  it('rejects revoked hostile proxies without leaking their trap error', () => {
    const proxy = Proxy.revocable(new Uint8Array([0x12, 0x10]), {});
    proxy.revoke();
    expect(() => parseCanonicalAacLcAudioSpecificConfig(proxy.proxy)).toThrow(TypeError);
  });

  it('rejects shared storage because it cannot provide a coherent snapshot', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    shared.set([0x12, 0x10]);
    expect(() => parseCanonicalAacLcAudioSpecificConfig(shared)).toThrow(/non-shared/i);
  });

  it('rejects a detached typed-array view', () => {
    const input = new Uint8Array([0x12, 0x10]);
    structuredClone(input.buffer, { transfer: [input.buffer] });
    expect(() => parseCanonicalAacLcAudioSpecificConfig(input)).toThrow(
      /exactly two bytes|readable/i,
    );
  });
});

describe('AAC-LC AudioSpecificConfig description ownership', () => {
  it('returns a fresh owned Uint8Array for every call', () => {
    const parsed = parseCanonicalAacLcAudioSpecificConfig(new Uint8Array([0x12, 0x10]));
    const first = createAacLcAudioSpecificConfigDescription(parsed);
    const second = createAacLcAudioSpecificConfigDescription(parsed);

    expect(first).toEqual(new Uint8Array([0x12, 0x10]));
    expect(second).toEqual(new Uint8Array([0x12, 0x10]));
    expect(first).not.toBe(second);
    expect(first.buffer).not.toBe(second.buffer);
    first.fill(0);
    expect(second).toEqual(new Uint8Array([0x12, 0x10]));
    expect(parsed.description).toEqual([0x12, 0x10]);
  });

  it('accepts a structurally exact clone and snapshots its numeric tuple', () => {
    const parsed = parseCanonicalAacLcAudioSpecificConfig(new Uint8Array([0x11, 0x88]));
    const tuple = [...parsed.description];
    const clone = { ...parsed, description: tuple };
    const bytes = createAacLcAudioSpecificConfigDescription(clone);
    tuple.fill(0);

    expect(bytes).toEqual(new Uint8Array([0x11, 0x88]));
  });

  it.each([
    ['sampleRateIndex', 3],
    ['sampleRateHz', 48_000],
    ['channelConfiguration', 1],
    ['channelCount', 1],
    ['coreFramesPerAccessUnit', 960],
    ['frameLengthFlag', 1],
    ['dependsOnCoreCoder', 1],
    ['extensionFlag', 1],
  ] as const)('rejects canonical field %s when it disagrees with the bytes', (key, value) => {
    const parsed = parseCanonicalAacLcAudioSpecificConfig(new Uint8Array([0x12, 0x10]));
    expect(() => createAacLcAudioSpecificConfigDescription({ ...parsed, [key]: value })).toThrow(
      /does not match/i,
    );
  });

  it('rejects altered description bytes, extra fields, and accessor fields', () => {
    const parsed = parseCanonicalAacLcAudioSpecificConfig(new Uint8Array([0x12, 0x10]));
    expect(() =>
      createAacLcAudioSpecificConfigDescription({ ...parsed, description: [0x11, 0x88] }),
    ).toThrow(/does not match/i);
    expect(() => createAacLcAudioSpecificConfigDescription({ ...parsed, extra: true })).toThrow(
      /unexpected|missing/i,
    );

    const descriptors = Object.getOwnPropertyDescriptors(parsed);
    descriptors.description = {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('must not run');
      },
    };
    const hostile = Object.defineProperties({}, descriptors);
    expect(() => createAacLcAudioSpecificConfigDescription(hostile)).toThrow(/data fields/i);
  });

  it('rejects hostile, sparse, typed, or non-byte description tuples', () => {
    const parsed = parseCanonicalAacLcAudioSpecificConfig(new Uint8Array([0x12, 0x10]));
    const revoked = Proxy.revocable([0x12, 0x10], {});
    revoked.revoke();
    for (const candidate of [
      [0x12],
      [0x12, 0x10, 0],
      Object.assign([0x12, 0x10], { extra: true }),
      new Uint8Array([0x12, 0x10]),
      [0x12, 256],
      [0x12, 0.5],
      revoked.proxy,
    ]) {
      expect(() =>
        createAacLcAudioSpecificConfigDescription({ ...parsed, description: candidate }),
      ).toThrow();
    }
  });
});
