/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import * as systemAudioSfu from '../../network/pro-system-audio-sfu.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
  type ProRoomSystemAudioState,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import {
  registerProPlaybackMediaEndpoint,
  type ProPlaybackMediaEndpoint,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import { joinProRoom } from '../runtime.ts';
import { getProSystemAudioViewState, refreshProSystemAudioState } from '../system-audio-service.ts';

const ROOM_CODE = '000001';
const ROOM_EPOCH = 7;
const QUEUE_ITEM_ID = '42000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'dQw4w9WgXcQ';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function roomSnapshot(): ProRoomSnapshot {
  const member = {
    memberId: 'member_0000000001',
    memberDisplayNumber: 1,
    isAuthenticated: true,
    participantId: 'participant_00001',
    displayName: 'Joining listener',
    role: 'member' as const,
    capabilities: [...capabilitiesForProRoomRole('member')],
  };
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      { queueItemId: QUEUE_ITEM_ID, name: 'Video', source: { kind: 'youtube', videoId: VIDEO_ID } },
    ],
    currentQueueItemId: QUEUE_ITEM_ID,
    playback: {
      coordinatorEpoch: ROOM_EPOCH,
      revision: 1,
      state: 'playing',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 37.5,
      youtubeVideoId: VIDEO_ID,
      youtubeSubIndex: 0,
      updatedAtMs: Date.now(),
    },
    presence: {
      coordinatorEpoch: ROOM_EPOCH,
      revision: 1,
      coordinatorParticipantId: null,
      participants: [
        { ...member, devicePlatform: 'other', joinedAtMs: 2 },
        {
          ...member,
          memberId: 'member_0000000002',
          memberDisplayNumber: 0,
          participantId: 'participant_00002',
          displayName: 'Sharing owner',
          role: 'owner',
          capabilities: [...capabilitiesForProRoomRole('owner')],
          devicePlatform: 'other',
          joinedAtMs: 1,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: { ...member, presenceIncarnationId: 'presence_0000000001', coordinatorEligible: false },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_0000000002',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Sharing owner',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ],
  };
}

function idleShare(generation = 0): ProRoomSystemAudioState {
  return {
    generation,
    status: 'idle',
    ownerParticipantId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

function liveShare(): ProRoomSystemAudioState {
  return {
    generation: 1,
    status: 'live',
    ownerParticipantId: 'participant_00002',
    claimExpiresAt: null,
    liveExpiresAt: Date.now() + 60_000,
    publication: {
      publicationId: 'publication_00001',
      sessionId: 'session_000000001',
      track: { trackName: 'audio-stereo', mid: '0' },
    },
  };
}

// Flush the completed API/clock promise chains through one event-loop turn.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('PRO join playback while a system-audio track is still arriving', () => {
  let calibrated: boolean;
  let initialClock: ReturnType<typeof deferred<boolean>>;
  let initialShare: ReturnType<typeof deferred<ProRoomSystemAudioState>>;
  let joinRestoration: Promise<void>;
  const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>();
  const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>();

  beforeEach(() => {
    resetState();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    calibrated = false;
    initialClock = deferred<boolean>();
    initialShare = deferred<ProRoomSystemAudioState>();
    const snapshot = roomSnapshot();
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(snapshot);
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(snapshot);
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue({
      ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
      expiresAtMs: Date.now() + 60_000,
      role: 'member',
      coordinatorEpoch: ROOM_EPOCH,
      presenceIncarnationId: 'presence_0000000001',
      ticketSequence: 1,
      pendingPlaybackTransition: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockResolvedValue({
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM_CODE,
      revision: 0,
      updatedAtMs: 1,
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM_CODE,
      revision: 0,
      playlistRevision: 1,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockImplementation(
      () => initialShare.promise,
    );
    vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined);
    vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'clockCalibrated', 'get').mockImplementation(
      () => calibrated,
    );
    vi.spyOn(
      ServerProRoomNetworkBridge.prototype,
      'waitForFreshClockCalibration',
    ).mockImplementation(() => initialClock.promise);
    // Call through and retain the real operation's lifetime for negative
    // assertions after the abandoned clock wait has actually settled.
    vi.spyOn(ProRoomPlaybackController.prototype, 'restorePersistedPlayback');
    // Native SFU transport is outside this regression. No received track has
    // attached: the authenticated live lease owns the receiving placeholder.
    vi.spyOn(systemAudioSfu, 'subscribeProSystemAudioSfu').mockResolvedValue(undefined);
    vi.spyOn(systemAudioSfu, 'stopProSystemAudioSfuSubscriber').mockImplementation(() => {});
    prepare.mockReset().mockImplementation(async (request) => ({
      status: 'ready',
      authority: request.authority,
      queueItemId: request.queueItemId,
      mediaKind: 'youtube',
      durationSeconds: 180,
      youtubeSubIndex: 0,
      youtubeVideoId: VIDEO_ID,
    }));
    commit.mockReset().mockImplementation(async (request) => ({
      status: 'applied',
      authority: request.authority,
    }));
    registerProPlaybackMediaEndpoint({ prepare, commit, cancel: vi.fn() });
  });

  afterEach(async () => {
    initialClock.resolve(false);
    initialShare.resolve(idleShare());
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await settle();
    registerProPlaybackMediaEndpoint(null);
    vi.restoreAllMocks();
    resetState();
  });

  async function joinWithPendingClock() {
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() =>
      expect(
        ServerProRoomNetworkBridge.prototype.waitForFreshClockCalibration,
      ).toHaveBeenCalledOnce(),
    );
    joinRestoration = vi.mocked(ProRoomPlaybackController.prototype.restorePersistedPlayback).mock
      .results[0]!.value;
  }

  async function acceptLiveShare() {
    initialShare.resolve(liveShare());
    await vi.waitFor(() =>
      expect(getState('player.currentTrackMeta')?.systemAudioMode).toBe('receiving'),
    );
    expect(getProSystemAudioViewState().phase).toBe('live');
  }

  it('keeps the live receiver after the earlier join clock wait completes', async () => {
    await joinWithPendingClock();
    await acceptLiveShare();
    calibrated = true;
    initialClock.resolve(true);
    await joinRestoration;
    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(getState('player.currentTrackMeta')?.systemAudioMode).toBe('receiving');
  });

  it('restores the playing checkpoint after a normal idle-share join', async () => {
    await joinWithPendingClock();
    initialShare.resolve(idleShare());
    calibrated = true;
    initialClock.resolve(true);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      queueItemId: QUEUE_ITEM_ID,
      committedPlaybackRevision: 1,
      state: 'playing',
    });
  });

  it('uses fresh release recovery while a pre-share clock completion stays retired', async () => {
    await joinWithPendingClock();
    await acceptLiveShare();
    const releaseClock = deferred<boolean>();
    vi.mocked(ServerProRoomNetworkBridge.prototype.waitForFreshClockCalibration).mockImplementation(
      () => releaseClock.promise,
    );
    vi.mocked(ProRoomApiClient.prototype.getSystemAudioState).mockResolvedValue(idleShare(2));
    await refreshProSystemAudioState();
    await vi.waitFor(() =>
      expect(
        vi.mocked(ServerProRoomNetworkBridge.prototype.waitForFreshClockCalibration).mock.calls
          .length,
      ).toBeGreaterThan(1),
    );
    // The old native wait is intentionally non-cooperative with cancellation.
    // Finishing it after release must not bypass the new restoration owner.
    calibrated = true;
    initialClock.resolve(true);
    await joinRestoration;
    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    releaseClock.resolve(true);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      queueItemId: QUEUE_ITEM_ID,
      committedPlaybackRevision: 1,
      state: 'playing',
    });
  });
});
