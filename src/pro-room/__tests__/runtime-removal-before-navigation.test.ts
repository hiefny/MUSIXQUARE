/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearManagedTimer } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  ProRoomApiClient,
  type ProRoomPlaybackCommand,
  type ProRoomSignalingAccess,
  type UpdateProRoomCompactSnapshotInput,
} from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { handleProRoomTrackRemoval } from '../media-hooks.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import {
  registerProPlaybackMediaEndpoint,
  routeProPlaybackCommand,
} from '../playback-authority-hooks.ts';
import { joinProRoom } from '../runtime.ts';

const ROOM = '000001';
const ONE = '59000000-0000-4000-8000-000000000001' as QueueItemId;
const TWO = '59000000-0000-4000-8000-000000000002' as QueueItemId;
const THREE = '59000000-0000-4000-8000-000000000003' as QueueItemId;
const nativeCreateSession = ProRoomApiClient.prototype.createSession;
const nativeExecuteCommand = ProRoomApiClient.prototype.executePlaybackCommand;

function snapshot(): ProRoomSnapshot {
  const permissions: ProRoomPermissionSet = {
    'media.add': true,
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
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      { queueItemId: ONE, name: 'One', source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
      { queueItemId: TWO, name: 'Two', source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' } },
      { queueItemId: THREE, name: 'Three', source: { kind: 'youtube', videoId: 'aqz-KE-bpKQ' } },
    ],
    currentQueueItemId: ONE,
    playback: {
      coordinatorEpoch: 1,
      revision: 1,
      state: 'paused',
      queueItemId: ONE,
      positionSeconds: 0,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
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

describe('PRO runtime: a removal reaches the Worker before the navigation after it', () => {
  let canonical: ProRoomSnapshot;
  let events: string[];
  let releaseUpdate: (() => void) | null;

  beforeEach(async () => {
    resetState();
    canonical = snapshot();
    events = [];
    releaseUpdate = null;
    registerProPlaybackMediaEndpoint({
      prepare: async (request) => ({
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: 180,
        youtubeVideoId: request.youtubeVideoId ?? null,
        youtubeSubIndex: request.youtubeSubIndex ?? null,
      }),
      commit: async (request) => ({ status: 'applied', authority: request.authority }),
    });
    const client = new ProRoomApiClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/sessions')) {
          return Response.json({
            snapshot: canonical,
            session: { expiresAtMs: Date.now() + 60_000 },
          });
        }
        expect(url.pathname.endsWith('/playback/commands')).toBe(true);
        const command = JSON.parse(String(init?.body)) as ProRoomPlaybackCommand;
        events.push(`command:${command.type}`);
        return Response.json({
          schemaVersion: 1,
          roomCode: ROOM,
          status: 'unchanged',
          playback: canonical.playback,
          serverTimeMs: 1,
        });
      },
    });
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockImplementation((input, signal) =>
      nativeCreateSession.call(client, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'executePlaybackCommand').mockImplementation(
      (input, signal) => nativeExecuteCommand.call(client, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation(() =>
      Promise.resolve(canonical),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'updateCompactSnapshot').mockImplementation(
      (request: UpdateProRoomCompactSnapshotInput) => {
        events.push(`remove:${String(request.playlistOrder)}`);
        return new Promise<ProRoomSnapshot>((resolve) => {
          releaseUpdate = () => {
            const order =
              request.playlistOrder ?? canonical.playlist.map((item) => item.queueItemId);
            canonical = {
              ...canonical,
              revision: canonical.revision + 1,
              playlistRevision: canonical.playlistRevision + 1,
              playlist: canonical.playlist.filter((item) => order.includes(item.queueItemId)),
            };
            events.push('removed');
            resolve(canonical);
          };
        });
      },
    );
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
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM,
      revision: 0,
      playlistRevision: 1,
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
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.getQueueMode).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearManagedTimer('preloadScheduleTimer');
    expect(getState('room.context').capabilities).toEqual(
      expect.arrayContaining(['queue.mutate', 'playback.control']),
    );
    vi.useFakeTimers();
  });

  afterEach(async () => {
    releaseUpdate?.();
    vi.useRealTimers();
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    registerProPlaybackMediaEndpoint(null);
    vi.restoreAllMocks();
    resetState();
  });

  it('sends Next only after the Worker accepted the playlist removal', async () => {
    expect(handleProRoomTrackRemoval([TWO])).toBe(true);
    expect(routeProPlaybackCommand({ kind: 'next', queueItemId: ONE, positionSeconds: 0 })).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual([`remove:${ONE},${THREE}`]);

    releaseUpdate!();
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([`remove:${ONE},${THREE}`, 'removed', 'command:next']);
  });

  it('does not leave Next unanswered behind a stalled removal', async () => {
    expect(handleProRoomTrackRemoval([TWO])).toBe(true);
    routeProPlaybackCommand({ kind: 'next', queueItemId: ONE, positionSeconds: 0 });

    await vi.advanceTimersByTimeAsync(4_900);
    expect(events).toEqual([`remove:${ONE},${THREE}`]);
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual([`remove:${ONE},${THREE}`, 'command:next']);
  });
});
