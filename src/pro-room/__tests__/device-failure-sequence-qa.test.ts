/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  getCurrentAudioBuffer,
  isCurrentLoadEpoch,
  markTrackFailed,
  setCurrentAudioBuffer,
} from '../../player/_state.ts';
import { initPlaylist } from '../../player/playlist.ts';
import { applyPlaylistSnapshot } from '../../player/queue-model.ts';
import { transition } from '../../player/lifecycle.ts';
import * as transport from '../../player/transport.ts';
import type { PlaylistItem, QueueItemId, RoomContext } from '../../types/index.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomSnapshot } from '../contracts.ts';
import {
  captureProRoomMediaHookSession,
  invalidateProRoomMediaHookSession,
  registerProRoomMediaHooks,
  renewProRoomMediaHookSession,
} from '../media-hooks.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import { resolveProRoomRemovalTransition } from '../playlist-transition.ts';
import * as proRoomClock from '../network-bridge.ts';

// Keep controller, authority fencing, playlist preparation and invalidation real.
// The decode seam controls per-device outcomes without requiring a browser codec.
const decoder = vi.hoisted(() => ({
  load: vi.fn<
    (file: File, queueItemId: QueueItemId, sessionId: number, epoch?: number) => Promise<boolean>
  >(),
}));
vi.mock('../../player/decode.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../player/decode.ts')>()),
  loadAndBroadcastFile: decoder.load,
}));
vi.mock('../network-bridge.ts', () => ({
  getProRoomServerNow: () => Date.now(),
  isProRoomServerClockCalibrated: () => true,
  waitForFreshProRoomServerClockCalibration: vi.fn().mockResolvedValue(true),
}));

const ROOM = '000001';
const FAILED = '41000000-0000-4000-8000-000000000001' as QueueItemId;
const HEALTHY = '41000000-0000-4000-8000-000000000002' as QueueItemId;
const READDED = '41000000-0000-4000-8000-000000000003' as QueueItemId;
const controllers: ProRoomPlaybackController[] = [];
let items: PlaylistItem[];

function enterRoom(epoch = 3, capabilities: RoomContext['capabilities'] = [], roomId = ROOM): void {
  setState('room.context', {
    kind: 'pro',
    roomId,
    epoch,
    role: 'member',
    coordinatorId: null,
    snapshotRevision: 1,
    capabilities,
  });
}

function checkpoint(
  queueItemId = FAILED,
  revision = 10,
  state: ProRoomPlaybackCheckpoint['state'] = 'playing',
): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: getState('room.context').epoch,
    revision,
    state,
    queueItemId,
    positionSeconds: revision * 2,
    updatedAtMs: Date.now(),
    youtubeVideoId: null,
    youtubeSubIndex: null,
  };
}

function snapshot(playback: ProRoomPlaybackCheckpoint): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: getState('room.context').roomId ?? ROOM,
    status: 'active',
    runtime: 'awake',
    revision: playback.revision,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: getState('playlist.items').map((item, index) => ({
      queueItemId: item.queueItemId,
      name: item.name,
      source: {
        kind: 'pro-r2',
        assetId: `asset_${String(index).repeat(22)}`,
        version: 1,
        byteLength: 4,
        mime: 'audio/flac',
      },
    })),
    currentQueueItemId: playback.queueItemId,
    playback,
    presence: {
      coordinatorEpoch: playback.coordinatorEpoch,
      revision: 1,
      coordinatorParticipantId: null,
      participants: [],
    },
    quota: { limitBytes: 1000, perAssetLimitBytes: 1000, usedBytes: 8, reservedBytes: 0 },
    viewer: null,
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [],
  };
}

function publishResident(file: File, queueItemId: QueueItemId, sessionId = 5): void {
  setState('playlist.currentQueueItemId', queueItemId);
  setCurrentAudioBuffer({ duration: 180 } as AudioBuffer);
  setState('files.current', {
    queueItemId,
    indexHint: 0,
    name: file.name,
    sessionId,
    blob: file,
    mime: file.type,
    size: file.size,
  });
}

function harness(initial = checkpoint()) {
  let canonical = snapshot(initial);
  const applied = vi.fn();
  bus.on('sync:diagnostic-pro-checkpoint', applied);
  const ports = {
    isActive: () => true,
    getCanonicalSnapshot: () => canonical,
    getPlaylistSnapshot: () => canonical,
    capturePlaylistLease: () => ({ generation: 1, roomCode: canonical.roomCode }),
    isPlaylistLeaseCurrent: () => true,
    getRoomAbortSignal: () => undefined,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: vi.fn().mockResolvedValue('waiting'),
    executePlaybackCommand: vi.fn(),
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  };
  initPlaylist();
  const controller = new ProRoomPlaybackController(ports);
  controller.startLifecycle();
  controllers.push(controller);
  return {
    controller,
    ports,
    applied,
    setCanonical(value: ProRoomPlaybackCheckpoint) {
      canonical = snapshot(value);
    },
    prepare(value: ProRoomPlaybackCheckpoint, id = `sequence_${value.revision}`) {
      controller.acceptPrepare({
        type: 'pro-playback-prepare',
        transitionId: id,
        serverTimeMs: Date.now(),
        deadlineAtMs: Date.now() + 3000,
        basePlaybackRevision: value.revision - 1,
        target: value,
      });
      return id;
    },
    commit(value: ProRoomPlaybackCheckpoint, id: string | null = null, delayMs = 0) {
      canonical = snapshot(value);
      controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: id,
        serverTimeMs: Date.now(),
        executeAtMs: Date.now() + delayMs,
        playback: value,
      });
    },
  };
}

beforeEach(() => {
  resetProPlaybackAuthorityHooks();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  enterRoom();
  // Same bytes/name are intentional: eligibility belongs to the occurrence.
  const file = new File(['same'], 'same.flac', { type: 'audio/flac' });
  items = [FAILED, HEALTHY].map((queueItemId) => ({
    queueItemId,
    type: 'file',
    name: file.name,
    file,
    videoId: null,
    playlistId: null,
  }));
  setState('playlist.items', items);
  registerProRoomMediaHooks({
    addFiles: () => false,
    addYouTube: () => false,
    updateTrackMetadata: () => false,
    removeTracks: () => false,
    reorderTrack: () => false,
    resolveFile: () => null,
    handlesPersistentFile: () => true,
  });
  decoder.load.mockReset();
  decoder.load.mockImplementation(async (blob, queueItemId, sessionId) => {
    if (queueItemId === FAILED) {
      markTrackFailed(`queue:${queueItemId}`);
      transition({ type: 'DECODE_ERROR' });
      return false;
    }
    publishResident(blob, queueItemId, sessionId);
    return true;
  });
  vi.spyOn(transport, 'applyProPlaybackFileCommit').mockImplementation(async (request) => {
    if (getState('files.current')?.queueItemId !== request.queueItemId) return false;
    setState('playback.activity', request.state === 'playing' ? 'playing' : 'paused');
    return true;
  });
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stopLifecycle();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
  registerProRoomMediaHooks(null);
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('device failure across real PRO controller/playlist sequences', () => {
  it('retains failure across heartbeat, pause/seek, reorder, role promotion and reconnect', async () => {
    const h = harness();
    await expect(h.controller.requestReconciliation()).resolves.toBe(false);
    expect(decoder.load).toHaveBeenCalledTimes(1);
    for (const operation of ['heartbeat', 'pause', 'seek', 'reorder', 'promote', 'reconnect']) {
      if (operation === 'reorder') setState('playlist.items', [...items].reverse());
      if (operation === 'promote') enterRoom(3, ['playback.control', 'queue.mutate']);
      if (operation === 'reconnect') h.controller.beginControlChannelRecovery();
      const revision =
        operation === 'heartbeat'
          ? 10
          : 11 + ['pause', 'seek', 'reorder', 'promote', 'reconnect'].indexOf(operation);
      h.setCanonical(checkpoint(FAILED, revision, operation === 'pause' ? 'paused' : 'playing'));
      await expect(h.controller.requestReconciliation()).resolves.toBe(false);
      expect(decoder.load).toHaveBeenCalledTimes(1);
    }
    expect(h.applied).not.toHaveBeenCalled();
    expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    h.setCanonical(checkpoint(HEALTHY, 20));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    expect(decoder.load).toHaveBeenCalledTimes(2);
    expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
    expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${FAILED}`]));
  });

  it('accepts readded identical bytes under a new queue identity', async () => {
    const h = harness();
    await expect(h.controller.requestReconciliation()).resolves.toBe(false);
    const replacement = { ...items[0]!, queueItemId: READDED };
    setState('playlist.items', [items[1]!, replacement]);
    h.setCanonical(checkpoint(READDED, 11));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    expect(decoder.load).toHaveBeenCalledTimes(2);
    expect(decoder.load.mock.calls[1]?.[0]).toBe(items[0]!.file);
    expect(getState('files.current')?.queueItemId).toBe(READDED);
  });

  it('publishes the failed title when canonical projection selects it from an idle renderer', async () => {
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    const idle = { ...checkpoint(HEALTHY, 11, 'idle'), queueItemId: null };
    h.commit(idle);
    await vi.waitFor(() => expect(h.applied).toHaveBeenCalledTimes(2));
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getCurrentAudioBuffer()).toBeNull();

    // Runtime applies the queue projection before restoring its checkpoint.
    // This changes selection without assigning renderer metadata.
    const result = applyPlaylistSnapshot(
      {
        revision: 12,
        currentQueueItemId: FAILED,
        list: items.map(({ queueItemId, name, type, videoId, playlistId }) => ({
          queueItemId,
          name,
          type,
          videoId,
          playlistId,
        })),
      },
      'rebase',
    );
    expect(result).toBe('rebased');
    h.setCanonical(checkpoint(FAILED, 12));
    await expect(h.controller.requestReconciliation()).resolves.toBe(false);
    expect(getState('player.currentTrackMeta')?.name).toBe(items[0]!.name);
    expect(getState('playlist.currentQueueItemId')).toBe(FAILED);
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(decoder.load).toHaveBeenCalledTimes(1);
    const metadataChanged = vi.fn();
    const stop = vi.spyOn(transport, 'stopAllMedia');
    bus.on('state:player.currentTrackMeta', metadataChanged);
    await expect(h.controller.requestReconciliation()).resolves.toBe(false);
    expect(metadataChanged).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('retries transient downloads of the same checkpoint and then plays normally', async () => {
    const original = items[1]!;
    setState('playlist.items', [{ ...original, file: undefined }]);
    const resolveFile = vi.fn(async () => {
      if (resolveFile.mock.calls.length <= 2) throw new Error('temporary download failure');
      setState('playlist.items', [original]);
      return original.file!;
    });
    registerProRoomMediaHooks({
      addFiles: () => false,
      addYouTube: () => false,
      updateTrackMetadata: () => false,
      removeTracks: () => false,
      reorderTrack: () => false,
      resolveFile,
      handlesPersistentFile: () => true,
    });
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(false);
    expect(resolveFile).toHaveBeenCalledTimes(1);
    expect(getState('playback.failedTrackKeys').size).toBe(0);
    await expect(h.controller.requestReconciliation()).resolves.toBe(false);
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    expect(resolveFile).toHaveBeenCalledTimes(3);
    expect(decoder.load).toHaveBeenCalledTimes(1);
    expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
    expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'reconnect'] as const)(
    'an orphan failed PREPARE followed by %s preserves healthy audio',
    async (action) => {
      const h = harness(checkpoint(HEALTHY, 10));
      await expect(h.controller.requestReconciliation()).resolves.toBe(true);
      const resident = getState('files.current');
      const buffer = getCurrentAudioBuffer();
      markTrackFailed(`queue:${FAILED}`);
      const stop = vi.spyOn(transport, 'stopAllMedia');
      const id = h.prepare(checkpoint(FAILED, 11));
      await vi.waitFor(() => expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalled());
      if (action === 'cancel') h.controller.acceptCancel(id);
      else h.controller.beginControlChannelRecovery();
      expect(stop).not.toHaveBeenCalled();
      expect(getState('files.current')).toBe(resident);
      expect(getCurrentAudioBuffer()).toBe(buffer);
      expect(getState('playback.activity')).toBe('playing');
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );

  it.each(['transition', 'direct', 'snapshot'] as const)(
    'a failed revisit through %s silences old audio and waits for healthy successor',
    async (path) => {
      const h = harness(checkpoint(HEALTHY, 10));
      await expect(h.controller.requestReconciliation()).resolves.toBe(true);
      markTrackFailed(`queue:${FAILED}`);
      const failed = checkpoint(FAILED, 11);
      if (path === 'snapshot') {
        h.setCanonical(failed);
        await expect(h.controller.requestReconciliation()).resolves.toBe(false);
      } else {
        const id = path === 'transition' ? h.prepare(failed) : null;
        if (id)
          await vi.waitFor(() => expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalled());
        h.commit(failed, id);
        await vi.waitFor(() => expect(getState('files.current')).toBeNull());
      }
      expect(getState('playback.activity')).toBe('idle');
      expect(getCurrentAudioBuffer()).toBeNull();
      expect(getState('playlist.currentQueueItemId')).toBe(FAILED);
      expect(decoder.load).toHaveBeenCalledTimes(1);
      expect(h.applied).toHaveBeenCalledTimes(1);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
      h.setCanonical(checkpoint(HEALTHY, 12));
      await expect(h.controller.requestReconciliation()).resolves.toBe(true);
      expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
      expect(h.applied).toHaveBeenCalledTimes(2);
    },
  );

  it('a delayed failed COMMIT cannot retire a newer healthy PREPARE', async () => {
    vi.useFakeTimers();
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    const stop = vi.spyOn(transport, 'stopAllMedia');
    h.commit(checkpoint(FAILED, 11), null, 500);
    await vi.advanceTimersByTimeAsync(0);
    const next = checkpoint(HEALTHY, 12);
    const id = h.prepare(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalled();
    const buffer = getCurrentAudioBuffer();
    stop.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(stop).not.toHaveBeenCalled();
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
    h.commit(next, id);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied).toHaveBeenCalledTimes(2);
  });

  it('room authority reset preserves terminal identity while fencing the old delayed invalidation', async () => {
    vi.useFakeTimers();
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    h.commit(checkpoint(FAILED, 11), null, 500);
    await vi.advanceTimersByTimeAsync(0);
    h.controller.resetPlaylistRuntime();
    enterRoom(4, ['playback.control']);
    h.setCanonical(checkpoint(HEALTHY, 1));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    const buffer = getCurrentAudioBuffer();
    await vi.advanceTimersByTimeAsync(500);
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
    h.setCanonical(checkpoint(FAILED, 2));
    await expect(h.controller.requestReconciliation()).resolves.toBe(false);
    expect(decoder.load.mock.calls.map((call) => call[1])).toEqual([HEALTHY, HEALTHY]);
  });

  it('late successful preparation after a failed successor cannot resurrect outgoing media', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    decoder.load.mockImplementationOnce(async (file, queueItemId, sessionId, epoch) => {
      await pending;
      if (epoch !== undefined && !isCurrentLoadEpoch(epoch)) return false;
      publishResident(file, queueItemId, sessionId);
      return true;
    });
    const h = harness(checkpoint(HEALTHY, 10));
    h.prepare(checkpoint(HEALTHY, 10));
    await vi.waitFor(() => expect(decoder.load).toHaveBeenCalledTimes(1));
    markTrackFailed(`queue:${FAILED}`);
    h.commit(checkpoint(FAILED, 11));
    await vi.waitFor(() => expect(getState('playlist.currentQueueItemId')).toBe(FAILED));
    release();
    await h.controller.requestReconciliation();
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('files.current')).toBeNull();
    expect(h.applied).not.toHaveBeenCalled();
    expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
  });
});

describe('device failure at projection and delayed commit boundaries', () => {
  it('late fetch failures in A to B to A to C cannot fail or relabel C', async () => {
    vi.useFakeTimers();
    const successor = { ...items[1]!, queueItemId: READDED, name: 'successor.flac' };
    setState('playlist.items', [{ ...items[0]!, file: undefined }, items[1]!, successor]);
    const rejects: Array<(error: Error) => void> = [];
    const resolveFile = vi.fn(
      () =>
        new Promise<File | null>((_resolve, reject) => {
          rejects.push(reject);
        }),
    );
    registerProRoomMediaHooks({
      addFiles: () => false,
      addYouTube: () => false,
      updateTrackMetadata: () => false,
      removeTracks: () => false,
      reorderTrack: () => false,
      resolveFile,
      handlesPersistentFile: () => true,
    });
    const h = harness(checkpoint(HEALTHY, 9));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    h.prepare(checkpoint(FAILED, 10));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveFile).toHaveBeenCalledTimes(1);

    const healthy = checkpoint(HEALTHY, 11);
    const healthyId = h.prepare(healthy);
    await vi.advanceTimersByTimeAsync(0);
    h.commit(healthy, healthyId);
    await vi.advanceTimersByTimeAsync(0);
    h.prepare(checkpoint(FAILED, 12));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveFile).toHaveBeenCalledTimes(2);

    const final = checkpoint(READDED, 13);
    const finalId = h.prepare(final);
    await vi.advanceTimersByTimeAsync(0);
    h.commit(final, finalId);
    await vi.advanceTimersByTimeAsync(0);
    const resident = getState('files.current');
    const buffer = getCurrentAudioBuffer();
    const metadata = getState('player.currentTrackMeta');
    rejects[1]!(new Error('second A fetch failed late'));
    rejects[0]!(new Error('first A fetch failed later'));
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('files.current')).toBe(resident);
    expect(resident?.queueItemId).toBe(READDED);
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getState('player.currentTrackMeta')).toBe(metadata);
    expect(getState('playback.failedTrackKeys').size).toBe(0);
    expect(getState('playback.activity')).toBe('playing');
    expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([9, 11, 13]);
    expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
  });

  it('uses the latest projected metadata when failed COMMIT reaches its scheduled instant', async () => {
    vi.useFakeTimers();
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    const failed = checkpoint(FAILED, 11);
    h.commit(failed, null, 500);
    await vi.advanceTimersByTimeAsync(0);

    // Queue metadata can be enriched without changing the playback revision.
    // Applying that projection does not stop surviving media or allocate a load.
    const renamed = { ...items[0]!, name: 'Corrected filename.flac', title: 'Canonical title' };
    expect(
      applyPlaylistSnapshot(
        {
          revision: 12,
          currentQueueItemId: FAILED,
          list: [items[1]!, renamed].map(
            ({ queueItemId, type, name, title, videoId, playlistId }) => ({
              queueItemId,
              type,
              name,
              title,
              videoId,
              playlistId,
            }),
          ),
        },
        'rebase',
      ),
    ).toBe('rebased');
    h.setCanonical(failed);
    const reconciliation = h.controller.requestReconciliation();
    await vi.advanceTimersByTimeAsync(500);
    await expect(reconciliation).resolves.toBe(false);
    expect(getState('player.currentTrackMeta')).toMatchObject({
      queueItemId: FAILED,
      name: renamed.name,
      title: renamed.title,
    });
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(h.applied).toHaveBeenCalledTimes(1);
    expect(decoder.load).toHaveBeenCalledTimes(1);
  });

  it('a canonical idle/removal supersedes pending failure without restoring deleted metadata', async () => {
    vi.useFakeTimers();
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    h.commit(checkpoint(FAILED, 11), null, 500);
    await vi.advanceTimersByTimeAsync(0);
    // Match runtime projection teardown when canonical removal deselects media.
    expect(
      applyPlaylistSnapshot(
        {
          revision: 12,
          currentQueueItemId: null,
          list: [items[1]!].map(({ queueItemId, type, name, videoId, playlistId }) => ({
            queueItemId,
            type,
            name,
            videoId,
            playlistId,
          })),
        },
        'rebase',
      ),
    ).toBe('rebased');
    transport.stopAllMedia({ cancelInFlight: true, clearBuffer: true });
    setState('player.currentTrackMeta', null);
    setState('files.current', null);
    const idle = { ...checkpoint(HEALTHY, 12, 'idle'), queueItemId: null };
    h.commit(idle);
    await vi.advanceTimersByTimeAsync(500);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('files.current')).toBeNull();
    expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([10, 12]);
    expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
  });

  it('removing pending failed A preserves surviving healthy playback before its replacement frame arrives', async () => {
    vi.useFakeTimers();
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    h.commit(checkpoint(FAILED, 11), null, 500);
    await vi.advanceTimersByTimeAsync(0);
    const buffer = getCurrentAudioBuffer();
    const resident = getState('files.current');
    const metadata = getState('player.currentTrackMeta');
    const stop = vi.spyOn(transport, 'stopAllMedia');

    // The playlist acceptance lane can publish removal before the replacement
    // playback frame arrives. Healthy B survives and remains selected, so the
    // runtime's removed-current/deselection teardown predicates are both false.
    expect(
      applyPlaylistSnapshot(
        {
          revision: 12,
          currentQueueItemId: HEALTHY,
          list: [items[1]!].map(({ queueItemId, type, name, videoId, playlistId }) => ({
            queueItemId,
            type,
            name,
            videoId,
            playlistId,
          })),
        },
        'rebase',
      ),
    ).toBe('rebased');
    h.setCanonical(checkpoint(HEALTHY, 12));
    await vi.advanceTimersByTimeAsync(500);
    expect(stop).not.toHaveBeenCalled();
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getState('files.current')).toBe(resident);
    expect(getState('player.currentTrackMeta')).toBe(metadata);
    expect(getState('playlist.currentQueueItemId')).toBe(HEALTHY);
    expect(getState('playback.activity')).toBe('playing');
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([10, 12]);
  });

  it('a removed failed occurrence cannot retire its readded identical-file successor', async () => {
    vi.useFakeTimers();
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    h.commit(checkpoint(FAILED, 11), null, 500);
    await vi.advanceTimersByTimeAsync(0);
    const readded = { ...items[0]!, queueItemId: READDED };
    setState('playlist.items', [readded, items[1]!]);
    const successor = checkpoint(READDED, 12);
    const id = h.prepare(successor);
    await vi.advanceTimersByTimeAsync(0);
    setState('playlist.items', [items[1]!, readded]);
    h.commit(successor, id);
    await vi.advanceTimersByTimeAsync(500);
    expect(getState('playlist.currentQueueItemId')).toBe(READDED);
    expect(getState('files.current')?.queueItemId).toBe(READDED);
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${FAILED}`]));
    expect(h.applied.mock.calls.map(([event]) => event.trackKey)).toEqual([HEALTHY, READDED]);
  });

  it('a cancelled failure followed by a stale COMMIT does not overwrite a newer healthy checkpoint', async () => {
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    const failed = checkpoint(FAILED, 11);
    const id = h.prepare(failed);
    await vi.waitFor(() => expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalled());
    h.controller.acceptCancel(id);
    h.setCanonical(checkpoint(HEALTHY, 12));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    const buffer = getCurrentAudioBuffer();
    const metadata = getState('player.currentTrackMeta');
    const stop = vi.spyOn(transport, 'stopAllMedia');
    h.commit(failed, id);
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getState('player.currentTrackMeta')).toBe(metadata);
    expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
    expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([10, 12]);
  });

  it('a retired room cannot invalidate a new room sharing epoch and queue IDs', async () => {
    vi.useFakeTimers();
    const h = harness(checkpoint(HEALTHY, 10));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    h.commit(checkpoint(FAILED, 11), null, 500);
    await vi.advanceTimersByTimeAsync(0);
    h.controller.stopLifecycle();
    h.controller.resetPlaylistRuntime();
    transport.stopAllMedia({ cancelInFlight: true, clearBuffer: true });
    // Full explicit room leave clears device failures before a new room starts.
    setState('playback.failedTrackKeys', new Set<string>());
    enterRoom(3, [], '000002');
    const secondFile = new File(['new room bytes'], 'second-room.flac', { type: 'audio/flac' });
    setState('playlist.items', [{ ...items[0]!, name: secondFile.name, file: secondFile }]);
    decoder.load.mockImplementation(async (file, queueItemId, sessionId) => {
      publishResident(file, queueItemId, sessionId);
      return true;
    });
    h.controller.startLifecycle();
    h.setCanonical(checkpoint(FAILED, 1));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    const buffer = getCurrentAudioBuffer();
    await vi.advanceTimersByTimeAsync(500);
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getState('files.current')?.blob).toBe(secondFile);
    expect(getState('player.currentTrackMeta')?.name).toBe(secondFile.name);
    expect(getState('playback.failedTrackKeys').size).toBe(0);
  });
});

describe('device failure across authority caches and permission transitions', () => {
  it.each(['failed', 'healthy'] as const)(
    'late %s COMMIT cannot cancel a newer healthy PREPARE admitted by command response',
    async (predecessor) => {
      vi.useFakeTimers();
      enterRoom(3, ['playback.control']);
      const outgoing = { ...items[1]!, queueItemId: READDED, name: 'outgoing.flac' };
      setState('playlist.items', [...items, outgoing]);
      if (predecessor === 'healthy') {
        decoder.load.mockImplementation(async (file, queueItemId, sessionId) => {
          publishResident(file, queueItemId, sessionId);
          return true;
        });
      }
      const h = harness(checkpoint(READDED, 9));
      await expect(h.controller.requestReconciliation()).resolves.toBe(true);
      if (predecessor === 'failed') markTrackFailed(`queue:${FAILED}`);
      const failed = checkpoint(FAILED, 10);
      const failedTransition = h.prepare(failed);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalledTimes(1);

      // HTTP command responses and websocket COMMIT frames can cross. The server
      // has committed A and admits B while this device has not received A's frame.
      const healthy = checkpoint(HEALTHY, 11);
      const healthyTransition = 'response_healthy_11';
      h.setCanonical(failed);
      h.ports.executePlaybackCommand.mockResolvedValue({
        schemaVersion: 1,
        roomCode: ROOM,
        status: 'preparing',
        playback: failed,
        serverTimeMs: Date.now(),
        transition: {
          type: 'pro-playback-prepare',
          transitionId: healthyTransition,
          serverTimeMs: Date.now(),
          deadlineAtMs: Date.now() + 3000,
          basePlaybackRevision: 10,
          target: healthy,
        },
      });
      await h.controller.enqueueIntent({
        kind: 'select',
        roomId: ROOM,
        roomEpoch: 3,
        queueItemId: HEALTHY,
        positionSeconds: 0,
        youtubeVideoId: null,
        youtubeSubIndex: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalledTimes(2);
      const preparedBuffer = getCurrentAudioBuffer();
      expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
      const stop = vi.spyOn(transport, 'stopAllMedia');
      h.commit(failed, failedTransition);
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).not.toHaveBeenCalled();
      expect(getCurrentAudioBuffer()).toBe(preparedBuffer);
      expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
      h.commit(healthy, healthyTransition);
      await vi.advanceTimersByTimeAsync(0);
      expect(decoder.load).toHaveBeenCalledTimes(predecessor === 'failed' ? 2 : 3);
      expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([9, 11]);
    },
  );

  it('a newer PREPARE fences an older failed COMMIT already queued for application', async () => {
    vi.useFakeTimers();
    const h = harness(checkpoint(HEALTHY, 9));
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    markTrackFailed(`queue:${FAILED}`);
    const healthy = checkpoint(HEALTHY, 11);
    h.commit(checkpoint(FAILED, 10), 'older_queued');
    const id = h.prepare(healthy);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready' }),
    );
    const buffer = getCurrentAudioBuffer();
    expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
    h.commit(healthy, id);
    await vi.advanceTimersByTimeAsync(0);
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(decoder.load).toHaveBeenCalledTimes(2);
    expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([9, 11]);
  });

  it.each(['failed', 'healthy'] as const)(
    'removing a newer pending target permits recovery of unchanged canonical %s A after CANCEL',
    async (predecessor) => {
      vi.useFakeTimers();
      const outgoing = { ...items[1]!, queueItemId: READDED, name: 'outgoing.flac' };
      setState('playlist.items', [...items, outgoing]);
      if (predecessor === 'healthy') {
        decoder.load.mockImplementation(async (file, queueItemId, sessionId) => {
          publishResident(file, queueItemId, sessionId);
          return true;
        });
      }
      const h = harness(checkpoint(READDED, 9));
      await expect(h.controller.requestReconciliation()).resolves.toBe(true);
      if (predecessor === 'failed') markTrackFailed(`queue:${FAILED}`);
      const canonical = checkpoint(FAILED, 10);
      h.prepare(canonical);
      await vi.advanceTimersByTimeAsync(0);
      const pendingId = h.prepare(checkpoint(HEALTHY, 11));
      await vi.advanceTimersByTimeAsync(0);
      h.setCanonical(canonical);
      await h.controller.restorePersistedPlayback(snapshot(canonical));
      expect(h.applied).toHaveBeenCalledTimes(1);

      // Removing only pending B emits CANCEL while canonical A and its playback
      // revision survive (the server has no new playback COMMIT to send).
      expect(
        applyPlaylistSnapshot(
          {
            revision: 12,
            currentQueueItemId: FAILED,
            list: [items[0]!, outgoing].map(({ queueItemId, type, name, videoId, playlistId }) => ({
              queueItemId,
              type,
              name,
              videoId,
              playlistId,
            })),
          },
          'rebase',
        ),
      ).toBe('rebased');
      // Runtime reattaches verified R2 cache files after the wire projection.
      setState('playlist.items', [items[0]!, outgoing]);
      transport.stopAllMedia({ cancelInFlight: true, clearBuffer: true });
      setState('files.current', null);
      setState('player.currentTrackMeta', null);
      h.controller.acceptCancel(pendingId);
      h.setCanonical(canonical);
      const attemptsBeforeRecovery = decoder.load.mock.calls.length;
      await expect(h.controller.requestReconciliation()).resolves.toBe(predecessor === 'healthy');
      if (predecessor === 'healthy') {
        expect(decoder.load).toHaveBeenCalledTimes(attemptsBeforeRecovery + 1);
        expect(getState('files.current')?.queueItemId).toBe(FAILED);
        expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([9, 10]);
      } else {
        expect(decoder.load).toHaveBeenCalledTimes(attemptsBeforeRecovery);
        expect(getState('files.current')).toBeNull();
        expect(getState('playback.activity')).toBe('idle');
        expect(getState('player.currentTrackMeta')?.queueItemId).toBe(FAILED);
      }
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'pause', state: 'paused' as const, positionSeconds: 20 },
    { label: 'seek', state: 'playing' as const, positionSeconds: 90 },
    { label: 'repeat', state: 'playing' as const, positionSeconds: 0 },
  ])(
    'cached failed PREPARE remains terminal through direct $label but permits the next healthy occurrence',
    async ({ state, positionSeconds }) => {
      vi.useFakeTimers();
      const h = harness();
      const failed = checkpoint(FAILED, 10);
      h.prepare(failed);
      await vi.advanceTimersByTimeAsync(0);
      expect(decoder.load).toHaveBeenCalledTimes(1);
      expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
      h.commit({ ...checkpoint(FAILED, 11, state), positionSeconds });
      await vi.advanceTimersByTimeAsync(0);
      expect(decoder.load).toHaveBeenCalledTimes(1);
      expect(getState('files.current')).toBeNull();
      expect(getState('playback.activity')).toBe('idle');
      expect(h.applied).not.toHaveBeenCalled();
      h.setCanonical(checkpoint(HEALTHY, 12));
      await expect(h.controller.requestReconciliation()).resolves.toBe(true);
      expect(decoder.load).toHaveBeenCalledTimes(2);
      expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
      expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${FAILED}`]));
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'permission change during healthy download preserves canonical preparation (promote=%s)',
    async (promote) => {
      vi.useFakeTimers();
      enterRoom(3, promote ? [] : ['playback.control']);
      markTrackFailed(`queue:${FAILED}`);
      const target = items[1]!;
      setState('playlist.items', [items[0]!, { ...target, file: undefined }]);
      let finish!: (file: File) => void;
      const resolveFile = vi.fn(
        () =>
          new Promise<File>((resolve) => {
            finish = resolve;
          }),
      );
      registerProRoomMediaHooks({
        addFiles: () => false,
        addYouTube: () => false,
        updateTrackMetadata: () => false,
        removeTracks: () => false,
        reorderTrack: () => false,
        resolveFile,
        handlesPersistentFile: () => true,
      });
      const healthy = checkpoint(HEALTHY, 10);
      const h = harness(healthy);
      const id = h.prepare(healthy);
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveFile).toHaveBeenCalledTimes(1);
      enterRoom(3, promote ? ['playback.control'] : []);
      setState('playlist.items', items);
      finish(target.file!);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.ports.reportPlaybackTransitionReady).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ready' }),
      );
      h.commit(healthy, id);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.applied).toHaveBeenCalledTimes(1);
      expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
      expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${FAILED}`]));
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );

  it('account hook revocation does not cache an aborted download as terminal after renewal', async () => {
    vi.useFakeTimers();
    const target = items[1]!;
    setState('playlist.items', [items[0]!, { ...target, file: undefined }]);
    const resolveFile = vi.fn(() => {
      if (resolveFile.mock.calls.length === 1) {
        const session = captureProRoomMediaHookSession();
        return new Promise<File>((_resolve, reject) => {
          session!.signal.addEventListener(
            'abort',
            () => reject(new DOMException('revoked', 'AbortError')),
            { once: true },
          );
        });
      }
      setState('playlist.items', items);
      return Promise.resolve(target.file!);
    });
    registerProRoomMediaHooks({
      addFiles: () => false,
      addYouTube: () => false,
      updateTrackMetadata: () => false,
      removeTracks: () => false,
      reorderTrack: () => false,
      resolveFile,
      handlesPersistentFile: () => true,
    });
    const h = harness(checkpoint(HEALTHY, 10));
    const first = h.controller.requestReconciliation();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveFile).toHaveBeenCalledTimes(1);
    const renewal = invalidateProRoomMediaHookSession();
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toBe(false);
    expect(getState('playback.failedTrackKeys').size).toBe(0);
    expect(renewProRoomMediaHookSession(renewal)).toBe(true);
    await expect(h.controller.requestReconciliation()).resolves.toBe(true);
    expect(resolveFile).toHaveBeenCalledTimes(2);
    expect(decoder.load).toHaveBeenCalledTimes(1);
    expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
    expect(h.applied).toHaveBeenCalledTimes(1);
  });
});

describe('cancelled preparation recovery through runtime entry points', () => {
  async function cancelledProjectedPreparation(
    alreadyApplied: boolean,
    state: 'playing' | 'paused',
  ) {
    vi.useFakeTimers();
    decoder.load.mockImplementation(async (file, queueItemId, sessionId) => {
      publishResident(file, queueItemId, sessionId);
      return true;
    });
    const outgoing = { ...items[1]!, queueItemId: READDED, name: 'outgoing.flac' };
    setState('playlist.items', [...items, outgoing]);
    const canonical = checkpoint(FAILED, 10, state);
    const h = harness(alreadyApplied ? canonical : checkpoint(READDED, 9));
    await h.controller.restorePersistedPlayback(h.ports.getCanonicalSnapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([
      alreadyApplied ? 10 : 9,
    ]);
    h.setCanonical(canonical);
    const pendingId = h.prepare(checkpoint(HEALTHY, 11));
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('files.current')?.queueItemId).toBe(HEALTHY);
    await h.controller.restorePersistedPlayback(snapshot(canonical));
    await vi.advanceTimersByTimeAsync(0);

    // Actual runtime predicate: preparing B selected it locally; removing B
    // stops that resident although the server keeps canonical A unchanged.
    const survivors = [items[0]!, outgoing];
    const removal = resolveProRoomRemovalTransition(
      getState('playlist.items'),
      survivors,
      getState('playlist.currentQueueItemId'),
      null,
    );
    expect(removal.removedCurrent).toBe(true);
    expect(
      applyPlaylistSnapshot(
        {
          revision: 12,
          currentQueueItemId: FAILED,
          list: survivors.map(({ queueItemId, type, name, videoId, playlistId }) => ({
            queueItemId,
            type,
            name,
            videoId,
            playlistId,
          })),
        },
        'rebase',
      ),
    ).toBe('rebased');
    setState('playlist.items', survivors);
    transport.stopAllMedia({ cancelInFlight: true, clearBuffer: true });
    setState('files.current', null);
    setState('player.currentTrackMeta', null);
    h.controller.acceptCancel(pendingId);
    h.setCanonical(canonical);
    return { h, canonical };
  }

  it.each(
    [false, true].flatMap((alreadyApplied) =>
      (['playing', 'paused'] as const).flatMap((state) =>
        (['heartbeat', 'manual'] as const).map((entry) => ({ alreadyApplied, state, entry })),
      ),
    ),
  )(
    '$entry recovers $state canonical A after pending B removal (alreadyApplied=$alreadyApplied)',
    async ({ alreadyApplied, state, entry }) => {
      const { h, canonical } = await cancelledProjectedPreparation(alreadyApplied, state);
      if (entry === 'heartbeat') {
        await h.controller.restorePersistedPlayback(snapshot(canonical));
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await expect(h.controller.requestReconciliation()).resolves.toBe(true);
      }
      expect(getState('files.current')?.queueItemId).toBe(FAILED);
      expect(getCurrentAudioBuffer()).not.toBeNull();
      expect(getState('playback.activity')).toBe(state);
      expect(getState('player.currentTrackMeta')?.queueItemId).toBe(FAILED);
      expect(getState('playback.failedTrackKeys').size).toBe(0);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );

  it.each(['playing', 'paused'] as const)(
    'repeated pending-target cancellations restore the same %s revision once per cycle',
    async (state) => {
      const { h, canonical } = await cancelledProjectedPreparation(true, state);
      await h.controller.restorePersistedPlayback(snapshot(canonical));
      await vi.advanceTimersByTimeAsync(0);
      expect(getState('files.current')?.queueItemId).toBe(FAILED);
      const firstRecoveryDecodes = decoder.load.mock.calls.length;
      for (let i = 0; i < 3; i++) {
        await h.controller.restorePersistedPlayback(snapshot(canonical));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(decoder.load).toHaveBeenCalledTimes(firstRecoveryDecodes);

      // CANCEL did not advance canonical playback, so another valid server
      // selection still prepares revision 11, with a different transition ID.
      const pendingId = h.prepare(checkpoint(READDED, 11), 'second_cancel_same_base');
      await vi.advanceTimersByTimeAsync(0);
      expect(getState('files.current')?.queueItemId).toBe(READDED);
      expect(
        resolveProRoomRemovalTransition(
          getState('playlist.items'),
          [items[0]!],
          getState('playlist.currentQueueItemId'),
          null,
        ).removedCurrent,
      ).toBe(true);
      expect(
        applyPlaylistSnapshot(
          {
            revision: 13,
            currentQueueItemId: FAILED,
            list: [items[0]!].map(({ queueItemId, type, name, videoId, playlistId }) => ({
              queueItemId,
              type,
              name,
              videoId,
              playlistId,
            })),
          },
          'monotonic',
        ),
      ).toBe('applied');
      setState('playlist.items', [items[0]!]);
      transport.stopAllMedia({ cancelInFlight: true, clearBuffer: true });
      setState('files.current', null);
      setState('player.currentTrackMeta', null);
      h.controller.acceptCancel(pendingId);
      h.setCanonical(canonical);
      for (let i = 0; i < 3; i++) {
        await h.controller.restorePersistedPlayback(snapshot(canonical));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(getState('files.current')?.queueItemId).toBe(FAILED);
      expect(getState('playback.activity')).toBe(state);
      expect(decoder.load).toHaveBeenCalledTimes(firstRecoveryDecodes + 2);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );

  it('cancelled unavailable B does not reprepare healthy A that never lost its renderer', async () => {
    vi.useFakeTimers();
    const canonical = checkpoint(HEALTHY, 10);
    const h = harness(canonical);
    await h.controller.restorePersistedPlayback(snapshot(canonical));
    await vi.advanceTimersByTimeAsync(0);
    const buffer = getCurrentAudioBuffer();
    const resident = getState('files.current');
    const stop = vi.spyOn(transport, 'stopAllMedia');
    const commits = vi.mocked(transport.applyProPlaybackFileCommit).mock.calls.length;
    markTrackFailed(`queue:${FAILED}`);
    const pendingId = h.prepare(checkpoint(FAILED, 11));
    await vi.advanceTimersByTimeAsync(0);
    h.controller.acceptCancel(pendingId);
    for (let i = 0; i < 3; i++) {
      await h.controller.restorePersistedPlayback(snapshot(canonical));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(decoder.load).toHaveBeenCalledTimes(1);
    expect(transport.applyProPlaybackFileCommit).toHaveBeenCalledTimes(commits);
    expect(stop).not.toHaveBeenCalled();
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getState('files.current')).toBe(resident);
    expect(getState('playback.activity')).toBe('playing');
  });

  it.each(['playing', 'paused'] as const)(
    'manual sync still applies the requested offset to preserved %s A after B cancellation',
    async (state) => {
      vi.useFakeTimers();
      const canonical = checkpoint(HEALTHY, 10, state);
      const h = harness(canonical);
      await h.controller.restorePersistedPlayback(snapshot(canonical));
      await vi.advanceTimersByTimeAsync(0);
      markTrackFailed(`queue:${FAILED}`);
      const pendingId = h.prepare(checkpoint(FAILED, 11));
      await vi.advanceTimersByTimeAsync(0);
      h.controller.acceptCancel(pendingId);
      setState('sync.localOffset', 0.35);
      const commits = vi.mocked(transport.applyProPlaybackFileCommit).mock.calls.length;
      await expect(h.controller.requestReconciliation()).resolves.toBe(true);
      expect(transport.applyProPlaybackFileCommit).toHaveBeenCalledTimes(commits + 1);
      expect(transport.applyProPlaybackFileCommit).toHaveBeenLastCalledWith(
        expect.objectContaining({ queueItemId: HEALTHY, state }),
      );
      expect(getState('sync.localOffset')).toBe(0.35);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    },
  );

  it('a decode failure while restoring an applied canonical occurrence stays terminal on later heartbeats', async () => {
    const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
    const attemptsBeforeRecovery = decoder.load.mock.calls.length;
    const originalFile = items[0]!.file!;
    setState(
      'playlist.items',
      getState('playlist.items').map((item) =>
        item.queueItemId === FAILED ? { ...item, file: undefined } : item,
      ),
    );
    const resolveFile = vi.fn(() => {
      setState(
        'playlist.items',
        getState('playlist.items').map((item) =>
          item.queueItemId === FAILED ? { ...item, file: originalFile } : item,
        ),
      );
      return Promise.resolve(originalFile);
    });
    registerProRoomMediaHooks({
      addFiles: () => false,
      addYouTube: () => false,
      updateTrackMetadata: () => false,
      removeTracks: () => false,
      reorderTrack: () => false,
      resolveFile,
      handlesPersistentFile: () => true,
    });
    decoder.load.mockImplementation(async (_file, queueItemId) => {
      expect(queueItemId).toBe(FAILED);
      transition({ type: 'FILE_PREPARE', variant: 'preload-match', queueItemId, name: _file.name });
      markTrackFailed(`queue:${queueItemId}`);
      transition({ type: 'DECODE_ERROR' });
      return false;
    });
    for (let i = 0; i < 4; i++) {
      await h.controller.restorePersistedPlayback(snapshot(canonical));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(decoder.load).toHaveBeenCalledTimes(attemptsBeforeRecovery + 1);
    expect(resolveFile).toHaveBeenCalledTimes(1);
    expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${FAILED}`]));
    expect(getState('files.current')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('playlist.currentQueueItemId')).toBe(FAILED);
    expect(getState('player.currentTrackMeta')?.queueItemId).toBe(FAILED);
    expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
  });

  it('automatic running recovery waits for a calibrated server clock', async () => {
    const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
    const calibrated = vi
      .spyOn(proRoomClock, 'isProRoomServerClockCalibrated')
      .mockReturnValue(false);
    const attempts = decoder.load.mock.calls.length;
    await h.controller.restorePersistedPlayback(snapshot(canonical));
    expect(decoder.load).toHaveBeenCalledTimes(attempts);
    expect(getState('files.current')).toBeNull();
    calibrated.mockReturnValue(true);
    await h.controller.restorePersistedPlayback(snapshot(canonical));
    expect(decoder.load).toHaveBeenCalledTimes(attempts + 1);
    expect(getState('files.current')?.queueItemId).toBe(FAILED);
    expect(getState('playback.activity')).toBe('playing');
  });

  it('a newer server transition supersedes an applied-checkpoint recovery still awaiting decode', async () => {
    const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
    let finish!: () => void;
    decoder.load.mockImplementationOnce((_file, queueItemId, _sessionId, epoch) => {
      expect(queueItemId).toBe(FAILED);
      return new Promise<boolean>((resolve) => {
        finish = () => {
          expect(isCurrentLoadEpoch(epoch!)).toBe(false);
          resolve(false);
        };
      });
    });
    const recovery = h.controller.restorePersistedPlayback(snapshot(canonical));
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toBeDefined();
    const successor = checkpoint(READDED, 11);
    const transitionId = h.prepare(successor, 'supersede_applied_recovery');
    await vi.advanceTimersByTimeAsync(0);
    h.commit(successor, transitionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('files.current')?.queueItemId).toBe(READDED);
    expect(getState('playback.activity')).toBe('playing');
    finish();
    await recovery;
    expect(getState('files.current')?.queueItemId).toBe(READDED);
    expect(getState('player.currentTrackMeta')?.queueItemId).toBe(READDED);
    expect(getState('playback.failedTrackKeys').size).toBe(0);
    expect(h.applied.mock.calls.map(([event]) => event.revision)).toEqual([10, 11]);
  });

  describe('recovery cancellation and follower boundaries, round 6', () => {
    it.each(['before-replacement', 'after-replacement'] as const)(
      'a second server PREPARE/CANCEL preserves recovery when the obsolete decode settles %s',
      async (settlement) => {
        const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
        const attempts = decoder.load.mock.calls.length;
        let finish!: () => void;
        decoder.load.mockImplementationOnce(
          (_file, _queueItemId, _sessionId, epoch) =>
            new Promise<boolean>((resolve) => {
              finish = () => {
                expect(isCurrentLoadEpoch(epoch!)).toBe(false);
                resolve(false);
              };
            }),
        );
        const original = h.controller.restorePersistedPlayback(snapshot(canonical));
        await vi.advanceTimersByTimeAsync(0);
        const follower = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
        const replacementId = h.prepare(checkpoint(READDED, 11), 'round6_second_pending');
        await vi.advanceTimersByTimeAsync(0);
        expect(getState('files.current')?.queueItemId).toBe(READDED);
        // Expiration/explicit CANCEL leaves canonical A unchanged, just like
        // pending-target removal. The second PREPARE has its own transition ID.
        h.controller.acceptCancel(replacementId);
        if (settlement === 'before-replacement') {
          finish();
          await Promise.all([original, follower]);
        }
        await h.controller.restorePersistedPlayback(snapshot(canonical));
        if (settlement === 'after-replacement') {
          finish();
          await Promise.all([original, follower]);
        }
        expect(decoder.load).toHaveBeenCalledTimes(attempts + 3);
        expect(getState('files.current')?.queueItemId).toBe(FAILED);
        expect(getState('playback.activity')).toBe('playing');
        expect(getState('playback.failedTrackKeys').size).toBe(0);
        await h.controller.restorePersistedPlayback(snapshot(canonical));
        expect(decoder.load).toHaveBeenCalledTimes(attempts + 3);
        expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
      },
    );

    it.each(['prepare', 'commit'] as const)(
      'waiting followers make one bounded retry after a transient %s rejection',
      async (phase) => {
        const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
        const attempts = decoder.load.mock.calls.length;
        let reject!: (reason: Error) => void;
        const pending = new Promise<boolean>((_resolve, fail) => {
          reject = fail;
        });
        if (phase === 'prepare') decoder.load.mockImplementationOnce(() => pending);
        else vi.mocked(transport.applyProPlaybackFileCommit).mockImplementationOnce(() => pending);
        // Production catches transient preparation errors at the playlist
        // endpoint; commit rejection propagates while its finally releases the
        // authority owner. Attach observation before releasing the rejection.
        const original = h.controller.restorePersistedPlayback(snapshot(canonical));
        const observedOriginal = original.then(
          () => null,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(0);
        const followerA = h.controller.restorePersistedPlayback(snapshot(canonical));
        const followerB = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
        const failure = new Error(`transient ${phase} rejection`);
        reject(failure);
        await Promise.all([observedOriginal, followerA, followerB]);
        expect(await observedOriginal).toBe(phase === 'commit' ? failure : null);
        expect(decoder.load).toHaveBeenCalledTimes(attempts + 2);
        expect(getState('files.current')?.queueItemId).toBe(FAILED);
        expect(getState('playback.activity')).toBe('playing');
        expect(getState('playback.failedTrackKeys').size).toBe(0);
        await h.controller.restorePersistedPlayback(snapshot(canonical));
        expect(decoder.load).toHaveBeenCalledTimes(attempts + 2);
        expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
      },
    );

    it('drops two superseded local owners while a default manual request and heartbeat recover', async () => {
      const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
      let firstCurrent = true;
      let secondCurrent = true;
      let finish!: () => void;
      decoder.load.mockImplementationOnce(
        (file, queueItemId, sessionId, epoch) =>
          new Promise<boolean>((resolve) => {
            transition({
              type: 'FILE_PREPARE',
              variant: 'preload-match',
              queueItemId,
              name: file.name,
            });
            finish = () => {
              if (!isCurrentLoadEpoch(epoch!)) return resolve(false);
              publishResident(file, queueItemId, sessionId);
              transition({ type: 'DECODE_SUCCESS' });
              resolve(true);
            };
          }),
      );
      const restores: Promise<void>[] = [];
      h.ports.runHeartbeat.mockClear();
      h.ports.runHeartbeat.mockImplementation(async (_force, _include, isCurrent) => {
        restores.push(h.controller.restorePersistedPlayback(snapshot(canonical), isCurrent));
      });
      const first = h.controller.requestReconciliation({
        liveness: { identity: {}, isCurrent: () => firstCurrent },
      });
      await vi.advanceTimersByTimeAsync(0);
      firstCurrent = false;
      const second = h.controller.requestReconciliation({
        liveness: { identity: {}, isCurrent: () => secondCurrent },
      });
      secondCurrent = false;
      const manual = h.controller.requestReconciliation();
      const ordinary = h.controller.restorePersistedPlayback(snapshot(canonical));
      setState('sync.localOffset', -0.25);
      finish();
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
      await expect(manual).resolves.toBe(true);
      await Promise.all([...restores, ordinary]);
      expect(h.ports.runHeartbeat).toHaveBeenCalledTimes(2);
      expect(getState('files.current')?.queueItemId).toBe(FAILED);
      expect(getState('playback.activity')).toBe('playing');
      expect(getState('sync.localOffset')).toBe(-0.25);
      const attempts = decoder.load.mock.calls.length;
      await h.controller.restorePersistedPlayback(snapshot(canonical));
      expect(decoder.load).toHaveBeenCalledTimes(attempts);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'changing playback permission preserves a room-owned recovery and its followers (promote=%s)',
      async (promote) => {
        const { h, canonical } = await cancelledProjectedPreparation(true, 'paused');
        enterRoom(3, promote ? [] : ['playback.control']);
        let finish!: () => void;
        decoder.load.mockImplementationOnce(
          (file, queueItemId, sessionId, epoch) =>
            new Promise<boolean>((resolve) => {
              finish = () => {
                expect(isCurrentLoadEpoch(epoch!)).toBe(true);
                publishResident(file, queueItemId, sessionId);
                resolve(true);
              };
            }),
        );
        const attempts = decoder.load.mock.calls.length;
        const recovery = h.controller.restorePersistedPlayback(snapshot(canonical));
        await vi.advanceTimersByTimeAsync(0);
        const follower = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
        enterRoom(3, promote ? ['playback.control'] : []);
        finish();
        await Promise.all([recovery, follower]);
        expect(decoder.load).toHaveBeenCalledTimes(attempts + 1);
        expect(getState('files.current')?.queueItemId).toBe(FAILED);
        expect(getState('playback.activity')).toBe('paused');
        expect(getState('playback.failedTrackKeys').size).toBe(0);
        expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
      },
    );

    it('a replaced same-room lease fences an old recovery and followers even when revision and epoch repeat', async () => {
      const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
      let finish!: () => void;
      decoder.load.mockImplementationOnce(
        (_file, _queueItemId, _sessionId, epoch) =>
          new Promise<boolean>((resolve) => {
            finish = () => {
              expect(isCurrentLoadEpoch(epoch!)).toBe(false);
              resolve(false);
            };
          }),
      );
      const original = h.controller.restorePersistedPlayback(snapshot(canonical));
      await vi.advanceTimersByTimeAsync(0);
      const follower = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
      // Runtime presence replacement stops lifecycle, resets its playlist
      // lease/controller, then starts the accepted same-room session afresh.
      h.controller.stopLifecycle();
      h.controller.resetPlaylistRuntime();
      transport.stopAllMedia({ cancelInFlight: true, clearBuffer: true });
      setState('files.current', null);
      h.setCanonical(canonical);
      h.controller.startLifecycle();
      await h.controller.restorePersistedPlayback(snapshot(canonical));
      await vi.advanceTimersByTimeAsync(0);
      const replacementResident = getState('files.current');
      expect(replacementResident?.queueItemId).toBe(FAILED);
      finish();
      await Promise.all([original, follower]);
      expect(getState('files.current')).toBe(replacementResident);
      expect(getState('playback.activity')).toBe('playing');
      expect(getState('playback.failedTrackKeys').size).toBe(0);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    });
  });

  describe('recovery command concurrency, round 5', () => {
    it('manual reconciliation waits for recovery launched by its own heartbeat adjunct', async () => {
      const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
      let finish!: () => void;
      decoder.load.mockImplementationOnce(
        (file, queueItemId, sessionId, epoch) =>
          new Promise<boolean>((resolve) => {
            transition({
              type: 'FILE_PREPARE',
              variant: 'preload-match',
              queueItemId,
              name: file.name,
            });
            finish = () => {
              if (!isCurrentLoadEpoch(epoch!)) return resolve(false);
              publishResident(file, queueItemId, sessionId);
              transition({ type: 'DECODE_SUCCESS' });
              resolve(true);
            };
          }),
      );
      const restores: Promise<void>[] = [];
      h.ports.runHeartbeat.mockImplementation(async (_force, _include, isCurrent) => {
        restores.push(h.controller.restorePersistedPlayback(snapshot(canonical), isCurrent));
      });
      setState('sync.localOffset', 0.35);
      const manual = h.controller.requestReconciliation();
      await vi.advanceTimersByTimeAsync(0);
      expect(finish).toBeDefined();
      finish();
      await Promise.all(restores);
      await expect(manual).resolves.toBe(true);
      expect(getState('playback.activity')).toBe('playing');
      expect(getState('sync.localOffset')).toBe(0.35);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    });

    it('ordinary heartbeat does not revoke recovery started by a live manual reconciliation owner', async () => {
      const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
      let finish!: () => void;
      decoder.load.mockImplementationOnce(
        (file, queueItemId, sessionId, epoch) =>
          new Promise<boolean>((resolve) => {
            transition({
              type: 'FILE_PREPARE',
              variant: 'preload-match',
              queueItemId,
              name: file.name,
            });
            finish = () => {
              if (!isCurrentLoadEpoch(epoch!)) return resolve(false);
              publishResident(file, queueItemId, sessionId);
              transition({ type: 'DECODE_SUCCESS' });
              resolve(true);
            };
          }),
      );
      const restores: Promise<void>[] = [];
      // runtime.runHeartbeat's adjunct restoration is intentionally started
      // without awaiting it, with the reconciliation caller's own liveness.
      h.ports.runHeartbeat.mockImplementation(async (_force, _include, isCurrent) => {
        restores.push(h.controller.restorePersistedPlayback(snapshot(canonical), isCurrent));
      });
      const manual = h.controller.requestReconciliation({
        liveness: { identity: {}, isCurrent: () => true },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(finish).toBeDefined();
      const ordinary = h.controller.restorePersistedPlayback(snapshot(canonical));
      await vi.advanceTimersByTimeAsync(0);
      finish();
      await Promise.all([...restores, ordinary]);
      expect(getState('files.current')?.queueItemId).toBe(FAILED);
      expect(getState('playback.activity')).toBe('playing');
      await expect(manual).resolves.toBe(true);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    });

    it('two live followers recover once under their own liveness after the original owner expires', async () => {
      const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
      let ownerCurrent = true;
      let finish!: () => void;
      decoder.load.mockImplementationOnce(
        (file, queueItemId, sessionId, epoch) =>
          new Promise<boolean>((resolve) => {
            finish = () => {
              if (!isCurrentLoadEpoch(epoch!)) return resolve(false);
              publishResident(file, queueItemId, sessionId);
              resolve(true);
            };
          }),
      );
      const attempts = decoder.load.mock.calls.length;
      const original = h.controller.restorePersistedPlayback(
        snapshot(canonical),
        () => ownerCurrent,
      );
      await vi.advanceTimersByTimeAsync(0);
      const followerA = h.controller.restorePersistedPlayback(snapshot(canonical));
      const followerB = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
      ownerCurrent = false;
      finish();
      await Promise.all([original, followerA, followerB]);
      expect(getState('files.current')?.queueItemId).toBe(FAILED);
      expect(getState('playback.activity')).toBe('playing');
      expect(decoder.load).toHaveBeenCalledTimes(attempts + 2);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    });

    it('revoking only a follower does not revoke the original live recovery', async () => {
      const { h, canonical } = await cancelledProjectedPreparation(true, 'paused');
      let followerCurrent = true;
      let finish!: () => void;
      decoder.load.mockImplementationOnce(
        (file, queueItemId, sessionId, epoch) =>
          new Promise<boolean>((resolve) => {
            finish = () => {
              if (!isCurrentLoadEpoch(epoch!)) return resolve(false);
              publishResident(file, queueItemId, sessionId);
              resolve(true);
            };
          }),
      );
      const attempts = decoder.load.mock.calls.length;
      const original = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
      await vi.advanceTimersByTimeAsync(0);
      const follower = h.controller.restorePersistedPlayback(
        snapshot(canonical),
        () => followerCurrent,
      );
      followerCurrent = false;
      finish();
      await Promise.all([original, follower]);
      expect(getState('files.current')?.queueItemId).toBe(FAILED);
      expect(getState('playback.activity')).toBe('paused');
      expect(decoder.load).toHaveBeenCalledTimes(attempts + 1);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    });

    it.each(['new-checkpoint', 'room-reset'] as const)(
      'waiting recovery followers cannot retry across %s',
      async (supersession) => {
        const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
        let finish!: () => void;
        decoder.load.mockImplementationOnce(
          (_file, _queueItemId, _sessionId, epoch) =>
            new Promise<boolean>((resolve) => {
              finish = () => {
                expect(isCurrentLoadEpoch(epoch!)).toBe(false);
                resolve(false);
              };
            }),
        );
        const attempts = decoder.load.mock.calls.length;
        const original = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
        await vi.advanceTimersByTimeAsync(0);
        const follower = h.controller.restorePersistedPlayback(snapshot(canonical));
        let successor = READDED;
        if (supersession === 'new-checkpoint') {
          const next = checkpoint(READDED, 11);
          const transitionId = h.prepare(next, 'follower_superseding_commit');
          await vi.advanceTimersByTimeAsync(0);
          h.commit(next, transitionId);
          await vi.advanceTimersByTimeAsync(0);
        } else {
          h.controller.stopLifecycle();
          transport.stopAllMedia({ cancelInFlight: true, clearBuffer: true });
          resetState();
          bus.clear();
          enterRoom(4, [], '000002');
          setState('playlist.items', items);
          successor = HEALTHY;
          const next = harness(checkpoint(successor, 10));
          await expect(next.controller.requestReconciliation()).resolves.toBe(true);
        }
        finish();
        await Promise.all([original, follower]);
        expect(decoder.load).toHaveBeenCalledTimes(attempts + 2);
        expect(getState('files.current')?.queueItemId).toBe(successor);
        expect(getState('playback.activity')).toBe('playing');
      },
    );

    it('a terminal decode result does not grant waiting followers another fetch or decode', async () => {
      const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
      let finish!: () => void;
      decoder.load.mockImplementationOnce((file, queueItemId) => {
        transition({
          type: 'FILE_PREPARE',
          variant: 'preload-match',
          queueItemId,
          name: file.name,
        });
        return new Promise<boolean>((resolve) => {
          finish = () => {
            markTrackFailed(`queue:${queueItemId}`);
            transition({ type: 'DECODE_ERROR' });
            resolve(false);
          };
        });
      });
      const attempts = decoder.load.mock.calls.length;
      const original = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
      await vi.advanceTimersByTimeAsync(0);
      const followerA = h.controller.restorePersistedPlayback(snapshot(canonical));
      const followerB = h.controller.restorePersistedPlayback(snapshot(canonical), () => true);
      finish();
      await Promise.all([original, followerA, followerB]);
      await h.controller.restorePersistedPlayback(snapshot(canonical));
      expect(decoder.load).toHaveBeenCalledTimes(attempts + 1);
      expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${FAILED}`]));
      expect(getState('files.current')).toBeNull();
      expect(getState('playback.activity')).toBe('idle');
      expect(getState('player.currentTrackMeta')?.queueItemId).toBe(FAILED);
      expect(h.ports.executePlaybackCommand).not.toHaveBeenCalled();
    });

    it.each(['healthy-successor', 'fresh-occurrence', 'room-rejoin'] as const)(
      'terminal cancellation recovery permits %s without reusing its old failure owner',
      async (next) => {
        const { h, canonical } = await cancelledProjectedPreparation(true, 'playing');
        decoder.load.mockImplementationOnce(async (file, queueItemId) => {
          transition({
            type: 'FILE_PREPARE',
            variant: 'preload-match',
            queueItemId,
            name: file.name,
          });
          markTrackFailed(`queue:${queueItemId}`);
          transition({ type: 'DECODE_ERROR' });
          return false;
        });
        await h.controller.restorePersistedPlayback(snapshot(canonical));
        expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${FAILED}`]));
        expect(getState('playback.activity')).toBe('idle');
        const afterFailure = decoder.load.mock.calls.length;
        let active = h;
        let target = READDED;
        if (next === 'fresh-occurrence') {
          target = '41000000-0000-4000-8000-000000000004' as QueueItemId;
          const replacement = { ...items[0]!, queueItemId: target };
          expect(
            applyPlaylistSnapshot(
              {
                revision: 13,
                currentQueueItemId: target,
                list: [replacement].map(({ queueItemId, type, name, videoId, playlistId }) => ({
                  queueItemId,
                  type,
                  name,
                  videoId,
                  playlistId,
                })),
              },
              'monotonic',
            ),
          ).toBe('applied');
          setState('playlist.items', [replacement]);
        } else if (next === 'room-rejoin') {
          // Model the synchronous controller/media/state teardown used on leave;
          // this is deliberately not an authenticated Worker rejoin fixture.
          h.controller.stopLifecycle();
          transport.stopAllMedia({ cancelInFlight: true, clearBuffer: true });
          resetState();
          bus.clear();
          enterRoom();
          setState('playlist.items', items);
          target = FAILED;
          active = harness(checkpoint(target, 10));
        }
        active.setCanonical(checkpoint(target, next === 'room-rejoin' ? 10 : 11));
        await expect(active.controller.requestReconciliation()).resolves.toBe(true);
        expect(decoder.load).toHaveBeenCalledTimes(afterFailure + 1);
        expect(getState('files.current')?.queueItemId).toBe(target);
        expect(getState('playback.activity')).toBe('playing');
        expect(getState('playback.failedTrackKeys').has(`queue:${target}`)).toBe(false);
        expect(active.ports.executePlaybackCommand).not.toHaveBeenCalled();
      },
    );
  });
});
