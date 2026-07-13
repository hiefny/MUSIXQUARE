import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import type {
  FilePlaybackActivationAuthority,
  FilePlaybackManager,
  FilePlaybackPublication,
} from '../file-playback-manager.ts';
import {
  publishManagedFilePlaybackSource,
  type ManagedFilePlaybackPublicationOptions,
} from '../file-playback-publication.ts';
import type {
  AudioBufferFilePlaybackSourceResult,
  StreamingFlacFilePlaybackSourceResult,
} from '../file-playback-source-factory.ts';
import type { FilePlaybackSource, FilePlaybackSourceSnapshot } from '../file-playback-source.ts';
import type { FlacMetadata } from '../flac/metadata.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const destination = {} as AudioNode;

function snapshot(
  backend: 'audio-buffer' | 'bounded-stream',
  queueItemId = QUEUE_ITEM_ID,
): FilePlaybackSourceSnapshot {
  return {
    schemaVersion: 1,
    queueItemId,
    backend,
    phase: 'connected',
    revision: 0,
    run: null,
    durationSeconds: 10,
    positionSeconds: 0,
    bufferedAheadSeconds: 4,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  };
}

function source(
  backend: 'audio-buffer' | 'bounded-stream',
  queueItemId = QUEUE_ITEM_ID,
): FilePlaybackSource {
  return {
    queueItemId,
    backend,
    prepare: vi.fn(),
    connect: vi.fn(),
    arm: vi.fn(),
    finalize: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    positionAt: vi.fn(),
    getSnapshot: vi.fn(() => snapshot(backend, queueItemId)),
    destroy: vi.fn(),
  } as unknown as FilePlaybackSource;
}

function audioBufferResult(
  overrides: Partial<AudioBufferFilePlaybackSourceResult> = {},
): AudioBufferFilePlaybackSourceResult {
  const playbackSource = source('audio-buffer') as AudioBufferFilePlaybackSourceResult['source'];
  return {
    backend: 'audio-buffer',
    source: playbackSource,
    sourceIdentity: 'blob:ordinary:1',
    audioBuffer: { duration: 10 } as AudioBuffer,
    releaseConstructionLease: vi.fn(),
    flacMetadata: null,
    ...overrides,
  };
}

function streamingResult(
  overrides: Partial<StreamingFlacFilePlaybackSourceResult> = {},
): StreamingFlacFilePlaybackSourceResult {
  const playbackSource = source(
    'bounded-stream',
  ) as StreamingFlacFilePlaybackSourceResult['source'];
  return {
    backend: 'bounded-stream',
    source: playbackSource,
    sourceIdentity: 'blob:flac:1',
    releaseConstructionLease: vi.fn(),
    flacMetadata: {} as FlacMetadata,
    ...overrides,
  };
}

function manager(
  activate: (
    source: FilePlaybackSource,
    destination: AudioNode,
    authority?: FilePlaybackActivationAuthority,
  ) => Promise<FilePlaybackPublication>,
  retire: (source: FilePlaybackSource) => Promise<void> = async () => undefined,
): FilePlaybackManager {
  return {
    activate: vi.fn(activate),
    retire: vi.fn(retire),
  } as unknown as FilePlaybackManager;
}

function options(
  result: AudioBufferFilePlaybackSourceResult | StreamingFlacFilePlaybackSourceResult,
  playbackManager: FilePlaybackManager,
  overrides: Partial<ManagedFilePlaybackPublicationOptions> = {},
): ManagedFilePlaybackPublicationOptions {
  return {
    result,
    manager: playbackManager,
    destination,
    isCurrent: () => true,
    publishResident: vi.fn(),
    clearResidentIfOwned: vi.fn(),
    ...overrides,
  };
}

function published(
  result: AudioBufferFilePlaybackSourceResult | StreamingFlacFilePlaybackSourceResult,
) {
  return {
    published: true,
    snapshot: snapshot(result.backend),
  } as const satisfies FilePlaybackPublication;
}

describe('publishManagedFilePlaybackSource', () => {
  it('keeps the ordinary construction lease through activation and exact resident publication', async () => {
    const order: string[] = [];
    const result = audioBufferResult({
      releaseConstructionLease: vi.fn(() => order.push('release')),
    });
    const playbackManager = manager(async (exactSource, exactDestination, authority) => {
      expect(exactSource).toBe(result.source);
      expect(exactDestination).toBe(destination);
      expect(authority?.()).toBe(true);
      order.push('activate');
      return published(result);
    });
    const publishResident = vi.fn((exactBuffer: AudioBuffer) => {
      expect(exactBuffer).toBe(result.audioBuffer);
      order.push('resident');
    });

    await expect(
      publishManagedFilePlaybackSource(
        options(result, playbackManager, {
          publishResident,
        }),
      ),
    ).resolves.toMatchObject({
      published: true,
      backend: 'audio-buffer',
      sourceIdentity: result.sourceIdentity,
    });

    expect(order).toEqual(['activate', 'resident', 'release']);
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
    expect(playbackManager.retire).not.toHaveBeenCalled();
  });

  it('publishes streaming FLAC without touching the legacy resident buffer', async () => {
    const result = streamingResult();
    const playbackManager = manager(async () => published(result));
    const publishResident = vi.fn();
    const clearResidentIfOwned = vi.fn();

    await expect(
      publishManagedFilePlaybackSource(
        options(result, playbackManager, { publishResident, clearResidentIfOwned }),
      ),
    ).resolves.toMatchObject({ published: true, backend: 'bounded-stream' });

    expect(publishResident).not.toHaveBeenCalled();
    expect(clearResidentIfOwned).not.toHaveBeenCalled();
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('retires and releases a stale result before activation', async () => {
    const result = audioBufferResult();
    const playbackManager = manager(async () => published(result));
    const clearResidentIfOwned = vi.fn();

    await expect(
      publishManagedFilePlaybackSource(
        options(result, playbackManager, {
          isCurrent: () => false,
          clearResidentIfOwned,
        }),
      ),
    ).resolves.toMatchObject({ published: false, reason: 'superseded' });

    expect(playbackManager.activate).not.toHaveBeenCalled();
    expect(playbackManager.retire).toHaveBeenCalledOnce();
    expect(playbackManager.retire).toHaveBeenCalledWith(result.source);
    expect(clearResidentIfOwned).not.toHaveBeenCalled();
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('withdraws a manager publication that becomes stale while activation is pending', async () => {
    const gate = deferred<FilePlaybackPublication>();
    const result = audioBufferResult();
    const playbackManager = manager(async () => gate.promise);
    let current = true;
    const publishResident = vi.fn();
    const pending = publishManagedFilePlaybackSource(
      options(result, playbackManager, {
        isCurrent: () => current,
        publishResident,
      }),
    );

    current = false;
    gate.resolve(published(result));

    await expect(pending).resolves.toMatchObject({ published: false, reason: 'superseded' });
    expect(publishResident).not.toHaveBeenCalled();
    expect(playbackManager.retire).toHaveBeenCalledOnce();
    expect(playbackManager.retire).toHaveBeenCalledWith(result.source);
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('cancels a pending activation on abort without waiting for its late completion', async () => {
    const gate = deferred<FilePlaybackPublication>();
    const result = streamingResult();
    const playbackManager = manager(async () => gate.promise);
    const abortController = new AbortController();
    const pending = publishManagedFilePlaybackSource(
      options(result, playbackManager, { signal: abortController.signal }),
    );

    abortController.abort();
    await expect(pending).resolves.toMatchObject({ published: false, reason: 'aborted' });
    expect(playbackManager.retire).toHaveBeenCalledOnce();
    expect(playbackManager.retire).toHaveBeenCalledWith(result.source);
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();

    gate.resolve(published(result));
  });

  it('rechecks abort after a re-entrant authority callback before resident publication', async () => {
    const result = audioBufferResult();
    const playbackManager = manager(async () => published(result));
    const abortController = new AbortController();
    const publishResident = vi.fn();
    let authorityChecks = 0;

    await expect(
      publishManagedFilePlaybackSource(
        options(result, playbackManager, {
          signal: abortController.signal,
          isCurrent: () => {
            authorityChecks += 1;
            if (authorityChecks === 2) abortController.abort();
            return true;
          },
          publishResident,
        }),
      ),
    ).resolves.toMatchObject({ published: false, reason: 'aborted' });

    expect(publishResident).not.toHaveBeenCalled();
    expect(playbackManager.retire).toHaveBeenCalledWith(result.source);
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('settles abort and releases resident ownership when exact retirement never settles', async () => {
    const result = audioBufferResult();
    const abortController = new AbortController();
    const playbackManager = manager(
      async () => published(result),
      () => new Promise<void>(() => undefined),
    );
    let residentBuffer: AudioBuffer | null = null;

    await expect(
      publishManagedFilePlaybackSource(
        options(result, playbackManager, {
          signal: abortController.signal,
          publishResident: (exactBuffer) => {
            residentBuffer = exactBuffer;
            abortController.abort();
          },
          clearResidentIfOwned: (exactBuffer) => {
            if (residentBuffer === exactBuffer) residentBuffer = null;
          },
        }),
      ),
    ).resolves.toMatchObject({ published: false, reason: 'aborted' });

    expect(playbackManager.retire).toHaveBeenCalledOnce();
    expect(playbackManager.retire).toHaveBeenCalledWith(result.source);
    expect(residentBuffer).toBeNull();
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('preserves a same-ID successor when a stale publication rolls back', async () => {
    const oldResult = audioBufferResult();
    const successorSource = source('audio-buffer', oldResult.source.queueItemId);
    const successorBuffer = { duration: 20 } as AudioBuffer;
    let activeSource: FilePlaybackSource | null = oldResult.source;
    let residentBuffer: AudioBuffer | null = null;
    const playbackManager = manager(
      async () => published(oldResult),
      async (exactSource) => {
        if (activeSource === exactSource) activeSource = null;
      },
    );
    let current = true;
    const clearResidentIfOwned = vi.fn((exactBuffer: AudioBuffer) => {
      if (residentBuffer === exactBuffer) residentBuffer = null;
    });
    const pending = publishManagedFilePlaybackSource(
      options(oldResult, playbackManager, {
        isCurrent: () => current,
        publishResident: (exactBuffer) => {
          residentBuffer = exactBuffer;
          // A re-entrant authoritative publication reuses the queue item ID,
          // but owns different native objects.
          activeSource = successorSource;
          residentBuffer = successorBuffer;
          current = false;
        },
        clearResidentIfOwned,
      }),
    );

    await expect(pending).resolves.toMatchObject({ published: false, reason: 'superseded' });
    expect(playbackManager.retire).toHaveBeenCalledWith(oldResult.source);
    expect(clearResidentIfOwned).toHaveBeenCalledWith(oldResult.audioBuffer);
    expect(activeSource).toBe(successorSource);
    expect(residentBuffer).toBe(successorBuffer);
    expect(oldResult.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('rolls back a partially applied resident hook and preserves its error', async () => {
    const result = audioBufferResult();
    const playbackManager = manager(async () => published(result));
    const residentError = new Error('resident publication failed');
    let residentBuffer: AudioBuffer | null = null;
    const clearResidentIfOwned = vi.fn((exactBuffer: AudioBuffer) => {
      if (residentBuffer === exactBuffer) residentBuffer = null;
    });

    await expect(
      publishManagedFilePlaybackSource(
        options(result, playbackManager, {
          publishResident: (exactBuffer) => {
            residentBuffer = exactBuffer;
            throw residentError;
          },
          clearResidentIfOwned,
        }),
      ),
    ).rejects.toBe(residentError);

    expect(playbackManager.retire).toHaveBeenCalledOnce();
    expect(playbackManager.retire).toHaveBeenCalledWith(result.source);
    expect(clearResidentIfOwned).toHaveBeenCalledOnce();
    expect(clearResidentIfOwned).toHaveBeenCalledWith(result.audioBuffer);
    expect(residentBuffer).toBeNull();
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('preserves activation errors while running every owned cleanup exactly once', async () => {
    const result = audioBufferResult({
      releaseConstructionLease: vi.fn(() => {
        throw new Error('release cleanup failed');
      }),
    });
    const activationError = new Error('activation failed');
    const playbackManager = manager(async () => {
      throw activationError;
    });

    await expect(publishManagedFilePlaybackSource(options(result, playbackManager))).rejects.toBe(
      activationError,
    );

    expect(playbackManager.retire).toHaveBeenCalledOnce();
    expect(playbackManager.retire).toHaveBeenCalledWith(result.source);
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('preserves a literal undefined activation rejection over cleanup errors', async () => {
    const result = audioBufferResult({
      releaseConstructionLease: vi.fn(() => {
        throw new Error('must not mask the activation rejection');
      }),
    });
    const playbackManager = manager(() => Promise.reject(undefined));

    await expect(
      publishManagedFilePlaybackSource(options(result, playbackManager)),
    ).rejects.toBeUndefined();
    expect(playbackManager.retire).toHaveBeenCalledOnce();
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('maps a manager supersession to a typed result and releases once', async () => {
    const result = streamingResult();
    const playbackManager = manager(async () => ({
      published: false,
      reason: 'duplicates-active',
      snapshot: snapshot('bounded-stream'),
    }));

    await expect(
      publishManagedFilePlaybackSource(options(result, playbackManager)),
    ).resolves.toEqual({
      published: false,
      backend: 'bounded-stream',
      sourceIdentity: result.sourceIdentity,
      reason: 'duplicates-active',
    });
    expect(playbackManager.retire).toHaveBeenCalledOnce();
    expect(result.releaseConstructionLease).toHaveBeenCalledOnce();
  });
});
