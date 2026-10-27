/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { bus } from '../../core/events.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { t } from '../../i18n/index.ts';
import type { PlaylistSlotsSummary, QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import { ProRoomApiError } from '../api-error.ts';
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
  handleProRoomTrackMetadata,
  handleProRoomTrackRemoval,
  handleProRoomTrackReorder,
  handleProRoomTrackTransfer,
  handleProRoomYouTubeForSession,
} from '../media-hooks.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { joinProRoom } from '../runtime.ts';
import { proHeartbeat } from './__helpers__/pro-heartbeat.ts';

/**
 * A full PRO room receipt ledger answers ROOM_STATE_CAPACITY_EXCEEDED (RO-53).
 * The playlist did not change, so every playlist path says the room cannot take
 * more changes for now instead of "The playlist changed".
 */
const ROOM = '012345';
const FIRST = '5b000000-0000-4000-8000-000000000001' as QueueItemId;
const SECOND = '5b000000-0000-4000-8000-000000000002' as QueueItemId;
const ADDED = '5b000000-0000-4000-8000-000000000003' as QueueItemId;
const SLOTS: PlaylistSlotsSummary = {
  activeSlot: 0,
  slots: [
    { count: 2, bytes: null },
    { count: 0, bytes: null },
    { count: 0, bytes: null },
  ],
};

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
      { queueItemId: FIRST, name: 'First', source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
      { queueItemId: SECOND, name: 'Second', source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' } },
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
    playlistSlots: SLOTS,
  };
}

async function join(canonical: ProRoomSnapshot, failure: Error): Promise<void> {
  resetState();
  applyAccountSession({
    configured: true,
    authenticated: true,
    account: { nickname: 'Controller', profileComplete: true },
    statsScope: 'a'.repeat(43),
  });
  vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(proHeartbeat(canonical));
  vi.spyOn(ProRoomApiClient.prototype, 'getSnapshot').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'attachCurrentAccount').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease').mockImplementation(async () => ({
    leaseExpiresAtMs: Date.now() + 120_000,
  }));
  vi.spyOn(ProRoomApiClient.prototype, 'updateCompactSnapshot').mockRejectedValue(failure);
  vi.spyOn(ProRoomApiClient.prototype, 'switchPlaylist').mockRejectedValue(failure);
  vi.spyOn(ProRoomApiClient.prototype, 'transferPlaylistTracks').mockRejectedValue(failure);
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
  await vi.waitFor(() => expect(getState('playlist.slots')).toEqual(SLOTS));
}

type PlaylistPath = {
  readonly name: string;
  readonly start: () => boolean;
};

const PATHS: readonly PlaylistPath[] = [
  {
    name: 'add a YouTube track',
    start: () =>
      handleProRoomYouTubeForSession(
        captureProRoomMediaHookSession()!,
        { queueItemId: ADDED, type: 'youtube', name: 'Added', videoId: '9bZkp7q19f0' },
        'https://youtube.test/added',
      ),
  },
  {
    name: 'edit track details',
    start: () => handleProRoomTrackMetadata(FIRST, { name: 'Renamed', title: 'Renamed' }),
  },
  { name: 'remove tracks', start: () => handleProRoomTrackRemoval([SECOND]) },
  {
    name: 'move a track',
    start: () => handleProRoomTrackReorder(SECOND, FIRST, getState('playlist.revision')),
  },
  { name: 'switch playlists', start: () => handleProRoomPlaylistSwitch(1) },
  { name: 'copy tracks', start: () => handleProRoomTrackTransfer([FIRST], [1], 'copy') },
  { name: 'move tracks', start: () => handleProRoomTrackTransfer([FIRST], [2], 'move') },
];

describe('PRO playlist feedback when the room receipt ledger is full', () => {
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

  async function toastsAfter(path: PlaylistPath, failure: Error): Promise<string[]> {
    await join(snapshot(), failure);
    const toasts: string[] = [];
    const stopListening = bus.on('ui:show-toast', (message) => {
      toasts.push(String(message));
    });
    try {
      expect(path.start()).toBe(true);
      await vi.waitFor(() => expect(toasts).not.toEqual([]));
      // Let a late second toast surface before reading the list.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return toasts;
    } finally {
      stopListening();
    }
  }

  it.each(PATHS)('says the room cannot take more changes when it fails to $name', async (path) => {
    const toasts = await toastsAfter(
      path,
      new ProRoomApiError('ROOM_STATE_CAPACITY_EXCEEDED', 409),
    );
    expect(toasts).toEqual([t('pro.room_state_limit')]);
    expect(toasts).not.toContain(t('playlist.mutation_retry'));
  });

  it('keeps the other playlist failure messages', async () => {
    expect(
      await toastsAfter(PATHS[2]!, new ProRoomApiError('PLAYLIST_CAPACITY_EXCEEDED', 409)),
    ).toEqual([t('playlist.queue_full')]);
  });

  it('keeps the move failure message for other errors', async () => {
    expect(await toastsAfter(PATHS[3]!, new ProRoomApiError('NETWORK_ERROR'))).toEqual([
      t('playlist.reorder_failed'),
    ]);
  });

  it('keeps the connection failure message for other errors', async () => {
    expect(await toastsAfter(PATHS[4]!, new ProRoomApiError('NETWORK_ERROR'))).toEqual([
      t('pro.connect_failed'),
    ]);
  });
});
