/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import type { ProRoomSnapshot } from '../contracts.ts';
import {
  claimLegacyYouTubeManifestCandidatesForTests,
  hydrateProRoomYouTubeManifestsForTests,
  maxLazyYouTubeManifestUpgradesForTests,
} from '../runtime.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';

function snapshot(videoIds: string[]): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
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

    hydrateProRoomYouTubeManifestsForTests(authoritative);

    expect(getState('youtube.subItemsMap').PL_MANIFEST).toEqual({
      ids: ['NEWVIDEO001', 'NEWVIDEO002'],
      titles: ['Resolved first title', 'Resolved second title'],
      loadError: true,
    });
    if (authoritative.playlist[0]?.source.kind !== 'youtube') throw new Error('fixture');
    authoritative.playlist[0].source.videoIds![0] = 'MUTATED0001';
    expect(getState('youtube.subItemsMap').PL_MANIFEST?.ids[0]).toBe('NEWVIDEO001');
  });

  it('reserves most of the per-IP resolver budget for explicit user actions', () => {
    expect(maxLazyYouTubeManifestUpgradesForTests()).toBeGreaterThan(0);
    expect(maxLazyYouTubeManifestUpgradesForTests()).toBeLessThanOrEqual(4);

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
    legacy.playlist[1]!.source.videoIds = [legacy.playlist[1]!.source.videoId];

    expect(claimLegacyYouTubeManifestCandidatesForTests(legacy)).toEqual(
      legacy.playlist.slice(2, 6).map((item) => item.queueItemId),
    );
  });
});
