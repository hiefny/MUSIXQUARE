/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomSnapshot } from '../contracts.ts';
import * as serverClock from '../network-bridge.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackCommitRequest,
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareRequest,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import * as systemAudioBridge from '../system-audio-bridge.ts';
import type { ProRoomSystemAudioViewState } from '../system-audio-controller.ts';

const ROOM = '000001';
const QID = '58000000-0000-4000-8000-000000000001' as QueueItemId;
let controller: ProRoomPlaybackController | null = null;
let view: ProRoomSystemAudioViewState;

function shareView(
  phase: ProRoomSystemAudioViewState['phase'],
  initialized = true,
): ProRoomSystemAudioViewState {
  return {
    roomCode: ROOM,
    initialized,
    phase,
    generation: initialized ? 1 : null,
    ownerParticipantId: phase === 'idle' ? null : 'participant_remote',
    isLocalOwner: false,
    localRequestPending: false,
    canStart: false,
    canStop: false,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

function observeShare(phase: ProRoomSystemAudioViewState['phase'], initialized = true): void {
  view = shareView(phase, initialized);
  bus.emit('pro-system-audio:state-changed', view, null);
}

function checkpoint(state: ProRoomPlaybackCheckpoint['state'] = 'paused') {
  return {
    coordinatorEpoch: 1,
    revision: 1,
    state,
    queueItemId: QID,
    positionSeconds: 20,
    youtubeVideoId: null,
    youtubeSubIndex: null,
    updatedAtMs: 10_000,
  } satisfies ProRoomPlaybackCheckpoint;
}

function ready(request: ProPlaybackPrepareRequest): ProPlaybackPrepareResult {
  return {
    status: 'ready',
    authority: request.authority,
    queueItemId: request.queueItemId,
    mediaKind: 'file',
    durationSeconds: 180,
    youtubeSubIndex: null,
    youtubeVideoId: null,
  };
}

function setup(
  playback = checkpoint(),
  prepareImplementation: ProPlaybackMediaEndpoint['prepare'] = async (request) => ready(request),
) {
  const snapshot = {
    roomCode: ROOM,
    playback,
    presence: { coordinatorEpoch: 1 },
  } as unknown as ProRoomSnapshot;
  const prepare = vi.fn(prepareImplementation);
  const commit = vi.fn(async (request: ProPlaybackCommitRequest) => ({
    status: 'applied' as const,
    authority: request.authority,
  }));
  const reportReady = vi.fn().mockResolvedValue('waiting');
  registerProPlaybackMediaEndpoint({ prepare, commit, cancel: vi.fn(), reset: vi.fn() });
  controller = new ProRoomPlaybackController({
    isActive: () => true,
    getCanonicalSnapshot: () => snapshot,
    getPlaylistSnapshot: () => snapshot,
    capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM }),
    isPlaylistLeaseCurrent: () => true,
    getRoomAbortSignal: () => undefined,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: reportReady,
    executePlaybackCommand: vi.fn(),
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  });
  controller.startLifecycle();
  return { controller, snapshot, prepare, commit, reportReady };
}

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetProPlaybackAuthorityHooks();
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM,
    role: 'member',
    coordinatorId: null,
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('playlist.items', [
    {
      queueItemId: QID,
      type: 'file',
      name: 'track.flac',
      file: new File([new Uint8Array([1])], 'track.flac', { type: 'audio/flac' }),
      videoId: null,
      playlistId: null,
    },
  ]);
  view = shareView('idle', false);
  vi.spyOn(systemAudioBridge, 'getProSystemAudioViewState').mockImplementation(() => view);
  vi.spyOn(serverClock, 'isProRoomServerClockCalibrated').mockReturnValue(true);
  vi.spyOn(serverClock, 'getProRoomServerNow').mockReturnValue(10_000);
  vi.spyOn(serverClock, 'waitForFreshProRoomServerClockCalibration').mockResolvedValue(true);
});

afterEach(() => {
  controller?.stopLifecycle();
  controller = null;
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  vi.restoreAllMocks();
});

describe('PRO snapshot restoration and system audio ownership', () => {
  // These tests exercise the real controller and authority layer. The endpoint
  // models asynchronous file preparation; native decoding and RTC are separate
  // integration coverage in playback-native-preparation-cancel and share tests.
  it.each(['unknown', 'idle', 'preparing'] as const)(
    'restores paused files immediately from initial %s without an observed live share',
    async (phase) => {
      view = shareView(phase === 'unknown' ? 'idle' : phase, phase !== 'unknown');
      const { controller, snapshot, prepare, commit } = setup();
      await controller.restorePersistedPlayback(snapshot);
      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
      expect(prepare).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ state: 'paused' }));
      expect(serverClock.waitForFreshProRoomServerClockCalibration).not.toHaveBeenCalled();
    },
  );

  it.each(['playing', 'paused'] as const)(
    'blocks a %s file snapshot when lifecycle starts during a live share',
    async (state) => {
      view = shareView('live');
      const { controller, snapshot, prepare, commit } = setup(checkpoint(state));
      await controller.restorePersistedPlayback(snapshot);
      expect(prepare).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(serverClock.waitForFreshProRoomServerClockCalibration).not.toHaveBeenCalled();
    },
  );

  it('retires pending file preparation through live and preparing, then retries the same revision after confirmed idle', async () => {
    let finishFirst!: () => void;
    let calls = 0;
    const { controller, snapshot, prepare, commit } = setup(checkpoint(), (request) => {
      if (++calls > 1) return Promise.resolve(ready(request));
      return new Promise((resolve) => {
        finishFirst = () => resolve(ready(request));
      });
    });
    await controller.restorePersistedPlayback(snapshot);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const oldRequest = prepare.mock.calls[0][0];
    expect(oldRequest.isCurrent?.()).toBe(true);

    observeShare('live');
    expect(oldRequest.isCurrent?.()).toBe(false);
    for (const phase of ['live', 'preparing'] as const) {
      observeShare(phase);
      await controller.restorePersistedPlayback(snapshot);
    }
    observeShare('idle', false);
    await controller.restorePersistedPlayback(snapshot);
    expect(prepare).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    observeShare('idle');
    expect(oldRequest.isCurrent?.()).toBe(false);
    await controller.restorePersistedPlayback(snapshot);
    finishFirst();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ state: 'paused' }));
  });

  it('keeps one pending restore across repeated idle polls and foreign-room live events', async () => {
    let finish!: () => void;
    view = shareView('idle');
    const { controller, snapshot, prepare, commit } = setup(
      checkpoint(),
      (request) =>
        new Promise((resolve) => {
          finish = () => resolve(ready(request));
        }),
    );
    await controller.restorePersistedPlayback(snapshot);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const request = prepare.mock.calls[0][0];
    for (let index = 0; index < 3; index += 1) {
      observeShare('idle');
      bus.emit(
        'pro-system-audio:state-changed',
        { ...shareView('live'), roomCode: '000002' },
        null,
      );
      await controller.restorePersistedPlayback(snapshot);
      expect(request.isCurrent?.()).toBe(true);
    }
    finish();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('does not revive a pre-share clock wait after live returns to idle', async () => {
    let finishClock!: (calibrated: boolean) => void;
    vi.mocked(serverClock.isProRoomServerClockCalibrated).mockReturnValue(false);
    vi.mocked(serverClock.waitForFreshProRoomServerClockCalibration).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishClock = resolve;
        }),
    );
    const { controller, snapshot, prepare, commit } = setup(checkpoint('playing'));
    const oldRestore = controller.restorePersistedPlayback(snapshot);
    observeShare('live');
    observeShare('idle');
    finishClock(true);
    await oldRestore;
    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    await controller.restorePersistedPlayback(snapshot);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'reset'] as const)(
    'retires a clock wait across %s even when the external room lease remains unchanged',
    async (boundary) => {
      let finishClock!: (calibrated: boolean) => void;
      vi.mocked(serverClock.isProRoomServerClockCalibrated).mockReturnValue(false);
      vi.mocked(serverClock.waitForFreshProRoomServerClockCalibration).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishClock = resolve;
          }),
      );
      const { controller, snapshot, prepare, commit } = setup(checkpoint('playing'));
      const oldRestore = controller.restorePersistedPlayback(snapshot);
      if (boundary === 'stop') {
        controller.stopLifecycle();
        controller.startLifecycle();
      } else {
        controller.resetPlaylistRuntime();
      }
      finishClock(true);
      await oldRestore;
      expect(prepare).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();

      await controller.restorePersistedPlayback(snapshot);
      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it.each(['PREPARE', 'COMMIT'] as const)(
    'keeps an explicit server %s authoritative while snapshots are fenced by a live share',
    async (origin) => {
      view = shareView('live');
      const target = checkpoint('playing');
      const { controller, snapshot, prepare, commit, reportReady } = setup(target);
      await controller.restorePersistedPlayback(snapshot);
      expect(prepare).not.toHaveBeenCalled();
      const transitionId = `transition_${'s'.repeat(22)}`;
      if (origin === 'PREPARE') {
        controller.acceptPrepare({
          type: 'pro-playback-prepare',
          transitionId,
          serverTimeMs: 10_000,
          deadlineAtMs: 13_000,
          basePlaybackRevision: 0,
          target,
        });
        await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());
      }
      controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId,
        serverTimeMs: 10_000,
        executeAtMs: 10_000,
        playback: target,
      });
      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
      expect(prepare).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ state: 'playing' }));
    },
  );

  it('applies a canonical COMMIT after a share retires a snapshot that reused its pending PREPARE', async () => {
    let finishFirst!: () => void;
    let calls = 0;
    const target = checkpoint('playing');
    const { controller, snapshot, prepare, commit } = setup(target, (request) => {
      if (++calls > 1) return Promise.resolve(ready(request));
      return new Promise((resolve) => {
        finishFirst = () => resolve(ready(request));
      });
    });
    const transitionId = `transition_${'p'.repeat(22)}`;
    controller.acceptPrepare({
      type: 'pro-playback-prepare',
      transitionId,
      serverTimeMs: 10_000,
      deadlineAtMs: 13_000,
      basePlaybackRevision: 0,
      target,
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await controller.restorePersistedPlayback(snapshot);
    observeShare('live');
    controller.acceptCommit({
      type: 'pro-playback-commit',
      transitionId,
      serverTimeMs: 10_000,
      executeAtMs: 10_000,
      playback: target,
    });
    finishFirst();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'playing', committedPlaybackRevision: 1 }),
    );
  });
});
