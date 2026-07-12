import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { createEncodedFilePlaybackSource } from '../file-playback-source-factory.ts';
import { BlobEncodedAudioAsset } from '../sources/blob-encoded-audio-asset.ts';
import {
  ENCODED_AUDIO_ASSET_MAX_LEASES,
  SharedEncodedAudioAsset,
} from '../sources/encoded-audio-asset.ts';
import {
  EncodedSourceClosedError,
  type EncodedAudioSource,
} from '../sources/encoded-audio-source.ts';
import { PeerRangeEncodedAudioAsset } from '../sources/peer-range-encoded-audio-asset.ts';
import type {
  PeerRangeReadRequest,
  PeerRangeTransport,
} from '../sources/peer-range-encoded-audio-source.ts';
import {
  FramedPeerRangeClientTransport,
  PeerRangeHostResponder,
  bindPeerRangeTrustedConnection,
} from '../sources/peer-range-transport.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  const packed = (BigInt(sampleRate) << 44n) | (1n << 41n) | (23n << 36n) | BigInt(totalSamples);
  info.set(uint64(packed), 10);
  return new Blob(
    [
      new Uint8Array([0x66, 0x4c, 0x61, 0x43]),
      new Uint8Array([0x80, 0x00, 0x00, 0x22]),
      info,
      new Uint8Array([0xff, 0xf8]),
    ],
    { type: 'audio/flac' },
  );
}

function ownedSource(
  readAt: EncodedAudioSource['readAt'],
  close: EncodedAudioSource['close'] = async () => undefined,
): EncodedAudioSource {
  return {
    kind: 'blob',
    size: 16,
    identity: 'asset:owned-source',
    metadata: { name: 'asset.flac', mime: 'audio/flac' },
    readAt,
    close,
  };
}

describe('SharedEncodedAudioAsset', () => {
  it('keeps root ownership across logical refcount churn and caps concurrency at two', async () => {
    const rootClose = vi.fn(async () => undefined);
    const asset = new SharedEncodedAudioAsset(
      ownedSource(async (_offset, length) => new Uint8Array(length), rootClose),
    );

    const first = asset.acquire();
    const second = asset.acquire();
    expect(asset.activeLeaseCount).toBe(ENCODED_AUDIO_ASSET_MAX_LEASES);
    expect(() => asset.acquire()).toThrow(/at most 2 concurrent leases/);

    const firstClose = first.close();
    expect(first.close()).toBe(firstClose);
    await firstClose;
    expect(asset.activeLeaseCount).toBe(1);
    expect(rootClose).not.toHaveBeenCalled();

    const replacement = asset.acquire();
    expect(asset.activeLeaseCount).toBe(2);
    await Promise.all([second.close(), replacement.close()]);
    expect(asset.activeLeaseCount).toBe(0);
    expect(rootClose).not.toHaveBeenCalled();

    const finalClose = asset.close();
    expect(asset.close()).toBe(finalClose);
    await finalClose;
    expect(rootClose).toHaveBeenCalledOnce();
    expect(() => asset.acquire()).toThrow(EncodedSourceClosedError);
  });

  it('publishes the terminal promise before a physical close can re-enter', async () => {
    let asset!: SharedEncodedAudioAsset;
    let reentered: Promise<void> | null = null;
    const rootClose = vi.fn(() => {
      reentered = asset.close();
      return Promise.resolve();
    });
    asset = new SharedEncodedAudioAsset(
      ownedSource(async (_offset, length) => new Uint8Array(length), rootClose),
    );

    const closing = asset.close();
    expect(reentered).toBe(closing);
    expect(asset.close()).toBe(closing);
    await closing;
    expect(rootClose).toHaveBeenCalledOnce();
  });

  it('aborts only the closing lease promptly even if its physical read never settles', async () => {
    const firstStarted = deferred<void>();
    const never = new Promise<Uint8Array>(() => undefined);
    const rootSignals: AbortSignal[] = [];
    const asset = new SharedEncodedAudioAsset(
      ownedSource(async (offset, length, signal) => {
        rootSignals.push(signal);
        if (offset === 0) {
          firstStarted.resolve();
          return never;
        }
        return new Uint8Array(length).fill(7);
      }),
    );
    const first = asset.acquire();
    const second = asset.acquire();
    const pending = first.readAt(0, 4, new AbortController().signal);

    await firstStarted.promise;
    await first.close();
    await expect(pending).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(rootSignals[0]?.aborted).toBe(true);
    await expect(second.readAt(4, 2, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([7, 7]),
    );
    expect(asset.activeLeaseCount).toBe(1);

    await asset.close();
    await expect(second.readAt(4, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
    expect(asset.activeLeaseCount).toBe(0);
  });

  it('settles a lease read promptly on caller abort without closing its sibling', async () => {
    const started = deferred<void>();
    const never = new Promise<Uint8Array>(() => undefined);
    const asset = new SharedEncodedAudioAsset(
      ownedSource(async (offset, length) => {
        if (offset === 0) {
          started.resolve();
          return never;
        }
        return new Uint8Array(length).fill(3);
      }),
    );
    const first = asset.acquire();
    const second = asset.acquire();
    const controller = new AbortController();
    const pending = first.readAt(0, 1, controller.signal);

    await started.promise;
    controller.abort(new Error('reader superseded'));
    await expect(pending).rejects.toThrow('reader superseded');
    await expect(second.readAt(1, 1, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([3]),
    );

    await asset.close();
  });

  it('force-closes both leases and the owned root exactly once at final asset close', async () => {
    let startedCount = 0;
    const bothStarted = deferred<void>();
    const never = new Promise<Uint8Array>(() => undefined);
    const rootClose = vi.fn(async () => undefined);
    const asset = new SharedEncodedAudioAsset(
      ownedSource(async () => {
        startedCount += 1;
        if (startedCount === 2) bothStarted.resolve();
        return never;
      }, rootClose),
    );
    const first = asset.acquire();
    const second = asset.acquire();
    const firstRead = first.readAt(0, 1, new AbortController().signal);
    const secondRead = second.readAt(1, 1, new AbortController().signal);

    await bothStarted.promise;
    const close = asset.close();
    expect(asset.close()).toBe(close);
    await close;

    await expect(firstRead).rejects.toBeInstanceOf(EncodedSourceClosedError);
    await expect(secondRead).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(asset.activeLeaseCount).toBe(0);
    expect(rootClose).toHaveBeenCalledOnce();
    await Promise.all([first.close(), second.close()]);
    expect(rootClose).toHaveBeenCalledOnce();
  });
});

describe('BlobEncodedAudioAsset', () => {
  it('retains one exact Blob by reference and creates two independent reader leases', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])], { type: 'audio/flac' });
    const slice = vi.spyOn(blob, 'slice');
    const asset = new BlobEncodedAudioAsset(blob, {
      identity: 'blob:queue-q1',
      metadata: { name: 'concert.flac' },
    });
    const first = asset.acquire();
    const second = asset.acquire();

    expect(slice).not.toHaveBeenCalled();
    expect(first.identity).toBe('blob:queue-q1');
    expect(second.identity).toBe(first.identity);
    await expect(first.readAt(1, 2, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    expect(slice).toHaveBeenCalledOnce();
    expect(slice).toHaveBeenLastCalledWith(1, 3);

    await first.close();
    await expect(second.readAt(4, 2, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([4, 5]),
    );
    await asset.close();
    await expect(second.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
  });

  it('backs two distinct streaming source instances without duplicating the Blob asset', async () => {
    const asset = new BlobEncodedAudioAsset(nativeFlacBlob(), {
      identity: 'blob:shared-streaming-asset',
      metadata: { name: 'concert.flac', mime: 'audio/flac' },
    });
    const queueItemId = '00000000-0000-4000-8000-000000000001' as QueueItemId;
    const sourceOptions = (encodedSource: EncodedAudioSource) => ({
      encodedSource,
      queueItemId,
      audioContext: { sampleRate: 48_000, currentTime: 0 } as AudioContext,
      nowRoomTimeMs: () => 1_000,
      roomTimeMsToContextTime: (roomTimeMs: number) => roomTimeMs / 1_000,
      localPerformanceMsToContextTime: (localTimeMs: number) => localTimeMs / 1_000,
      signal: new AbortController().signal,
    });

    const first = await createEncodedFilePlaybackSource(sourceOptions(asset.acquire()));
    const second = await createEncodedFilePlaybackSource(sourceOptions(asset.acquire()));

    expect(first.backend).toBe('streaming-flac');
    expect(second.backend).toBe('streaming-flac');
    expect(first.source).not.toBe(second.source);
    expect(first.sourceIdentity).toBe('blob:shared-streaming-asset');
    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect(asset.activeLeaseCount).toBe(2);
    expect(() => asset.acquire()).toThrow(/at most 2 concurrent leases/);

    await Promise.all([first.source.destroy(), second.source.destroy()]);
    expect(asset.activeLeaseCount).toBe(0);
    const later = asset.acquire();
    await later.close();
    await asset.close();
  });
});

describe('PeerRangeEncodedAudioAsset', () => {
  const sourceIdentity = 'peer:host/source:q1/session:7';
  const offeredHandleId = 'offer-handle:q1:prepare-7';

  function asset(transport: PeerRangeTransport): PeerRangeEncodedAudioAsset {
    return new PeerRangeEncodedAudioAsset({
      size: 4_096,
      identity: sourceIdentity,
      handleId: offeredHandleId,
      metadata: { name: 'concert.flac', mime: 'audio/flac' },
      transport,
    });
  }

  it('requires one exact bounded offer handle', () => {
    const read = vi.fn<PeerRangeTransport['read']>();
    expect(
      () =>
        new PeerRangeEncodedAudioAsset({
          size: 1,
          identity: sourceIdentity,
          handleId: ' invalid-offer-handle ',
          metadata: { name: 'concert.flac', mime: 'audio/flac' },
          transport: { read },
        }),
    ).toThrow(/handleId/);
    expect(read).not.toHaveBeenCalled();
  });

  it('shares the exact offered handle while lease close aborts only its own reader', async () => {
    const firstStarted = deferred<void>();
    const never = new Promise<Uint8Array>(() => undefined);
    const requests: PeerRangeReadRequest[] = [];
    const closeHandle = vi.fn(async () => undefined);
    const encodedAsset = asset({
      read: async (request) => {
        requests.push(request);
        if (request.offset === 0) {
          firstStarted.resolve();
          return never;
        }
        return new Uint8Array(request.length).fill(9);
      },
      closeHandle,
    });
    const first = encodedAsset.acquire();
    const second = encodedAsset.acquire();
    const firstRead = first.readAt(0, 4, new AbortController().signal);

    await firstStarted.promise;
    await first.close();
    await expect(firstRead).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(closeHandle).not.toHaveBeenCalled();

    await expect(second.readAt(4, 2, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([9, 9]),
    );
    expect(requests.map((request) => request.handleId)).toEqual([offeredHandleId, offeredHandleId]);
    expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);

    const finalClose = encodedAsset.close();
    expect(encodedAsset.close()).toBe(finalClose);
    await finalClose;
    expect(closeHandle).toHaveBeenCalledOnce();
    expect(closeHandle).toHaveBeenCalledWith(offeredHandleId, sourceIdentity);
    await second.close();
    expect(closeHandle).toHaveBeenCalledOnce();
  });

  it('does not consume a revoked-handle tombstone per sequential candidate lease', async () => {
    const token = Object.freeze({ connection: 'asset-cap-test' });
    const connection = bindPeerRangeTrustedConnection(token, 'connection:asset-cap-test');
    const onFatalConnection = vi.fn();
    let client!: FramedPeerRangeClientTransport;
    const host = new PeerRangeHostResponder({
      connection,
      sources: { resolve: () => new Blob([new Uint8Array(4_096)]) },
      onFatalConnection,
      canSend: () => true,
      sendBulk: (frame) => client.acceptBulk(token, frame),
      maxSourceLeases: 1,
      maxRevokedHandleClaims: 1,
    });
    client = new FramedPeerRangeClientTransport({
      connection,
      onFatalConnection,
      canSend: () => true,
      sendControl: (frame) => {
        host.acceptControl(token, frame);
      },
    });
    const encodedAsset = asset(client);

    const initial = encodedAsset.acquire();
    await initial.readAt(0, 1, new AbortController().signal);
    await initial.close();
    expect(host.sourceLeaseCount).toBe(1);

    // Even with a host tombstone cap of one, lease churn beyond the production
    // default of 512 must retain the one handle and emit no per-lease close.
    for (let index = 0; index < 600; index += 1) {
      const lease = encodedAsset.acquire();
      await lease.close();
    }

    expect(encodedAsset.activeLeaseCount).toBe(0);
    expect(host.sourceLeaseCount).toBe(1);
    expect(onFatalConnection).not.toHaveBeenCalled();

    await encodedAsset.close();
    await vi.waitFor(() => expect(host.sourceLeaseCount).toBe(0));
    expect(onFatalConnection).not.toHaveBeenCalled();
  });
});
