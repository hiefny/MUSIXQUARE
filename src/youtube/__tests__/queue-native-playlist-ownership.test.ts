/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initPlaylist, playTrack } from '../../player/playlist.ts';
import { setPlaybackTrackMeta, setPlaybackYouTubePaused } from '../../player/ownership.ts';
import { initYouTube } from '../player.ts';
import * as search from '../search.ts';
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
    [A_PLAYLIST]: { ids: [...A_VIDEOS], titles: [], manifestComplete: true },
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function removeAWhileBRequestsItsManifest(playlistOnly = false) {
  const { cuePlaylist, player, fake } = makeResidentPlayer();
  let resolve!: (manifest: search.YouTubePlaylistManifest) => void;
  const pending = new Promise<search.YouTubePlaylistManifest>((yes) => {
    resolve = yes;
  });
  vi.spyOn(search, 'resolveYouTubePlaylistManifest').mockReturnValue(pending);
  setState('youtube.subItemsMap', {
    [A_PLAYLIST]: { ids: [...A_VIDEOS], titles: [], manifestComplete: true },
    [B_PLAYLIST]: { ids: playlistOnly ? [] : [B_VIDEOS[0]], titles: [] },
  });
  if (playlistOnly)
    setState(
      'playlist.items',
      getState('playlist.items').map((item) =>
        item.queueItemId === B_ID ? { ...item, videoId: null } : item,
      ),
    );
  bus.emit('playlist:remove-tracks', [A_ID]);
  expect(getState('playlist.currentQueueItemId')).toBe(B_ID);
  expect(cuePlaylist).not.toHaveBeenCalled();
  expect(getYtIndexingSession()).toBeNull();
  expect(player.getPlaylist?.()).toEqual(A_VIDEOS);
  const finish = async () => {
    resolve({ playlistId: B_PLAYLIST, videoId: B_VIDEOS[0], videoIds: [...B_VIDEOS], title: 'B' });
    await vi.advanceTimersByTimeAsync(1);
  };
  return { fake, player, cuePlaylist, finish };
}

describe('native playlist cache ownership during queue replacement', () => {
  it('does not store the deleted row playlist under its pending successor after a fast Next', async () => {
    await removeAWhileBRequestsItsManifest();
    bus.emit('playlist:next-track');
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('youtube.subItemsMap')[B_PLAYLIST].ids).toEqual([B_VIDEOS[0]]);
  });

  it('does not populate an empty successor from the old native cache while acquiring its complete manifest', async () => {
    await removeAWhileBRequestsItsManifest(true);
    bus.emit('youtube:populate-sub-items', B_PLAYLIST, B_ID);
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('youtube.subItemsMap')[B_PLAYLIST].ids).toEqual([]);
  });

  it('accepts the successor native list after manifest acquisition completes and navigates its own next video', async () => {
    const { fake, finish } = await removeAWhileBRequestsItsManifest();
    await finish();
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

  it('repairs a truncated cache from the server rather than the retained native list', async () => {
    const { fake } = makeResidentPlayer();
    vi.spyOn(search, 'resolveYouTubePlaylistManifest').mockResolvedValueOnce({
      playlistId: A_PLAYLIST,
      videoId: A_VIDEOS[0],
      videoIds: [...A_VIDEOS],
      title: 'A',
    });
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

  it('owns Next synchronously while repairing 200 IDs, then plays the 201st without leaving the row', async () => {
    const ids = Array.from({ length: 248 }, (_, i) => `video${String(i).padStart(6, '0')}`);
    const { fake } = makeResidentPlayer();
    fake.__videoId = ids[199];
    setState('youtube.currentSubIndex', 199);
    setState('youtube.subItemsMap', { [A_PLAYLIST]: { ids: ids.slice(0, 200), titles: [] } });
    let finish!: (manifest: search.YouTubePlaylistManifest) => void;
    vi.spyOn(search, 'resolveYouTubePlaylistManifest').mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    bus.emit('playlist:next-track');
    expect(getState('playlist.currentQueueItemId')).toBe(A_ID);
    expect(getState('youtube.currentSubIndex')).toBe(199);
    finish({ playlistId: A_PLAYLIST, videoId: ids[0], videoIds: ids, title: 'A' });
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('playlist.currentQueueItemId')).toBe(A_ID);
    expect(getState('youtube.currentSubIndex')).toBe(200);
    expect(fake.getVideoData().video_id).toBe(ids[200]);
  });

  it.each(['next', 'previous'] as const)(
    're-enters outer %s navigation at the true complete-manifest boundary',
    async (direction) => {
      const { fake } = makeResidentPlayer();
      const currentId = direction === 'next' ? A_ID : B_ID;
      const otherId = direction === 'next' ? B_ID : A_ID;
      const playlistId = direction === 'next' ? A_PLAYLIST : B_PLAYLIST;
      const ids = direction === 'next' ? A_VIDEOS : B_VIDEOS;
      setState(
        'playlist.items',
        getState('playlist.items').map((item) =>
          item.queueItemId === otherId ? { ...item, playlistId: null } : item,
        ),
      );
      setState('playlist.currentQueueItemId', currentId);
      const subIndex = direction === 'next' ? 1 : 0;
      fake.__videoId = ids[subIndex];
      fake.__currentTime = 0;
      setState('youtube.currentSubIndex', subIndex);
      setState('youtube.subItemsMap', { [playlistId]: { ids: [...ids], titles: [] } });
      let finish!: (manifest: search.YouTubePlaylistManifest) => void;
      vi.spyOn(search, 'resolveYouTubePlaylistManifest').mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const chosen: unknown[] = [];
      const dispose = bus.on('state:playlist.currentQueueItemId', (id) => chosen.push(id));
      if (direction === 'next') bus.emit('playlist:next-track');
      else bus.emit('playlist:prev-track');
      expect(getState('playlist.currentQueueItemId')).toBe(currentId);
      finish({ playlistId, videoId: ids[0], videoIds: [...ids], title: 'Full' });
      await vi.advanceTimersByTimeAsync(1);
      expect(getState('playlist.currentQueueItemId')).toBe(otherId);
      expect(chosen.filter((id) => id === otherId)).toHaveLength(1);
      dispose();
    },
  );
});
