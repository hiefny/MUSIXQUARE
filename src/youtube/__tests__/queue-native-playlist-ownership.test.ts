/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initPlaylist, playTrack } from '../../player/playlist.ts';
import { setPlaybackTrackMeta, setPlaybackYouTubePaused } from '../../player/ownership.ts';
import { initYouTube } from '../player.ts';
import {
  getYtIndexingSession,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setYouTubePlayer,
  type YouTubePlayerInstance,
} from '../_state.ts';
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

const A_ID = '16111111-1111-4111-8111-111111111111';
const B_ID = '16222222-2222-4222-8222-222222222222';
const A_PLAYLIST = 'PL_NATIVE_OWNED_A';
const B_PLAYLIST = 'PL_NATIVE_PENDING_B';
const A_VIDEOS = ['aaaaaa00001', 'aaaaaa00002'];
const B_VIDEOS = ['bbbbbb00001', 'bbbbbb00002'];

function makeResidentPlayer(attach = true) {
  const fake = makeFakeYtPlayer({
    __videoId: A_VIDEOS[0],
    __playlist: [...A_VIDEOS],
    __playlistIdx: 0,
  });
  // The iframe command is asynchronous: until its remote response arrives,
  // the resident API cache continues exposing A. No application Promise is
  // suspended, and no obsolete callback is injected after cancellation.
  const cuePlaylist = vi.fn(() => {
    fake.__state = 3;
  });
  const player = Object.assign(fake, {
    cuePlaylist,
    loadPlaylist: cuePlaylist,
  }) as unknown as YouTubePlayerInstance;
  if (attach) {
    setYouTubePlayer(player);
    markYtPlayerReady(player);
  }
  return { fake, player, cuePlaylist };
}

beforeAll(() => {
  initPlaylist();
  initYouTube();
});

beforeEach(() => {
  clearAllManagedTimers();
  resetYouTubeModuleState();
  resetState();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('YT', {
    Player: vi.fn(),
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ title: 'Fixture title' })),
  );
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
  setState('network.appRole', 'host');
  setState('network.myId', 'native-playlist-host');
  setState('network.sessionCode', '161616');
  setState('setup.sessionStarted', true);
  setState('player.isFirstTrackLoad', false);
  const a = {
    queueItemId: A_ID,
    type: 'youtube' as const,
    name: 'Playlist A',
    videoId: A_VIDEOS[0],
    playlistId: A_PLAYLIST,
  };
  const b = {
    queueItemId: B_ID,
    type: 'youtube' as const,
    name: 'Playlist B',
    videoId: B_VIDEOS[0],
    playlistId: B_PLAYLIST,
  };
  setState('playlist.items', [a, b]);
  setState('playlist.currentQueueItemId', A_ID);
  setState('youtube.subItemsMap', {
    [A_PLAYLIST]: { ids: [...A_VIDEOS], titles: [] },
    [B_PLAYLIST]: { ids: [B_VIDEOS[0]], titles: [] },
  });
  setState('youtube.currentSubIndex', 0);
  setPlaybackTrackMeta(a);
  setPlaybackYouTubePaused();
});

afterEach(() => {
  bus.emit('youtube:stop-mode', { silent: true });
  clearAllManagedTimers();
  resetYouTubeModuleState();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function removeAWhileBRequestsItsNativePlaylist(playlistOnly = false) {
  const { cuePlaylist, player, fake } = makeResidentPlayer(false);
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
  setState('youtube.subItemsMap', {
    [A_PLAYLIST]: { ids: [A_VIDEOS[0]], titles: [] },
    [B_PLAYLIST]: { ids: playlistOnly ? [] : [B_VIDEOS[0]], titles: [] },
  });
  if (playlistOnly) {
    setState(
      'playlist.items',
      getState('playlist.items').map((item) =>
        item.queueItemId === B_ID ? { ...item, videoId: null } : item,
      ),
    );
  }
  await playTrack(A_ID, 0);
  ready();
  expect(cuePlaylist).toHaveBeenLastCalledWith(expect.objectContaining({ list: A_PLAYLIST }));
  // Native A has produced its first complete API snapshot. The real indexer
  // now waits 300 ms for a second stable sample before accepting that list.
  fake.__setState(5);
  expect(getYtIndexingSession()?.playlistId).toBe(A_PLAYLIST);
  expect(getState('youtube.subItemsMap')[A_PLAYLIST].ids).toEqual([A_VIDEOS[0]]);
  bus.emit('playlist:remove-tracks', [A_ID]);
  expect(getState('playlist.currentQueueItemId')).toBe(B_ID);
  expect(cuePlaylist).toHaveBeenCalledWith(expect.objectContaining({ list: B_PLAYLIST }));
  expect(getYtIndexingSession()?.playlistId).toBe(B_PLAYLIST);
  expect(player.getPlaylist?.()).toEqual(A_VIDEOS);
  return { fake, player, cuePlaylist };
}

describe('native playlist cache ownership during queue replacement', () => {
  it('does not store the deleted row playlist under its pending successor after a fast Next', async () => {
    await removeAWhileBRequestsItsNativePlaylist();
    bus.emit('playlist:next-track');
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('youtube.subItemsMap')[B_PLAYLIST].ids).toEqual([B_VIDEOS[0]]);
  });

  it('does not populate an empty successor from the old native cache while indexing', async () => {
    await removeAWhileBRequestsItsNativePlaylist(true);
    bus.emit('youtube:populate-sub-items', B_PLAYLIST, B_ID);
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('youtube.subItemsMap')[B_PLAYLIST].ids).toEqual([]);
  });

  it('accepts the successor native list after indexing completes and navigates its own next video', async () => {
    const { fake } = await removeAWhileBRequestsItsNativePlaylist();
    fake.__playlist = [...B_VIDEOS];
    fake.__videoId = B_VIDEOS[0];
    fake.__playlistIdx = 0;
    fake.__setState(5);
    await vi.advanceTimersByTimeAsync(301);
    expect(getYtIndexingSession()).toBeNull();
    expect(getState('youtube.subItemsMap')[B_PLAYLIST].ids).toEqual(B_VIDEOS);
    bus.emit('playlist:next-track');
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('playlist.currentQueueItemId')).toBe(B_ID);
    expect(getState('youtube.currentSubIndex')).toBe(1);
    expect(fake.getVideoData().video_id).toBe(B_VIDEOS[1]);
  });

  it('still navigates a fully indexed current playlist after an unrelated reorder', async () => {
    makeResidentPlayer();
    bus.emit('playlist:reorder-track', B_ID, A_ID, getState('playlist.revision'));
    expect(getState('playlist.currentQueueItemId')).toBe(A_ID);
    await playTrack(A_ID, 1, { navigateToPlay: false });
    expect(getState('youtube.subItemsMap')[A_PLAYLIST].ids).toEqual(A_VIDEOS);
    expect(getState('youtube.currentSubIndex')).toBe(1);
    expect(getState('player.currentTrackMeta')?.queueItemId).toBe(A_ID);
  });

  it('keeps the settled native fallback when the current cached list is truncated', async () => {
    const { fake } = makeResidentPlayer();
    setState('youtube.subItemsMap', {
      [A_PLAYLIST]: { ids: [A_VIDEOS[0]], titles: [] },
    });
    expect(getYtIndexingSession()).toBeNull();
    bus.emit('playlist:next-track');
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('youtube.subItemsMap')[A_PLAYLIST].ids).toEqual(A_VIDEOS);
    expect(getState('playlist.currentQueueItemId')).toBe(A_ID);
    expect(getState('youtube.currentSubIndex')).toBe(1);
    expect(fake.getVideoData().video_id).toBe(A_VIDEOS[1]);
  });
});
