/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import type { PlaylistSlotsSummary, QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import {
  captureProRoomMediaHookSession,
  handleProRoomPlaylistSwitch,
  handleProRoomTrackTransfer,
} from '../media-hooks.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { joinProRoom } from '../runtime.ts';

const ROOM = '012345';
const ITEM = '5a000000-0000-4000-8000-000000000001' as QueueItemId;
const SLOTS: PlaylistSlotsSummary = {
  activeSlot: 0,
  slots: [
    { count: 1, bytes: null },
    { count: 4, bytes: 8_192 },
    { count: 0, bytes: null },
  ],
};

function snapshot(playlistSlots: PlaylistSlotsSummary | undefined, canMutate = true) {
  const permissions: ProRoomPermissionSet = {
    'media.add': canMutate,
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
  const value: ProRoomSnapshot = {
    schemaVersion: 1,
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      { queueItemId: ITEM, name: 'Track', source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
    ],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 1,
      revision: 1,
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
      usedBytes: 12_288,
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
  return playlistSlots ? { ...value, playlistSlots } : value;
}

async function join(canonical: ProRoomSnapshot): Promise<void> {
  resetState();
  applyAccountSession({
    configured: true,
    authenticated: true,
    account: { nickname: 'Controller', profileComplete: true },
    statsScope: 'a'.repeat(43),
  });
  vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'getSnapshot').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'attachCurrentAccount').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease').mockImplementation(async () => ({
    leaseExpiresAtMs: Date.now() + 120_000,
  }));
  vi.spyOn(ProRoomApiClient.prototype, 'switchPlaylist').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'transferPlaylistTracks').mockResolvedValue(canonical);
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
    playlistRevision: canonical.playlistRevision,
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
  await joinProRoom({ code: ROOM, pin: '12345678' });
  await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
  await vi.waitFor(() => expect(getState('playlist.storageUsage')).not.toBeNull());
}

describe('PRO room playlist summaries', () => {
  afterEach(async () => {
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    setAccountAnonymous();
    vi.restoreAllMocks();
    resetState();
  });

  it('publishes summaries and storage use, routes playlist edits, and clears them on leave', async () => {
    await join(snapshot(SLOTS));

    expect(getState('playlist.slots')).toEqual(SLOTS);
    expect(getState('playlist.storageUsage')).toEqual({
      usedBytes: 12_288,
      limitBytes: PRO_ROOM_QUOTA_BYTES,
    });

    expect(handleProRoomPlaylistSwitch(1)).toBe(true);
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.switchPlaylist).toHaveBeenCalledWith(
        expect.objectContaining({ code: ROOM, baseRevision: 1, slot: 1 }),
        expect.any(AbortSignal),
      ),
    );
    expect(handleProRoomTrackTransfer([ITEM], [1, 2], 'copy')).toBe(true);
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.transferPlaylistTracks).toHaveBeenCalledWith(
        expect.objectContaining({ queueItemIds: [ITEM], targetSlots: [1, 2], mode: 'copy' }),
        expect.any(AbortSignal),
      ),
    );
    expect(handleProRoomPlaylistSwitch(3)).toBe(false);
    expect(handleProRoomTrackTransfer([ITEM], [], 'move')).toBe(false);

    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    expect(getState('playlist.slots')).toBeNull();
    expect(getState('playlist.storageUsage')).toBeNull();
  });

  it('keeps playlist edits unavailable when the Worker announces no playlists', async () => {
    await join(snapshot(undefined));

    expect(getState('playlist.slots')).toBeNull();
    expect(handleProRoomPlaylistSwitch(1)).toBe(false);
    expect(handleProRoomTrackTransfer([ITEM], [1], 'copy')).toBe(false);
    expect(ProRoomApiClient.prototype.switchPlaylist).not.toHaveBeenCalled();
  });

  it('refuses playlist edits without queue authority', async () => {
    await join(snapshot(SLOTS, false));

    expect(getState('playlist.slots')).toEqual(SLOTS);
    expect(handleProRoomPlaylistSwitch(1)).toBe(false);
    expect(handleProRoomTrackTransfer([ITEM], [1], 'move')).toBe(false);
    expect(ProRoomApiClient.prototype.transferPlaylistTracks).not.toHaveBeenCalled();
  });
});
