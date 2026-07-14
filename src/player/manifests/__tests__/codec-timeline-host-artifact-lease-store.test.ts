import { describe, expect, it } from 'vitest';

import { FilePlaybackAssetRegistry } from '../../file-playback-asset-registry.ts';
import { scanAdtsFrames } from '../../aac/frame-scanner.ts';
import {
  throwIfAborted,
  validateExactRead,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
} from '../../sources/encoded-audio-source.ts';
import {
  createCodecTimelineHostArtifact,
  type CodecTimelineHostArtifact,
  type CodecTimelineHostArtifactBinding,
} from '../codec-timeline-host-artifact.ts';
import {
  copyCodecTimelineHostArtifactManifestForLease,
  describeCodecTimelineHostArtifactForLease,
  installCodecTimelineHostArtifactForLease,
  revokeCodecTimelineHostArtifactForLease,
} from '../codec-timeline-host-artifact-lease-store.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_IDENTITY = 'source:host-artifact-lease';
const TRANSFER_SESSION_ID = 'transfer:host-artifact-lease';
const NAME = 'lease-track.aac';
const MIME = 'audio/aac';

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({ name: NAME, mime: MIME });

  constructor(
    readonly bytes: Uint8Array,
    readonly identity = SOURCE_IDENTITY,
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {}
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

function registry(roomToken: object): FilePlaybackAssetRegistry {
  return new FilePlaybackAssetRegistry({
    liveRoomToken: roomToken,
    onFatalRoom: () => undefined,
  });
}

function distributedBinding(): Record<string, string> {
  return {
    queueItemId: QUEUE_ITEM_ID,
    sourceIdentity: SOURCE_IDENTITY,
    transferSessionId: TRANSFER_SESSION_ID,
  };
}

function artifactBinding(source: MemorySource): CodecTimelineHostArtifactBinding {
  return {
    ...distributedBinding(),
    encodedSize: source.size,
    name: NAME,
    mime: MIME,
  } as CodecTimelineHostArtifactBinding;
}

async function issueArtifact(bytes: Uint8Array): Promise<Readonly<CodecTimelineHostArtifact>> {
  const source = new MemorySource(bytes);
  const timeline = await scanAdtsFrames(source, new AbortController().signal);
  return createCodecTimelineHostArtifact({
    binding: artifactBinding(source),
    source,
    timeline,
    signal: new AbortController().signal,
  });
}

function admitLive(target: FilePlaybackAssetRegistry, roomToken: object, bytes: Uint8Array) {
  return target.admitBlob(roomToken, distributedBinding(), new Blob([bytes]), {
    name: NAME,
    mime: MIME,
  });
}

function installOptions(
  target: FilePlaybackAssetRegistry,
  roomToken: object,
  lease: ReturnType<typeof admitLive>,
  artifact: Readonly<CodecTimelineHostArtifact>,
) {
  return { registry: target, roomToken, lease, artifact };
}

function readOptions(
  target: FilePlaybackAssetRegistry,
  roomToken: object,
  lease: ReturnType<typeof admitLive>,
) {
  return { registry: target, roomToken, lease };
}

describe('codec timeline host artifact exact lease store', () => {
  it('authenticates once, installs idempotently, and exposes only detached diagnostics and copies', async () => {
    const roomToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(37, 0x11);
    const lease = admitLive(target, roomToken, bytes);
    const artifact = await issueArtifact(bytes);
    const options = installOptions(target, roomToken, lease, artifact);

    expect(installCodecTimelineHostArtifactForLease(options)).toBeUndefined();
    expect(installCodecTimelineHostArtifactForLease(options)).toBeUndefined();
    expect(
      describeCodecTimelineHostArtifactForLease(readOptions(target, roomToken, lease)),
    ).toEqual({
      codec: 'adts-aac-lc',
      manifestByteLength: artifact.manifestByteLength,
      manifestSha256B64: artifact.manifestSha256B64,
    });
    expect(Object.keys(artifact)).toEqual([]);

    const first = copyCodecTimelineHostArtifactManifestForLease(
      readOptions(target, roomToken, lease),
    );
    const second = copyCodecTimelineHostArtifactManifestForLease(
      readOptions(target, roomToken, lease),
    );
    expect(first?.some((byte) => byte !== 0)).toBe(true);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('keeps an installed artifact readable across provisional promotion', async () => {
    const roomToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(41, 0x22);
    const lease = target.admitProvisionalBlobAsset(
      roomToken,
      distributedBinding(),
      new Blob([bytes]),
      { name: NAME, mime: MIME },
    );
    const artifact = await issueArtifact(bytes);

    installCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease, artifact });
    expect(
      describeCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease }),
    ).not.toBeNull();
    expect(target.promoteProvisionalAsset(roomToken, lease)).toBe(lease);
    expect(
      copyCodecTimelineHostArtifactManifestForLease({ registry: target, roomToken, lease }),
    ).not.toBeNull();
  });

  it('drops stale reads after retirement without mutating registry lifecycle', async () => {
    const roomToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(43, 0x33);
    const lease = admitLive(target, roomToken, bytes);
    const artifact = await issueArtifact(bytes);
    installCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease, artifact });

    await target.retire(roomToken, lease);
    expect(
      describeCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease }),
    ).toBeNull();
    expect(
      copyCodecTimelineHostArtifactManifestForLease({ registry: target, roomToken, lease }),
    ).toBeNull();
  });

  it('explicitly terminalizes retirement without requiring a later read', async () => {
    const roomToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(45, 0x3a);
    const lease = admitLive(target, roomToken, bytes);
    const artifact = await issueArtifact(bytes);
    installCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease, artifact });

    await target.retire(roomToken, lease);
    expect(revokeCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease })).toBe(
      true,
    );
    expect(revokeCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease })).toBe(
      false,
    );

    const replacementToken = Object.freeze({});
    const replacementTarget = registry(replacementToken);
    const replacement = admitLive(replacementTarget, replacementToken, bytes);
    expect(() =>
      installCodecTimelineHostArtifactForLease({
        registry: replacementTarget,
        roomToken: replacementToken,
        lease: replacement,
        artifact,
      }),
    ).toThrow(/claim is no longer live/u);
  });

  it('drops discarded provisional associations but permanently rejects ABA artifact reuse', async () => {
    const roomToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(47, 0x44);
    const first = target.admitProvisionalBlobAsset(
      roomToken,
      distributedBinding(),
      new Blob([bytes]),
      { name: NAME, mime: MIME },
    );
    const artifact = await issueArtifact(bytes);
    installCodecTimelineHostArtifactForLease({
      registry: target,
      roomToken,
      lease: first,
      artifact,
    });

    await expect(target.discardProvisionalAsset(roomToken, first)).resolves.toBe(true);
    expect(
      describeCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease: first }),
    ).toBeNull();

    const replacement = target.admitProvisionalBlobAsset(
      roomToken,
      distributedBinding(),
      new Blob([bytes]),
      { name: NAME, mime: MIME },
    );
    expect(() =>
      installCodecTimelineHostArtifactForLease({
        registry: target,
        roomToken,
        lease: replacement,
        artifact,
      }),
    ).toThrow(/claim is no longer live/u);
  });

  it('rejects cross-registry artifact reuse even when every diagnostic is identical', async () => {
    const firstToken = Object.freeze({ room: 1 });
    const secondToken = Object.freeze({ room: 2 });
    const firstRegistry = registry(firstToken);
    const secondRegistry = registry(secondToken);
    const bytes = adtsFrame(53, 0x55);
    const firstLease = admitLive(firstRegistry, firstToken, bytes);
    const secondLease = admitLive(secondRegistry, secondToken, bytes);
    const artifact = await issueArtifact(bytes);
    installCodecTimelineHostArtifactForLease({
      registry: firstRegistry,
      roomToken: firstToken,
      lease: firstLease,
      artifact,
    });

    expect(() =>
      installCodecTimelineHostArtifactForLease({
        registry: secondRegistry,
        roomToken: secondToken,
        lease: secondLease,
        artifact,
      }),
    ).toThrow(/another exact registry lease/u);
  });

  it('rejects replacement artifacts on the same exact live lease', async () => {
    const roomToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(59, 0x66);
    const lease = admitLive(target, roomToken, bytes);
    const first = await issueArtifact(bytes);
    const second = await issueArtifact(bytes);
    installCodecTimelineHostArtifactForLease({
      registry: target,
      roomToken,
      lease,
      artifact: first,
    });

    expect(() =>
      installCodecTimelineHostArtifactForLease({
        registry: target,
        roomToken,
        lease,
        artifact: second,
      }),
    ).toThrow(/lease is already claimed/u);
    expect(
      describeCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease }),
    ).not.toBeNull();
  });

  it('authenticates all six live snapshot fields against the artifact binding', async () => {
    const bytes = adtsFrame(61, 0x71);
    const artifact = await issueArtifact(bytes);
    const variants = [
      {
        binding: {
          ...distributedBinding(),
          queueItemId: '22222222-2222-4222-8222-222222222222',
        },
        bytes,
        metadata: { name: NAME, mime: MIME },
      },
      {
        binding: { ...distributedBinding(), sourceIdentity: 'source:other-lease' },
        bytes,
        metadata: { name: NAME, mime: MIME },
      },
      {
        binding: { ...distributedBinding(), transferSessionId: 'transfer:other-lease' },
        bytes,
        metadata: { name: NAME, mime: MIME },
      },
      {
        binding: distributedBinding(),
        bytes: new Uint8Array(bytes.byteLength + 1),
        metadata: { name: NAME, mime: MIME },
      },
      {
        binding: distributedBinding(),
        bytes,
        metadata: { name: 'other.aac', mime: MIME },
      },
      {
        binding: distributedBinding(),
        bytes,
        metadata: { name: NAME, mime: 'audio/mpeg' },
      },
    ] as const;

    for (const variant of variants) {
      const roomToken = Object.freeze({});
      const target = registry(roomToken);
      const lease = target.admitBlob(
        roomToken,
        variant.binding,
        new Blob([variant.bytes]),
        variant.metadata,
      );
      expect(() =>
        installCodecTimelineHostArtifactForLease({
          registry: target,
          roomToken,
          lease,
          artifact,
        }),
      ).toThrow(/does not match/u);
    }
  });

  it('fails closed for wrong tokens and forged leases without erasing the live owner', async () => {
    const roomToken = Object.freeze({});
    const wrongToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(61, 0x77);
    const lease = admitLive(target, roomToken, bytes);
    const artifact = await issueArtifact(bytes);
    installCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease, artifact });
    const forged = Object.freeze({}) as typeof lease;

    expect(
      describeCodecTimelineHostArtifactForLease({ registry: target, roomToken: wrongToken, lease }),
    ).toBeNull();
    expect(
      copyCodecTimelineHostArtifactManifestForLease({ registry: target, roomToken, lease: forged }),
    ).toBeNull();
    expect(() =>
      installCodecTimelineHostArtifactForLease({
        registry: target,
        roomToken,
        lease: forged,
        artifact,
      }),
    ).toThrow(/forged, foreign, or stale/u);
    expect(
      describeCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease }),
    ).not.toBeNull();
  });

  it('rejects forged artifact diagnostics and registry subclasses', async () => {
    const roomToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(67, 0x88);
    const lease = admitLive(target, roomToken, bytes);
    const artifact = await issueArtifact(bytes);
    const forged = Object.create(Reflect.getPrototypeOf(artifact)) as CodecTimelineHostArtifact;

    expect(() =>
      installCodecTimelineHostArtifactForLease({
        registry: target,
        roomToken,
        lease,
        artifact: forged,
      }),
    ).toThrow(/not authentic/u);

    class RegistrySubclass extends FilePlaybackAssetRegistry {}
    const subclassToken = Object.freeze({});
    const subclass = new RegistrySubclass({
      liveRoomToken: subclassToken,
      onFatalRoom: () => undefined,
    });
    const subclassLease = admitLive(subclass, subclassToken, bytes);
    expect(() =>
      installCodecTimelineHostArtifactForLease({
        registry: subclass,
        roomToken: subclassToken,
        lease: subclassLease,
        artifact,
      }),
    ).toThrow(/not an exact FilePlaybackAssetRegistry/u);
  });

  it('uses the captured registry snapshot method and rejects accessor options without reading them', async () => {
    const roomToken = Object.freeze({});
    const target = registry(roomToken);
    const bytes = adtsFrame(71, 0x99);
    const lease = admitLive(target, roomToken, bytes);
    const artifact = await issueArtifact(bytes);
    Object.defineProperty(target, 'snapshotForLease', {
      configurable: true,
      value: () => null,
    });
    expect(
      installCodecTimelineHostArtifactForLease({ registry: target, roomToken, lease, artifact }),
    ).toBeUndefined();

    let getterCalls = 0;
    const malicious = { registry: target, roomToken, lease } as Record<string, unknown>;
    Object.defineProperty(malicious, 'lease', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return lease;
      },
    });
    expect(() => describeCodecTimelineHostArtifactForLease(malicious)).toThrow(/enumerable data/u);
    expect(getterCalls).toBe(0);
  });
});
