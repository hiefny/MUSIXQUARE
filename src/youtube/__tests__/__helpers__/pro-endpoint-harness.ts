/**
 * A PRO participant fixture around the real ProRoomPlaybackController, for
 * suites that run the App's PRO YouTube path end to end (the playlist media
 * endpoint, the iframe module and player.ts).
 *
 * Factories only. This module declares no vi.mock and keeps no state between
 * fixtures: the calibrated server clock (pro-room/network-bridge.ts), log,
 * toast and network mocks stay in each test file, and the caller resets the
 * controllers it created (resetControllers) in its afterEach.
 *
 * Timing comes from its homes or their pinned copies, never retyped: the
 * Worker's barrier and COMMIT lead from the copy that
 * pro-room-playback-timing.test.ts pins to cloudflare/pro-room-playback-timing.ts
 * (an App suite must not load Worker code, see ci-quality-gates.test.ts).
 *
 * pro-late-prepare-reload.test.ts still carries the first copy of this
 * fixture; it moves here once that suite's pull request has merged.
 */
import { vi, type Mock } from 'vitest';
import type {
  ProRoomPlaybackCommitEvent,
  ProRoomPlaybackPrepareEvent,
} from '../../../pro-room/api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPlaybackCheckpoint,
  type ProRoomSnapshot,
} from '../../../pro-room/contracts.ts';
import { ProRoomPlaybackController } from '../../../pro-room/playback-controller.ts';
import {
  PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
  PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS,
} from '../../../pro-room/__tests__/__helpers__/pro-room-playback-timing-copy.ts';
import { proSnapshot } from '../../../pro-room/__tests__/__helpers__/pro-snapshot.ts';
import type { QueueItemId } from '../../../types/index.ts';

export type ProTimingMode = 'zero-start' | 'scheduled-control';

export interface ProEndpointIdentity {
  /** A synthetic room code such as '000001'. */
  readonly roomCode: string;
  readonly roomEpoch: number;
  readonly queueItemId: QueueItemId;
  readonly videoId: string;
  readonly transitionId: string;
  readonly title?: string;
}

export interface ProParticipant {
  readonly controller: ProRoomPlaybackController;
  /** reportPlaybackTransitionReady; resolves 'waiting' unless the test changes it. */
  readonly reportReady: Mock;
  /** The canonical snapshot the controller reads from now on. */
  setCanonicalSnapshot(next: ProRoomSnapshot): void;
}

export interface ProEndpointFixture {
  readonly identity: ProEndpointIdentity;
  checkpoint(
    revision: number,
    positionSeconds: number,
    updatedAtMs: number,
    state?: ProRoomPlaybackCheckpoint['state'],
  ): ProRoomPlaybackCheckpoint;
  prepareEvent(
    basePlaybackRevision: number,
    positionSeconds: number,
    timingMode: ProTimingMode,
  ): ProRoomPlaybackPrepareEvent;
  /** A transition COMMIT, or a direct COMMIT when transitionId is null. */
  commitEvent(
    revision: number,
    positionSeconds: number,
    timingMode: ProTimingMode,
    transitionId?: string | null,
  ): ProRoomPlaybackCommitEvent;
  snapshot(playback?: ProRoomPlaybackCheckpoint): ProRoomSnapshot;
  createParticipant(): ProParticipant;
  /** Reset the playlist runtime of every controller this fixture created. */
  resetControllers(): void;
}

/** Build PREPARE/COMMIT events, snapshots and participants for one synthetic room. */
export function createProEndpointFixture(identity: ProEndpointIdentity): ProEndpointFixture {
  const controllers: ProRoomPlaybackController[] = [];

  const checkpoint: ProEndpointFixture['checkpoint'] = (
    revision,
    positionSeconds,
    updatedAtMs,
    state = 'playing',
  ) => ({
    coordinatorEpoch: identity.roomEpoch,
    revision,
    state,
    queueItemId: identity.queueItemId,
    positionSeconds,
    youtubeVideoId: identity.videoId,
    youtubeSubIndex: 0,
    updatedAtMs,
  });

  const prepareEvent: ProEndpointFixture['prepareEvent'] = (
    basePlaybackRevision,
    positionSeconds,
    timingMode,
  ) => {
    const serverTimeMs = Date.now();
    return {
      type: 'pro-playback-prepare',
      transitionId: identity.transitionId,
      serverTimeMs,
      deadlineAtMs: serverTimeMs + PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS,
      basePlaybackRevision,
      target: checkpoint(basePlaybackRevision + 1, positionSeconds, serverTimeMs),
      timingMode,
    };
  };

  const commitEvent: ProEndpointFixture['commitEvent'] = (
    revision,
    positionSeconds,
    timingMode,
    transitionId = identity.transitionId,
  ) => {
    const serverTimeMs = Date.now();
    const executeAtMs = serverTimeMs + PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS;
    return {
      type: 'pro-playback-commit',
      transitionId,
      serverTimeMs,
      executeAtMs,
      playback: checkpoint(revision, positionSeconds, executeAtMs),
      timingMode,
    };
  };

  const snapshot: ProEndpointFixture['snapshot'] = (playback) =>
    proSnapshot({
      roomCode: identity.roomCode,
      status: 'active',
      runtime: 'awake',
      revision: 1,
      playlistRevision: 1,
      effectsRevision: 0,
      queueModeRevision: 0,
      playlist: [
        {
          queueItemId: identity.queueItemId,
          name: identity.title ?? 'Synthetic video',
          source: { kind: 'youtube', videoId: identity.videoId },
        },
      ],
      currentQueueItemId: playback?.queueItemId ?? null,
      playback: playback ?? {
        coordinatorEpoch: identity.roomEpoch,
        revision: 0,
        state: 'idle',
        queueItemId: null,
        positionSeconds: 0,
        youtubeVideoId: null,
        youtubeSubIndex: null,
        updatedAtMs: 1,
      },
      presence: { coordinatorEpoch: identity.roomEpoch, revision: 1, participants: [] },
      quota: {
        limitBytes: PRO_ROOM_QUOTA_BYTES,
        perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
        usedBytes: 0,
        reservedBytes: 0,
      },
      viewer: null,
      administrators: [],
    });

  const createParticipant = (): ProParticipant => {
    let current = snapshot();
    const reportReady = vi.fn().mockResolvedValue('waiting');
    const controller = new ProRoomPlaybackController({
      isActive: () => true,
      getCanonicalSnapshot: () => current,
      getPlaylistSnapshot: () => current,
      capturePlaylistLease: () => ({ generation: 1, roomCode: identity.roomCode }),
      isPlaylistLeaseCurrent: () => true,
      getRoomAbortSignal: () => undefined,
      subscribePlaylistProjection: () => () => undefined,
      runHeartbeat: vi.fn().mockResolvedValue(undefined),
      reportPlaybackTransitionReady: reportReady,
      executePlaybackCommand: vi.fn(),
      recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
    });
    controllers.push(controller);
    return {
      controller,
      reportReady,
      setCanonicalSnapshot: (next) => {
        current = next;
      },
    };
  };

  return {
    identity,
    checkpoint,
    prepareEvent,
    commitEvent,
    snapshot,
    createParticipant,
    resetControllers: () => {
      for (const controller of controllers.splice(0)) controller.resetPlaylistRuntime();
    },
  };
}
