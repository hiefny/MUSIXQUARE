/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearManagedTimer } from '../../core/timers.ts';
import { toggleRepeat, toggleShuffle } from '../../player/playlist.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import type { ProRoomQueueModeSnapshot } from '../queue-mode.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';

const ROOM = '000001';
const ITEM = '56000000-0000-4000-8000-000000000001' as QueueItemId;
const nativeCreateSession = ProRoomApiClient.prototype.createSession;
const nativeGetQueueMode = ProRoomApiClient.prototype.getQueueMode;
const nativeUpdateQueueMode = ProRoomApiClient.prototype.updateQueueMode;

function snapshot(revision = 1, canMutateQueue = true): ProRoomSnapshot {
  const permissions: ProRoomPermissionSet = {
    'media.add': canMutateQueue,
    'playback.control': true,
    'members.kick': false,
    'chat.notice': false,
  };
  const capabilities = [...capabilitiesForProRoomRole('controller', permissions)];
  const member = {
    memberId: 'member_0000000002',
    memberDisplayNumber: 1,
    isAuthenticated: true,
    displayName: 'Controller',
    role: 'controller' as const,
  };
  return {
    schemaVersion: 1,
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      { queueItemId: ITEM, name: 'Track', source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
    ],
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
      revision,
      coordinatorParticipantId: null,
      participants: [
        {
          ...member,
          participantId: 'participant_00002',
          capabilities,
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
    viewer: {
      ...member,
      participantId: 'participant_00002',
      presenceIncarnationId: 'presence_0000000002',
      capabilities,
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_0000000001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        onlineDeviceCount: 0,
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
      },
      { ...member, permissions, inheritedPermissions: [], onlineDeviceCount: 1 },
    ],
  };
}

describe('PRO queue-mode conflict reconciliation read recovery', () => {
  let canonical: ProRoomSnapshot;
  let mode: ProRoomQueueModeSnapshot;
  let puts: Array<{
    repeatMode: 0 | 1 | 2;
    shuffleEnabled: boolean;
    baseRevision: number;
    playlistRevision: number;
  }>;
  let responseBody: ReadableStreamDefaultController<Uint8Array>;
  let deniedResponse: Response | undefined;
  let responseCancelled: boolean;
  let rejectReadStatus: number;

  beforeEach(async () => {
    rejectReadStatus = 0;
    resetState();
    canonical = snapshot();
    mode = {
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM,
      revision: 0,
      playlistRevision: 1,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    };
    puts = [];
    deniedResponse = undefined;
    responseCancelled = false;
    const controlClient = new ProRoomApiClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/sessions')) {
          return Response.json({
            snapshot: canonical,
            session: { expiresAtMs: Date.now() + 60_000 },
          });
        }
        expect(url.pathname.endsWith('/queue-mode')).toBe(true);
        if (init?.method === 'GET') {
          if (rejectReadStatus)
            return Response.json(
              {
                error: rejectReadStatus === 403 ? 'PERMISSION_REQUIRED' : 'TEMPORARILY_UNAVAILABLE',
              },
              { status: rejectReadStatus },
            );
          return Response.json(mode);
        }
        const body = JSON.parse(String(init?.body));
        puts.push(body);
        if (puts.length === 1) {
          // The native parser awaits this response body while the caller can
          // make a newer gesture. The first PUT loses a real revision race.
          deniedResponse = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                responseBody = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      error: 'QUEUE_MODE_REVISION_CONFLICT',
                    }).slice(0, -1),
                  ),
                );
              },
              cancel() {
                responseCancelled = true;
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
          return deniedResponse;
        }
        expect(canonical.viewer?.capabilities).toContain('queue.mutate');
        if (body.baseRevision !== mode.revision)
          return Response.json({ error: 'QUEUE_MODE_REVISION_CONFLICT' }, { status: 409 });
        expect(body.playlistRevision).toBe(canonical.playlistRevision);
        expect(body.shuffleEnabled ? [...body.shuffleOrder].sort() : body.shuffleOrder).toEqual(
          body.shuffleEnabled ? canonical.playlist.map((item) => item.queueItemId).sort() : [],
        );
        mode = {
          ...mode,
          repeatMode: body.repeatMode,
          shuffleEnabled: body.shuffleEnabled,
          shuffleOrder: body.shuffleOrder,
          revision: mode.revision + 1,
        };
        return Response.json(mode);
      },
    });
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockImplementation((input, signal) =>
      nativeCreateSession.call(controlClient, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'updateQueueMode').mockImplementation((input, signal) =>
      nativeUpdateQueueMode.call(controlClient, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation(async () => canonical);
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue({
      ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
      expiresAtMs: Date.now() + 60_000,
      role: 'member',
      coordinatorEpoch: 1,
      presenceIncarnationId: 'presence_0000000002',
      ticketSequence: 1,
      pendingPlaybackTransition: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockResolvedValue({
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM,
      revision: 0,
      updatedAtMs: 1,
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockImplementation((code, signal) =>
      nativeGetQueueMode.call(controlClient, code, signal),
    );
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
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.getQueueMode).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearManagedTimer('preloadScheduleTimer');
    vi.useFakeTimers();
  });

  afterEach(async () => {
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetState();
  });

  function finishResponse() {
    if (!responseCancelled) {
      responseBody.enqueue(new TextEncoder().encode('}'));
      responseBody.close();
    }
  }

  it('uses a fresh canonical baseline for the newer repeat gesture after conflict GET failure', async () => {
    toggleRepeat();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(deniedResponse?.body?.locked).toBe(true);
    canonical = { ...canonical, revision: 2, queueModeRevision: 1 };
    mode = { ...mode, revision: 1, shuffleEnabled: true, shuffleOrder: [ITEM] };
    toggleRepeat();
    expect(getState('playlist.repeatMode')).toBe(2);
    rejectReadStatus = 503;
    finishResponse();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts).toHaveLength(1);
    rejectReadStatus = 0;
    const readsBeforeRecovery = vi.mocked(ProRoomApiClient.prototype.getQueueMode).mock.calls
      .length;
    await vi.advanceTimersByTimeAsync(400);
    expect(vi.mocked(ProRoomApiClient.prototype.getQueueMode).mock.calls.length).toBe(
      readsBeforeRecovery + 1,
    );
    expect(puts[1]?.baseRevision).toBe(1);
    expect(mode.repeatMode).toBe(2);
    expect(getState('playlist.repeatMode')).toBe(2);
    expect(mode.shuffleEnabled).toBe(true);
    expect(puts).toHaveLength(2);
  });
  it.each([0, 503, 403])(
    'retires conflicted repeat through canonical GET status %s',
    async (status) => {
      toggleRepeat();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
      expect(deniedResponse?.body?.locked).toBe(true);
      // Another participant has enabled shuffle, so this repeat CAS is rejected.
      canonical = { ...canonical, revision: 2, queueModeRevision: 1 };
      mode = { ...mode, revision: 1, shuffleEnabled: true, shuffleOrder: [ITEM] };
      rejectReadStatus = status;
      finishResponse();
      await vi.advanceTimersByTimeAsync(0);
      expect(puts).toHaveLength(1);
      // Read transport recovers independently, without replaying the rejected gesture.
      rejectReadStatus = 0;
      acceptProRoomRealtimeFrameForTests({
        type: 'pro-server-event',
        version: 1,
        roomCode: ROOM,
        coordinatorEpoch: 1,
        event: { type: 'pro-room-invalidated', roomRevision: 2, queueModeRevision: 1 },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(getState('playlist.repeatMode')).toBe(0);
      expect(getState('playlist.isShuffle')).toBe(true);
      toggleShuffle();
      await vi.advanceTimersByTimeAsync(400);
      expect(mode.repeatMode).toBe(0);
      expect(mode.shuffleEnabled).toBe(false);
      expect(puts).toHaveLength(2);
    },
  );
});
