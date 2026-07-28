/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bounded = vi.hoisted(() => ({
  prepare: vi.fn(),
  commit: vi.fn(),
  cancel: vi.fn(),
  clear: vi.fn(),
  hasCurrent: vi.fn(),
  position: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock('../pro-room-bounded-playback.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pro-room-bounded-playback.ts')>();
  return {
    ...actual,
    prepareProRoomBoundedFilePlayback: bounded.prepare,
    commitProRoomBoundedFilePlayback: bounded.commit,
    cancelProRoomBoundedFilePlayback: bounded.cancel,
    clearProRoomBoundedFilePlayback: bounded.clear,
    hasCurrentProRoomBoundedFilePlayback: bounded.hasCurrent,
    getProRoomBoundedFilePlaybackPosition: bounded.position,
  };
});

import { PLAYBACK_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  cancelProPlaybackPreparation,
  commitProPlaybackAuthority,
  createProPlaybackAuthorityToken,
  prepareProPlaybackAuthority,
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import type { PlaylistItem, QueueItemId, ResidentFile } from '../../types/index.ts';
import { getCurrentAudioBuffer, setCurrentAudioBuffer } from '../_state.ts';
import { getPlaybackOwnership, setPlaybackTrackMeta } from '../ownership.ts';
import { initPlaylist } from '../playlist.ts';
import { applyProPlaybackFileCommit } from '../transport.ts';

const ROOM_CODE = '000001';
const ROOM_EPOCH = 1;
const PREVIOUS_ID = '20000000-0000-4000-8000-000000000001' as QueueItemId;
const INCOMING_ID = '20000000-0000-4000-8000-000000000002' as QueueItemId;

function item(queueItemId: QueueItemId, name: string, title: string): PlaylistItem {
  return {
    queueItemId,
    type: 'file',
    name,
    title,
    videoId: null,
    playlistId: null,
  };
}

function authority(basePlaybackRevision: number, transitionId: string) {
  return createProPlaybackAuthorityToken({
    roomId: ROOM_CODE,
    roomEpoch: ROOM_EPOCH,
    basePlaybackRevision,
    transitionId,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function enterRoomWithPredecessor() {
  const previous = item(PREVIOUS_ID, 'previous.flac', 'Previous title');
  const incoming = item(INCOMING_ID, 'incoming.flac', 'Incoming title');
  const previousFile = new File([Uint8Array.of(1, 2, 3, 4)], previous.name, {
    type: 'audio/flac',
  });
  const resident: ResidentFile = {
    queueItemId: previous.queueItemId,
    indexHint: 0,
    name: previous.name,
    sessionId: 11,
    blob: previousFile,
    mime: previousFile.type,
    size: previousFile.size,
  };
  const buffer = { duration: 120 } as AudioBuffer;
  setState('playlist.items', [previous, incoming]);
  setState('playlist.currentQueueItemId', previous.queueItemId);
  setState('files.current', resident);
  setCurrentAudioBuffer(buffer);
  setState('player.startedAt', 9);
  setState('player.pausedAt', 4);
  setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
  setState('playback.mode', 'file');
  setState('playback.activity', 'playing');
  setPlaybackTrackMeta(previous);
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    role: 'member',
    coordinatorId: null,
    epoch: ROOM_EPOCH,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  return { previous, incoming, resident, buffer };
}

beforeEach(() => {
  resetState();
  bus.clear();
  setCurrentAudioBuffer(null);
  bounded.prepare.mockReset().mockResolvedValue({ status: 'fallback' });
  bounded.commit.mockReset().mockResolvedValue(null);
  bounded.cancel.mockReset();
  bounded.clear.mockReset().mockResolvedValue(undefined);
  bounded.hasCurrent.mockReset().mockReturnValue(false);
  bounded.position.mockReset().mockReturnValue(null);
  bounded.snapshot.mockReset().mockReturnValue(null);
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
});

afterEach(() => {
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  bus.clear();
  setCurrentAudioBuffer(null);
});

describe('PRO bounded playlist publication boundary', () => {
  it('keeps predecessor UI/audio intact through PREPARE and publishes incoming only after COMMIT', async () => {
    const { previous, incoming, resident, buffer } = enterRoomWithPredecessor();
    const durationUpdates = vi.fn();
    const timeUpdates = vi.fn();
    bus.on('ui:duration-update', durationUpdates);
    bus.on('ui:time-update', timeUpdates);
    bounded.prepare.mockResolvedValueOnce({ status: 'ready', durationSeconds: 180 });
    bounded.commit.mockResolvedValueOnce({
      status: 'applied',
      phase: 'playing',
      durationSeconds: 180,
      positionSeconds: 42,
    });
    initPlaylist();
    const token = authority(0, 'bounded-incoming');

    await expect(
      prepareProPlaybackAuthority({
        authority: token,
        queueItemId: incoming.queueItemId,
        positionSeconds: 42,
        state: 'playing',
        prepareBudgetMs: 800,
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      queueItemId: incoming.queueItemId,
      mediaKind: 'file',
      durationSeconds: 180,
    });

    expect(getState('playlist.currentQueueItemId')).toBe(previous.queueItemId);
    expect(getState('files.current')).toBe(resident);
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.PLAYING);
    expect(getState('player.startedAt')).toBe(9);
    expect(getState('player.pausedAt')).toBe(4);
    expect(getPlaybackOwnership().currentTrackMeta).toMatchObject({
      name: previous.name,
      title: previous.title,
    });
    expect(durationUpdates).not.toHaveBeenCalled();
    expect(timeUpdates).not.toHaveBeenCalled();
    expect(bounded.commit).not.toHaveBeenCalled();

    await expect(
      commitProPlaybackAuthority({
        authority: token,
        committedPlaybackRevision: 1,
        queueItemId: incoming.queueItemId,
        state: 'playing',
        positionSeconds: 42,
        scheduleDelayMs: 30,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    expect(getState('playlist.currentQueueItemId')).toBe(incoming.queueItemId);
    expect(getState('files.current')).toBeNull();
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.PLAYING);
    expect(getState('player.pausedAt')).toBe(42);
    expect(getPlaybackOwnership().currentTrackMeta).toMatchObject({
      name: incoming.name,
      title: incoming.title,
    });
    expect(durationUpdates).toHaveBeenCalledOnce();
    expect(durationUpdates).toHaveBeenLastCalledWith(180);
    expect(timeUpdates).toHaveBeenLastCalledWith('0:42', '3:00', 42, 180);
  });

  it('keeps predecessor publication when a bounded PREPARE is cancelled', async () => {
    const { previous, incoming, resident, buffer } = enterRoomWithPredecessor();
    const pending = deferred<Readonly<{ status: 'ready'; durationSeconds: number }>>();
    bounded.prepare.mockReturnValueOnce(pending.promise);
    initPlaylist();
    const token = authority(0, 'cancelled-bounded');

    const preparation = prepareProPlaybackAuthority({
      authority: token,
      queueItemId: incoming.queueItemId,
      positionSeconds: 0,
      state: 'playing',
      prepareBudgetMs: 800,
    });
    await vi.waitFor(() => expect(bounded.prepare).toHaveBeenCalledOnce());
    expect(cancelProPlaybackPreparation(token)).toBe(true);
    pending.resolve({ status: 'ready', durationSeconds: 180 });

    await expect(preparation).resolves.toMatchObject({
      status: 'superseded',
      queueItemId: incoming.queueItemId,
    });
    expect(bounded.cancel).toHaveBeenCalledOnce();
    expect(bounded.commit).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(previous.queueItemId);
    expect(getState('files.current')).toBe(resident);
    expect(getCurrentAudioBuffer()).toBe(buffer);
    expect(getPlaybackOwnership().currentTrackMeta).toMatchObject({
      name: previous.name,
      title: previous.title,
    });
  });

  it('does not let stale COMMIT A clear newer PREPARE B after its await resumes', async () => {
    const { previous, incoming, resident, buffer } = enterRoomWithPredecessor();
    const successor = item(
      '20000000-0000-4000-8000-000000000003' as QueueItemId,
      'successor.flac',
      'Successor title',
    );
    setState('playlist.items', [previous, incoming, successor]);
    bounded.prepare.mockResolvedValue({ status: 'ready', durationSeconds: 180 });
    const staleCommit = deferred<
      Readonly<{
        status: 'applied';
        phase: 'playing';
        durationSeconds: number;
        positionSeconds: number;
      }>
    >();
    bounded.commit.mockReturnValueOnce(staleCommit.promise);
    initPlaylist();
    const first = authority(0, 'commit-a');
    const second = authority(1, 'prepare-b');

    await expect(
      prepareProPlaybackAuthority({
        authority: first,
        queueItemId: incoming.queueItemId,
        positionSeconds: 10,
        state: 'playing',
        prepareBudgetMs: 800,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    let firstIsCurrent = true;
    const committing = applyProPlaybackFileCommit({
      authority: first,
      committedPlaybackRevision: 1,
      queueItemId: incoming.queueItemId,
      state: 'playing',
      positionSeconds: 10,
      scheduleDelayMs: 30,
      timingMode: 'scheduled-control',
      isCurrent: () => firstIsCurrent,
    });
    await vi.waitFor(() => expect(bounded.commit).toHaveBeenCalledOnce());

    firstIsCurrent = false;
    await expect(
      prepareProPlaybackAuthority({
        authority: second,
        queueItemId: successor.queueItemId,
        positionSeconds: 20,
        state: 'playing',
        prepareBudgetMs: 800,
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      queueItemId: successor.queueItemId,
    });
    bounded.clear.mockClear();
    staleCommit.resolve({
      status: 'applied',
      phase: 'playing',
      durationSeconds: 180,
      positionSeconds: 10,
    });

    await expect(committing).resolves.toBe(false);
    expect(bounded.clear).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(previous.queueItemId);
    expect(getState('files.current')).toBe(resident);
    expect(getCurrentAudioBuffer()).toBe(buffer);
  });
});
