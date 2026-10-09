/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import * as sessionReset from '../../core/session-reset.ts';
import { ProRoomApiClient, ProRoomApiError, type ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { ProRoomPlaylistStateManager } from '../playlist-state-manager.ts';
import { joinProRoom } from '../runtime.ts';
import { ProRoomSessionController } from '../session-controller.ts';

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_lease_1';
const PRESENCE_ID = 'presence_lease_1';

function snapshot(presenceIncarnationId = PRESENCE_ID): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    memberIdentityVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
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
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: 'member_lease_0001',
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Minsu',
          devicePlatform: 'other',
          role: 'owner',
          capabilities: [...capabilitiesForProRoomRole('owner')],
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
      memberId: 'member_lease_0001',
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId,
      displayName: 'Minsu',
      role: 'owner',
      capabilities: [...capabilitiesForProRoomRole('owner')],
      coordinatorEligible: false,
    },
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_lease_0001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Minsu',
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

function signalingAccess(presenceIncarnationId = PRESENCE_ID): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: Date.now() + 60_000,
    role: 'member',
    coordinatorEpoch: 1,
    presenceIncarnationId,
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

const handoff = vi.hoisted(() => ({ listener: null as ((roomCode: string) => void) | null }));
vi.mock('../tab-handoff.ts', () => ({
  onProRoomTabTakeover: (listener: (roomCode: string) => void) => {
    handoff.listener = listener;
    return () => undefined;
  },
}));

function notifyTakeover(roomCode = ROOM_CODE): void {
  expect(handoff.listener).not.toBeNull();
  handoff.listener!(roomCode);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function join(presenceIncarnationId = PRESENCE_ID): Promise<void> {
  const next = snapshot(presenceIncarnationId);
  vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValue(next);
  vi.mocked(ProRoomApiClient.prototype.createSignalingTicket).mockResolvedValue(
    signalingAccess(presenceIncarnationId),
  );
  vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(next);
  vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount).mockResolvedValue(next);
  await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
  await vi.advanceTimersByTimeAsync(0);
}

describe('PRO runtime takeover validation', { concurrent: false }, () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
      statsScope: 's'.repeat(43),
    });
    const initial = snapshot();
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue(
      signalingAccess(),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'attachCurrentAccount').mockResolvedValue(initial);
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
    vi.spyOn(ProRoomApiClient.prototype, 'enterPresence').mockResolvedValue(initial);
    vi.spyOn(sessionReset, 'scheduleSessionReset').mockReturnValue(null);
    vi.spyOn(sessionReset, 'scheduleDocumentReload').mockImplementation(() => {});
  });

  afterEach(async () => {
    requestProRoomLeave();
    await vi.advanceTimersByTimeAsync(0);
    clearAllManagedTimers();
    setAccountAnonymous();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps a newer same-room incarnation when a delayed takeover hint validates successfully', async () => {
    await join();
    // Forced delayed delivery is preventive coverage, not proof that native
    // BroadcastChannel and the setup flow can produce this ordering.
    const deliverOldNotice = () => notifyTakeover();
    requestProRoomLeave();
    await join('presence_latest_handoff');
    const close = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced);
    const closeCalls = close.mock.calls.length;
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    deliverOldNotice();
    await vi.advanceTimersByTimeAsync(0);
    expect(heartbeat).toHaveBeenCalledExactlyOnceWith(
      ROOM_CODE,
      undefined,
      expect.objectContaining({
        viewer: expect.objectContaining({ presenceIncarnationId: 'presence_latest_handoff' }),
      }),
    );
    expect(getState('room.context').kind).toBe('pro');
    expect(close).toHaveBeenCalledTimes(closeCalls);
    expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
    expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
  });

  it('retires only a server-confirmed superseded presence without revoking the shared cookie', async () => {
    await join();
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockRejectedValueOnce(new ProRoomApiError('PRESENCE_SUPERSEDED', 409));
    notifyTakeover();
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('room.context').kind).toBe('standard');
    expect(sessionReset.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
    expect(ProRoomApiClient.prototype.enterPresence).not.toHaveBeenCalled();
    expect(ProRoomApiClient.prototype.closeSessionFenced).not.toHaveBeenCalled();
    expect(ProRoomApiClient.prototype.closePresenceOnUnload).not.toHaveBeenCalled();
  });

  it('recovers confirmed expiry through ordinary entry without claiming a takeover', async () => {
    await join();
    const recovered = snapshot('presence_expiry_handoff');
    vi.mocked(ProRoomApiClient.prototype.heartbeat)
      .mockRejectedValueOnce(new ProRoomApiError('PRESENCE_EXPIRED', 409))
      .mockResolvedValue(recovered);
    vi.mocked(ProRoomApiClient.prototype.enterPresence).mockResolvedValue(recovered);
    vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount).mockResolvedValue(recovered);
    vi.mocked(ProRoomApiClient.prototype.createSignalingTicket).mockResolvedValue(
      signalingAccess('presence_expiry_handoff'),
    );
    notifyTakeover();
    await vi.advanceTimersByTimeAsync(0);
    expect(ProRoomApiClient.prototype.enterPresence).toHaveBeenCalledExactlyOnceWith(
      ROOM_CODE,
      expect.not.objectContaining({ takeover: true }),
    );
    expect(getState('room.context').kind).toBe('pro');
    expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
    expect(ProRoomApiClient.prototype.closeSessionFenced).not.toHaveBeenCalled();
  });

  it.each(['PRESENCE_SUPERSEDED', 'PRESENCE_EXPIRED', 'SESSION_REQUIRED'])(
    'ignores a late %s validation failure after leave and rejoin',
    async (code) => {
      await join();
      const validation = deferred<ProRoomSnapshot>();
      vi.mocked(ProRoomApiClient.prototype.heartbeat).mockReturnValueOnce(validation.promise);
      notifyTakeover();
      await vi.advanceTimersByTimeAsync(0);
      requestProRoomLeave();
      await join('presence_after_pending_validation');
      const closeCalls = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced).mock.calls.length;
      validation.reject(new ProRoomApiError(code, 409));
      await vi.advanceTimersByTimeAsync(0);
      expect(getState('room.context').kind).toBe('pro');
      expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
      expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
      expect(ProRoomApiClient.prototype.enterPresence).not.toHaveBeenCalled();
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalledTimes(closeCalls);
    },
  );

  it('ignores terminal projection failure after a newer session replaces the validated one', async () => {
    await join();
    const projection = deferred<ProRoomSnapshot>();
    vi.spyOn(ProRoomPlaylistStateManager.prototype, 'acceptSnapshot').mockReturnValueOnce(
      projection.promise,
    );
    notifyTakeover();
    await vi.advanceTimersByTimeAsync(0);
    expect(ProRoomPlaylistStateManager.prototype.acceptSnapshot).toHaveBeenCalledOnce();
    requestProRoomLeave();
    await join('presence_after_pending_projection');
    projection.reject(new ProRoomApiError('PRESENCE_SUPERSEDED', 409));
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('room.context').kind).toBe('pro');
    expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
  });

  it('keeps a transient validation failure active and retries through the heartbeat timer', async () => {
    await join();
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear().mockRejectedValueOnce(new TypeError('network offline'));
    notifyTakeover();
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('room.context').kind).toBe('pro');
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
    expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(getState('room.context').kind).toBe('pro');
  });

  it('forces a fresh validation after a heartbeat already in flight at notification', async () => {
    await join();
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const pending = deferred<ProRoomSnapshot>();
    heartbeat
      .mockClear()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new ProRoomApiError('PRESENCE_SUPERSEDED', 409));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(heartbeat).toHaveBeenCalledOnce();
    notifyTakeover();
    pending.resolve(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(getState('room.context').kind).toBe('standard');
    expect(sessionReset.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(ProRoomApiClient.prototype.closeSessionFenced).not.toHaveBeenCalled();
  });

  it('does not schedule stale navigation when termination finishes after a new entry', async () => {
    await join();
    const disconnect = deferred<void>();
    const terminate = ProRoomSessionController.prototype.terminate;
    vi.spyOn(ProRoomSessionController.prototype, 'terminate').mockImplementationOnce(
      async function (this: ProRoomSessionController) {
        await terminate.call(this);
        await disconnect.promise;
      },
    );
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockRejectedValueOnce(
      new ProRoomApiError('PRESENCE_SUPERSEDED', 409),
    );
    notifyTakeover();
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('room.context').kind).toBe('standard');
    await join('presence_after_pending_disconnect');
    disconnect.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('room.context').kind).toBe('pro');
    expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
  });

  it('cancels a delayed home navigation when a successor starts opening', async () => {
    await join();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockRejectedValueOnce(
      new ProRoomApiError('PRESENCE_SUPERSEDED', 409),
    );
    notifyTakeover();
    await vi.advanceTimersByTimeAsync(0);
    const navigate = vi.mocked(sessionReset.scheduleSessionReset).mock.calls[0]![1];
    const restore = vi.spyOn(sessionReset, 'restoreSessionReset').mockImplementation(() => {});
    const successor = join('presence_after_scheduled_navigation');
    navigate();
    await successor;
    expect(restore).toHaveBeenCalledOnce();
    expect(getState('room.context').kind).toBe('pro');
  });

  it('ignores another room notification without requesting validation', async () => {
    await join();
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    notifyTakeover('000002');
    await vi.advanceTimersByTimeAsync(0);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(getState('room.context').kind).toBe('pro');
  });
});
