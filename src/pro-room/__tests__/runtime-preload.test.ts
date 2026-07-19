/**
 * @vitest-environment jsdom
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, setState } from '../../core/state.ts';
import { setPlaybackTrackMeta } from '../../player/ownership.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomR2Source,
  type ProRoomSnapshot,
} from '../contracts.ts';
import {
  handleProRoomTrackRemoval,
  preloadProRoomPlaylistFile,
  resolveProRoomPlaylistFile,
} from '../legacy-media-hooks.ts';
import { ProRoomMediaTransfer } from '../media-transfer.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_00001';
const CACHE_QUEUE_ITEM_ID = '30000000-0000-4000-8000-000000000001' as QueueItemId;
const PROMOTE_QUEUE_ITEM_ID = '30000000-0000-4000-8000-000000000002' as QueueItemId;

const CACHE_SOURCE: ProRoomR2Source = {
  kind: 'pro-r2',
  assetId: 'asset_00000000001',
  version: 1,
  byteLength: 4,
  mime: 'audio/flac',
};
const PROMOTE_SOURCE: ProRoomR2Source = {
  kind: 'pro-r2',
  assetId: 'asset_00000000002',
  version: 1,
  byteLength: 4,
  mime: 'audio/flac',
};

const CACHE_FILE = new File(['warm'], 'cached-before-selection.flac', {
  type: 'audio/flac',
});
const PROMOTED_FILE = new File(['play'], 'promoted-in-flight.flac', {
  type: 'audio/flac',
});

function roomSnapshot(): ProRoomSnapshot {
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
      {
        queueItemId: CACHE_QUEUE_ITEM_ID,
        name: CACHE_FILE.name,
        source: CACHE_SOURCE,
      },
      {
        queueItemId: PROMOTE_QUEUE_ITEM_ID,
        name: PROMOTED_FILE.name,
        source: PROMOTE_SOURCE,
      },
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
      revision: 1,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          displayName: 'Owner',
          role: 'owner',
          joinedAtMs: 1,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: CACHE_SOURCE.byteLength + PROMOTE_SOURCE.byteLength,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_0000000001',
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [...capabilitiesForProRoomRole('owner')],
      coordinatorEligible: false,
    },
  };
}

function signalingAccess(): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: Date.now() + 60_000,
    role: 'member',
    coordinatorEpoch: 1,
    presenceIncarnationId: 'presence_0000000001',
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

describe.sequential('PRO room runtime preload adoption', () => {
  const restoreSpies: Array<{ mockRestore(): void }> = [];
  let download: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const snapshot = roomSnapshot();
    restoreSpies.push(
      vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(snapshot),
      vi
        .spyOn(ProRoomApiClient.prototype, 'createSignalingTicket')
        .mockResolvedValue(signalingAccess()),
      vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
        generation: 0,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined),
      vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined),
      vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined),
      vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {}),
    );

    download = vi
      .spyOn(ProRoomMediaTransfer.prototype, 'download')
      .mockImplementation(async function (input) {
        const file = input.source.assetId === CACHE_SOURCE.assetId ? CACHE_FILE : PROMOTED_FILE;
        this.cache.put(input.source, file);
        input.onProgress?.(1);
        return file;
      });
    restoreSpies.push(download);

    await joinProRoom({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
  });

  afterAll(async () => {
    setState('files.current', null);
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    for (const spy of restoreSpies.reverse()) spy.mockRestore();
  });

  it('reuses a completed cache hit even when resolveFile runs before queue selection', async () => {
    const preload = preloadProRoomPlaylistFile(CACHE_QUEUE_ITEM_ID);
    expect(preload).not.toBeNull();
    await expect(preload).resolves.toBe(CACHE_FILE);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(
      getState('playlist.items').find((item) => item.queueItemId === CACHE_QUEUE_ITEM_ID)?.file,
    ).toBeUndefined();

    const callsBeforeResolve = download.mock.calls.length;
    const resolved = resolveProRoomPlaylistFile(CACHE_QUEUE_ITEM_ID);

    await expect(resolved).resolves.toBe(CACHE_FILE);
    expect(download).toHaveBeenCalledTimes(callsBeforeResolve);
  });

  it('lets foreground promotion bypass the encoded background-overlap skip', async () => {
    setState('files.current', {
      queueItemId: CACHE_QUEUE_ITEM_ID,
      indexHint: 0,
      name: 'large-current.flac',
      sessionId: 7,
      blob: { size: PRO_ROOM_MAX_ASSET_BYTES } as Blob,
      mime: 'audio/flac',
      size: PRO_ROOM_MAX_ASSET_BYTES,
    });

    const preload = preloadProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
    const foreground = resolveProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);

    expect(preload).not.toBeNull();
    expect(foreground).toBe(preload);
    await expect(foreground).resolves.toBe(PROMOTED_FILE);
    expect(
      download.mock.calls.filter(([input]) => input.source.assetId === PROMOTE_SOURCE.assetId),
    ).toHaveLength(1);
  });

  it('refreshes the authoritative snapshot from an exact server invalidation hint', async () => {
    const next = { ...roomSnapshot(), revision: 2, playlistRevision: 2 };
    const refresh = vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(next);

    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM_CODE,
      coordinatorEpoch: 2,
      event: { type: 'pro-room-invalidated', roomRevision: 2, playlistRevision: 2 },
    });
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();

    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM_CODE,
      coordinatorEpoch: 1,
      event: { type: 'pro-room-invalidated', roomRevision: 2, playlistRevision: 2 },
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    refresh.mockRestore();
  });

  it('renders server-fanned-out queue additions once in authoritative revision order', async () => {
    const messages: string[] = [];
    const off = bus.on('chat:system-message', (text) => messages.push(text));
    const later = {
      type: 'pro-queue-addition' as const,
      version: 1 as const,
      roomCode: ROOM_CODE,
      coordinatorEpoch: 1,
      playlistRevision: 4,
      eventId: 'qa_000001_4_6',
      actorName: 'Later bot',
      count: 2,
    };
    const earlier = {
      ...later,
      playlistRevision: 3,
      eventId: 'qa_000001_3_5',
      actorName: 'Earlier bot',
      count: 1,
    };

    const serverFrame = (addition: typeof later | typeof earlier, coordinatorEpoch = 1) => ({
      type: 'pro-server-event' as const,
      version: 1 as const,
      roomCode: ROOM_CODE,
      coordinatorEpoch,
      event: {
        type: 'pro-room-invalidated',
        roomRevision: 6,
        playlistRevision: addition.playlistRevision,
        addition,
      },
    });

    const accepted = { ...roomSnapshot(), revision: 6, playlistRevision: 4 };
    const refresh = vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(accepted);
    acceptProRoomRealtimeFrameForTests(serverFrame(later));
    acceptProRoomRealtimeFrameForTests(serverFrame(earlier));
    acceptProRoomRealtimeFrameForTests(serverFrame(later));
    acceptProRoomRealtimeFrameForTests(
      serverFrame(
        {
          ...later,
          coordinatorEpoch: 2,
          eventId: 'qa_000001_5_7',
        },
        2,
      ),
    );

    // The server event itself is only a hint. Its paired heartbeat accepts the
    // canonical playlist revision before the queued system rows are rendered.
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(refresh).toHaveBeenCalled();
    expect(messages[0]).toContain('Earlier bot');
    expect(messages[1]).toContain('Later bot');

    acceptProRoomRealtimeFrameForTests(
      serverFrame({
        ...earlier,
        playlistRevision: 2,
        eventId: 'qa_000001_2_4',
        actorName: 'Late old bot',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(messages).toHaveLength(2);
    refresh.mockRestore();
    off();
  });

  it('clears stale playback metadata when an accepted projection empties the room', async () => {
    setState('playlist.currentQueueItemId', CACHE_QUEUE_ITEM_ID);
    setPlaybackTrackMeta({
      type: 'youtube',
      name: 'Deleted title',
      title: 'Deleted title',
      videoId: 'deletedVideo',
      playlistId: null,
    });
    setState('files.current', {
      queueItemId: CACHE_QUEUE_ITEM_ID,
      indexHint: 0,
      name: CACHE_FILE.name,
      sessionId: 9,
      blob: CACHE_FILE,
      mime: CACHE_FILE.type,
      size: CACHE_FILE.size,
    });
    const update = vi
      .spyOn(ProRoomApiClient.prototype, 'updateCompactSnapshot')
      .mockImplementation(async (input) => ({
        ...roomSnapshot(),
        revision: input.baseRevision + 1,
        playlistRevision: input.baseRevision + 1,
        playlist: [],
        currentQueueItemId: null,
        playback: {
          ...roomSnapshot().playback,
          revision: 1,
          queueItemId: null,
          state: 'idle' as const,
        },
      }));
    const deleteAsset = vi
      .spyOn(ProRoomMediaTransfer.prototype, 'deleteAsset')
      .mockResolvedValue(undefined);

    expect(handleProRoomTrackRemoval([CACHE_QUEUE_ITEM_ID, PROMOTE_QUEUE_ITEM_ID])).toBe(true);

    await vi.waitFor(() => expect(getState('playlist.items')).toEqual([]));
    expect(update).toHaveBeenCalledOnce();
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('files.current')).toBeNull();
    deleteAsset.mockRestore();
    update.mockRestore();
  });
});
