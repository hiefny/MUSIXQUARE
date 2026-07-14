import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeCodecTimelineSourceBindingSha256 } from '../codec-timeline-source-binding.ts';
import {
  throwIfAborted,
  validateExactRead,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  type EncodedRandomAccessSource,
} from '../../sources/encoded-audio-source.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_IDENTITY = 'source-1';
const TRANSFER_SESSION_ID = 'transfer-1';
const NAME = 'a.mp3';
const MIME = 'audio/mpeg';
const PROBE_BYTES = 64 * 1_024;

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly reads: Array<Readonly<{ offset: number; length: number }>> = [];
  metadata: EncodedAudioSourceMetadata;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity = SOURCE_IDENTITY,
    name = NAME,
    mime = MIME,
  ) {
    this.metadata = { name, mime };
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {}
}

function descriptor(
  encodedSize: number,
  patch: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    queueItemId: QUEUE_ITEM_ID,
    sourceIdentity: SOURCE_IDENTITY,
    transferSessionId: TRANSFER_SESSION_ID,
    encodedSize,
    name: NAME,
    mime: MIME,
    ...patch,
  };
}

function bytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 29 + 7) & 0xff);
}

function appendByte(value: Uint8Array, byte: number): Uint8Array {
  const result = new Uint8Array(value.byteLength + 1);
  result.set(value);
  result[value.byteLength] = byte;
  return result;
}

type TestDigest = (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>;

function stubSubtleDigest(digest: TestDigest): void {
  vi.stubGlobal('crypto', Object.freeze({ subtle: Object.freeze({ digest }) }));
}

function copyBufferSource(value: BufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('codec timeline source binding probe geometry', () => {
  it.each([
    { size: 1, reads: [[0, 1]] },
    { size: PROBE_BYTES, reads: [[0, PROBE_BYTES]] },
    {
      size: PROBE_BYTES + 1,
      reads: [
        [0, PROBE_BYTES],
        [PROBE_BYTES, 1],
      ],
    },
    {
      size: PROBE_BYTES * 2,
      reads: [
        [0, PROBE_BYTES],
        [PROBE_BYTES, PROBE_BYTES],
      ],
    },
    {
      size: PROBE_BYTES * 3 + 17,
      reads: [
        [0, PROBE_BYTES],
        [PROBE_BYTES * 2 + 17, PROBE_BYTES],
      ],
    },
  ])('reads exact, non-overlapping probes for $size bytes', async ({ size, reads }) => {
    const source = new MemorySource(bytes(size));

    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(size),
        source,
        new AbortController().signal,
      ),
    ).resolves.toHaveLength(32);

    expect(source.reads.map(({ offset, length }) => [offset, length])).toEqual(reads);
    expect(source.reads.every(({ length }) => length <= PROBE_BYTES)).toBe(true);
    if (source.reads.length === 2) {
      const first = source.reads[0];
      const tail = source.reads[1];
      expect(first && tail && first.offset + first.length <= tail.offset).toBe(true);
    }
  });

  it('binds the exact canonical preimage and known SHA-256 value', async () => {
    const source = new MemorySource(Uint8Array.of(1, 2, 3));
    let captured: Uint8Array | null = null;
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    stubSubtleDigest(async (algorithm, data) => {
      captured = copyBufferSource(data);
      return realDigest(algorithm, data);
    });

    const result = await computeCodecTimelineSourceBindingSha256(
      descriptor(3),
      source,
      new AbortController().signal,
    );

    expect(toHex(captured ?? new Uint8Array())).toBe(
      '4d58512d4354532d42494e4400000100000000000000030000002431313131313131312d313131312d343131312d383131312d31313131313131313131313100000008736f757263652d310000000a7472616e736665722d3100000005612e6d70330000000a617564696f2f6d706567000000000000000000000003000000000000000300000000010203',
    );
    expect(toHex(result)).toBe('6e5b347151b68cb3f063e5f23644234c95deeebfe1232d94bb50c56340c17820');
  });
});

describe('codec timeline source binding authority', () => {
  it('has no caller-controlled digest override, including surplus JavaScript arguments', async () => {
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let platformDigestCalls = 0;
    let hostileDigestCalls = 0;
    stubSubtleDigest(async (algorithm, data) => {
      platformDigestCalls += 1;
      return realDigest(algorithm, data);
    });

    const result = (await Reflect.apply(computeCodecTimelineSourceBindingSha256, undefined, [
      descriptor(1),
      new MemorySource(Uint8Array.of(1)),
      new AbortController().signal,
      async () => {
        hostileDigestCalls += 1;
        return new ArrayBuffer(32);
      },
    ])) as Uint8Array;

    expect(result).toHaveLength(32);
    expect(platformDigestCalls).toBe(1);
    expect(hostileDigestCalls).toBe(0);
  });

  it('changes for every mutable descriptor field and for head or tail bytes', async () => {
    const baselineBytes = bytes(PROBE_BYTES * 2 + 11);
    const hash = async (source: MemorySource, value: Record<string, unknown>): Promise<string> =>
      toHex(
        await computeCodecTimelineSourceBindingSha256(value, source, new AbortController().signal),
      );
    const baseline = await hash(
      new MemorySource(baselineBytes),
      descriptor(baselineBytes.byteLength),
    );

    const cases: Array<Readonly<{ source: MemorySource; value: Record<string, unknown> }>> = [
      {
        source: new MemorySource(baselineBytes),
        value: descriptor(baselineBytes.byteLength, {
          queueItemId: '22222222-2222-4222-8222-222222222222',
        }),
      },
      {
        source: new MemorySource(baselineBytes, 'source-2'),
        value: descriptor(baselineBytes.byteLength, { sourceIdentity: 'source-2' }),
      },
      {
        source: new MemorySource(baselineBytes),
        value: descriptor(baselineBytes.byteLength, { transferSessionId: 'transfer-2' }),
      },
      {
        source: new MemorySource(baselineBytes, SOURCE_IDENTITY, 'b.mp3'),
        value: descriptor(baselineBytes.byteLength, { name: 'b.mp3' }),
      },
      {
        source: new MemorySource(baselineBytes, SOURCE_IDENTITY, NAME, 'audio/mp3'),
        value: descriptor(baselineBytes.byteLength, { mime: 'audio/mp3' }),
      },
      {
        source: new MemorySource(appendByte(baselineBytes, 0xaa)),
        value: descriptor(baselineBytes.byteLength + 1),
      },
    ];

    for (const value of cases) {
      await expect(hash(value.source, value.value)).resolves.not.toBe(baseline);
    }

    const changedHead = baselineBytes.slice();
    changedHead[0] ^= 0xff;
    await expect(
      hash(new MemorySource(changedHead), descriptor(changedHead.byteLength)),
    ).resolves.not.toBe(baseline);

    const changedTail = baselineBytes.slice();
    changedTail[changedTail.byteLength - 1] ^= 0xff;
    await expect(
      hash(new MemorySource(changedTail), descriptor(changedTail.byteLength)),
    ).resolves.not.toBe(baseline);
  });

  it('returns fresh, detached digest copies', async () => {
    const sharedDigest = Uint8Array.from({ length: 32 }, (_, index) => index).buffer;
    stubSubtleDigest(async () => sharedDigest);
    const source = new MemorySource(Uint8Array.of(1));
    const first = await computeCodecTimelineSourceBindingSha256(
      descriptor(1),
      source,
      new AbortController().signal,
    );
    first.fill(0xff);
    const second = await computeCodecTimelineSourceBindingSha256(
      descriptor(1),
      source,
      new AbortController().signal,
    );

    expect(first).not.toBe(second);
    expect(Array.from(second)).toEqual(Array.from({ length: 32 }, (_, index) => index));
  });
});

describe('codec timeline source binding validation', () => {
  it('rejects descriptor accessors without invoking them and rejects extra fields', async () => {
    let getterCalls = 0;
    const accessor = descriptor(1);
    Object.defineProperty(accessor, 'queueItemId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return QUEUE_ITEM_ID;
      },
    });
    const source = new MemorySource(Uint8Array.of(1));

    await expect(
      computeCodecTimelineSourceBindingSha256(accessor, source, new AbortController().signal),
    ).rejects.toThrow(/enumerable data/);
    expect(getterCalls).toBe(0);

    await expect(
      computeCodecTimelineSourceBindingSha256(
        { ...descriptor(1), extra: true },
        source,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not exact/);
    const symbolField = descriptor(1);
    Object.defineProperty(symbolField, Symbol('extra'), { enumerable: true, value: true });
    await expect(
      computeCodecTimelineSourceBindingSha256(symbolField, source, new AbortController().signal),
    ).rejects.toThrow(/not exact/);
  });

  it('enforces existing identity, name, MIME, size, and valid Unicode bounds without trimming', async () => {
    const source = new MemorySource(Uint8Array.of(1));
    const invalid = [
      descriptor(1, { schemaVersion: 2 }),
      descriptor(1, { queueItemId: 'queue' }),
      descriptor(1, { sourceIdentity: ` ${SOURCE_IDENTITY}` }),
      descriptor(1, { sourceIdentity: 'x'.repeat(257) }),
      descriptor(1, { transferSessionId: 'x'.repeat(257) }),
      descriptor(1, { encodedSize: 0 }),
      descriptor(1, { encodedSize: Number.MAX_SAFE_INTEGER + 1 }),
      descriptor(1, { name: ' '.repeat(3) }),
      descriptor(1, { name: 'x'.repeat(513) }),
      descriptor(1, { name: 'bad\ud800name' }),
      descriptor(1, { sourceIdentity: 'bad\udc00id' }),
      descriptor(1, { mime: ' audio/mpeg' }),
      descriptor(1, { mime: `audio/${'x'.repeat(123)}` }),
    ];

    for (const value of invalid) {
      await expect(
        computeCodecTimelineSourceBindingSha256(value, source, new AbortController().signal),
      ).rejects.toMatchObject({ name: 'CodecTimelineSourceBindingError' });
    }

    const wideIdentity = '한'.repeat(256);
    const wideName = '😀'.repeat(256);
    const wideSource = new MemorySource(Uint8Array.of(1), wideIdentity, wideName, MIME);
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(1, { sourceIdentity: wideIdentity, name: wideName }),
        wideSource,
        new AbortController().signal,
      ),
    ).resolves.toHaveLength(32);
  });

  it('requires exact source identity, size, and present metadata', async () => {
    const signal = new AbortController().signal;
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(1),
        new MemorySource(Uint8Array.of(1), 'other'),
        signal,
      ),
    ).rejects.toThrow(/identity/);
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(2),
        new MemorySource(Uint8Array.of(1)),
        signal,
      ),
    ).rejects.toThrow(/size/);
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(1),
        new MemorySource(Uint8Array.of(1), SOURCE_IDENTITY, 'other.mp3'),
        signal,
      ),
    ).rejects.toThrow(/metadata/);

    const randomAccessOnly: EncodedRandomAccessSource = {
      size: 1,
      identity: SOURCE_IDENTITY,
      async readAt() {
        return Uint8Array.of(1);
      },
      async close() {},
    };
    await expect(
      computeCodecTimelineSourceBindingSha256(descriptor(1), randomAccessOnly, signal),
    ).resolves.toHaveLength(32);
  });

  it('rejects a short probe and unavailable Web Crypto without a fallback', async () => {
    const shortSource = new MemorySource(Uint8Array.of(1, 2));
    shortSource.readAt = async () => Uint8Array.of(1);
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(2),
        shortSource,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/short/);

    const source = new MemorySource(Uint8Array.of(1));
    vi.stubGlobal('crypto', undefined);
    await expect(
      computeCodecTimelineSourceBindingSha256(descriptor(1), source, new AbortController().signal),
    ).rejects.toThrow(/unavailable/);
    expect(source.reads).toHaveLength(0);
  });

  it('rejects a non-AbortSignal before touching the source', async () => {
    let identityReads = 0;
    const source = {
      get identity() {
        identityReads += 1;
        return SOURCE_IDENTITY;
      },
      size: 1,
      async readAt() {
        return Uint8Array.of(1);
      },
      async close() {},
    };

    await expect(
      computeCodecTimelineSourceBindingSha256(descriptor(1), source, {} as AbortSignal),
    ).rejects.toThrow(/AbortSignal/);
    expect(identityReads).toBe(0);
  });

  it('detects source fields changing after either probe or the digest', async () => {
    let identityReads = 0;
    const changingIdentitySource: EncodedRandomAccessSource = {
      size: 1,
      get identity() {
        identityReads += 1;
        return identityReads === 1 ? SOURCE_IDENTITY : 'changed-source';
      },
      async readAt() {
        return Uint8Array.of(1);
      },
      async close() {},
    };
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(1),
        changingIdentitySource,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/identity/);

    const twoProbeBytes = bytes(PROBE_BYTES + 1);
    let sizeReads = 0;
    const changingSizeSource: EncodedRandomAccessSource = {
      identity: SOURCE_IDENTITY,
      get size() {
        sizeReads += 1;
        return sizeReads <= 2 ? twoProbeBytes.byteLength : twoProbeBytes.byteLength - 1;
      },
      async readAt(offset, length) {
        return twoProbeBytes.slice(offset, offset + length);
      },
      async close() {},
    };
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(twoProbeBytes.byteLength),
        changingSizeSource,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/size/);
    expect(sizeReads).toBe(3);

    const changingMetadataSource = new MemorySource(Uint8Array.of(1));
    stubSubtleDigest(async () => {
      changingMetadataSource.metadata = { name: 'changed.mp3', mime: MIME };
      return new ArrayBuffer(32);
    });
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(1),
        changingMetadataSource,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/metadata/);

    const disappearingMetadataSource = new MemorySource(Uint8Array.of(1));
    stubSubtleDigest(async () => {
      Reflect.deleteProperty(disappearingMetadataSource, 'metadata');
      return new ArrayBuffer(32);
    });
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(1),
        disappearingMetadataSource,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/metadata presence/);
  });
});

describe('codec timeline source binding abort boundaries', () => {
  it('honors abort before reads and after the final read', async () => {
    const before = new AbortController();
    const beforeReason = new Error('before');
    before.abort(beforeReason);
    const beforeSource = new MemorySource(Uint8Array.of(1));
    await expect(
      computeCodecTimelineSourceBindingSha256(descriptor(1), beforeSource, before.signal),
    ).rejects.toBe(beforeReason);
    expect(beforeSource.reads).toHaveLength(0);

    const after = new AbortController();
    const afterReason = new Error('after-read');
    const afterBytes = bytes(PROBE_BYTES * 2);
    const afterSource = new MemorySource(afterBytes);
    const originalRead = afterSource.readAt.bind(afterSource);
    afterSource.readAt = async (offset, length, signal) => {
      const result = await originalRead(offset, length, signal);
      if (offset > 0) after.abort(afterReason);
      return result;
    };
    let digestCalls = 0;
    stubSubtleDigest(async () => {
      digestCalls += 1;
      return new ArrayBuffer(32);
    });
    await expect(
      computeCodecTimelineSourceBindingSha256(
        descriptor(afterBytes.byteLength),
        afterSource,
        after.signal,
      ),
    ).rejects.toBe(afterReason);
    expect(afterSource.reads).toHaveLength(2);
    expect(digestCalls).toBe(0);
  });

  it('discards a digest that resolves after abort', async () => {
    const controller = new AbortController();
    const reason = new Error('late-digest');
    let releaseDigest!: () => void;
    const digestGate = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    let announceDigest!: () => void;
    const announced = new Promise<void>((resolve) => {
      announceDigest = resolve;
    });
    stubSubtleDigest(async () => {
      announceDigest();
      await digestGate;
      return new ArrayBuffer(32);
    });
    const pending = computeCodecTimelineSourceBindingSha256(
      descriptor(1),
      new MemorySource(Uint8Array.of(1)),
      controller.signal,
    );

    await announced;
    controller.abort(reason);
    releaseDigest();
    await expect(pending).rejects.toBe(reason);
  });

  it('honors an abort raised by the final source revalidation', async () => {
    const controller = new AbortController();
    const reason = new Error('final-source-check');
    let metadataReads = 0;
    const source: EncodedAudioSource = {
      kind: 'blob',
      size: 1,
      identity: SOURCE_IDENTITY,
      get metadata() {
        metadataReads += 1;
        if (metadataReads === 3) controller.abort(reason);
        return { name: NAME, mime: MIME };
      },
      async readAt() {
        return Uint8Array.of(1);
      },
      async close() {},
    };

    await expect(
      computeCodecTimelineSourceBindingSha256(descriptor(1), source, controller.signal),
    ).rejects.toBe(reason);
    expect(metadataReads).toBe(3);
  });
});
