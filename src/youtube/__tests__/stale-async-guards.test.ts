/**
 * @vitest-environment jsdom
 *
 * Regression tests for YouTube stale-async guards.
 *
 * The YT→YT reuse path deliberately skips stopYouTubeMode (gesture
 * preservation), which is the timer-clear owner for the scrape poll, the
 * playlist snapshot, and the first-track fisher. Those tasks must be canceled
 * or identity-guarded across a track switch so they cannot reload the current
 * track or write a new player's list under the prior playlist ID. Likewise,
 * onYouTubePlayerError needs the same mode and video-identity gates as its
 * state-change sibling so an abandoned video's late error cannot advance the
 * active room playlist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { YOUTUBE_PRIME_VIDEO_ID } from '../constants.ts';
import { setManagedTimer } from '../../core/timers.ts';
import { showToast } from '../../ui/toast.ts';
import { broadcast } from '../../network/peer.ts';
import { setPlaybackFilePlaying, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { PlaylistItem, TrackMeta } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';

const QUEUE_ITEM_ID = '88888888-8888-4888-8888-888888888888';

const zeroStartFacade = vi.hoisted(() => ({
  handlePlayerState: vi.fn(() => false),
  inFlight: false,
  active: false,
}));

// ─── Mocks (cloned from indexing-lifecycle.test.ts — keep in sync) ─────────

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
  getSelectedYouTubeSearchResult: vi.fn(() => null),
  searchYouTubeFromInput: vi.fn(),
  clearYouTubeInputState: vi.fn(),
  fetchYouTubePreview: vi.fn(),
  fetchPlaylistSubTitles: vi.fn(),
  cancelSubTitleFetch: vi.fn(),
}));

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

vi.mock('../zero-start.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../zero-start.ts')>()),
  handleYouTubeZeroStartPlayerState: zeroStartFacade.handlePlayerState,
  isYouTubeZeroStartInFlight: vi.fn(() => zeroStartFacade.inFlight),
  isYouTubeZeroStartProtocolActive: vi.fn(() => zeroStartFacade.active),
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
const showToastMock = vi.mocked(showToast);
const broadcastMock = vi.mocked(broadcast);

/** Latest registered callback for a managed timer name (timers are mocked —
 *  poll/timeout steps must be driven manually). */
function lastTimerCallback(name: string): (() => void) | undefined {
  const calls = setManagedTimerMock.mock.calls.filter(([timerName]) => timerName === name);
  return calls.length > 0 ? calls[calls.length - 1][1] : undefined;
}

function timerArmCount(name: string): number {
  return setManagedTimerMock.mock.calls.filter(([timerName]) => timerName === name).length;
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
  fireReady: () => void;
  fireError: (code: number) => void;
}

function installYtNamespace(player: YouTubePlayerInstance): YtTestHandle {
  let capturedOnStateChange: ((event: { data: number }) => void) | undefined;
  let capturedOnReady: (() => void) | undefined;
  let capturedOnError: ((event: { data: number }) => void) | undefined;
  (window as unknown as { YT: unknown }).YT = {
    Player: vi.fn(function (
      _target: string,
      options: {
        events: {
          onStateChange?: (event: { data: number }) => void;
          onReady?: () => void;
          onError?: (event: { data: number }) => void;
        };
      },
    ) {
      capturedOnStateChange = options.events.onStateChange;
      capturedOnReady = options.events.onReady;
      capturedOnError = options.events.onError;
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
    fireReady: () => {
      if (!capturedOnReady) throw new Error('onReady was never captured');
      capturedOnReady();
    },
    fireError: (code: number) => {
      if (!capturedOnError) throw new Error('onError was never captured');
      capturedOnError({ data: code });
    },
  };
}

function wireStopAllMediaChain(): void {
  bus.on('player:stop-all-media', () => {
    bus.emit('youtube:stop-mode', { silent: false });
  });
}

beforeEach(async () => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  zeroStartFacade.inFlight = false;
  zeroStartFacade.active = false;
  zeroStartFacade.handlePlayerState.mockReset();
  zeroStartFacade.handlePlayerState.mockReturnValue(false);
  const stateMod = await import('../_state.ts');
  stateMod.resetYouTubeModuleState();

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
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

/** Host-side scrape load: mode youtube, no hostConn, playlistId present. */
async function startHostScrapeLoad(
  handlePlayer: YouTubePlayerInstance,
  playlistId: string,
): Promise<YtTestHandle> {
  const { loadYouTubeVideo } = await import('../iframe.ts');
  const handle = installYtNamespace(handlePlayer);
  setPlaybackYouTubePlaying();
  wireStopAllMediaChain();
  loadYouTubeVideo(null, playlistId, false, 0);
  return handle;
}

// ─── Scrape poll supersession ──────────────────────────────────────────────

describe('scrape poll supersession (F-2401)', () => {
  it('a stale scrape poll step must not touch the player after the load was superseded', async () => {
    const player = createMockYtPlayer([]);
    const handle = await startHostScrapeLoad(player, 'PL_A');

    // CUED during scrape → first poll step runs inline, next step scheduled.
    handle.fireStateChange(5);
    const stalePoll = lastTimerCallback('yt-scrape-poll');
    expect(stalePoll).toBeDefined();

    // Supersede: YT→YT switch to a plain video (reuse path — no scrape armed).
    const { loadYouTubeVideo } = await import('../iframe.ts');
    loadYouTubeVideo('vidB000000B', null, false, 0);
    expect(player.loadVideoById).toHaveBeenCalledWith('vidB000000B');

    // The stale chain must die at its identity guard: no player reads, no
    // _finishScrape (which would loadVideoById+playVideo the current track),
    // no rescheduling.
    vi.mocked(player.getPlaylist!).mockClear();
    vi.mocked(player.loadVideoById!).mockClear();
    vi.mocked(player.playVideo!).mockClear();
    const armsBefore = timerArmCount('yt-scrape-poll');
    stalePoll!();
    expect(player.getPlaylist).not.toHaveBeenCalled();
    expect(player.loadVideoById).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(timerArmCount('yt-scrape-poll')).toBe(armsBefore);
  });

  it('a live (non-superseded) scrape poll still completes and applies the scrape', async () => {
    const player = createMockYtPlayer(['subA1AAAAAA', 'subA2AAAAAA']);
    const handle = await startHostScrapeLoad(player, 'PL_A');
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Row A',
        playlistId: 'PL_A',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

    handle.fireStateChange(5);
    // Poll 1 scheduled with prevCount=2 → poll 2 stabilizes and finishes.
    lastTimerCallback('yt-scrape-poll')!();
    expect(player.loadVideoById).toHaveBeenCalledWith('subA1AAAAAA', 0);
    expect((getState('youtube.subItemsMap') || {})['PL_A']?.ids).toEqual([
      'subA1AAAAAA',
      'subA2AAAAAA',
    ]);
  });
});

// ─── YT→YT reuse cancels the pending seek-play timer ───────────────────────

describe('YT→YT reuse timer cleanup (F-2407)', () => {
  it('clears yt-seek-play on the reuse branch so a stale delayed play cannot fire against the new video', async () => {
    const { clearManagedTimer } = await import('../../core/timers.ts');
    const clearMock = vi.mocked(clearManagedTimer);
    const player = createMockYtPlayer([]);

    // First load establishes the player (non-reuse construct path).
    await startHostScrapeLoad(player, 'PL_A');
    clearMock.mockClear();

    // YT→YT switch to a plain video → skip-teardown reuse branch (player kept).
    const { loadYouTubeVideo } = await import('../iframe.ts');
    loadYouTubeVideo('vidB000000B', null, false, 0);
    expect(player.loadVideoById).toHaveBeenCalledWith('vidB000000B');

    // The reuse branch must cancel the pending seek-play timer — parity with
    // stopYouTubeMode and the adjacent yt-clock-action clear — so a delayed
    // playVideo scheduled for the outgoing video cannot fire against vidB.
    expect(clearMock).toHaveBeenCalledWith('yt-seek-play');
  });
});

// ─── Snapshot / fisher fire-time pid identity ──────────────────────────────

describe('playlist snapshot pid identity (F-2401)', () => {
  async function armSnapshotForPidA(player: YouTubePlayerInstance): Promise<YtTestHandle> {
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const handle = installYtNamespace(player);
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('player.currentTrackMeta', {
      name: 'Row A',
      playlistId: 'PL_A',
    } as unknown as TrackMeta);
    loadYouTubeVideo(null, 'PL_A', false, 0);
    handle.fireReady(); // arms 'yt-playlist-snapshot' + 'yt-first-track-fisher' for PL_A
    return handle;
  }

  it('a snapshot firing after the track changed must not write or broadcast under the old pid', async () => {
    const player = createMockYtPlayer(['c1CCCCCCCCC', 'c2CCCCCCCCC']);
    await armSnapshotForPidA(player);
    const snapshotCb = lastTimerCallback('yt-playlist-snapshot');
    expect(snapshotCb).toBeDefined();

    // Track switched (YT→YT reuse keeps the player; timers were armed for PL_A).
    setState('player.currentTrackMeta', {
      name: 'Row C',
      playlistId: 'PL_C',
    } as unknown as TrackMeta);

    broadcastMock.mockClear();
    snapshotCb!();
    expect((getState('youtube.subItemsMap') || {})['PL_A']).toBeUndefined();
    expect(broadcastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.YOUTUBE_PLAYLIST_INFO }),
    );
  });

  it('a snapshot for the still-current pid keeps working (positive control)', async () => {
    const player = createMockYtPlayer(['a1AAAAAAAAA', 'a2AAAAAAAAA']);
    await armSnapshotForPidA(player);
    const snapshotCb = lastTimerCallback('yt-playlist-snapshot');

    broadcastMock.mockClear();
    snapshotCb!();
    expect((getState('youtube.subItemsMap') || {})['PL_A']?.ids).toEqual([
      'a1AAAAAAAAA',
      'a2AAAAAAAAA',
    ]);
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.YOUTUBE_PLAYLIST_INFO, playlistId: 'PL_A' }),
    );
  });

  it('a first-track fisher firing after the track changed must not write under the old pid', async () => {
    const player = createMockYtPlayer([]);
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'cFirstCCCCC' });
    await armSnapshotForPidA(player);
    const fisherCb = lastTimerCallback('yt-first-track-fisher');
    expect(fisherCb).toBeDefined();

    setState('player.currentTrackMeta', {
      name: 'Row C',
      playlistId: 'PL_C',
    } as unknown as TrackMeta);

    fisherCb!();
    expect((getState('youtube.subItemsMap') || {})['PL_A']).toBeUndefined();
  });
});

// ─── onYouTubePlayerError gating ───────────────────────────────────────────

describe('onYouTubePlayerError supersession gates (F-2402)', () => {
  async function createPlayerInYouTubeMode(player: YouTubePlayerInstance): Promise<YtTestHandle> {
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const handle = installYtNamespace(player);
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    loadYouTubeVideo('vidA000000A', null, false, 0);
    return handle;
  }

  it('a late unavailable error outside YouTube mode (retained player) must not toast or advance', async () => {
    const player = createMockYtPlayer();
    const handle = await createPlayerInYouTubeMode(player);

    // Room moved on to a local file (stopYouTubeMode retains the player on
    // iOS — here we just flip the decomposed mode/activity contract).
    setPlaybackFilePlaying();

    const nextTrack = vi.fn();
    const tryNext = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    bus.on('youtube:try-next-internal', tryNext);
    showToastMock.mockClear();

    handle.fireError(150);
    expect(nextTrack).not.toHaveBeenCalled();
    expect(tryNext).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('an unavailable error whose video does not match the intended track must not advance', async () => {
    const player = createMockYtPlayer();
    const handle = await createPlayerInYouTubeMode(player);
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'B',
        videoId: 'vidB000000B',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

    // Late error from abandoned video A while B is loading (BUFFERING).
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'vidA000000A' });
    vi.mocked(player.getPlayerState!).mockReturnValue(3);

    const nextTrack = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    showToastMock.mockClear();

    handle.fireError(150);
    expect(nextTrack).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('a genuine unavailable error for the intended track still toasts and advances (positive control)', async () => {
    const player = createMockYtPlayer();
    const handle = await createPlayerInYouTubeMode(player);
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'B',
        videoId: 'vidB000000B',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'vidB000000B' });
    vi.mocked(player.getPlayerState!).mockReturnValue(3);

    const nextTrack = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    showToastMock.mockClear();

    handle.fireError(150);
    expect(showToastMock).toHaveBeenCalledWith('youtube.video_unavailable');
    expect(nextTrack).toHaveBeenCalledTimes(1);
  });

  it('an indexing-time unavailable error gives feedback but never advances the room playlist', async () => {
    const stateMod = await import('../_state.ts');
    const { initYouTube } = await import('../player.ts');
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    initYouTube();
    wireStopAllMediaChain();
    // File-mode room adds a YouTube playlist → deferred-navigation arms an
    // indexing session (≤1 cached sub-items) and constructs the player.
    setPlaybackFilePlaying();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Broken playlist',
        videoId: 'vidEntry000',
        playlistId: 'PL_BROKEN',
      },
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    bus.emit('youtube:load', 'vidEntry000', 'PL_BROKEN', QUEUE_ITEM_ID, false, 0);
    expect(stateMod.isYtIndexing()).toBe(true);

    const nextTrack = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    showToastMock.mockClear();

    handle.fireError(150);
    expect(stateMod.isYtIndexing()).toBe(false);
    expect(showToastMock).toHaveBeenCalledWith('youtube.video_unavailable');
    expect(nextTrack).not.toHaveBeenCalled();
  });
});

describe('persistent prime transition supersession', () => {
  it('publishes runtime readiness when the iOS gesture bounce reaches PLAYING', async () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const stateMod = await import('../_state.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const readinessChanged = vi.fn();
    bus.on('youtube:zero-start-readiness-changed', readinessChanged);

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Prime target',
        videoId: 'realVideo01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('realVideo01', null, false, 0);
    stateMod.setYtPrimed(false);
    stateMod.setYtPrimeBouncePending(true);

    handle.fireStateChange(1);

    expect(stateMod.isYtPrimed()).toBe(true);
    expect(stateMod.isYtPrimeBouncePending()).toBe(false);
    expect(readinessChanged).toHaveBeenCalledOnce();
    expect(player.pauseVideo).toHaveBeenCalled();
  });

  it('does not project a late silent-prime PLAYING event into the real room track', async () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Real',
        videoId: 'realVideo01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('realVideo01', null, true, 0);

    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: YOUTUBE_PRIME_VIDEO_ID });
    vi.mocked(player.pauseVideo!).mockClear();
    broadcastMock.mockClear();

    handle.fireStateChange(1);

    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    expect(broadcastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.YOUTUBE_STATE }),
    );
  });
});

describe('zero-start iframe projection barrier', () => {
  async function startPlainYouTubeVideo(player: YouTubePlayerInstance): Promise<YtTestHandle> {
    const handle = installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Zero start video',
        videoId: 'zeroStart01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'zeroStart01' });
    loadYouTubeVideo('zeroStart01', null, true, 0);
    return handle;
  }

  it('consumes warm-up states before UI, ownership, and room broadcast projection', async () => {
    const player = createMockYtPlayer();
    const handle = await startPlainYouTubeVideo(player);
    const playStateUpdates = vi.fn();
    bus.on('ui:update-play-state', playStateUpdates);
    broadcastMock.mockClear();
    zeroStartFacade.inFlight = true;
    zeroStartFacade.active = true;
    zeroStartFacade.handlePlayerState.mockReturnValue(true);

    for (const state of [1, 2, 3, 5]) handle.fireStateChange(state);

    expect(zeroStartFacade.handlePlayerState.mock.calls.map(([state]) => state)).toEqual([
      1, 2, 3, 5,
    ]);
    expect(getState('playback.activity')).toBe('playing');
    expect(playStateUpdates).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.YOUTUBE_STATE }),
    );
  });

  it('projects the real release PLAYING once without emitting a second legacy release', async () => {
    const player = createMockYtPlayer();
    const handle = await startPlainYouTubeVideo(player);
    const playStateUpdates = vi.fn();
    bus.on('ui:update-play-state', playStateUpdates);
    broadcastMock.mockClear();
    zeroStartFacade.inFlight = false;
    zeroStartFacade.active = true;
    zeroStartFacade.handlePlayerState.mockReturnValue(false);

    handle.fireStateChange(1);

    expect(getState('playback.activity')).toBe('playing');
    expect(playStateUpdates).toHaveBeenCalledTimes(1);
    expect(playStateUpdates).toHaveBeenCalledWith(true);
    expect(
      broadcastMock.mock.calls.filter(([message]) => message.type === MSG.YOUTUBE_STATE),
    ).toHaveLength(0);
  });

  it('keeps the legacy UI heartbeat and auto-advance loop inert while in-flight', async () => {
    const player = createMockYtPlayer();
    vi.mocked(player.getCurrentTime!).mockReturnValue(9.5);
    vi.mocked(player.getDuration!).mockReturnValue(10);
    vi.mocked(player.getPlayerState!).mockReturnValue(1);
    vi.mocked(player.getPlaylistIndex!).mockReturnValue(0);
    const handle = await startPlainYouTubeVideo(player);
    handle.fireReady();
    const uiTick = lastTimerCallback('youtubeUILoop');
    expect(uiTick).toBeDefined();

    const timeUpdates = vi.fn();
    const autoAdvance = vi.fn();
    bus.on('ui:time-update', timeUpdates);
    bus.on('youtube:try-next-internal', autoAdvance);
    setManagedTimerMock.mockClear();
    zeroStartFacade.inFlight = true;
    zeroStartFacade.active = true;

    uiTick!();

    expect(timeUpdates).not.toHaveBeenCalled();
    expect(autoAdvance).not.toHaveBeenCalled();
    expect(setManagedTimerMock.mock.calls.some(([name]) => name === 'youtubeSyncLoop')).toBe(false);
  });
});
