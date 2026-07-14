import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanAdtsFrames } from '../../aac/frame-scanner.ts';
import { parseMpegLayer3FrameHeader } from '../../mp3/frame-header.ts';
import { readMp3Metadata } from '../../mp3/metadata.ts';
import {
  throwIfAborted,
  validateExactRead,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
} from '../../sources/encoded-audio-source.ts';
import {
  copyCodecTimelineHostArtifactManifest,
  createCodecTimelineHostArtifact,
  type CodecTimelineHostArtifactBinding,
} from '../codec-timeline-host-artifact.ts';
import { parseCodecTimelineManifest } from '../codec-timeline-manifest.ts';
import { computeCodecTimelineSourceBindingSha256 } from '../codec-timeline-source-binding.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_IDENTITY = 'source:host-artifact';
const TRANSFER_SESSION_ID = 'transfer:host-artifact';
const NAME = 'session-track.aac';
const MIME = 'audio/aac';

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly metadata: EncodedAudioSourceMetadata;
  readonly reads: Array<Readonly<{ offset: number; length: number }>> = [];
  closeCount = 0;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity = SOURCE_IDENTITY,
    name = NAME,
    mime = MIME,
  ) {
    this.metadata = Object.freeze({ name, mime });
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

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function adtsFrame(frameLengthBytes: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(frameLengthBytes).fill(fill);
  const sampleRateIndex = 4;
  const channelConfiguration = 2;
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = (1 << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100;
  return bytes;
}

function mp3Frame(mainDataBeginBytes: number, fill: number): Uint8Array {
  const headerBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const bytes = new Uint8Array(header.frameLengthBytes).fill(fill);
  bytes.set(headerBytes);
  bytes[4] = mainDataBeginBytes >>> 1;
  bytes[5] = (mainDataBeginBytes & 1) << 7;
  return bytes;
}

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function noCountXingMp3(audioFrameCount: number): Uint8Array {
  const tag = mp3Frame(0, 0);
  const header = parseMpegLayer3FrameHeader(tag.subarray(0, 4));
  const markerOffset = 4 + header.sideInfoBytes;
  setAscii(tag, markerOffset, 'Xing');
  // Flags remain zero: this is deliberately a Xing stream without a frame-count declaration.
  const audio = Array.from({ length: audioFrameCount }, (_, index) =>
    mp3Frame(index === 0 ? 0 : 16, index + 1),
  );
  return concatenate(tag, ...audio);
}

function binding(
  source: MemorySource,
  patch: Readonly<Record<string, unknown>> = {},
): CodecTimelineHostArtifactBinding {
  return {
    queueItemId: QUEUE_ITEM_ID,
    sourceIdentity: source.identity,
    transferSessionId: TRANSFER_SESSION_ID,
    encodedSize: source.size,
    name: source.metadata.name,
    mime: source.metadata.mime,
    ...patch,
  } as CodecTimelineHostArtifactBinding;
}

function bindingDescriptor(value: CodecTimelineHostArtifactBinding): Record<string, unknown> {
  return {
    schemaVersion: 1,
    queueItemId: value.queueItemId,
    sourceIdentity: value.sourceIdentity,
    transferSessionId: value.transferSessionId,
    encodedSize: value.encodedSize,
    name: value.name,
    mime: value.mime,
  };
}

function copyOptions(
  artifact: Awaited<ReturnType<typeof createCodecTimelineHostArtifact>>,
  exactBinding: CodecTimelineHostArtifactBinding,
): Record<string, unknown> {
  return { artifact, binding: exactBinding };
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return btoa(String.fromCharCode(...digest));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('codec timeline host artifact issuance', () => {
  it('binds a scanner-issued ADTS timeline and retains only opaque body-free diagnostics', async () => {
    const source = new MemorySource(
      concatenate(adtsFrame(19, 0x11), adtsFrame(41, 0x22), adtsFrame(83, 0x33)),
    );
    const timeline = await scanAdtsFrames(source, new AbortController().signal);
    source.reads.length = 0;
    const exactBinding = binding(source);

    const artifact = await createCodecTimelineHostArtifact({
      binding: exactBinding,
      source,
      timeline,
      signal: new AbortController().signal,
    });

    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.binding)).toBe(true);
    expect(Object.getPrototypeOf(artifact.binding)).toBeNull();
    expect(artifact).toMatchObject({
      codec: 'adts-aac-lc',
      binding: exactBinding,
    });
    expect(Object.keys(artifact)).toEqual([]);
    expect(JSON.stringify(artifact)).toBe('{}');
    expect('copyBytes' in artifact).toBe(false);
    expect(source.reads).toEqual([{ offset: 0, length: source.size }]);
    expect(source.closeCount).toBe(0);

    const first = copyCodecTimelineHostArtifactManifest(copyOptions(artifact, exactBinding));
    const expectedBinding = await computeCodecTimelineSourceBindingSha256(
      bindingDescriptor(exactBinding),
      source,
      new AbortController().signal,
    );
    const parsed = parseCodecTimelineManifest(first);
    expect(parsed).toMatchObject({
      codec: 'adts-aac-lc',
      sourceSize: source.size,
      sourceBindingSha256: Array.from(expectedBinding),
    });
    expect(artifact.manifestByteLength).toBe(first.byteLength);
    await expect(sha256Base64(first)).resolves.toBe(artifact.manifestSha256B64);

    const pristine = first.slice();
    first.fill(0);
    const second = copyCodecTimelineHostArtifactManifest(copyOptions(artifact, exactBinding));
    expect(second).toEqual(pristine);
    expect(second).not.toBe(first);
  });

  it('uses the same artifact contract for a fully scanned no-count MP3 timeline', async () => {
    const source = new MemorySource(
      noCountXingMp3(6),
      'source:host-mp3',
      'session-track.mp3',
      'audio/mpeg',
    );
    const timeline = await readMp3Metadata(source, new AbortController().signal);
    const exactBinding = binding(source);

    const artifact = await createCodecTimelineHostArtifact({
      binding: exactBinding,
      source,
      timeline,
      signal: new AbortController().signal,
    });
    const parsed = parseCodecTimelineManifest(
      copyCodecTimelineHostArtifactManifest(copyOptions(artifact, exactBinding)),
    );

    expect(artifact.codec).toBe('mp3-no-frame-count');
    expect(parsed).toMatchObject({
      codec: 'mp3-no-frame-count',
      hasFrameCountDeclaration: false,
      frameCount: 6,
      sourceSize: source.size,
    });
    expect(source.closeCount).toBe(0);
  });

  it('rejects copied scanner results and mismatched source identities before probing', async () => {
    const source = new MemorySource(adtsFrame(31, 1));
    const timeline = await scanAdtsFrames(source, new AbortController().signal);
    source.reads.length = 0;

    await expect(
      createCodecTimelineHostArtifact({
        binding: binding(source),
        source,
        timeline: { ...timeline },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/scanner-issued/i);
    await expect(
      createCodecTimelineHostArtifact({
        binding: binding(source, { sourceIdentity: 'source:other' }),
        source,
        timeline,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/does not match/i);
    expect(source.reads).toEqual([]);
  });

  it('rejects unknown fields and accessors without invoking input getters', async () => {
    const source = new MemorySource(adtsFrame(31, 1));
    const timeline = await scanAdtsFrames(source, new AbortController().signal);
    const exactBinding = binding(source) as unknown as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(exactBinding, 'name', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return NAME;
      },
    });

    await expect(
      createCodecTimelineHostArtifact({
        binding: exactBinding,
        source,
        timeline,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/enumerable data/i);
    expect(getterCalls).toBe(0);

    await expect(
      createCodecTimelineHostArtifact({
        binding: { ...binding(source), extra: true },
        source,
        timeline,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not exact/i);
    await expect(
      createCodecTimelineHostArtifact({
        binding: binding(source),
        source,
        timeline,
        signal: new AbortController().signal,
        extra: true,
      }),
    ).rejects.toThrow(/not exact/i);
  });

  it('does not publish an artifact when abort wins the manifest hash', async () => {
    const source = new MemorySource(adtsFrame(31, 1));
    const timeline = await scanAdtsFrames(source, new AbortController().signal);
    const exactBinding = binding(source);
    const controller = new AbortController();
    const reason = new Error('abort manifest artifact');
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let digestCalls = 0;
    let release!: () => void;
    let markSecondDigestStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const secondDigestStarted = new Promise<void>((resolve) => {
      markSecondDigestStarted = resolve;
    });
    vi.stubGlobal(
      'crypto',
      Object.freeze({
        subtle: Object.freeze({
          async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
            digestCalls += 1;
            if (digestCalls === 2) {
              markSecondDigestStarted();
              await gate;
            }
            return realDigest(algorithm, data);
          },
        }),
      }),
    );

    const pending = createCodecTimelineHostArtifact({
      binding: exactBinding,
      source,
      timeline,
      signal: controller.signal,
    });
    await secondDigestStarted;
    controller.abort(reason);
    release();

    await expect(pending).rejects.toBe(reason);
  });

  it('does not publish stale diagnostics when the exact source changes during hashing', async () => {
    const source = new MemorySource(adtsFrame(31, 1));
    const timeline = await scanAdtsFrames(source, new AbortController().signal);
    const exactBinding = binding(source);
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let digestCalls = 0;
    let release!: () => void;
    let markSecondDigestStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const secondDigestStarted = new Promise<void>((resolve) => {
      markSecondDigestStarted = resolve;
    });
    vi.stubGlobal(
      'crypto',
      Object.freeze({
        subtle: Object.freeze({
          async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
            digestCalls += 1;
            if (digestCalls === 2) {
              markSecondDigestStarted();
              await gate;
            }
            return realDigest(algorithm, data);
          },
        }),
      }),
    );

    const pending = createCodecTimelineHostArtifact({
      binding: exactBinding,
      source,
      timeline,
      signal: new AbortController().signal,
    });
    await secondDigestStarted;
    (source as { identity: string }).identity = 'source:changed-during-hash';
    release();

    await expect(pending).rejects.toThrow(/source changed/i);
  });
});

describe('codec timeline host artifact read authority', () => {
  it('requires an authentic artifact and the exact six-field source identity', async () => {
    const source = new MemorySource(adtsFrame(31, 1));
    const timeline = await scanAdtsFrames(source, new AbortController().signal);
    const exactBinding = binding(source);
    const artifact = await createCodecTimelineHostArtifact({
      binding: exactBinding,
      source,
      timeline,
      signal: new AbortController().signal,
    });

    for (const patch of [
      { queueItemId: '22222222-2222-4222-8222-222222222222' },
      { sourceIdentity: 'source:wrong' },
      { transferSessionId: 'transfer:wrong' },
      { encodedSize: source.size + 1 },
      { name: 'wrong.aac' },
      { mime: 'audio/mpeg' },
    ]) {
      expect(() =>
        copyCodecTimelineHostArtifactManifest(copyOptions(artifact, binding(source, patch))),
      ).toThrow(/does not match/i);
    }

    expect(() =>
      copyCodecTimelineHostArtifactManifest({
        artifact: { ...artifact },
        binding: exactBinding,
      }),
    ).toThrow(/not authentic/i);

    const prototypeForged = Object.create(Reflect.getPrototypeOf(artifact));
    expect(() =>
      copyCodecTimelineHostArtifactManifest({
        artifact: prototypeForged,
        binding: exactBinding,
      }),
    ).toThrow(/not authentic/i);
  });

  it('rejects surplus and accessor copy authority without invoking getters', async () => {
    const source = new MemorySource(adtsFrame(31, 1));
    const timeline = await scanAdtsFrames(source, new AbortController().signal);
    const exactBinding = binding(source);
    const artifact = await createCodecTimelineHostArtifact({
      binding: exactBinding,
      source,
      timeline,
      signal: new AbortController().signal,
    });

    expect(() =>
      copyCodecTimelineHostArtifactManifest({
        artifact,
        binding: { ...exactBinding, extra: true },
      }),
    ).toThrow(/not exact/i);
    expect(() =>
      copyCodecTimelineHostArtifactManifest({ artifact, binding: exactBinding, extra: true }),
    ).toThrow(/not exact/i);

    const accessor = { ...exactBinding } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessor, 'sourceIdentity', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return SOURCE_IDENTITY;
      },
    });
    expect(() => copyCodecTimelineHostArtifactManifest({ artifact, binding: accessor })).toThrow(
      /enumerable data/i,
    );
    expect(getterCalls).toBe(0);
  });
});
