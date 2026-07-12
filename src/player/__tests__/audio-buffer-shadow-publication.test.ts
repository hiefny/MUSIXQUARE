import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  publishAudioBufferShadow,
  retireActiveManagedSourceBeforeDecode,
  withdrawAudioBufferShadow,
  type AudioBufferShadowRuntime,
} from '../audio-buffer-shadow-publication.ts';
import { FilePlaybackManager, type FilePlaybackPublication } from '../file-playback-manager.ts';
import type { FilePlaybackSource, FilePlaybackSourceSnapshot } from '../file-playback-source.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function audioFixture() {
  const createBufferSource = vi.fn();
  const createGain = vi.fn();
  const context = {
    currentTime: 0,
    sampleRate: 48_000,
    state: 'running',
    createBufferSource,
    createGain,
  } as unknown as AudioContext;
  const destination = { context } as AudioNode;
  const audioBuffer = {
    duration: 120,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 5_760_000,
  } as AudioBuffer;
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
  return { context, destination, audioBuffer, blob, createBufferSource, createGain };
}

function bindings() {
  return {
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (roomTimeMs: number) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (localPerformanceTimeMs: number) =>
      localPerformanceTimeMs / 1_000,
  };
}

function runtime(
  manager: FilePlaybackManager,
  destination: AudioNode | null,
  overrides: Partial<AudioBufferShadowRuntime> = {},
): Partial<AudioBufferShadowRuntime> {
  return {
    manager,
    getDestination: () => destination,
    bindClock: bindings,
    onInfrastructureFailure: vi.fn(),
    ...overrides,
  };
}

function snapshot(source: FilePlaybackSource): FilePlaybackSourceSnapshot {
  return {
    schemaVersion: 1,
    queueItemId: source.queueItemId,
    backend: source.backend,
    phase: 'connected',
    revision: 0,
    run: null,
    durationSeconds: 120,
    positionSeconds: 0,
    bufferedAheadSeconds: 120,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  };
}

describe('AudioBuffer shadow publication', () => {
  it('connects one silent managed shadow and publishes the exact resident buffer once', async () => {
    const fixture = audioFixture();
    const manager = new FilePlaybackManager();
    let resident: AudioBuffer | null = null;
    const release = vi.fn(() => {
      expect(manager.activeSource()).not.toBeNull();
      expect(resident).toBe(fixture.audioBuffer);
    });
    const publishResident = vi.fn((buffer: AudioBuffer) => {
      resident = buffer;
    });

    const outcome = await publishAudioBufferShadow({
      queueItemId: QUEUE_ITEM_ID,
      blob: fixture.blob,
      audioBuffer: fixture.audioBuffer,
      audioContext: fixture.context,
      releaseConstructionLease: release,
      isCurrent: () => true,
      publishResident,
      clearResidentIfOwned: (buffer) => {
        if (resident === buffer) resident = null;
      },
      runtime: runtime(manager, fixture.destination),
    });

    expect(outcome.status).toBe('managed-shadow');
    expect(manager.activeSource()).toBe(
      outcome.status === 'managed-shadow' ? outcome.source : null,
    );
    expect(manager.snapshot().active).toMatchObject({
      queueItemId: QUEUE_ITEM_ID,
      backend: 'audio-buffer',
      phase: 'connected',
    });
    expect(publishResident).toHaveBeenCalledOnce();
    expect(resident).toBe(fixture.audioBuffer);
    expect(release).toHaveBeenCalledOnce();
    // prepare/connect stores only routing metadata. Audible one-shot nodes are
    // created exclusively by a later rendezvous arm, which this stage never calls.
    expect(fixture.createBufferSource).not.toHaveBeenCalled();
    expect(fixture.createGain).not.toHaveBeenCalled();

    await manager.clear();
  });

  it('falls back to the exact legacy resident when the graph route is unavailable', async () => {
    const fixture = audioFixture();
    const manager = new FilePlaybackManager();
    const release = vi.fn();
    const publishResident = vi.fn();
    const infrastructureFailure = vi.fn();

    const outcome = await publishAudioBufferShadow({
      queueItemId: QUEUE_ITEM_ID,
      blob: fixture.blob,
      audioBuffer: fixture.audioBuffer,
      audioContext: fixture.context,
      releaseConstructionLease: release,
      isCurrent: () => true,
      publishResident,
      clearResidentIfOwned: vi.fn(),
      runtime: runtime(manager, null, { onInfrastructureFailure: infrastructureFailure }),
    });

    expect(outcome.status).toBe('legacy-fallback');
    expect(publishResident).toHaveBeenCalledExactlyOnceWith(fixture.audioBuffer);
    expect(release).toHaveBeenCalledOnce();
    expect(manager.activeSource()).toBeNull();
    expect(infrastructureFailure).toHaveBeenCalledOnce();
  });

  it('preserves legacy playback when shadow construction fails', async () => {
    const fixture = audioFixture();
    const manager = new FilePlaybackManager();
    const release = vi.fn();
    const publishResident = vi.fn();
    const constructionError = new Error('shadow-construction-failed');

    const outcome = await publishAudioBufferShadow({
      queueItemId: QUEUE_ITEM_ID,
      blob: fixture.blob,
      audioBuffer: fixture.audioBuffer,
      audioContext: fixture.context,
      releaseConstructionLease: release,
      isCurrent: () => true,
      publishResident,
      clearResidentIfOwned: vi.fn(),
      runtime: runtime(manager, fixture.destination, {
        createSource: () => {
          throw constructionError;
        },
      }),
    });

    expect(outcome).toMatchObject({
      status: 'legacy-fallback',
      infrastructureError: constructionError,
    });
    expect(publishResident).toHaveBeenCalledExactlyOnceWith(fixture.audioBuffer);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the decode lease even when exact retirement never settles', async () => {
    const fixture = audioFixture();
    const release = vi.fn();
    const publishResident = vi.fn();
    const publicationError = new Error('shadow-publication-failed');
    const retire = vi.fn(() => new Promise<void>(() => undefined));
    const manager = { retire } as unknown as FilePlaybackManager;

    const outcome = await publishAudioBufferShadow({
      queueItemId: QUEUE_ITEM_ID,
      blob: fixture.blob,
      audioBuffer: fixture.audioBuffer,
      audioContext: fixture.context,
      releaseConstructionLease: release,
      isCurrent: () => true,
      publishResident,
      clearResidentIfOwned: vi.fn(),
      runtime: runtime(manager, fixture.destination, {
        publishSource: vi.fn(async () => {
          throw publicationError;
        }),
      }),
    });

    expect(outcome).toMatchObject({
      status: 'legacy-fallback',
      infrastructureError: publicationError,
    });
    expect(retire).toHaveBeenCalledOnce();
    expect(publishResident).toHaveBeenCalledExactlyOnceWith(fixture.audioBuffer);
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not legacy-publish when authority becomes stale during manager activation', async () => {
    const fixture = audioFixture();
    const activation = deferred<FilePlaybackPublication>();
    const release = vi.fn();
    const publishResident = vi.fn();
    const retire = vi.fn(async () => undefined);
    const manager = {
      activate: vi.fn(() => activation.promise),
      retire,
    } as unknown as FilePlaybackManager;
    let current = true;

    const pending = publishAudioBufferShadow({
      queueItemId: QUEUE_ITEM_ID,
      blob: fixture.blob,
      audioBuffer: fixture.audioBuffer,
      audioContext: fixture.context,
      releaseConstructionLease: release,
      isCurrent: () => current,
      publishResident,
      clearResidentIfOwned: vi.fn(),
      runtime: runtime(manager, fixture.destination),
    });
    await vi.waitFor(() => expect(manager.activate).toHaveBeenCalledOnce());
    const exactSource = vi.mocked(manager.activate).mock.calls[0]![0];
    current = false;
    activation.resolve({ published: true, snapshot: snapshot(exactSource) });

    await expect(pending).resolves.toMatchObject({
      status: 'unpublished',
      reason: 'superseded',
    });
    expect(publishResident).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledWith(exactSource);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back only its exact buffer when fallback publication loses authority re-entrantly', async () => {
    const fixture = audioFixture();
    const release = vi.fn();
    const clearResident = vi.fn();
    let current = true;
    const publishResident = vi.fn(() => {
      current = false;
    });

    const outcome = await publishAudioBufferShadow({
      queueItemId: QUEUE_ITEM_ID,
      blob: fixture.blob,
      audioBuffer: fixture.audioBuffer,
      audioContext: fixture.context,
      releaseConstructionLease: release,
      isCurrent: () => current,
      publishResident,
      clearResidentIfOwned: clearResident,
      runtime: runtime(new FilePlaybackManager(), null),
    });

    expect(outcome).toMatchObject({ status: 'unpublished', reason: 'superseded' });
    expect(clearResident).toHaveBeenCalledExactlyOnceWith(fixture.audioBuffer);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases once and clears exact ownership when a legacy publication hook throws', async () => {
    const fixture = audioFixture();
    const release = vi.fn();
    const clearResident = vi.fn();
    const publicationError = new Error('resident-publication-failed');

    await expect(
      publishAudioBufferShadow({
        queueItemId: QUEUE_ITEM_ID,
        blob: fixture.blob,
        audioBuffer: fixture.audioBuffer,
        audioContext: fixture.context,
        releaseConstructionLease: release,
        isCurrent: () => true,
        publishResident: () => {
          throw publicationError;
        },
        clearResidentIfOwned: clearResident,
        runtime: runtime(new FilePlaybackManager(), null),
      }),
    ).rejects.toBe(publicationError);

    expect(clearResident).toHaveBeenCalledExactlyOnceWith(fixture.audioBuffer);
    expect(release).toHaveBeenCalledOnce();
  });

  it('withdraws one completed shadow by exact source and resident identity', async () => {
    const fixture = audioFixture();
    const manager = new FilePlaybackManager();
    let resident: AudioBuffer | null = null;
    const outcome = await publishAudioBufferShadow({
      queueItemId: QUEUE_ITEM_ID,
      blob: fixture.blob,
      audioBuffer: fixture.audioBuffer,
      audioContext: fixture.context,
      releaseConstructionLease: vi.fn(),
      isCurrent: () => true,
      publishResident: (buffer) => {
        resident = buffer;
      },
      clearResidentIfOwned: (buffer) => {
        if (resident === buffer) resident = null;
      },
      runtime: runtime(manager, fixture.destination),
    });

    await withdrawAudioBufferShadow({
      outcome,
      audioBuffer: fixture.audioBuffer,
      clearResidentIfOwned: (buffer) => {
        if (resident === buffer) resident = null;
      },
      runtime: { manager },
    });

    expect(manager.activeSource()).toBeNull();
    expect(resident).toBeNull();
  });
});

describe('managed source retirement before decode admission', () => {
  it('detaches only the captured object without awaiting destroy and preserves an ABA successor', async () => {
    const previous = { queueItemId: QUEUE_ITEM_ID } as FilePlaybackSource;
    const successor = { queueItemId: QUEUE_ITEM_ID } as FilePlaybackSource;
    const standby = { queueItemId: 'standby' as QueueItemId } as FilePlaybackSource;
    let active: FilePlaybackSource | null = previous;
    let current = true;
    const manager = {
      activeSource: vi.fn(() => active),
      standbySource: vi.fn(() => standby),
      retire: vi.fn((exactSource: FilePlaybackSource) => {
        if (active === exactSource) active = successor;
        // Re-entrant authority loss is observed after the synchronous detach,
        // while the platform destruction Promise never settles.
        current = false;
        return new Promise<void>(() => undefined);
      }),
    } as unknown as FilePlaybackManager;

    await expect(
      retireActiveManagedSourceBeforeDecode({
        isCurrent: () => current,
        runtime: { manager, onInfrastructureFailure: vi.fn() },
      }),
    ).resolves.toBe(false);

    expect(active).toBe(successor);
    expect(manager.standbySource()).toBe(standby);
    expect(manager.retire).toHaveBeenCalledExactlyOnceWith(previous);
  });

  it('observes a late retirement rejection without blocking admission', async () => {
    const previous = { queueItemId: QUEUE_ITEM_ID } as FilePlaybackSource;
    const cleanupError = new Error('late-native-cleanup-failure');
    const onInfrastructureFailure = vi.fn();
    const manager = {
      activeSource: vi.fn(() => previous),
      retire: vi.fn(() => Promise.reject(cleanupError)),
    } as unknown as FilePlaybackManager;

    await expect(
      retireActiveManagedSourceBeforeDecode({
        isCurrent: () => true,
        runtime: { manager, onInfrastructureFailure },
      }),
    ).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(onInfrastructureFailure).toHaveBeenCalledExactlyOnceWith(cleanupError),
    );
  });
});
