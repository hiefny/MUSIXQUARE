import { describe, expect, it, vi } from 'vitest';

import { AacWebCodecsUnavailableError } from '../aac/webcodecs-canary.ts';
import {
  FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
} from '../file-playback-bounded-route-policy.ts';
import type {
  FilePlaybackR2RecordDeliveryScope,
  FilePlaybackR2RecordDescriptorRef,
} from '../file-playback-r2-record-descriptor.ts';
import type {
  BlobFilePlaybackSourceResult,
  BoundedStreamFilePlaybackSourceResult,
} from '../file-playback-source-factory.ts';
import {
  createLegacyBoundedFileV1BlobBinding,
  createLegacyBoundedFileV1R2Binding,
  createLegacyBoundedFileV1SourceAdapter,
  type LegacyBoundedFileV1EncodedSourceBinding,
  type LegacyBoundedFileV1SourceAdapterOptions,
} from '../legacy-bounded-file-v1-source.ts';
import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
} from '../sources/encoded-audio-source.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

function uint64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function nativeFlacBlob(): Blob {
  const sampleRate = 48_000;
  const totalSamples = sampleRate * 2;
  const info = new Uint8Array(34);
  info[0] = 0x10;
  info[1] = 0x00;
  info[2] = 0x10;
  info[3] = 0x00;
  info.set(
    uint64((BigInt(sampleRate) << 44n) | (1n << 41n) | (23n << 36n) | BigInt(totalSamples)),
    10,
  );
  return new Blob(
    [
      Uint8Array.of(0x66, 0x4c, 0x61, 0x43),
      Uint8Array.of(0x80, 0x00, 0x00, 0x22),
      info,
      Uint8Array.of(0xff, 0xf8),
    ],
    { type: 'audio/flac' },
  );
}

function audioHarness(state: AudioContextState = 'running') {
  const audioContext = {
    currentTime: 0,
    sampleRate: 48_000,
    state,
  } as AudioContext;
  const destination = { context: audioContext } as unknown as AudioNode;
  return { audioContext, destination };
}

function adapterOptions(
  binding: Readonly<LegacyBoundedFileV1EncodedSourceBinding>,
  overrides: Partial<LegacyBoundedFileV1SourceAdapterOptions> = {},
): LegacyBoundedFileV1SourceAdapterOptions {
  const audio = audioHarness();
  return {
    binding,
    queueItemId: QUEUE_ITEM_ID,
    audioContext: audio.audioContext,
    destination: audio.destination,
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (value) => value / 1_000,
    localPerformanceMsToContextTime: (value) => value / 1_000,
    ...overrides,
  };
}

function memorySource(identity = 'source:exact'): {
  readonly source: EncodedAudioSource;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => undefined);
  return {
    source: {
      kind: 'r2-records',
      size: 64,
      identity,
      metadata: { name: 'fixture.bin', mime: 'application/octet-stream' },
      readAt: vi.fn(async (_offset, length) => new Uint8Array(length)),
      close,
    },
    close,
  };
}

function fakeBoundedResult(sourceIdentity = 'source:exact'): BoundedStreamFilePlaybackSourceResult {
  const destroy = vi.fn(async () => undefined);
  return {
    backend: 'bounded-stream',
    sourceIdentity,
    releaseConstructionLease: vi.fn(),
    source: {
      backend: 'bounded-stream',
      queueItemId: QUEUE_ITEM_ID,
      prepare: vi.fn(),
      connect: vi.fn(),
      arm: vi.fn(),
      finalize: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      positionAt: vi.fn(),
      getSnapshot: vi.fn(),
      destroy,
    } as never,
  };
}

function bindingFor(source: EncodedAudioSource): LegacyBoundedFileV1EncodedSourceBinding {
  return {
    sourceIdentity: source.identity,
    open: vi.fn(async () => source),
  };
}

describe('legacy bounded V1 source adapter', () => {
  it('positively admits a verified native FLAC without creating an AudioBuffer', async () => {
    const binding = createLegacyBoundedFileV1BlobBinding({
      blob: nativeFlacBlob(),
      sourceIdentity: 'blob:verified-flac',
      metadata: { name: 'verified.flac', mime: 'audio/flac' },
    });
    const options = adapterOptions(binding);
    const adapter = createLegacyBoundedFileV1SourceAdapter(options);

    const outcome = await adapter.open(new AbortController().signal);

    expect(outcome).toMatchObject({
      status: 'opened',
      sourceIdentity: 'blob:verified-flac',
      opened: {
        source: { backend: 'bounded-stream', queueItemId: QUEUE_ITEM_ID },
      },
    });
    if (outcome.status === 'opened') {
      expect(outcome.opened.destination).toBe(options.destination);
      await outcome.opened.source.destroy();
    }
  });

  it('keeps raw ADTS AAC and unsupported content on explicit pre-ownership fallback', async () => {
    const binding = createLegacyBoundedFileV1BlobBinding({
      blob: new Blob([Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc)]),
      sourceIdentity: 'blob:raw-adts',
      metadata: { name: 'fixture.aac', mime: 'audio/aac' },
    });
    const adapter = createLegacyBoundedFileV1SourceAdapter(adapterOptions(binding));

    await expect(adapter.open(new AbortController().signal)).resolves.toEqual({
      status: 'fallback',
      reason: 'unsupported-source',
    });
  });

  it('rejects a policy that enables raw ADTS before opening any byte source', async () => {
    const fixture = memorySource();
    const binding = bindingFor(fixture.source);
    const adapter = createLegacyBoundedFileV1SourceAdapter(
      adapterOptions(binding, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      }),
    );

    await expect(adapter.open(new AbortController().signal)).resolves.toEqual({
      status: 'fallback',
      reason: 'policy-unsupported',
    });
    expect(binding.open).not.toHaveBeenCalled();
  });

  it('maps an exact codec capability failure to fallback and closes the byte source', async () => {
    const fixture = memorySource();
    const adapter = createLegacyBoundedFileV1SourceAdapter(
      adapterOptions(bindingFor(fixture.source), {
        createPlaybackSource: vi.fn(async () => {
          throw new AacWebCodecsUnavailableError('WebCodecs unavailable');
        }),
      }),
    );

    await expect(adapter.open(new AbortController().signal)).resolves.toEqual({
      status: 'fallback',
      reason: 'capability-unavailable',
    });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('preserves malformed and integrity failures instead of converting them to fallback', async () => {
    const fixture = memorySource();
    const integrity = new EncodedSourceIntegrityError('authenticated bytes changed');
    const adapter = createLegacyBoundedFileV1SourceAdapter(
      adapterOptions(bindingFor(fixture.source), {
        createPlaybackSource: vi.fn(async () => {
          throw integrity;
        }),
      }),
    );

    await expect(adapter.open(new AbortController().signal)).rejects.toBe(integrity);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('keeps provider authentication errors typed and never invokes the playback factory', async () => {
    const authFailure = new Error('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_UNAVAILABLE');
    const provider = { open: vi.fn(async () => Promise.reject(authFailure)) };
    const scope: FilePlaybackR2RecordDeliveryScope = {
      roomEpoch: 'room-epoch-1',
      bridgeGeneration: 'bridge-generation-1',
      bindingId: 'binding-1',
      queueItemId: QUEUE_ITEM_ID,
      sourceIdentity: 'r2:source-1',
    };
    const descriptor: FilePlaybackR2RecordDescriptorRef = {
      scope,
      descriptorId: 'descriptor-1',
      descriptorVersion: 1,
    };
    const binding = createLegacyBoundedFileV1R2Binding({
      provider,
      scope,
      descriptor,
    });
    const createPlaybackSource = vi.fn();
    const signal = new AbortController().signal;
    const adapter = createLegacyBoundedFileV1SourceAdapter(
      adapterOptions(binding, { createPlaybackSource }),
    );

    await expect(adapter.open(signal)).rejects.toBe(authFailure);
    expect(provider.open).toHaveBeenCalledWith(
      expect.objectContaining({ scope, descriptor: expect.any(Object), signal }),
    );
    expect(createPlaybackSource).not.toHaveBeenCalled();
  });

  it('fails malformed destination bindings before source ownership and treats closed audio as fallback', async () => {
    const fixture = memorySource();
    const binding = bindingFor(fixture.source);
    const firstAudio = audioHarness();
    const secondAudio = audioHarness();

    expect(() =>
      createLegacyBoundedFileV1SourceAdapter(
        adapterOptions(binding, {
          audioContext: firstAudio.audioContext,
          destination: secondAudio.destination,
        }),
      ),
    ).toThrow(/do not match/i);
    expect(binding.open).not.toHaveBeenCalled();

    const closed = audioHarness('closed');
    const closedAdapter = createLegacyBoundedFileV1SourceAdapter(
      adapterOptions(binding, {
        audioContext: closed.audioContext,
        destination: closed.destination,
      }),
    );
    await expect(closedAdapter.open(new AbortController().signal)).resolves.toEqual({
      status: 'fallback',
      reason: 'audio-context-closed',
    });
    expect(binding.open).not.toHaveBeenCalled();
  });

  it('destroys a successful result whose identity disagrees with the exact binding', async () => {
    const fixture = memorySource();
    const result = fakeBoundedResult('source:other');
    const adapter = createLegacyBoundedFileV1SourceAdapter(
      adapterOptions(bindingFor(fixture.source), {
        boundedRoutePolicy: FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
        createPlaybackSource: vi.fn(async () => result as BlobFilePlaybackSourceResult),
      }),
    );

    await expect(adapter.open(new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceIntegrityError,
    );
    expect(result.source.destroy).toHaveBeenCalledOnce();
  });
});
