/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { ProRoomSnapshot } from '../contracts.ts';
import {
  claimLegacyYouTubeManifestCandidates,
  hydrateProRoomYouTubeManifests,
} from '../youtube-manifest-policy.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';

function snapshot(videoIds: string[]): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      {
        queueItemId: QUEUE_ITEM_ID,
        name: 'Playlist',
        source: {
          kind: 'youtube',
          playlistId: 'PL_MANIFEST',
          videoId: videoIds[0]!,
          videoIds,
        },
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
      participants: [],
    },
    quota: {
      limitBytes: 1024 * 1024 * 1024,
      perAssetLimitBytes: 200 * 1024 * 1024,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: null,
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_owner_0001',
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
        onlineDeviceCount: 0,
      },
    ],
  };
}

describe('PRO YouTube manifest runtime projection', () => {
  beforeEach(() => resetState());

  it('hydrates canonical IDs without discarding richer endpoint-local titles', () => {
    setState('youtube.subItemsMap', {
      PL_MANIFEST: {
        ids: ['OLDVIDEO001', 'OLDVIDEO002'],
        titles: ['Resolved first title', 'Resolved second title'],
        loadError: true,
      },
    });
    const authoritative = snapshot(['NEWVIDEO001', 'NEWVIDEO002']);

    hydrateProRoomYouTubeManifests(authoritative);

    expect(getState('youtube.subItemsMap').PL_MANIFEST).toEqual({
      ids: ['NEWVIDEO001', 'NEWVIDEO002'],
      titles: ['Resolved first title', 'Resolved second title'],
      loadError: true,
      manifestComplete: true,
    });
    if (authoritative.playlist[0]?.source.kind !== 'youtube') throw new Error('fixture');
    authoritative.playlist[0].source.videoIds![0] = 'MUTATED0001';
    expect(getState('youtube.subItemsMap').PL_MANIFEST?.ids[0]).toBe('NEWVIDEO001');
  });

  it('promotes an identical one-item placeholder to a complete server manifest', () => {
    setState('youtube.subItemsMap', {
      PL_MANIFEST: {
        ids: ['NEWVIDEO001'],
        titles: ['Only video'],
      },
    });

    hydrateProRoomYouTubeManifests(snapshot(['NEWVIDEO001']));

    expect(getState('youtube.subItemsMap').PL_MANIFEST).toMatchObject({
      ids: ['NEWVIDEO001'],
      titles: ['Only video'],
      manifestComplete: true,
    });
  });

  it('reserves most of the per-IP resolver budget for explicit user actions', () => {
    const legacy = snapshot(['NEWVIDEO001']);
    legacy.playlist = Array.from({ length: 7 }, (_, index) => ({
      queueItemId: `${index + 1}0000000-0000-4000-8000-000000000000`,
      name: `Legacy ${index}`,
      source: {
        kind: 'youtube' as const,
        videoId: `VIDEOID${String(index).padStart(4, '0')}`,
        playlistId: `PL_LEGACY_${index}`,
      },
    }));
    legacy.currentQueueItemId = legacy.playlist[0]!.queueItemId;
    const alreadyHydrated = legacy.playlist[1]!.source;
    if (alreadyHydrated.kind !== 'youtube') throw new Error('fixture');
    alreadyHydrated.videoIds = [alreadyHydrated.videoId];

    const attempted = new Set<QueueItemId>();
    expect(
      claimLegacyYouTubeManifestCandidates(legacy, attempted).map(
        (candidate) => candidate.queueItemId,
      ),
    ).toEqual(legacy.playlist.slice(2, 6).map((item) => item.queueItemId));
  });
});
