import { describe, expect, it } from 'vitest';

import {
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  ADTS_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES,
  ADTS_MAX_FRAME_BYTES,
  AdtsIncrementalFrameReader,
  AdtsIncrementalFrameReaderError,
  type AdtsCoreConfiguration,
  type AdtsIncrementalFrameReaderOptions,
} from '../incremental-frame-reader.ts';

function requireAssigned<T>(read: () => T | null, message: string): T {
  const value = read();
  if (value === null) throw new Error(message);
  return value;
}

interface FrameOptions {
  readonly mpegId?: 0 | 1;
  readonly protectionAbsent?: boolean;
  readonly profile?: 0 | 1 | 2 | 3;
  readonly sampleRateIndex?: number;
  readonly channelConfiguration?: number;
  readonly privateBit?: boolean;
  readonly originalCopy?: boolean;
  readonly copyrightIdentificationBit?: boolean;
  readonly frameLengthBytes?: number;
  readonly bufferFullness?: number;
  readonly rawDataBlocks?: 1 | 2 | 3 | 4;
  readonly payloadByte?: number;
}

function makeFrame(options: FrameOptions = {}): Uint8Array {
  const mpegId = options.mpegId ?? 0;
  const protectionAbsent = options.protectionAbsent ?? true;
  const profile = options.profile ?? 1;
  const sampleRateIndex = options.sampleRateIndex ?? 4;
  const channelConfiguration = options.channelConfiguration ?? 2;
  const headerLength = protectionAbsent ? 7 : 9;
  const frameLengthBytes = options.frameLengthBytes ?? 31;
  const bufferFullness = options.bufferFullness ?? 0x7ff;
  const rawDataBlocks = options.rawDataBlocks ?? 1;
  const bytes = new Uint8Array(frameLengthBytes).fill(options.payloadByte ?? 0x5a);

  bytes[0] = 0xff;
  bytes[1] = 0xf0 | (mpegId << 3) | (protectionAbsent ? 1 : 0);
  bytes[2] =
    (profile << 6) |
    (sampleRateIndex << 2) |
    (options.privateBit ? 0b10 : 0) |
    ((channelConfiguration >>> 2) & 1);
  bytes[3] =
    ((channelConfiguration & 0b11) << 6) |
    (options.originalCopy ? 0b10_0000 : 0) |
    (options.copyrightIdentificationBit ? 0b1000 : 0) |
    ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | ((bufferFullness >>> 6) & 0b1_1111);
  bytes[6] = ((bufferFullness & 0b11_1111) << 2) | ((rawDataBlocks - 1) & 0b11);
  if (!protectionAbsent && headerLength <= frameLengthBytes) {
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

const CONFIG: Readonly<AdtsCoreConfiguration> = Object.freeze({
  mpegId: 0,
  profile: 1,
  coreAudioObjectType: 2,
  sampleRateIndex: 4,
  channelConfiguration: 2,
  protectionAbsent: true,
  rawDataBlocks: 1,
});

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'fixture.aac',
    mime: 'audio/aac',
  });
  readonly reads: ReadRecord[] = [];
  identity = 'adts-incremental-fixture';
  closeCount = 0;
  shortRead = false;
  onRead: ((source: MemorySource) => void | Promise<void>) | null = null;
  resultFactory: ((bytes: Uint8Array) => unknown) | null = null;

  constructor(readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    await this.onRead?.(this);
    throwIfAborted(signal);
    const exact = this.bytes.slice(offset, offset + length - (this.shortRead ? 1 : 0));
    return (this.resultFactory?.(exact) ?? exact) as Uint8Array;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function options(
  source: EncodedAudioSource,
  overrides: Partial<AdtsIncrementalFrameReaderOptions> = {},
): AdtsIncrementalFrameReaderOptions {
  return { source, ...overrides };
}

describe('AdtsIncrementalFrameReader sequential framing', () => {
  it('reads exact owned frames through bounded pages and reaches only physical EOF', async () => {
    const frames = [
      makeFrame({ frameLengthBytes: 19, payloadByte: 0x11 }),
      makeFrame({
        frameLengthBytes: 41,
        payloadByte: 0x22,
        privateBit: true,
        originalCopy: true,
        bufferFullness: 37,
      }),
      makeFrame({ frameLengthBytes: 83, payloadByte: 0x33 }),
    ];
    const source = new MemorySource(concatenate(...frames));
    const reader = new AdtsIncrementalFrameReader(options(source, { pageBytes: 7 }));
    const ownedResults: Uint8Array[] = [];
    let byteOffset = 0;

    for (let frameOrdinal = 0; frameOrdinal < frames.length; frameOrdinal += 1) {
      const original = frames[frameOrdinal];
      if (!original) throw new Error('missing fixture frame');
      const frame = await reader.readNext(signal());
      expect(frame?.bytes).toEqual(original);
      expect(frame?.bytes).not.toBe(original);
      if (frame) ownedResults.push(frame.bytes);
      expect(frame?.descriptor).toMatchObject({
        frameOrdinal,
        byteOffset,
        byteEndOffset: byteOffset + original.byteLength,
      });
      expect(Object.isFrozen(frame)).toBe(true);
      expect(Object.isFrozen(frame?.descriptor)).toBe(true);
      expect(Object.isFrozen(frame?.descriptor.header)).toBe(true);
      byteOffset += original.byteLength;
    }

    source.bytes.fill(0);
    expect(ownedResults).toEqual(frames);
    expect(await reader.readNext(signal())).toBeNull();
    expect(await reader.readNext(signal())).toBeNull();
    expect(source.reads.every((read) => read.length <= 7)).toBe(true);
    expect(source.closeCount).toBe(0);
  });

  it('keeps every default transport read at or below 64 KiB for long input', async () => {
    const source = new MemorySource(
      concatenate(
        ...Array.from({ length: 10 }, (_, index) =>
          makeFrame({ frameLengthBytes: ADTS_MAX_FRAME_BYTES, payloadByte: index }),
        ),
      ),
    );
    const reader = new AdtsIncrementalFrameReader(options(source));
    for (let index = 0; index < 10; index += 1)
      expect(await reader.readNext(signal())).not.toBeNull();
    expect(await reader.readNext(signal())).toBeNull();
    expect(Math.max(...source.reads.map((read) => read.length))).toBe(
      ADTS_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES,
    );
    expect(source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
  });

  it('allows non-core header flags and fullness to vary without inventing config drift', async () => {
    const source = new MemorySource(
      concatenate(
        makeFrame(),
        makeFrame({
          privateBit: true,
          originalCopy: true,
          copyrightIdentificationBit: true,
          bufferFullness: 123,
        }),
      ),
    );
    const reader = new AdtsIncrementalFrameReader(options(source));
    expect(await reader.readNext(signal())).not.toBeNull();
    expect(await reader.readNext(signal())).not.toBeNull();
    expect(await reader.readNext(signal())).toBeNull();
  });

  it('accepts the maximum physical ADTS frame length', async () => {
    const source = new MemorySource(makeFrame({ frameLengthBytes: ADTS_MAX_FRAME_BYTES }));
    const frame = await new AdtsIncrementalFrameReader(options(source)).readNext(signal());
    expect(frame?.bytes).toHaveLength(8_191);
    expect(frame?.descriptor.byteEndOffset).toBe(8_191);
  });

  it('treats an exact nonzero audioStartByte as frame zero and never reads its metadata prefix', async () => {
    const prefix = new Uint8Array(37).fill(0x49);
    const frames = [makeFrame({ frameLengthBytes: 19 }), makeFrame({ frameLengthBytes: 41 })];
    const source = new MemorySource(concatenate(prefix, ...frames));
    const reader = new AdtsIncrementalFrameReader(
      options(source, { audioStartByte: prefix.byteLength, pageBytes: 7 }),
    );

    expect(await reader.readNext(signal())).toMatchObject({
      descriptor: {
        frameOrdinal: 0,
        byteOffset: prefix.byteLength,
        byteEndOffset: prefix.byteLength + frames[0]!.byteLength,
      },
    });
    expect(await reader.readNext(signal())).toMatchObject({
      descriptor: {
        frameOrdinal: 1,
        byteOffset: prefix.byteLength + frames[0]!.byteLength,
      },
    });
    expect(await reader.readNext(signal())).toBeNull();
    expect(source.reads.every((read) => read.offset >= prefix.byteLength)).toBe(true);
  });
});

describe('AdtsIncrementalFrameReader strict admission and continuity', () => {
  it.each([
    ['MPEG-2', makeFrame({ mpegId: 1 })],
    ['AAC Main', makeFrame({ profile: 0 })],
    ['CRC', makeFrame({ protectionAbsent: false })],
    ['multichannel', makeFrame({ channelConfiguration: 6 })],
    ['multiple raw blocks', makeFrame({ rawDataBlocks: 2 })],
  ])('rejects unsupported %s framing at the initial admission boundary', async (_name, bytes) => {
    const reader = new AdtsIncrementalFrameReader(options(new MemorySource(bytes)));
    await expect(reader.readNext(signal())).rejects.toBeInstanceOf(AdtsIncrementalFrameReaderError);
  });

  it.each([
    ['sample rate', makeFrame({ sampleRateIndex: 3 })],
    ['channel configuration', makeFrame({ channelConfiguration: 1 })],
    ['profile', makeFrame({ profile: 2 })],
  ])('fails closed when the %s changes midstream', async (_name, changed) => {
    const reader = new AdtsIncrementalFrameReader(
      options(new MemorySource(concatenate(makeFrame(), changed))),
    );
    expect(await reader.readNext(signal())).not.toBeNull();
    const failure = await reader.readNext(signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdtsIncrementalFrameReaderError);
    await expect(reader.readNext(signal())).rejects.toBe(failure);
  });

  it('does not byte-resynchronize across a gap at the next exact frame boundary', async () => {
    const first = makeFrame();
    const source = new MemorySource(concatenate(first, Uint8Array.of(0, 1, 2), makeFrame()));
    const reader = new AdtsIncrementalFrameReader(options(source));
    expect(await reader.readNext(signal())).not.toBeNull();
    await expect(reader.readNext(signal())).rejects.toThrow(
      new RegExp(`Invalid ADTS frame at byte ${first.byteLength}`),
    );
    expect(source.reads.some((read) => read.offset > first.byteLength + 3)).toBe(false);
  });

  it('rejects truncated frames and trailing non-frame bytes instead of false EOF', async () => {
    const complete = makeFrame({ frameLengthBytes: 100 });
    const truncated = complete.slice(0, 90);
    await expect(
      new AdtsIncrementalFrameReader(options(new MemorySource(truncated))).readNext(signal()),
    ).rejects.toThrow(/truncated at physical EOF/i);

    const trailingReader = new AdtsIncrementalFrameReader(
      options(new MemorySource(concatenate(makeFrame(), Uint8Array.of(1, 2, 3)))),
    );
    expect(await trailingReader.readNext(signal())).not.toBeNull();
    await expect(trailingReader.readNext(signal())).rejects.toThrow(/trailing bytes/i);
  });
});

describe('AdtsIncrementalFrameReader verified anchors', () => {
  it('starts only at the supplied nonzero anchor with full-scan expected config', async () => {
    const prefix = makeFrame({ frameLengthBytes: 23 });
    const tail = makeFrame({ frameLengthBytes: 47 });
    const source = new MemorySource(concatenate(prefix, tail));
    const reader = new AdtsIncrementalFrameReader(
      options(source, {
        start: { byteOffset: prefix.byteLength, frameOrdinal: 91 },
        expectedConfig: CONFIG,
        pageBytes: 7,
      }),
    );
    expect(await reader.readNext(signal())).toMatchObject({
      descriptor: {
        frameOrdinal: 91,
        byteOffset: prefix.byteLength,
        byteEndOffset: prefix.byteLength + tail.byteLength,
      },
    });
    expect(await reader.readNext(signal())).toBeNull();
    expect(source.reads.every((read) => read.offset >= prefix.byteLength)).toBe(true);
  });

  it('requires expected config for a nonzero anchor and compares it on the first read', async () => {
    const prefix = makeFrame();
    const tail = makeFrame({ sampleRateIndex: 3 });
    const source = new MemorySource(concatenate(prefix, tail));
    expect(
      () =>
        new AdtsIncrementalFrameReader(
          options(source, { start: { byteOffset: prefix.byteLength, frameOrdinal: 1 } }),
        ),
    ).toThrow(/requires full-scan expected/i);

    const reader = new AdtsIncrementalFrameReader(
      options(source, {
        start: { byteOffset: prefix.byteLength, frameOrdinal: 1 },
        expectedConfig: CONFIG,
      }),
    );
    await expect(reader.readNext(signal())).rejects.toThrow(/contradicts verified metadata/i);
  });

  it('optionally compares origin admission to expected full-scan config', async () => {
    const reader = new AdtsIncrementalFrameReader(
      options(new MemorySource(makeFrame({ channelConfiguration: 1 })), {
        expectedConfig: CONFIG,
      }),
    );
    await expect(reader.readNext(signal())).rejects.toThrow(/contradicts verified metadata/i);
  });
});

describe('AdtsIncrementalFrameReader hostile boundaries', () => {
  it('snapshots options, anchors, and config without invoking accessors', () => {
    let getterCalls = 0;
    const hostileOptions = Object.defineProperty({}, 'source', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return new MemorySource(makeFrame());
      },
    });
    expect(() => new AdtsIncrementalFrameReader(hostileOptions as never)).toThrow(/data fields/i);

    const hostileStart = Object.defineProperties(
      {},
      {
        byteOffset: {
          enumerable: true,
          get() {
            getterCalls += 1;
            return 0;
          },
        },
        frameOrdinal: { enumerable: true, value: 0 },
      },
    );
    expect(
      () =>
        new AdtsIncrementalFrameReader(
          options(new MemorySource(makeFrame()), { start: hostileStart as never }),
        ),
    ).toThrow(/data fields/i);

    const hostileConfig = { ...CONFIG } as Record<string, unknown>;
    Object.defineProperty(hostileConfig, 'sampleRateIndex', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 4;
      },
    });
    expect(
      () =>
        new AdtsIncrementalFrameReader(
          options(new MemorySource(makeFrame()), { expectedConfig: hostileConfig as never }),
        ),
    ).toThrow(/data fields/i);
    expect(getterCalls).toBe(0);
  });

  it('does not use dynamic property gets on a transparent options Proxy', () => {
    let getCalls = 0;
    const source = new MemorySource(makeFrame());
    const proxy = new Proxy(
      { source },
      {
        get() {
          getCalls += 1;
          throw new Error('dynamic get must not run');
        },
      },
    );
    expect(() => new AdtsIncrementalFrameReader(proxy)).not.toThrow();
    expect(getCalls).toBe(0);

    const opaque = new Proxy(
      { source },
      {
        ownKeys() {
          throw new Error('hostile proxy');
        },
      },
    );
    expect(() => new AdtsIncrementalFrameReader(opaque)).toThrow(/inspected safely/i);
  });

  it('captures source properties once and owns exact page snapshots', async () => {
    const delegate = new MemorySource(makeFrame());
    const reads = { size: 0, identity: 0, readAt: 0, close: 0 };
    const authority = Object.defineProperties(
      {},
      {
        size: {
          get() {
            reads.size += 1;
            return delegate.size;
          },
        },
        identity: {
          get() {
            reads.identity += 1;
            return delegate.identity;
          },
        },
        readAt: {
          get() {
            reads.readAt += 1;
            return delegate.readAt.bind(delegate);
          },
        },
        close: {
          get() {
            reads.close += 1;
            return delegate.close.bind(delegate);
          },
        },
      },
    ) as EncodedAudioSource;
    const reader = new AdtsIncrementalFrameReader(options(authority));
    expect(await reader.readNext(signal())).not.toBeNull();
    expect(await reader.readNext(signal())).toBeNull();
    expect(reads).toEqual({ size: 1, identity: 1, readAt: 1, close: 1 });
    expect(delegate.closeCount).toBe(0);
  });

  it('copies intrinsic Uint8Array bytes but rejects Proxy and shared pages', async () => {
    let accessorCalls = 0;
    const accessorSource = new MemorySource(makeFrame());
    accessorSource.resultFactory = (bytes) => {
      Object.defineProperty(bytes, 'byteLength', {
        get() {
          accessorCalls += 1;
          throw new Error('must not run');
        },
      });
      Object.defineProperty(bytes, Symbol.iterator, {
        get() {
          accessorCalls += 1;
          throw new Error('must not run');
        },
      });
      return bytes;
    };
    expect(
      await new AdtsIncrementalFrameReader(options(accessorSource)).readNext(signal()),
    ).not.toBeNull();
    expect(accessorCalls).toBe(0);

    const proxySource = new MemorySource(makeFrame());
    proxySource.resultFactory = (bytes) => new Proxy(bytes, {});
    await expect(
      new AdtsIncrementalFrameReader(options(proxySource)).readNext(signal()),
    ).rejects.toThrow(/invalid page bytes/i);

    if (typeof SharedArrayBuffer !== 'undefined') {
      const sharedSource = new MemorySource(makeFrame());
      sharedSource.resultFactory = (bytes) => {
        const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
        shared.set(bytes);
        return shared;
      };
      await expect(
        new AdtsIncrementalFrameReader(options(sharedSource)).readNext(signal()),
      ).rejects.toThrow(/non-shared/i);
    }
  });
});

describe('AdtsIncrementalFrameReader concurrency, aborts, and poisoning', () => {
  it('rejects concurrent and transport-reentrant reads without disturbing the active read', async () => {
    const source = new MemorySource(makeFrame());
    let release: (() => void) | null = null;
    const entered = new Promise<void>((resolveEntered) => {
      source.onRead = () =>
        new Promise<void>((resolveRead) => {
          release = resolveRead;
          resolveEntered();
        });
    });
    const reader = new AdtsIncrementalFrameReader(options(source));
    const active = reader.readNext(signal());
    await entered;
    await expect(reader.readNext(signal())).rejects.toThrow(/concurrent or reentrant/i);
    requireAssigned(() => release, 'deferred read was not installed')();
    expect(await active).not.toBeNull();

    const reentrantSource = new MemorySource(makeFrame());
    let reentrant: Promise<unknown> | null = null;
    let reentrantReader: AdtsIncrementalFrameReader;
    reentrantSource.onRead = () => {
      reentrant = reentrantReader.readNext(signal());
    };
    reentrantReader = new AdtsIncrementalFrameReader(options(reentrantSource));
    expect(await reentrantReader.readNext(signal())).not.toBeNull();
    if (reentrant === null) throw new Error('transport did not attempt reentry');
    await expect(reentrant).rejects.toThrow(/concurrent or reentrant/i);
  });

  it('propagates exact abort reasons and permits a clean retry without closing the source', async () => {
    const before = new AbortController();
    const beforeReason = new Error('before-adts-read');
    before.abort(beforeReason);
    const beforeSource = new MemorySource(makeFrame());
    const beforeReader = new AdtsIncrementalFrameReader(options(beforeSource));
    await expect(beforeReader.readNext(before.signal)).rejects.toBe(beforeReason);
    expect(beforeSource.reads).toHaveLength(0);

    const during = new AbortController();
    const duringReason = new Error('during-adts-read');
    const duringSource = new MemorySource(makeFrame());
    duringSource.onRead = () => {
      duringSource.onRead = null;
      during.abort(duringReason);
    };
    const duringReader = new AdtsIncrementalFrameReader(options(duringSource));
    await expect(duringReader.readNext(during.signal)).rejects.toBe(duringReason);
    expect(await duringReader.readNext(signal())).not.toBeNull();
    expect(duringSource.closeCount).toBe(0);
  });

  it('does not commit a frame when an abort-resistant source settles after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('abort-resistant-adts-read');
    const source = new MemorySource(makeFrame());
    let release: (() => void) | null = null;
    let enteredResolve: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    source.onRead = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        enteredResolve?.();
      });
    const reader = new AdtsIncrementalFrameReader(options(source));
    const active = reader.readNext(controller.signal);
    await entered;
    controller.abort(reason);
    let settled = false;
    void active.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    source.onRead = null;
    requireAssigned(() => release, 'abort-resistant read was not installed')();
    await expect(active).rejects.toBe(reason);
    expect(await reader.readNext(signal())).toMatchObject({ descriptor: { frameOrdinal: 0 } });
    expect(source.closeCount).toBe(0);
  });

  it('poisons on a short transport page and preserves the original terminal error', async () => {
    const source = new MemorySource(makeFrame());
    source.shortRead = true;
    const reader = new AdtsIncrementalFrameReader(options(source));
    const failure = await reader.readNext(signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdtsIncrementalFrameReaderError);
    expect(String(failure)).toMatch(/expected/i);
    source.shortRead = false;
    await expect(reader.readNext(signal())).rejects.toBe(failure);
    const laterAbort = new AbortController();
    laterAbort.abort(new Error('must not hide poison'));
    await expect(reader.readNext(laterAbort.signal)).rejects.toBe(failure);
    expect(source.closeCount).toBe(0);
  });
});

describe('AdtsIncrementalFrameReader constructor validation', () => {
  it('rejects impossible source, page, start, config, and option shapes before reading', () => {
    const source = new MemorySource(makeFrame());
    const invalid: unknown[] = [
      null,
      {},
      { source, unexpected: true },
      options(source, { pageBytes: 6 }),
      options(source, { pageBytes: ADTS_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES + 1 }),
      options(source, { start: { byteOffset: 0, frameOrdinal: 1 } }),
      options(source, { start: { byteOffset: 1, frameOrdinal: 0 }, expectedConfig: CONFIG }),
      options(source, { expectedConfig: { ...CONFIG, sampleRateIndex: 13 as never } }),
      options(source, { expectedConfig: { ...CONFIG, channelConfiguration: 3 as never } }),
    ];
    for (const value of invalid) {
      expect(() => new AdtsIncrementalFrameReader(value as never)).toThrow();
    }
    expect(source.reads).toHaveLength(0);

    expect(
      () => new AdtsIncrementalFrameReader(options(new MemorySource(new Uint8Array(7)))),
    ).toThrow(/at least one complete/i);
    expect(
      () =>
        new AdtsIncrementalFrameReader(
          options(source, {
            start: { byteOffset: source.size - 1, frameOrdinal: 1 },
            expectedConfig: CONFIG,
          }),
        ),
    ).toThrow();
  });

  it('requires a real AbortSignal without poisoning the reader', async () => {
    const reader = new AdtsIncrementalFrameReader(options(new MemorySource(makeFrame())));
    await expect(reader.readNext(null as never)).rejects.toThrow(/AbortSignal/i);
    expect(await reader.readNext(signal())).not.toBeNull();
  });
});
