/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MusixquareProRoom } from '../../../cloudflare/pro-room-worker.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { playTrack } from '../../player/playlist.ts';
import type { ProRoomPlaylistWireItem, ProRoomSnapshot } from '../contracts.ts';
import {
  registerProPlaybackCommandHandler,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackUserIntent,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaylistProjection } from '../playlist-projection.ts';
import { hydrateProRoomYouTubeManifests } from '../youtube-manifest-policy.ts';
import { updateSubItemIds } from '../../youtube/_state.ts';
import { proYouTubeSubItemsKey } from '../../youtube/queue-manifest.ts';

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const A = 'dQw4w9WgXcQ';
const B = 'M7lc1UVf-VE';
const C = 'jNQXAC9IVRw';

function row(queueItemId: string, videoIds: string[]): ProRoomPlaylistWireItem {
  return {
    queueItemId,
    name: 'Saved playlist',
    source: { kind: 'youtube', playlistId: 'PL_SHARED_123', videoId: videoIds[0]!, videoIds },
  };
}

beforeEach(() => {
  resetState();
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
});
afterEach(() => {
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
});

async function select(playlist: ProRoomPlaylistWireItem[], queueItemId = FIRST, evict = false) {
  setState('playlist.items', new ProRoomPlaylistProjection().project(playlist));
  hydrateProRoomYouTubeManifests({ playlist } as ProRoomSnapshot);
  if (evict) {
    for (let index = 0; index < 50; index++) updateSubItemIds(`PL_OTHER_${index}`, [C]);
    expect(getState('youtube.subItemsMap')[proYouTubeSubItemsKey(queueItemId)]).toBeUndefined();
  }
  const intents: ProPlaybackUserIntent[] = [];
  registerProPlaybackCommandHandler((intent) => {
    intents.push(intent);
  });
  await playTrack(queueItemId, 1);
  const intent = intents[0]!;
  if (intent.kind !== 'select') throw new Error('Expected selection');
  // Exercise the production target validator, without changing its authority
  // contract to accept the client cache's mistaken video ID.
  const worker = Object.create(MusixquareProRoom.prototype) as {
    room: unknown;
    targetPlayback: (...args: unknown[]) => { youtubeVideoId: string } | null;
  };
  worker.room = { playlist, presence: { coordinatorEpoch: 1 }, playback: { revision: 1 } };
  const target = worker.targetPlayback(queueItemId, 'playing', 0, 1000, {
    youtubeSubIndex: intent.youtubeSubIndex,
    youtubeVideoId: intent.youtubeVideoId,
  });
  return { intent, target };
}

it('selects the old immutable occurrence after the same playlist is added with new videos', async () => {
  const { intent, target } = await select([row(FIRST, [A, B]), row(SECOND, [A, C])]);
  expect(intent.youtubeVideoId).toBe(B);
  expect(target?.youtubeVideoId).toBe(B);
});

it('preserves the newer occurrence when the saved rows are reordered', async () => {
  const { intent, target } = await select([row(SECOND, [A, C]), row(FIRST, [A, B])], SECOND);
  expect(intent.youtubeVideoId).toBe(C);
  expect(target?.youtubeVideoId).toBe(C);
});

it('keeps identical duplicate manifests selectable', async () => {
  const { intent, target } = await select([row(FIRST, [A, B]), row(SECOND, [A, B])]);
  expect(intent.youtubeVideoId).toBe(B);
  expect(target?.youtubeVideoId).toBe(B);
});

it('retains canonical selection after the bounded cache evicts the inactive occurrence', async () => {
  const { intent, target } = await select([row(FIRST, [A, B]), row(SECOND, [A, C])], FIRST, true);
  expect(intent.youtubeVideoId).toBe(B);
  expect(target?.youtubeVideoId).toBe(B);
});
