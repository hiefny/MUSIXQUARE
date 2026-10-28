/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import * as sessionReset from '../../core/session-reset.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { joinProRoom } from '../runtime.ts';
import { proHeartbeat } from './__helpers__/pro-heartbeat.ts';
import { proSnapshot } from './__helpers__/pro-snapshot.ts';

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_close_1';
const MEMBER_ID = 'member_close_0001';
const LEAVE_PRESENCE_ID = 'presence_close_leave';
const UNLOAD_PRESENCE_ID = 'presence_close_unload';
// The keys a presence close names: the room, the captured participant and its
// presence incarnation, and a fresh receipt key. No playback observation.
const CLOSE_INPUT_KEYS = [
  'code',
  'expectedParticipantId',
  'expectedPresenceIncarnationId',
  'idempotencyKey',
];
const IDEMPOTENCY_KEY_RE = /^mxqr-pro-[0-9a-f]{48}$/;

function snapshot(presenceIncarnationId: string): ProRoomSnapshot {
  const capabilities = [...capabilitiesForProRoomRole('owner')];
  return proSnapshot({
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 7,
    playlistRevision: 0,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 1,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: MEMBER_ID,
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Owner',
          devicePlatform: 'other',
          role: 'owner',
          capabilities,
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
    viewer: {
      memberId: MEMBER_ID,
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId,
      displayName: 'Owner',
      role: 'owner',
      capabilities,
    },
    administrators: [
      {
        memberId: MEMBER_ID,
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
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
  });
}

function signalingAccess(presenceIncarnationId: string): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'c'.repeat(32)}.${'D'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: Date.now() + 60_000,
    role: 'member',
    coordinatorEpoch: 1,
    presenceIncarnationId,
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

async function join(presenceIncarnationId: string): Promise<void> {
  const next = snapshot(presenceIncarnationId);
  vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValue(next);
  vi.mocked(ProRoomApiClient.prototype.enterPresence).mockResolvedValue(next);
  vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount).mockResolvedValue(next);
  vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(proHeartbeat(next));
  vi.mocked(ProRoomApiClient.prototype.createSignalingTicket).mockResolvedValue(
    signalingAccess(presenceIncarnationId),
  );
  await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
  await vi.advanceTimersByTimeAsync(0);
  expect(getState('room.context').kind).toBe('pro');
}

function pageHide(persisted: boolean): Event {
  const event = new Event('pagehide');
  Object.defineProperty(event, 'persisted', { value: persisted });
  return event;
}

describe('PRO runtime presence close', { concurrent: false }, () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Owner', profileComplete: true },
      statsScope: 'c'.repeat(43),
    });
    const initial = snapshot(LEAVE_PRESENCE_ID);
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'enterPresence').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'attachCurrentAccount').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(proHeartbeat(initial));
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue(
      signalingAccess(LEAVE_PRESENCE_ID),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease').mockImplementation(
      async () => ({ leaseExpiresAtMs: Date.now() + 120_000 }),
    );
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
      playlistRevision: 0,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined);
    vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'reconfigure').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    vi.spyOn(sessionReset, 'scheduleSessionReset').mockReturnValue(null);
    vi.spyOn(sessionReset, 'scheduleDocumentReload').mockImplementation(() => {});
  });

  afterEach(async () => {
    // A no-op after the confirmed pagehide below: the lifecycle hook handles
    // one confirmed unload per document, and the hard close already ended
    // the room locally.
    requestProRoomLeave();
    await vi.advanceTimersByTimeAsync(0);
    clearAllManagedTimers();
    setAccountAnonymous();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('closes presence from explicit leave and the confirmed-pagehide hard close without a playback observation', async () => {
    const closePresence = vi.mocked(ProRoomApiClient.prototype.closePresenceOnUnload);
    const closeSession = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced);

    await join(LEAVE_PRESENCE_ID);
    requestProRoomLeave();
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('room.context').kind).toBe('standard');
    // Explicit leave still revokes the exact server session after the close.
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(
      {
        code: ROOM_CODE,
        expectedParticipantId: PARTICIPANT_ID,
        expectedPresenceIncarnationId: LEAVE_PRESENCE_ID,
      },
      undefined,
    );

    await join(UNLOAD_PRESENCE_ID);
    // The registered hard-close handler runs from the lifecycle hook's capture
    // pagehide listener. A document handles one confirmed pagehide, so this
    // stays the last step of the last row in this file.
    window.dispatchEvent(pageHide(false));
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('room.context').kind).toBe('standard');
    // A tab close keeps the resumable cookie session.
    expect(closeSession).toHaveBeenCalledOnce();

    // JSON.stringify drops undefined keys, so the wire body alone would not
    // catch `baseRevision: undefined`; pin the keys of the input object.
    const inputs = closePresence.mock.calls.map(([input]) => input);
    expect(inputs.map((input) => Object.keys(input).sort())).toEqual([
      CLOSE_INPUT_KEYS,
      CLOSE_INPUT_KEYS,
    ]);
    expect(inputs).toStrictEqual([
      {
        code: ROOM_CODE,
        expectedParticipantId: PARTICIPANT_ID,
        expectedPresenceIncarnationId: LEAVE_PRESENCE_ID,
        idempotencyKey: expect.stringMatching(IDEMPOTENCY_KEY_RE),
      },
      {
        code: ROOM_CODE,
        expectedParticipantId: PARTICIPANT_ID,
        expectedPresenceIncarnationId: UNLOAD_PRESENCE_ID,
        idempotencyKey: expect.stringMatching(IDEMPOTENCY_KEY_RE),
      },
    ]);
    expect(inputs[0]!.idempotencyKey).not.toBe(inputs[1]!.idempotencyKey);
  });
});
