/**
 * @vitest-environment jsdom
 *
 * Regression tests for the playlist-indexing session lifecycle. Indexing state
 * is armed inside loadYouTubeVideo as a clear-then-arm session object, cleared
 * unconditionally by stopYouTubeMode, and identity-guarded throughout the poll
 * chain. Stale state must never route the next YouTube add through auto-play or
 * invoke a callback with another playlist's IDs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import { showLoader } from '../../ui/toast.ts';
import { broadcast } from '../../network/peer.ts';
import { setPlaybackFilePlaying } from '../../player/ownership.ts';
import type { PlaylistItem } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';

const FILE_QUEUE_ITEM_ID = '66666666-6666-4666-8666-666666666666';
const YOUTUBE_QUEUE_ITEM_ID = '77777777-7777-4777-8777-777777777777';

// ─── Mocks (cloned from player.test.ts — keep in sync) ────────────────────

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
  getManagedTimer: vi.fn(() => null),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
  verifyOperator: vi.fn(() => true),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(async () => {}),
}));

vi.mock('../../audio/effects.ts', () => ({
  applySettings: vi.fn(async () => {}),
  setEngineMode: vi.fn(),
}));

vi.mock('../../ui/player-controls.ts', () => ({
  fmtTime: vi.fn(
    (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
  ),
  showPlacementToastForChannel: vi.fn(),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  getRoleLabelByChannelMode: vi.fn(),
}));

vi.mock('../search.ts', () => ({
  extractYouTubeVideoId: vi.fn((url: string) => {
    const m = url.match(/v=([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }),
  extractYouTubePlaylistId: vi.fn(() => null),
  isYouTubeLiveUrl: vi.fn(() => false),
  getYouTubeInputIntent: vi.fn(() => ({ kind: 'invalid-url' })),
  getPrefetchedYouTubePlaylistManifest: vi.fn(() => null),
  getSelectedYouTubeSearchResult: vi.fn(() => null),
  searchYouTubeFromInput: vi.fn(),
  clearYouTubeInputState: vi.fn(),
  fetchYouTubePreview: vi.fn(),
  fetchPlaylistSubTitles: vi.fn(),
  cancelSubTitleFetch: vi.fn(),
}));

// player.ts imports the oEmbed fetcher from the oembed.ts leaf (not search.ts).
vi.mock('../oembed.ts', () => ({
  fetchOEmbedTitle: vi.fn(async () => 'Test Title'),
}));

vi.mock('../sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
  guestRendezvousSync: vi.fn(() => ({ status: 'not-ready' })),
  resetAdDetection: vi.fn(),
  initYouTubeSync: vi.fn(),
  resetYouTubeSyncState: vi.fn(),
  suppressDriftUntil: vi.fn(),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../../ui/dom.ts', () => ({
  animateTransition: vi.fn((fn: () => void) => fn()),
}));

// ─── Harness ───────────────────────────────────────────────────────────────

const setManagedTimerMock = vi.mocked(setManagedTimer);
const clearManagedTimerMock = vi.mocked(clearManagedTimer);
const showLoaderMock = vi.mocked(showLoader);
const broadcastMock = vi.mocked(broadcast);

/** Latest registered callback for a managed timer name (timers are mocked —
 *  poll/timeout steps must be driven manually; vi.useFakeTimers does NOT
 *  fire managed timers). SessionScope.timer routes through the same mock. */
function matchesTimerName(actual: string, logicalName: string): boolean {
  return actual === logicalName || actual.endsWith(`:${logicalName}`);
}

function lastTimerCallback(name: string): (() => void) | undefined {
  const calls = setManagedTimerMock.mock.calls.filter(([timerName]) =>
    matchesTimerName(timerName, name),
  );
  return calls.length > 0 ? calls[calls.length - 1][1] : undefined;
}

function createMockYtPlayer(playlistIds: string[] = []): YouTubePlayerInstance {
  return {
    loadVideoById: vi.fn(),
    loadPlaylist: vi.fn(),
    cuePlaylist: vi.fn(),
    pauseVideo: vi.fn(),
    playVideo: vi.fn(),
    stopVideo: vi.fn(),
    destroy: vi.fn(),
    seekTo: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    getPlayerState: vi.fn(() => 5),
    getPlaylistIndex: vi.fn(() => 0),
    getVideoData: vi.fn(() => ({ video_id: 'mockVideo' })),
    getPlaylist: vi.fn(() => playlistIds),
    setVolume: vi.fn(),
  };
}

interface YtTestHandle {
  fireStateChange: (state: number) => void;
}

function installYtNamespace(player: YouTubePlayerInstance): YtTestHandle {
  let capturedOnStateChange: ((event: { data: number }) => void) | undefined;
  (window as unknown as { YT: unknown }).YT = {
    Player: vi.fn(function (
      _target: string,
      options: { events: { onStateChange?: (event: { data: number }) => void } },
    ) {
      capturedOnStateChange = options.events.onStateChange;
      return player;
    }),
    PlayerState: {
      UNSTARTED: -1,
      ENDED: 0,
      PLAYING: 1,
      PAUSED: 2,
      BUFFERING: 3,
      CUED: 5,
    },
  };
  return {
    fireStateChange: (state: number) => {
      if (!capturedOnStateChange) throw new Error('onStateChange was never captured');
      capturedOnStateChange({ data: state });
    },
  };
}

/** Mirror the prod stop chain: loadYouTubeVideo's player:stop-all-media emit
 *  reaches stopYouTubeMode via stopAllMedia → 'youtube:stop-mode'
 *  (transport.ts). initYouTube registers the youtube:stop-mode listener. */
function wireStopAllMediaChain(): void {
  bus.on('player:stop-all-media', () => {
    bus.emit('youtube:stop-mode', { silent: false });
  });
}

beforeEach(async () => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  const stateMod = await import('../_state.ts');
  stateMod.resetYouTubeModuleState();

  // loadYouTubeVideo requires a .video-wrapper host for the iframe container.
  const wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper';
  const container = document.createElement('div');
  container.id = 'youtube-player-container';
  const playerDiv = document.createElement('div');
  playerDiv.id = 'youtube-player';
  container.appendChild(playerDiv);
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

/** Arm an indexing session via the deferred-playlist-navigation flow
 *  ('youtube:load' with <= 1 cached sub-items). Returns nothing — callers
 *  assert on module state / mocks. */
async function armIndexingViaDeferredNavigation(
  videoId: string,
  playlistId: string,
  autoplay = false,
  subIndex = 0,
): Promise<void> {
  const { initYouTube } = await import('../player.ts');
  const items = getState('playlist.items');
  if (!items.some((item) => item.queueItemId === YOUTUBE_QUEUE_ITEM_ID)) {
    setState('playlist.items', [
      ...items,
      {
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        type: 'youtube',
        name: playlistId,
        videoId,
        playlistId,
      },
    ]);
  }
  setState('playlist.currentQueueItemId', YOUTUBE_QUEUE_ITEM_ID);
  initYouTube();
  wireStopAllMediaChain();
  bus.emit('youtube:load', videoId, playlistId, YOUTUBE_QUEUE_ITEM_ID, autoplay, subIndex);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('YouTube indexing session lifecycle', () => {
  it('activates the complete host runtime when a retained player is reused', async () => {
    const stateMod = await import('../_state.ts');
    const syncMod = await import('../sync.ts');
    const { initYouTube, loadYouTubeVideo } = await import('../player.ts');
    const player = createMockYtPlayer();
    const volumeApply = vi.fn();

    installYtNamespace(player);
    stateMod.setYouTubePlayer(player);
    stateMod.setYtPrimed(true); // Retention path used by the persistent iOS iframe.
    setPlaybackFilePlaying();
    setState('network.appRole', 'host');
    bus.on('audio:apply-youtube-volume', volumeApply);
    initYouTube();
    wireStopAllMediaChain();

    loadYouTubeVideo('persistent1', null, true, 0);

    expect(player.destroy).not.toHaveBeenCalled();
    expect(player.pauseVideo).toHaveBeenCalled();
    expect(player.stopVideo).not.toHaveBeenCalled();
    expect(player.loadVideoById).toHaveBeenCalledWith('persistent1');
    expect(lastTimerCallback('youtubeUILoop')).toBeTypeOf('function');
    expect(lastTimerCallback('youtubeSyncLoop')).toBeTypeOf('function');
    expect(volumeApply).toHaveBeenCalledTimes(1);

    lastTimerCallback('youtubeSyncLoop')?.();
    expect(syncMod.broadcastYouTubeSync).toHaveBeenCalledWith(false);
  });

  it('does not inherit the host heartbeat when a retained player is reused as a guest', async () => {
    const stateMod = await import('../_state.ts');
    const { initYouTube, loadYouTubeVideo } = await import('../player.ts');
    const player = createMockYtPlayer();

    installYtNamespace(player);
    stateMod.setYouTubePlayer(player);
    stateMod.setYtPrimed(true);
    setPlaybackFilePlaying();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true } as never);
    initYouTube();
    wireStopAllMediaChain();

    loadYouTubeVideo('persistent2', null, false, 0);

    expect(lastTimerCallback('youtubeUILoop')).toBeTypeOf('function');
    expect(lastTimerCallback('youtubeSyncLoop')).toBeUndefined();
    expect(clearManagedTimerMock).toHaveBeenCalledWith('youtubeSyncLoop');
  });

  it('does not mistake a coordinator-free PRO endpoint for a legacy host', async () => {
    const stateMod = await import('../_state.ts');
    const { initYouTube, loadYouTubeVideo } = await import('../player.ts');
    const player = createMockYtPlayer();

    installYtNamespace(player);
    stateMod.setYouTubePlayer(player);
    stateMod.setYtPrimed(true);
    setPlaybackFilePlaying();
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    initYouTube();
    wireStopAllMediaChain();

    loadYouTubeVideo('persistent-pro', null, true, 0);

    expect(lastTimerCallback('youtubeUILoop')).toBeTypeOf('function');
    expect(lastTimerCallback('youtubeSyncLoop')).toBeUndefined();
    expect(clearManagedTimerMock).toHaveBeenCalledWith('youtubeSyncLoop');
  });

  it('self-heals a missing host heartbeat while the retained UI runtime is alive', async () => {
    const stateMod = await import('../_state.ts');
    const { initYouTube, loadYouTubeVideo } = await import('../player.ts');
    const player = createMockYtPlayer();

    installYtNamespace(player);
    stateMod.setYouTubePlayer(player);
    stateMod.setYtPrimed(true);
    setPlaybackFilePlaying();
    setState('network.appRole', 'host');
    initYouTube();
    wireStopAllMediaChain();
    loadYouTubeVideo('persistent3', null, true, 0);

    const uiTick = lastTimerCallback('youtubeUILoop');
    expect(uiTick).toBeTypeOf('function');
    setManagedTimerMock.mockClear();

    uiTick?.();

    expect(lastTimerCallback('youtubeSyncLoop')).toBeTypeOf('function');
  });

  it('real mode exit clears the live indexing session and hides its loader (gated)', async () => {
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    installYtNamespace(createMockYtPlayer());

    await armIndexingViaDeferredNavigation('vidEntry', 'PL_EXIT');
    expect(stateMod.isYtIndexing()).toBe(true);

    showLoaderMock.mockClear();
    stopYouTubeMode();

    expect(stateMod.isYtIndexing()).toBe(false);
    expect(showLoaderMock).toHaveBeenCalledWith(false);

    // Contract: a stop with no live indexing session must not hide the loader
    // (a plain track switch would otherwise stomp the incoming flow's loader).
    showLoaderMock.mockClear();
    stopYouTubeMode();
    expect(showLoaderMock).not.toHaveBeenCalled();
  });

  it('the arming load survives its own transient stop and shows the indexing loader', async () => {
    const stateMod = await import('../_state.ts');
    installYtNamespace(createMockYtPlayer());

    await armIndexingViaDeferredNavigation('vidEntry', 'PL_ARM');

    // Clear-then-arm runs AFTER the player:stop-all-media transient stop, so
    // the session armed for this load must still be live once the load returns.
    expect(stateMod.isYtIndexing()).toBe(true);
    const lastLoaderCall = showLoaderMock.mock.calls[showLoaderMock.mock.calls.length - 1];
    expect(lastLoaderCall).toEqual([true, 'youtube.indexing_playlist']);
  });

  it('after a mid-index exit, the next chat add queues instead of hijacking playback', async () => {
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { showToast } = await import('../../ui/toast.ts');
    installYtNamespace(createMockYtPlayer());

    // Non-empty queue: without the stale-indexing flag, a chat add must NOT
    // take the isIdle takeover branch.
    setState('playlist.items', [
      {
        queueItemId: FILE_QUEUE_ITEM_ID,
        type: 'file',
        name: 'song.mp3',
        videoId: null,
        playlistId: null,
      },
    ] satisfies PlaylistItem[]);
    setState('playlist.currentQueueItemId', FILE_QUEUE_ITEM_ID);

    await armIndexingViaDeferredNavigation('vidEntry', 'PL_MID');
    expect(stateMod.isYtIndexing()).toBe(true);

    stopYouTubeMode(); // user-driven mode exit mid-index
    expect(stateMod.isYtIndexing()).toBe(false);

    broadcastMock.mockClear();
    bus.emit('youtube:load-from-chat', 'https://www.youtube.com/watch?v=VIDEO_ID_99');

    // Queued, not played: no playback takeover, no room-wide YOUTUBE_PLAY.
    expect(getState('playlist.currentQueueItemId')).toBe(YOUTUBE_QUEUE_ITEM_ID);
    expect(showToast).toHaveBeenCalledWith('youtube.added_to_playlist');
    expect(broadcastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.YOUTUBE_PLAY }),
    );
    // The add itself still propagates to guests.
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAYLIST_UPDATE }),
    );
  });

  it('happy path: deferred navigation from file mode indexes, completes, and lands on the requested sub-index', async () => {
    const stateMod = await import('../_state.ts');
    const player = createMockYtPlayer(['a', 'b', 'c']);
    const yt = installYtNamespace(player);

    setPlaybackFilePlaying();
    setState('playlist.items', [
      {
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        type: 'youtube',
        videoId: 'vidA',
        playlistId: 'PL_HAPPY',
        name: 'Playlist',
      },
    ] satisfies PlaylistItem[]);
    setState('playlist.currentQueueItemId', YOUTUBE_QUEUE_ITEM_ID);

    await armIndexingViaDeferredNavigation('vidA', 'PL_HAPPY', true, 1);
    expect(stateMod.isYtIndexing()).toBe(true);
    // The transient stop's sub-index reset (-1) must be healed by the cue
    // branch before CUED arrives.
    expect(getState('youtube.currentSubIndex')).toBe(0);
    expect(player.cuePlaylist).not.toHaveBeenCalled(); // fresh create cues via playerVars

    yt.fireStateChange(5); // CUED → first poll (sync) → schedules step 2
    lastTimerCallback('yt-indexing-poll')?.(); // step 2: count stabilized → onComplete

    // Callback consumed the IDs and navigated to the requested sub-index.
    expect(getState('youtube.subItemsMap')['PL_HAPPY']?.ids).toEqual(['a', 'b', 'c']);
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.YOUTUBE_PLAYLIST_INFO,
        playlistId: 'PL_HAPPY',
        ids: ['a', 'b', 'c'],
      }),
    );
    expect(player.loadVideoById).toHaveBeenCalledWith('b');
    expect(getState('youtube.currentSubIndex')).toBe(1);
    expect(getState('playlist.items')[0].isExpanded).toBe(true);
    // Session fully released after completion.
    expect(stateMod.isYtIndexing()).toBe(false);
  });

  it('loads a fully cached manifest as one concrete video without native playlist indexing', async () => {
    const stateMod = await import('../_state.ts');
    const { initYouTube } = await import('../player.ts');
    const player = createMockYtPlayer();
    installYtNamespace(player);

    setPlaybackFilePlaying();
    setState('playlist.items', [
      {
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        type: 'youtube',
        videoId: 'cachedFirst',
        playlistId: 'PL_CACHED',
        name: 'Cached Playlist',
      },
    ] satisfies PlaylistItem[]);
    setState('playlist.currentQueueItemId', YOUTUBE_QUEUE_ITEM_ID);
    setState('youtube.subItemsMap', {
      PL_CACHED: {
        ids: ['cachedFirst', 'cachedSecond', 'cachedThird'],
        titles: ['First', 'Second', 'Third'],
      },
    });

    initYouTube();
    wireStopAllMediaChain();
    bus.emit('youtube:load', 'cachedFirst', 'PL_CACHED', YOUTUBE_QUEUE_ITEM_ID, false, 1);

    expect(stateMod.isYtIndexing()).toBe(false);
    expect(window.YT?.Player).toHaveBeenCalledOnce();
    expect(window.YT?.Player).toHaveBeenCalledWith(
      'youtube-player',
      expect.objectContaining({
        playerVars: expect.objectContaining({ origin: window.location.origin }),
      }),
    );
    expect(window.YT?.Player).toHaveBeenCalledWith(
      'youtube-player',
      expect.objectContaining({
        videoId: 'cachedSecond',
        playerVars: expect.not.objectContaining({
          list: 'PL_CACHED',
          listType: 'playlist',
        }),
      }),
    );
    expect(player.cuePlaylist).not.toHaveBeenCalled();
    expect(player.loadPlaylist).not.toHaveBeenCalled();
    expect(getState('playlist.items')[0]).toMatchObject({
      playlistId: 'PL_CACHED',
      videoId: 'cachedFirst',
    });
  });

  it('does not re-index a complete one-item server manifest', async () => {
    const stateMod = await import('../_state.ts');
    const { initYouTube } = await import('../player.ts');
    const player = createMockYtPlayer();
    installYtNamespace(player);

    setPlaybackFilePlaying();
    setState('playlist.items', [
      {
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        type: 'youtube',
        videoId: 'singleVideo',
        playlistId: 'PL_SINGLE',
        name: 'Single-item playlist',
      },
    ] satisfies PlaylistItem[]);
    setState('playlist.currentQueueItemId', YOUTUBE_QUEUE_ITEM_ID);
    stateMod.updateSubItemIds('PL_SINGLE', ['singleVideo'], { manifestComplete: true });

    initYouTube();
    wireStopAllMediaChain();
    bus.emit('youtube:load', 'singleVideo', 'PL_SINGLE', YOUTUBE_QUEUE_ITEM_ID, false, 0);

    expect(stateMod.isYtIndexing()).toBe(false);
    expect(window.YT?.Player).toHaveBeenCalledWith(
      'youtube-player',
      expect.objectContaining({
        videoId: 'singleVideo',
        playerVars: expect.not.objectContaining({
          list: 'PL_SINGLE',
          listType: 'playlist',
        }),
      }),
    );
    expect(player.cuePlaylist).not.toHaveBeenCalled();
  });

  it('index-before-add: pasted playlist with a non-empty idle queue auto-plays after indexing (isIdle contract)', async () => {
    const stateMod = await import('../_state.ts');
    const { initYouTube } = await import('../player.ts');
    const { getYouTubeInputIntent } = await import('../search.ts');
    const { showToast } = await import('../../ui/toast.ts');
    const player = createMockYtPlayer(['iba1', 'iba2', 'iba3']);
    const yt = installYtNamespace(player);

    // Non-empty queue while IDLE (tracks loaded, never played): the
    // `(isCompatIdle() && playlistWasEmpty)` term of _addYouTubeToPlaylist's
    // isIdle is false, so the takeover below rides exclusively on the
    // `|| isYtIndexing()` term — the index-then-autoplay contract. It only
    // holds because the poll clears the session AFTER the callback runs.
    setState('playlist.items', [
      {
        queueItemId: FILE_QUEUE_ITEM_ID,
        type: 'file',
        name: 'song.mp3',
        videoId: null,
        playlistId: null,
      },
    ] satisfies PlaylistItem[]);

    const url = 'https://www.youtube.com/watch?v=ibaEntry000&list=PL_IBA';
    const input = document.createElement('div');
    input.id = 'youtube-url-input';
    input.textContent = url;
    document.body.appendChild(input);
    vi.mocked(getYouTubeInputIntent).mockReturnValueOnce({
      kind: 'video-url',
      raw: url,
      videoId: 'ibaEntry000',
      playlistId: 'PL_IBA',
      query: null,
    });

    initYouTube();
    wireStopAllMediaChain();
    bus.emit('youtube:load-from-input');

    // The second arm site (index-before-add) routes through the same
    // clear-then-arm step inside loadYouTubeVideo.
    expect(stateMod.isYtIndexing()).toBe(true);
    expect(showLoaderMock).toHaveBeenCalledWith(true, 'youtube.indexing_playlist');

    yt.fireStateChange(5); // CUED → first poll (sync) → schedules step 2
    lastTimerCallback('yt-indexing-poll')?.(); // step 2: count stabilized → onComplete

    // The callback added the playlist and TOOK OVER playback (not queued):
    // currentQueueItemId points at the new entry and the host broadcast
    // YOUTUBE_PLAY in single-video mode (playlistId nulled, entry video only).
    expect(getState('youtube.subItemsMap')['PL_IBA']?.ids).toEqual(['iba1', 'iba2', 'iba3']);
    expect(getState('playlist.items')).toHaveLength(2);
    const addedQueueItemId = getState('playlist.items')[1]?.queueItemId;
    expect(getState('playlist.currentQueueItemId')).toBe(addedQueueItemId);
    expect(showToast).not.toHaveBeenCalledWith('youtube.added_to_playlist');
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.YOUTUBE_PLAY,
        videoId: 'iba1',
        playlistId: null,
        queueItemId: addedQueueItemId,
      }),
    );
    // Session fully released after completion: the callback's own nested load
    // cleared it (clear-then-arm), and the poll's guarded post-callback clear
    // must not clobber anything armed during the callback.
    expect(stateMod.isYtIndexing()).toBe(false);
  });

  it('concurrent non-indexing YT-to-YT load mid-index cancels the stale session (reuse branch)', async () => {
    const stateMod = await import('../_state.ts');
    const player = createMockYtPlayer(['x1', 'x2']);
    const yt = installYtNamespace(player);

    await armIndexingViaDeferredNavigation('vidEntry', 'PL_STALE');
    expect(stateMod.isYtIndexing()).toBe(true);

    // User pastes a plain video mid-index: mode is youtube + player is live,
    // so this load takes the reuse branch which never reaches stopYouTubeMode.
    // The clear-then-arm step inside loadYouTubeVideo must cancel the session.
    showLoaderMock.mockClear();
    bus.emit('youtube:load', 'vidZ_direct1', null, YOUTUBE_QUEUE_ITEM_ID, true, 0);

    expect(stateMod.isYtIndexing()).toBe(false);
    expect(player.loadVideoById).toHaveBeenCalledWith('vidZ_direct1');
    expect(showLoaderMock).toHaveBeenCalledWith(false);

    // A late CUED from the cancelled cue must not start a poll or fire the
    // stale callback with the new load active.
    broadcastMock.mockClear();
    setManagedTimerMock.mockClear();
    yt.fireStateChange(5);

    expect(
      setManagedTimerMock.mock.calls.some(([name]) => matchesTimerName(name, 'yt-indexing-poll')),
    ).toBe(false);
    expect(getState('youtube.subItemsMap')['PL_STALE']).toBeUndefined();
    expect(broadcastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.YOUTUBE_PLAYLIST_INFO }),
    );
  });

  it('stray CUED on a retained player after a real exit is a no-op', async () => {
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const player = createMockYtPlayer(['r1', 'r2']);
    const yt = installYtNamespace(player);

    await armIndexingViaDeferredNavigation('vidEntry', 'PL_RETAIN');
    expect(stateMod.isYtIndexing()).toBe(true);

    // iOS-style retention: the player instance survives the mode exit, so a
    // late CUED can still be delivered to the (cleared) module.
    stateMod.setYtPrimed(true);
    stopYouTubeMode();
    expect(stateMod.isYtIndexing()).toBe(false);
    expect(stateMod.getYouTubePlayer()).not.toBeNull();

    broadcastMock.mockClear();
    setManagedTimerMock.mockClear();
    vi.mocked(player.getPlaylist).mockClear();
    yt.fireStateChange(5);

    expect(player.getPlaylist).not.toHaveBeenCalled();
    expect(
      setManagedTimerMock.mock.calls.some(([name]) => matchesTimerName(name, 'yt-indexing-poll')),
    ).toBe(false);
    expect(broadcastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.YOUTUBE_PLAYLIST_INFO }),
    );
  });

  it('yt-load-timeout during indexing clears the session and hides the loader', async () => {
    const stateMod = await import('../_state.ts');
    // No window.YT: the load goes through runWhenYouTubeApiReady and arms the
    // safety timeout; the API script never resolves in jsdom.
    await armIndexingViaDeferredNavigation('vidEntry', 'PL_TIMEOUT');
    expect(stateMod.isYtIndexing()).toBe(true);

    showLoaderMock.mockClear();
    const fireTimeout = lastTimerCallback('yt-load-timeout');
    expect(fireTimeout).toBeDefined();
    fireTimeout?.();

    expect(stateMod.isYtIndexing()).toBe(false);
    expect(showLoaderMock).toHaveBeenCalledWith(false);
  });

  it('a stale poll closure of a replaced session neither fires its callback nor clobbers the new session', async () => {
    const stateMod = await import('../_state.ts');
    const player = createMockYtPlayer(['p1a', 'p1b']);
    const yt = installYtNamespace(player);

    // Arm S1 and let its first poll step get scheduled.
    await armIndexingViaDeferredNavigation('e1', 'PL_1');
    yt.fireStateChange(5);
    const stalePollStep = lastTimerCallback('yt-indexing-poll');
    expect(stalePollStep).toBeDefined();

    // Arm S2 over the live S1 (reuse branch → clear-then-arm replaces it).
    bus.emit('youtube:load', 'e2', 'PL_2', YOUTUBE_QUEUE_ITEM_ID, false, 0);
    expect(stateMod.isYtIndexing()).toBe(true);
    // The replacement's loader must be live (not stomped by the S1 clear).
    const lastLoaderCall = showLoaderMock.mock.calls[showLoaderMock.mock.calls.length - 1];
    expect(lastLoaderCall).toEqual([true, 'youtube.indexing_playlist']);
    expect(player.cuePlaylist).toHaveBeenCalledWith(
      expect.objectContaining({ list: 'PL_2', listType: 'playlist' }),
    );

    // Drive the orphaned S1 step: the identity guard must end the chain
    // without touching the player, S1's callback, or S2.
    broadcastMock.mockClear();
    stalePollStep?.();
    expect(getState('youtube.subItemsMap')['PL_1']).toBeUndefined();
    expect(stateMod.isYtIndexing()).toBe(true); // S2 not clobbered
    expect(broadcastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.YOUTUBE_PLAYLIST_INFO }),
    );

    // S2 still completes normally with ITS playlist's IDs.
    vi.mocked(player.getPlaylist).mockReturnValue(['p2a', 'p2b', 'p2c']);
    yt.fireStateChange(5);
    lastTimerCallback('yt-indexing-poll')?.();

    expect(getState('youtube.subItemsMap')['PL_2']?.ids).toEqual(['p2a', 'p2b', 'p2c']);
    expect(getState('youtube.subItemsMap')['PL_1']).toBeUndefined();
    expect(stateMod.isYtIndexing()).toBe(false);
  });

  it('resetYouTubeModuleState clears the indexing session', async () => {
    const stateMod = await import('../_state.ts');
    stateMod.beginYtIndexingSession({
      playlistId: 'PL_RESET',
      sessionId: 1,
      onComplete: vi.fn(),
    });
    expect(stateMod.isYtIndexing()).toBe(true);

    stateMod.resetYouTubeModuleState();

    expect(stateMod.isYtIndexing()).toBe(false);
    expect(stateMod.getYtIndexingSession()).toBeNull();
  });
});
