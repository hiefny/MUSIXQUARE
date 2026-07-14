import { describe, expect, it } from 'vitest';

import {
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  ADTS_CORE_SAMPLES_PER_FRAME,
  AdtsFrameScanError,
  scanAdtsFrames,
} from '../frame-scanner.ts';
import { ADTS_SEEK_INDEX_MAX_POINTS } from '../seek-index.ts';

interface FrameOptions {
  readonly mpegId?: 0 | 1;
  readonly protectionAbsent?: boolean;
  readonly profile?: 0 | 1 | 2 | 3;
  readonly sampleRateIndex?: number;
  readonly channelConfiguration?: number;
  readonly frameLengthBytes?: number;
  readonly rawDataBlocks?: 1 | 2 | 3 | 4;
  readonly payloadByte?: number;
}

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function makeFrame(options: FrameOptions = {}): Uint8Array {
  const mpegId = options.mpegId ?? 0;
  const protectionAbsent = options.protectionAbsent ?? true;
  const profile = options.profile ?? 1;
  const sampleRateIndex = options.sampleRateIndex ?? 4;
  const channelConfiguration = options.channelConfiguration ?? 2;
  const frameLengthBytes = options.frameLengthBytes ?? 31;
  const rawDataBlocks = options.rawDataBlocks ?? 1;
  const bytes = new Uint8Array(frameLengthBytes).fill(options.payloadByte ?? 0x5a);

  bytes[0] = 0xff;
  bytes[1] = 0xf0 | (mpegId << 3) | (protectionAbsent ? 1 : 0);
  bytes[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100 | ((rawDataBlocks - 1) & 0b11);
  if (!protectionAbsent && frameLengthBytes >= 9) {
    bytes[7] = 0xab;
    bytes[8] = 0xcd;
  }
  return bytes;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function repeatFrame(frame: Uint8Array, count: number): Uint8Array {
  const result = new Uint8Array(frame.byteLength * count);
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    result.set(frame, ordinal * frame.byteLength);
  }
  return result;
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'fixture.aac',
    mime: 'audio/aac',
  });
  readonly reads: ReadRecord[] = [];
  size: number;
  identity = 'adts-frame-scanner-memory';
  closeCount = 0;
  shortRead = false;
  ignoreAbortAfterReadStarts = false;
  onRead: ((source: MemorySource) => void | Promise<void>) | null = null;

  constructor(readonly bytes: Uint8Array) {
    this.size = bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    await this.onRead?.(this);
    if (!this.ignoreAbortAfterReadStarts) throwIfAborted(signal);
    return this.bytes.slice(offset, end - (this.shortRead && length > 0 ? 1 : 0));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function containsEncodedStorage(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const nested of Object.values(value)) {
    if (containsEncodedStorage(nested, seen)) return true;
  }
  return false;
}

describe('scanAdtsFrames verified metadata', () => {
  it('fully verifies a raw stream and returns exact frozen wrapper metadata', async () => {
    const frames = [
      makeFrame({ frameLengthBytes: 19, payloadByte: 0x11 }),
      makeFrame({ frameLengthBytes: 41, payloadByte: 0x22 }),
      makeFrame({ frameLengthBytes: 83, payloadByte: 0x33 }),
    ];
    const source = new MemorySource(concatenate(...frames));
    const result = await scanAdtsFrames(source, signal());

    expect(result).toMatchObject({
      sourceIdentity: source.identity,
      sourceSize: source.size,
      audioStartByte: 0,
      coreSampleRateHz: 44_100,
      coreChannelCount: 2,
      samplesPerFrame: 1_024,
      frameCount: 3,
      totalCoreSamples: 3 * ADTS_CORE_SAMPLES_PER_FRAME,
      audioEndByteOffset: source.size,
      fullyVerifiedFrameSpan: true,
      coreConfiguration: {
        mpegId: 0,
        profile: 1,
        coreAudioObjectType: 2,
        sampleRateIndex: 4,
        channelConfiguration: 2,
        protectionAbsent: true,
        rawDataBlocks: 1,
      },
    });
    expect(result.seekPoints).toEqual([
      { frameOrdinal: 0, byteOffset: 0 },
      { frameOrdinal: 1, byteOffset: frames[0]!.byteLength },
      { frameOrdinal: 2, byteOffset: frames[0]!.byteLength + frames[1]!.byteLength },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.coreConfiguration)).toBe(true);
    expect(Object.isFrozen(result.seekPoints)).toBe(true);
    expect(result.seekPoints.every((point) => Object.isFrozen(point))).toBe(true);
    expect(source.closeCount).toBe(0);
  });

  it('verifies an 8,191-byte frame across bounded transport pages', async () => {
    const maximum = makeFrame({ frameLengthBytes: 8_191, payloadByte: 0x7a });
    const tail = makeFrame({ frameLengthBytes: 23, payloadByte: 0x33 });
    const source = new MemorySource(concatenate(maximum, tail));
    const result = await scanAdtsFrames(source, signal(), { pageBytes: 1_024 });

    expect(result.frameCount).toBe(2);
    expect(result.audioEndByteOffset).toBe(source.size);
    expect(result.seekPoints).toEqual([
      { frameOrdinal: 0, byteOffset: 0 },
      { frameOrdinal: 1, byteOffset: 8_191 },
    ]);
    expect(source.reads.length).toBeGreaterThan(8);
    expect(source.reads.every((read) => read.length <= 1_024)).toBe(true);
    expect(source.closeCount).toBe(0);
  });

  it('preserves full source size while indexing absolute nonzero audio coordinates to EOF', async () => {
    const prefix = new Uint8Array(53).fill(0x49);
    const frames = [makeFrame({ frameLengthBytes: 19 }), makeFrame({ frameLengthBytes: 41 })];
    const source = new MemorySource(concatenate(prefix, ...frames));
    const result = await scanAdtsFrames(source, signal(), {
      audioStartByte: prefix.byteLength,
      pageBytes: 7,
    });

    expect(result).toMatchObject({
      sourceSize: source.size,
      audioStartByte: prefix.byteLength,
      audioEndByteOffset: source.size,
      frameCount: 2,
    });
    expect(result.seekPoints).toEqual([
      { frameOrdinal: 0, byteOffset: prefix.byteLength },
      { frameOrdinal: 1, byteOffset: prefix.byteLength + frames[0]!.byteLength },
    ]);
    expect(source.reads.every((read) => read.offset >= prefix.byteLength)).toBe(true);
  });

  it('bounds a long stream index and retains no duration-proportional encoded storage', async () => {
    const frame = makeFrame({ frameLengthBytes: 8 });
    const frameCount = 25_000;
    const source = new MemorySource(repeatFrame(frame, frameCount));
    const result = await scanAdtsFrames(source, signal());

    expect(result.frameCount).toBe(frameCount);
    expect(result.totalCoreSamples).toBe(frameCount * 1_024);
    expect(result.seekPoints.length).toBeLessThanOrEqual(ADTS_SEEK_INDEX_MAX_POINTS);
    expect(result.seekPoints[0]).toEqual({ frameOrdinal: 0, byteOffset: 0 });
    expect(result.seekPoints.at(-1)).toEqual({
      frameOrdinal: frameCount - 1,
      byteOffset: (frameCount - 1) * frame.byteLength,
    });
    expect(containsEncodedStorage(result)).toBe(false);
    expect(Object.keys(result)).not.toContain('bytes');
    expect(Object.keys(result)).not.toContain('frames');
    expect(source.closeCount).toBe(0);
  });

  it('supports a smaller deterministic seek-point cap without retaining frame bodies', async () => {
    const frame = makeFrame({ frameLengthBytes: 11 });
    const source = new MemorySource(repeatFrame(frame, 10_000));
    const result = await scanAdtsFrames(source, signal(), { maxSeekPoints: 4 });

    expect(result.seekPoints.length).toBeLessThanOrEqual(4);
    expect(result.seekPoints[0]).toEqual({ frameOrdinal: 0, byteOffset: 0 });
    expect(result.seekPoints.at(-1)).toEqual({
      frameOrdinal: 9_999,
      byteOffset: 9_999 * frame.byteLength,
    });
    expect(containsEncodedStorage(result)).toBe(false);
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
  });
});

describe('scanAdtsFrames strict continuity', () => {
  it.each([
    ['sample rate', makeFrame({ sampleRateIndex: 3 })],
    ['channel configuration', makeFrame({ channelConfiguration: 1 })],
    ['profile', makeFrame({ profile: 2 })],
  ])('rejects midstream %s drift', async (_name, changed) => {
    const bytes = concatenate(makeFrame(), changed);
    const source = new MemorySource(bytes);
    await expect(scanAdtsFrames(source, signal())).rejects.toThrow(
      /configuration changes|outside the MPEG-4 AAC-LC/i,
    );
    expect(source.closeCount).toBe(0);
  });

  it('rejects truncation, short trailing junk, and header-sized trailing junk', async () => {
    const frame = makeFrame({ frameLengthBytes: 100 });
    const malformed = [
      frame.slice(0, 90),
      concatenate(frame, Uint8Array.of(1, 2, 3)),
      concatenate(frame, Uint8Array.of(1, 2, 3, 4, 5, 6, 7)),
    ];
    for (const bytes of malformed) {
      const source = new MemorySource(bytes);
      await expect(scanAdtsFrames(source, signal())).rejects.toThrow();
      expect(source.closeCount).toBe(0);
    }
  });

  it('inherits strict MPEG-4 AAC-LC atomic-frame admission', async () => {
    const unsupported = [
      makeFrame({ mpegId: 1 }),
      makeFrame({ protectionAbsent: false }),
      makeFrame({ channelConfiguration: 6 }),
      makeFrame({ rawDataBlocks: 2 }),
    ];
    for (const bytes of unsupported) {
      await expect(scanAdtsFrames(new MemorySource(bytes), signal())).rejects.toThrow();
    }
  });

  it('fails closed on a short transport response and never closes the source', async () => {
    const source = new MemorySource(makeFrame());
    source.shortRead = true;
    await expect(scanAdtsFrames(source, signal())).rejects.toThrow(/expected/i);
    expect(source.closeCount).toBe(0);
  });
});

describe('scanAdtsFrames abort and ownership', () => {
  it('honors a noncooperative late abort and permits a fresh full retry', async () => {
    const source = new MemorySource(concatenate(makeFrame(), makeFrame()));
    source.ignoreAbortAfterReadStarts = true;
    let releaseRead: (() => void) | undefined;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    source.onRead = () => readBlocked;
    const controller = new AbortController();
    const reason = new Error('late scanner abort');
    const pending = scanAdtsFrames(source, controller.signal, { pageBytes: 7 });

    for (let attempt = 0; attempt < 20 && source.reads.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(source.reads).toHaveLength(1);
    controller.abort(reason);
    releaseRead?.();
    await expect(pending).rejects.toBe(reason);
    expect(source.closeCount).toBe(0);

    source.onRead = null;
    source.ignoreAbortAfterReadStarts = false;
    const retry = await scanAdtsFrames(source, signal(), { pageBytes: 7 });
    expect(retry.frameCount).toBe(2);
    expect(retry.audioEndByteOffset).toBe(source.size);
    expect(source.closeCount).toBe(0);
  });

  it('rejects a pre-aborted signal before transport reads without consuming ownership', async () => {
    const source = new MemorySource(makeFrame());
    const controller = new AbortController();
    const reason = new Error('already aborted');
    controller.abort(reason);

    await expect(scanAdtsFrames(source, controller.signal)).rejects.toBe(reason);
    expect(source.reads).toHaveLength(0);
    expect(source.closeCount).toBe(0);
  });
});

describe('scanAdtsFrames snapshot integrity', () => {
  it.each(['identity', 'size'] as const)(
    'rejects a discoverable source %s change',
    async (field) => {
      const source = new MemorySource(makeFrame());
      source.onRead = () => {
        if (field === 'identity') source.identity = 'changed-adts-source';
        else source.size += 1;
      };

      await expect(scanAdtsFrames(source, signal())).rejects.toBeInstanceOf(AdtsFrameScanError);
      expect(source.closeCount).toBe(0);
    },
  );

  it('snapshots data-only options without invoking accessors', async () => {
    let accessorCalls = 0;
    const hostile = Object.defineProperty({}, 'pageBytes', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 7;
      },
    });
    const source = new MemorySource(makeFrame());

    await expect(scanAdtsFrames(source, signal(), hostile)).rejects.toThrow(/data property/i);
    expect(accessorCalls).toBe(0);
    expect(source.reads).toHaveLength(0);
  });

  it('rejects invalid source geometry and options before any transport read', async () => {
    const source = new MemorySource(makeFrame());
    const invalidOptions: unknown[] = [
      null,
      { unexpected: true },
      { pageBytes: 6 },
      { pageBytes: 64 * 1_024 + 1 },
      { maxSeekPoints: 1 },
      { maxSeekPoints: ADTS_SEEK_INDEX_MAX_POINTS + 1 },
      { audioStartByte: -1 },
      { audioStartByte: source.size - 7 },
    ];
    for (const options of invalidOptions) {
      await expect(scanAdtsFrames(source, signal(), options as never)).rejects.toThrow();
    }
    expect(source.reads).toHaveLength(0);

    source.size = Number.MAX_SAFE_INTEGER + 1;
    await expect(scanAdtsFrames(source, signal())).rejects.toThrow(/size/i);
    expect(source.reads).toHaveLength(0);
  });

  it('does not expose mutable aliases through a successful result', async () => {
    const source = new MemorySource(concatenate(makeFrame(), makeFrame()));
    const result = await scanAdtsFrames(source, signal());

    expect(() => {
      (result as { frameCount: number }).frameCount = 99;
    }).toThrow();
    expect(() => {
      (result.coreConfiguration as { sampleRateIndex: number }).sampleRateIndex = 3;
    }).toThrow();
    expect(() => {
      (result.seekPoints as Array<unknown>).push({ frameOrdinal: 99, byteOffset: 99 });
    }).toThrow();
    expect(result.frameCount).toBe(2);
    expect(result.coreConfiguration.sampleRateIndex).toBe(4);
    expect(result.seekPoints).toHaveLength(2);
  });
});
