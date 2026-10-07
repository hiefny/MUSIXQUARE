/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { playTrack } from '../../player/playlist.ts';
import { setPlaybackTrackMeta, setPlaybackYouTubePaused } from '../../player/ownership.ts';
import { ProRoomPlaylistProjection } from '../../pro-room/playlist-projection.ts';
import { hydrateProRoomYouTubeManifests } from '../../pro-room/youtube-manifest-policy.ts';
import type { ProRoomSnapshot } from '../../pro-room/contracts.ts';
import {
  createProPlaybackAuthorityToken,
  registerProPlaybackCommandHandler,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import { initYouTube } from '../player.ts';
import {
  markYtPlayerReady,
  resetYouTubeModuleState,
  setYouTubePlayer,
  updateSubItemIds,
  type YouTubePlayerInstance,
} from '../_state.ts';
import { getPlaylistSubItems, proYouTubeSubItemsKey } from '../queue-manifest.ts';
import { cancelSubTitleFetch } from '../search.ts';
import { makeFakeYtPlayer } from './__helpers__/fake-yt-player.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const PLAYLIST = 'PL_SHARED_123';
const A = 'dQw4w9WgXcQ';
const B = 'M7lc1UVf-VE';
const C = 'jNQXAC9IVRw';

beforeAll(() => initYouTube());
beforeEach(() => {
  clearAllManagedTimers();
  resetYouTubeModuleState();
  resetState();
  vi.useFakeTimers();
  vi.stubGlobal('YT', {
    Player: vi.fn(),
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => Response.json({ title: url.includes(B) ? 'Saved B' : 'Saved A' })),
  );
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('setup.sessionStarted', true);
  setState('player.isFirstTrackLoad', false);
  const playlist = [
    {
      queueItemId: FIRST,
      name: 'Old saved list',
      source: { kind: 'youtube' as const, videoId: A, playlistId: PLAYLIST, videoIds: [A, B] },
    },
    {
      queueItemId: SECOND,
      name: 'New saved list',
      source: { kind: 'youtube' as const, videoId: A, playlistId: PLAYLIST, videoIds: [A, C] },
    },
  ];
  const projected = new ProRoomPlaylistProjection().project(playlist);
  setState('playlist.items', projected);
  setState('playlist.currentQueueItemId', FIRST);
  setState('youtube.currentSubIndex', 0);
  hydrateProRoomYouTubeManifests({ playlist } as ProRoomSnapshot);
  updateSubItemIds(PLAYLIST, [A, C], { manifestComplete: true });
  setPlaybackTrackMeta(projected[0]!);
  setPlaybackYouTubePaused();
});
afterEach(() => {
  bus.emit('youtube:stop-mode', { silent: true });
  cancelSubTitleFetch();
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  resetYouTubeModuleState();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function resident() {
  const fake = makeFakeYtPlayer({ __videoId: A, __playlist: [A, C], __playlistIdx: 0 });
  const cuePlaylist = vi.fn();
  const player = Object.assign(fake, {
    cuePlaylist,
    loadPlaylist: cuePlaylist,
  }) as unknown as YouTubePlayerInstance;
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  return { fake, cuePlaylist };
}

it('loads the selected occurrence as its concrete video, even after its title cache is evicted', () => {
  const { fake, cuePlaylist } = resident();
  setState('youtube.subItemsMap', { [PLAYLIST]: { ids: [A, C], titles: [] } });
  bus.emit('youtube:load', A, PLAYLIST, FIRST, false, 1);
  expect(fake.getVideoData().video_id).toBe(B);
  expect(cuePlaylist).not.toHaveBeenCalled();
});

it('uses its manifest fallback during server-authorized preparation', async () => {
  const { fake, cuePlaylist } = resident();
  const authority = createProPlaybackAuthorityToken({
    roomId: '000001',
    roomEpoch: 1,
    basePlaybackRevision: 0,
    transitionId: 'prepare-saved',
  });
  await playTrack(FIRST, 1, {
    proAuthority: authority,
    proAuthorityPreparation: { positionSeconds: 0, youtubeSubIndex: 1, youtubeVideoId: null },
  });
  expect(fake.getVideoData().video_id).toBe(B);
  expect(cuePlaylist).not.toHaveBeenCalled();
});

it('sends a sub-row selection with the occurrence video ID', () => {
  const handler = vi.fn();
  registerProPlaybackCommandHandler(handler);
  bus.emit('youtube:sub-seek', FIRST, 1, false);
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ queueItemId: FIRST, youtubeSubIndex: 1, youtubeVideoId: B }),
  );
});

it('refills and labels an evicted occurrence from its stored IDs without native-list contamination', async () => {
  resident();
  setState('youtube.subItemsMap', { [PLAYLIST]: { ids: [A, C], titles: ['', 'New C'] } });
  bus.emit('youtube:populate-sub-items', PLAYLIST, FIRST);
  await vi.advanceTimersByTimeAsync(1000);
  expect(getState('youtube.subItemsMap')[proYouTubeSubItemsKey(FIRST)]).toMatchObject({
    ids: [A, B],
    titles: ['Saved A', 'Saved B'],
    manifestComplete: true,
  });
  expect(getState('youtube.subItemsMap')[PLAYLIST]).toEqual({ ids: [A, C], titles: ['', 'New C'] });
  expect(getPlaylistSubItems(getState('playlist.items')[1])?.ids).toEqual([A, C]);
});

it('reports an ended occurrence with its saved video when iframe metadata is unavailable', () => {
  const fake = makeFakeYtPlayer({ __videoId: B, __playlist: [], __playlistIdx: -1 });
  const player = Object.assign(fake, {
    cuePlaylist: vi.fn(),
    loadPlaylist: vi.fn(),
  }) as unknown as YouTubePlayerInstance;
  let ready!: () => void;
  vi.stubGlobal('YT', {
    Player: function (
      _element: string,
      options: {
        events: {
          onReady: (event: { target: YouTubePlayerInstance }) => void;
          onStateChange: NonNullable<typeof fake.__onStateChange>;
        };
      },
    ) {
      ready = () => options.events.onReady({ target: player });
      fake.__onStateChange = options.events.onStateChange;
      return player;
    },
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  });
  const handler = vi.fn();
  registerProPlaybackCommandHandler(handler);
  bus.emit('youtube:load', B, PLAYLIST, FIRST, false, 1);
  ready();
  fake.__videoId = '';
  fake.__currentTime = fake.__duration;
  fake.__setState(0);
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'ended',
      queueItemId: FIRST,
      youtubeSubIndex: 1,
      youtubeVideoId: B,
    }),
  );
});

it('navigates backward within the selected saved occurrence', async () => {
  resident();
  const items = getState('playlist.items');
  setState(
    'playlist.items',
    items.map((item) =>
      item.queueItemId === SECOND ? { ...item, videoId: C, youtubeVideoIds: [C, B] } : item,
    ),
  );
  setState('playlist.currentQueueItemId', SECOND);
  setState('youtube.currentSubIndex', 1);
  const navigate = vi.fn();
  const handler = vi.fn();
  registerProPlaybackCommandHandler(handler);
  let selection: Promise<void> | undefined;
  const unsubscribe = bus.on('playlist:play-track', (queueItemId, subIndex, options) => {
    navigate(queueItemId, subIndex, options);
    selection = playTrack(queueItemId, subIndex, options);
  });
  const result = vi.fn();
  bus.emit('youtube:try-prev-internal', result);
  expect(result).toHaveBeenCalledWith(true);
  expect(navigate).toHaveBeenCalledWith(SECOND, 0, { navigateToPlay: false });
  await selection;
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'select', queueItemId: SECOND, youtubeVideoId: C }),
  );
  unsubscribe();
});
