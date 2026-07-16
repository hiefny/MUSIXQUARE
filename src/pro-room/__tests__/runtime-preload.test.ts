/**
 * @vitest-environment jsdom
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getState, setState } from '../../core/state.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomR2Source,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { preloadProRoomPlaylistFile, resolveProRoomPlaylistFile } from '../legacy-media-hooks.ts';
import { ProRoomMediaTransfer } from '../media-transfer.ts';
import { LegacyProRoomNetworkBridge } from '../network-bridge.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { joinProRoom } from '../runtime.ts';

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
      coordinatorParticipantId: PARTICIPANT_ID,
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
      coordinatorEligible: true,
    },
  };
}

function signalingAccess(): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: Date.now() + 60_000,
    role: 'coordinator',
    coordinatorEpoch: 1,
    presenceIncarnationId: 'presence_0000000001',
    ticketSequence: 1,
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
      vi.spyOn(LegacyProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined),
      vi.spyOn(LegacyProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {}),
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
});
