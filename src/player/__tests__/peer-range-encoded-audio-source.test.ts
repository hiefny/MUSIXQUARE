import { describe, expect, it, vi } from 'vitest';

import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  EncodedSourceRangeError,
} from '../sources/encoded-audio-source.ts';
import {
  PEER_RANGE_MAX_READ_BYTES,
  PeerRangeEncodedAudioSource,
  type PeerRangeReadRequest,
  type PeerRangeTransport,
} from '../sources/peer-range-encoded-audio-source.ts';
import { getFilePlaybackUniversalLifecycleSnapshotForTests as getFilePlaybackUniversalLifecycleSnapshot } from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function source(transport: PeerRangeTransport, maxReadBytes?: number) {
  return new PeerRangeEncodedAudioSource({
    size: 200_000,
    identity: 'peer:host/source:q1/session:7',
    metadata: { name: 'concert.flac', mime: 'audio/flac' },
    transport,
    maxReadBytes,
  });
}

describe('PeerRangeEncodedAudioSource', () => {
  it('issues an exact bounded read and returns an isolated exact-size buffer', async () => {
    const backing = new Uint8Array(128);
    backing.set([4, 5, 6, 7], 64);
    const read = vi.fn(async (_request: PeerRangeReadRequest) => backing.subarray(64, 68));
    const encoded = source({ read });

    const result = await encoded.readAt(8, 4, new AbortController().signal);

    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toMatchObject({
      sourceIdentity: encoded.identity,
      handleId: expect.any(String),
      offset: 8,
      length: 4,
    });
    expect(read.mock.calls[0]?.[0].requestId).toEqual(expect.any(String));
    expect(Array.from(result)).toEqual([4, 5, 6, 7]);
    expect(result.byteOffset).toBe(0);
    expect(result.buffer.byteLength).toBe(4);
    expect(encoded).toMatchObject({
      kind: 'peer-range',
      size: 200_000,
      identity: 'peer:host/source:q1/session:7',
      metadata: { name: 'concert.flac', mime: 'audio/flac' },
    });
  });

  it('rejects invalid and over-limit reads before touching the transport', async () => {
    const read = vi.fn<PeerRangeTransport['read']>();
    const encoded = source({ read }, 1_024);
    const signal = new AbortController().signal;

    await expect(encoded.readAt(-1, 1, signal)).rejects.toBeInstanceOf(EncodedSourceRangeError);
    await expect(encoded.readAt(0, 1_025, signal)).rejects.toBeInstanceOf(EncodedSourceRangeError);
    await expect(encoded.readAt(199_999, 2, signal)).rejects.toBeInstanceOf(
      EncodedSourceRangeError,
    );
    expect(read).not.toHaveBeenCalled();
    expect(
      () =>
        new PeerRangeEncodedAudioSource({
          size: 1,
          identity: 'source',
          metadata: { name: 'x.flac', mime: 'audio/flac' },
          transport: { read },
          maxReadBytes: PEER_RANGE_MAX_READ_BYTES + 1,
        }),
    ).toThrow(/maxReadBytes/);
  });

  it('rejects a short transport response instead of exposing partial media', async () => {
    const encoded = source({ read: async () => new Uint8Array([1, 2, 3]) });

    await expect(encoded.readAt(0, 4, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceIntegrityError,
    );
  });

  it('allocates a fresh request ID for every read on one handle', async () => {
    const read = vi.fn(async () => new Uint8Array([1]));
    const encoded = source({ read });

    await encoded.readAt(0, 1, new AbortController().signal);
    await encoded.readAt(1, 1, new AbortController().signal);

    expect(read.mock.calls[0]?.[0].handleId).toBe(read.mock.calls[1]?.[0].handleId);
    expect(read.mock.calls[0]?.[0].requestId).not.toBe(read.mock.calls[1]?.[0].requestId);
  });

  it('suppresses a late response after the caller aborts', async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    let transportSignal: AbortSignal | null = null;
    const encoded = source({
      read: async (request) => {
        transportSignal = request.signal;
        started.resolve();
        return pending.promise;
      },
    });
    const controller = new AbortController();
    const result = encoded.readAt(0, 4, controller.signal);

    await started.promise;
    controller.abort(new Error('seek superseded'));
    pending.resolve(new Uint8Array(4));

    await expect(result).rejects.toThrow('seek superseded');
    expect(transportSignal?.aborted).toBe(true);
  });

  it('settles immediately on abort even when the transport never settles', async () => {
    const never = new Promise<Uint8Array>(() => undefined);
    const started = deferred<void>();
    const encoded = source({
      read: async () => {
        started.resolve();
        return never;
      },
    });
    const controller = new AbortController();
    const result = encoded.readAt(0, 4, controller.signal);

    await started.promise;
    controller.abort(new Error('caller stopped waiting'));

    await expect(result).rejects.toThrow('caller stopped waiting');
  });

  it('closes once, aborts active reads, and makes late completion inert', async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    let transportSignal: AbortSignal | null = null;
    const closeHandle = vi.fn(async () => undefined);
    const encoded = source({
      read: async (request) => {
        transportSignal = request.signal;
        started.resolve();
        return pending.promise;
      },
      closeHandle,
    });
    const result = encoded.readAt(0, 4, new AbortController().signal);

    await started.promise;
    const firstClose = encoded.close();
    const secondClose = encoded.close();
    pending.resolve(new Uint8Array(4));

    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(result).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(transportSignal?.aborted).toBe(true);
    expect(closeHandle).toHaveBeenCalledOnce();
    expect(closeHandle).toHaveBeenCalledWith(expect.any(String), encoded.identity);
    await expect(encoded.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
  });

  it('claims one close barrier before a hostile transport abort listener reenters close', async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    const closeHandle = vi.fn(async () => undefined);
    let encoded!: PeerRangeEncodedAudioSource;
    let reentrantClose: Promise<void> | null = null;
    encoded = source({
      read: (request) => {
        request.signal.addEventListener(
          'abort',
          () => {
            reentrantClose = encoded.close();
          },
          { once: true },
        );
        started.resolve();
        return pending.promise;
      },
      closeHandle,
    });
    const read = encoded.readAt(0, 4, new AbortController().signal);
    await started.promise;
    const before = getFilePlaybackUniversalLifecycleSnapshot();

    const firstClose = encoded.close();
    expect(reentrantClose).toBe(firstClose);
    expect(encoded.close()).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    expect(closeHandle).toHaveBeenCalledOnce();

    pending.resolve(new Uint8Array(4));
    await expect(read).rejects.toBeInstanceOf(EncodedSourceClosedError);
    await vi.waitFor(() => {
      const after = getFilePlaybackUniversalLifecycleSnapshot();
      expect(after.kinds.encodedSources.live).toBe(before.kinds.encodedSources.live - 1);
      expect(after.kinds.encodedSources.retiring).toBe(before.kinds.encodedSources.retiring);
    });
    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.invariantFaults).toBe(before.invariantFaults);
    expect(after.kinds.encodedSources.unconfirmed).toBe(before.kinds.encodedSources.unconfirmed);
  });

  it('keeps encoded-source retirement pending until an abort-resistant transport read settles', async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    const before = getFilePlaybackUniversalLifecycleSnapshot().kinds.encodedSources;
    const encoded = source({
      read: async () => {
        started.resolve();
        return pending.promise;
      },
      closeHandle: async () => undefined,
    });
    const read = encoded.readAt(0, 4, new AbortController().signal);
    await started.promise;

    const closing = encoded.close();
    const retiring = getFilePlaybackUniversalLifecycleSnapshot().kinds.encodedSources;
    expect(retiring.live).toBe(before.live);
    expect(retiring.retiring).toBe(before.retiring + 1);
    await expect(closing).resolves.toBeUndefined();
    expect(getFilePlaybackUniversalLifecycleSnapshot().kinds.encodedSources.retiring).toBe(
      before.retiring + 1,
    );

    pending.resolve(new Uint8Array(4));
    await expect(read).rejects.toBeInstanceOf(EncodedSourceClosedError);
    await vi.waitFor(() =>
      expect(getFilePlaybackUniversalLifecycleSnapshot().kinds.encodedSources.retiring).toBe(
        before.retiring,
      ),
    );
    const retired = getFilePlaybackUniversalLifecycleSnapshot().kinds.encodedSources;
    expect(retired.live).toBe(before.live);
    expect(retired.retiring).toBe(before.retiring);
    expect(retired.unconfirmed).toBe(before.unconfirmed);
  });

  it('never dispatches a deferred read after same-tick close or caller abort', async () => {
    const readAfterClose = vi.fn(async () => new Uint8Array(4));
    const closed = source({ read: readAfterClose });
    const closedResult = closed.readAt(0, 4, new AbortController().signal);
    await closed.close();

    await expect(closedResult).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(readAfterClose).not.toHaveBeenCalled();

    const readAfterAbort = vi.fn(async () => new Uint8Array(4));
    const aborted = source({ read: readAfterAbort });
    const controller = new AbortController();
    const abortedResult = aborted.readAt(0, 4, controller.signal);
    controller.abort(new Error('cancelled before dispatch'));

    await expect(abortedResult).rejects.toThrow('cancelled before dispatch');
    expect(readAfterAbort).not.toHaveBeenCalled();
  });

  it('preserves opaque identity and scopes close to one overlapping handle', async () => {
    const closeHandle = vi.fn(async () => undefined);
    const read = vi.fn(async () => new Uint8Array([9]));
    const transport = { read, closeHandle };
    const first = source(transport);
    const second = source(transport);
    const unicodeIdentity = new PeerRangeEncodedAudioSource({
      size: 1,
      identity: 'peer:호스트 / source:α',
      metadata: { name: 'x.flac', mime: 'audio/flac' },
      transport,
    });

    expect(unicodeIdentity.identity).toBe('peer:호스트 / source:α');

    expect(
      () =>
        new PeerRangeEncodedAudioSource({
          size: 1,
          identity: ' source-with-whitespace ',
          metadata: { name: 'x.flac', mime: 'audio/flac' },
          transport,
        }),
    ).toThrow(/identity/);

    await first.readAt(0, 1, new AbortController().signal);
    await second.readAt(0, 1, new AbortController().signal);
    const firstHandle = read.mock.calls[0]?.[0].handleId;
    const secondHandle = read.mock.calls[1]?.[0].handleId;
    expect(firstHandle).not.toBe(secondHandle);

    await first.close();
    expect(closeHandle).toHaveBeenCalledWith(firstHandle, first.identity);
    expect(closeHandle).not.toHaveBeenCalledWith(secondHandle, second.identity);
    await expect(second.readAt(0, 1, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([9]),
    );
    await unicodeIdentity.close();
  });
});
