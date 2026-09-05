/**
 * @vitest-environment jsdom
 * Real playlist selection, YouTube load listener, and native indexing callbacks.
 * Only external peers, metadata requests, and timer scheduling are controlled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { setManagedTimer } from '../../core/timers.ts';
import { broadcast } from '../../network/peer.ts';
import type { YouTubePlayerInstance } from '../_state.ts';

const YOUTUBE_QUEUE_ITEM_ID = '77777777-7777-4777-8777-777777777777';

// ─── Mocks (cloned from player.test.ts — keep in sync) ────────────────────

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const i18nFixture = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) =>
    i18nFixture.locale === 'ja' && key === 'common.youtube_video' ? 'YouTube動画' : key,
  ),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
  getManagedTimer: vi.fn(() => null),
  delay: vi.fn(async () => {}),
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
  fetchPlaylistSubTitles: vi.fn(async () => {}),
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
  cancelGuestRendezvous: vi.fn(),
  suppressDriftUntil: vi.fn(),
}));

vi.mock('../standard-host-manual-offset-gate.ts', () => ({
  cancelStandardHostManualOffsetTransaction: vi.fn(() => false),
  afterStandardHostManualOffsetTransaction: vi.fn(() => false),
  isStandardHostManualOffsetTransactionPending: vi.fn(() => false),
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
  let muted = false;
  return {
    cueVideoById: vi.fn(),
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
    mute: vi.fn(() => {
      muted = true;
    }),
    unMute: vi.fn(() => {
      muted = false;
    }),
    isMuted: vi.fn(() => muted),
  };
}

interface YtTestHandle {
  fireReady: () => void;
  fireStateChange: (state: number) => void;
}

function installYtNamespace(player: YouTubePlayerInstance): YtTestHandle {
  let capturedOnReady: ((event: { target: YouTubePlayerInstance }) => void) | undefined;
  let capturedOnStateChange:
    | ((event: { data: number; target: YouTubePlayerInstance }) => void)
    | undefined;
  (window as unknown as { YT: unknown }).YT = {
    Player: vi.fn(function (
      _target: string,
      options: {
        events: {
          onReady?: (event: { target: YouTubePlayerInstance }) => void;
          onStateChange?: (event: { data: number; target: YouTubePlayerInstance }) => void;
        };
      },
    ) {
      capturedOnStateChange = options.events.onStateChange;
      capturedOnReady = options.events.onReady;
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
    fireReady: () => {
      if (!capturedOnReady) throw new Error('onReady was never captured');
      capturedOnReady({ target: player });
    },
    fireStateChange: (state: number) => {
      if (!capturedOnStateChange) throw new Error('onStateChange was never captured');
      capturedOnStateChange({ data: state, target: player });
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
  i18nFixture.locale = 'en';
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
  document
    .querySelectorAll('script[src*="youtube.com/iframe_api"]')
    .forEach((script) => script.remove());
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

const ENTRY = 'abcdefghijk';
const SECOND = 'lmnopqrstuv';
const PLAYLIST = 'PL_INDEXING_INTENT';

async function selectPlaylist({
  indexed = false,
  explicit = true,
  ids = [ENTRY, SECOND],
  subIndex = 0,
} = {}) {
  const { playTrack } = await import('../../player/playlist.ts');
  const { initYouTube, getPendingAutoSyncOnReadyForTests } = await import('../player.ts');
  const state = await import('../_state.ts');
  const { log } = await import('../../core/log.ts');
  const player = createMockYtPlayer(ids);
  let nativeVideoId = ENTRY;
  vi.mocked(player.getVideoData!).mockImplementation(() => ({ video_id: nativeVideoId }));
  vi.mocked(player.getDuration!).mockReturnValue(120);
  vi.mocked(player.cueVideoById!).mockImplementation((videoId) => {
    nativeVideoId = videoId;
  });
  const yt = installYtNamespace(player);
  const autoplay = vi.fn();
  setState('playlist.items', [
    {
      queueItemId: YOUTUBE_QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Native playlist',
      videoId: ENTRY,
      playlistId: PLAYLIST,
    },
  ]);
  if (indexed)
    setState('youtube.subItemsMap', { [PLAYLIST]: { ids, titles: [], manifestComplete: true } });
  initYouTube();
  wireStopAllMediaChain();
  bus.on('youtube:auto-play', autoplay);
  await playTrack(YOUTUBE_QUEUE_ITEM_ID, subIndex, { explicitPlaybackIntent: explicit });
  expect(log.error).not.toHaveBeenCalled();
  expect(broadcastMock).toHaveBeenCalledWith(
    expect.objectContaining({ type: MSG.YOUTUBE_PLAY, autoplay: false }),
  );
  expect(getPendingAutoSyncOnReadyForTests()).toBe(explicit);
  yt.fireReady();
  yt.fireStateChange(5);
  return { player, yt, autoplay, state, log, getPendingAutoSyncOnReadyForTests };
}

function finishIndexing(h: Awaited<ReturnType<typeof selectPlaylist>>) {
  expect(h.state.isYtIndexing()).toBe(true);
  const initialSession = h.state.getCurrentSessionId();
  for (let step = 0; h.state.isYtIndexing() && step < 16; step += 1) {
    const poll = lastTimerCallback('yt-indexing-poll');
    expect(poll).toBeTypeOf('function');
    poll!();
  }
  expect(h.state.isYtIndexing()).toBe(false);
  expect(h.state.getCurrentSessionId()).toBeGreaterThan(initialSession);
  lastTimerCallback('yt-same-video-occurrence-handoff')?.();
  h.yt.fireStateChange(5);
  lastTimerCallback('yt-pending-auto-sync-ready')?.();
  expect(h.log.error).not.toHaveBeenCalled();
}

describe('actual playTrack intent through deferred native playlist indexing', () => {
  it.each([
    { label: 'entry video', ids: [ENTRY, SECOND], subIndex: 0, target: ENTRY },
    { label: 'another resolved sub-video', ids: [ENTRY, SECOND], subIndex: 1, target: SECOND },
    { label: 'empty-list fallback', ids: [], subIndex: 0, target: ENTRY },
  ])('keeps explicit synchronized play through $label', async ({ ids, subIndex, target }) => {
    const h = await selectPlaylist({ ids, subIndex });
    finishIndexing(h);
    expect(h.autoplay).toHaveBeenCalledTimes(1);
    expect(h.autoplay).toHaveBeenCalledWith(
      expect.objectContaining({ zeroStart: true, targetTime: 0, videoId: target, subIndex }),
    );
    expect(h.getPendingAutoSyncOnReadyForTests()).toBe(false);
    expect(h.player.playVideo).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.YOUTUBE_STATE,
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        state: 1,
        videoId: target,
        subIndex,
      }),
    );
  });

  it('keeps the already-indexed explicit playback path', async () => {
    const h = await selectPlaylist({ indexed: true });
    expect(h.autoplay).toHaveBeenCalledTimes(1);
    expect(h.player.playVideo).toHaveBeenCalledTimes(1);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('keeps ordinary first-entry indexing paused until a later explicit play', async () => {
    const h = await selectPlaylist({ explicit: false });
    finishIndexing(h);
    expect(h.autoplay).not.toHaveBeenCalled();
    expect(h.player.playVideo).not.toHaveBeenCalled();
    expect(h.getPendingAutoSyncOnReadyForTests()).toBe(false);
  });

  it('does not restore a paused intent when its indexing finishes', async () => {
    const h = await selectPlaylist();
    bus.emit('youtube:set-local-paused', true);
    expect(h.getPendingAutoSyncOnReadyForTests()).toBe(false);
    finishIndexing(h);
    expect(h.autoplay).not.toHaveBeenCalled();
    expect(h.player.playVideo).not.toHaveBeenCalled();
  });

  it('does not revive a stopped indexing session from its queued poll', async () => {
    const h = await selectPlaylist();
    const oldPoll = lastTimerCallback('yt-indexing-poll');
    bus.emit('youtube:stop-mode');
    const stoppedSession = h.state.getCurrentSessionId();
    oldPoll!();
    expect(h.state.getCurrentSessionId()).toBe(stoppedSession);
    expect(h.getPendingAutoSyncOnReadyForTests()).toBe(false);
    expect(h.autoplay).not.toHaveBeenCalled();
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('preserves a different row selection against the old indexing completion', async () => {
    const h = await selectPlaylist();
    const oldPoll = lastTimerCallback('yt-indexing-poll');
    const nextId = '88888888-8888-4888-8888-888888888888';
    setState('playlist.items', [
      ...getState('playlist.items'),
      { queueItemId: nextId, type: 'youtube', name: 'Next', videoId: SECOND, playlistId: null },
    ]);
    const { playTrack } = await import('../../player/playlist.ts');
    await playTrack(nextId, 0, { explicitPlaybackIntent: true });
    const nextSession = h.state.getCurrentSessionId();
    oldPoll!();
    h.yt.fireStateChange(5);
    expect(getState('playlist.currentQueueItemId')).toBe(nextId);
    expect(h.state.getCurrentSessionId()).toBe(nextSession);
    expect(h.autoplay).toHaveBeenCalledTimes(1);
    expect(h.autoplay).toHaveBeenCalledWith(expect.objectContaining({ videoId: SECOND }));
    expect(h.log.error).not.toHaveBeenCalled();
  });
});
