/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { showToast } from '../../ui/toast.ts';
import { broadcast } from '../../network/peer.ts';
import { setPlaybackFilePlaying, setPlaybackTrackMeta } from '../../player/ownership.ts';
import type { TrackMeta } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';

const QUEUE_ITEM_ID = '88888888-8888-4888-8888-888888888888';
const SECOND_QUEUE_ITEM_ID = '99999999-9999-4999-8999-999999999999';

const zeroStartFacade = vi.hoisted(() => ({
  handlePlayerState: vi.fn<(state: number) => boolean>(() => false),
  inFlight: false,
  active: false,
}));

// ─── Mocks (cloned from indexing-lifecycle.test.ts — keep in sync) ─────────

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Provider events are synthetic. Physical iOS behavior remains separately verified.
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  IS_IOS: false,
  IS_ANDROID: false,
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));

vi.mock('../../chat/protocol.ts', () => ({
  broadcastSystemMessage: vi.fn(),
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

vi.mock('../oembed.ts', () => ({
  fetchOEmbedTitle: vi.fn(async () => 'Test Title'),
}));

vi.mock('../standard-host-manual-offset-gate.ts', () => ({
  afterStandardHostManualOffsetTransaction: vi.fn(() => true),
  cancelStandardHostManualOffsetTransaction: vi.fn(() => false),
  isStandardHostManualOffsetTransactionPending: vi.fn(() => false),
  resetStandardHostManualOffsetTransaction: vi.fn(),
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

const showToastMock = vi.mocked(showToast);
const broadcastMock = vi.mocked(broadcast);

function createMockYtPlayer(playlistIds: string[] = []): YouTubePlayerInstance {
  let muted = false;
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
  fireStateChange: (state: number, target?: YouTubePlayerInstance) => void;
  fireReady: () => void;
  fireError: (code: number, target?: YouTubePlayerInstance) => void;
  fireAutoplayBlocked: () => void;
  fireApiChange: (target?: YouTubePlayerInstance) => void;
}

function installYtNamespace(player: YouTubePlayerInstance): YtTestHandle {
  let capturedOnStateChange:
    ((event: { data: number; target: YouTubePlayerInstance }) => void) | undefined;
  let capturedOnReady: ((event: { target: YouTubePlayerInstance }) => void) | undefined;
  let capturedOnError:
    ((event: { data: number; target: YouTubePlayerInstance }) => void) | undefined;
  let capturedOnAutoplayBlocked: ((event: { target: YouTubePlayerInstance }) => void) | undefined;
  let capturedOnApiChange: ((event: { target: YouTubePlayerInstance }) => void) | undefined;
  (window as unknown as { YT: unknown }).YT = {
    Player: vi.fn(function (
      _target: string,
      options: {
        events: {
          onStateChange?: (event: { data: number; target: YouTubePlayerInstance }) => void;
          onReady?: (event: { target: YouTubePlayerInstance }) => void;
          onError?: (event: { data: number; target: YouTubePlayerInstance }) => void;
          onAutoplayBlocked?: (event: { target: YouTubePlayerInstance }) => void;
          onApiChange?: (event: { target: YouTubePlayerInstance }) => void;
        };
      },
    ) {
      capturedOnStateChange = options.events.onStateChange;
      capturedOnReady = options.events.onReady;
      capturedOnError = options.events.onError;
      capturedOnAutoplayBlocked = options.events.onAutoplayBlocked;
      capturedOnApiChange = options.events.onApiChange;
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
    fireStateChange: (state: number, target = player) => {
      if (!capturedOnStateChange) throw new Error('onStateChange was never captured');
      capturedOnStateChange({ data: state, target });
    },
    fireReady: () => {
      if (!capturedOnReady) throw new Error('onReady was never captured');
      capturedOnReady({ target: player });
    },
    fireError: (code: number, target = player) => {
      if (!capturedOnError) throw new Error('onError was never captured');
      capturedOnError({ data: code, target });
    },
    fireAutoplayBlocked: () => {
      if (!capturedOnAutoplayBlocked) throw new Error('onAutoplayBlocked was never captured');
      capturedOnAutoplayBlocked({ target: player });
    },
    fireApiChange: (target = player) => {
      if (!capturedOnApiChange) throw new Error('onApiChange was never captured');
      capturedOnApiChange({ target });
    },
  };
}
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { SCRIPT_LOAD_TIMEOUT_MS } from '../constants.ts';
import { initYouTube, setPendingAutoSyncOnReady } from '../player.ts';
import {
  handoffSameVideoOccurrenceRestart,
  loadYouTubeVideo,
  updateYouTubeUIForTests,
} from '../iframe.ts';
import { initPlayback } from '../../player/playback.ts';
import { stopAllMedia } from '../../player/transport.ts';
import * as ytState from '../_state.ts';

function choose(id: string, videoId: string): void {
  const items = getState('playlist.items');
  if (!items.some((item) => item.queueItemId === id)) {
    setState('playlist.items', [
      ...items,
      { queueItemId: id, type: 'youtube', name: videoId, videoId, playlistId: null },
    ]);
  }
  setState('playlist.currentQueueItemId', id);
  setPlaybackTrackMeta({ name: videoId, videoId, playlistId: null } as TrackMeta);
}
function registeredLoad(id = QUEUE_ITEM_ID, videoId = 'vidA000000A', autoplay = false): void {
  choose(id, videoId);
  bus.emit('youtube:load', videoId, null, id, autoplay, 0);
}
beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  ytState.resetYouTubeModuleState();
  zeroStartFacade.inFlight = false;
  zeroStartFacade.active = false;
  zeroStartFacade.handlePlayerState.mockReturnValue(false);
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
  setState('network.appRole', 'host');
  initPlayback();
  initYouTube();
  initYouTubeSync();
});
afterEach(() => {
  clearAllManagedTimers();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document
    .querySelectorAll('script[src*="youtube.com/iframe_api"]')
    .forEach((script) => script.remove());
  delete window.YT;
  delete window.onYouTubeIframeAPIReady;
});

import { initYouTubeSync } from '../sync.ts';

describe('QA3 R17 actual registered lifecycle probes', () => {
  it('script error tears down the actual registered load and retry ignores predecessor events', () => {
    registeredLoad();
    const failed = document.querySelector<HTMLScriptElement>(
      'script[src*="youtube.com/iframe_api"]',
    )!;
    expect(failed).toBeTruthy();
    expect(ytState.isYtScriptLoading()).toBe(true);
    failed.dispatchEvent(new Event('error'));
    expect(getState('playback.mode')).toBeNull();
    expect(ytState.isYtLoadInProgress()).toBe(false);
    expect(failed.isConnected).toBe(false);
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidB000000B');
    const retry = document.querySelector<HTMLScriptElement>(
      'script[src*="youtube.com/iframe_api"]',
    )!;
    expect(retry).not.toBe(failed);
    failed.dispatchEvent(new Event('load'));
    expect(ytState.getYouTubePlayer()).toBeNull();
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    retry.dispatchEvent(new Event('load'));
    expect(ytState.getYouTubePlayer()).toBe(player);
    expect(ytState.isYtLoadInProgress()).toBe(true);
    handle.fireReady();
    expect(ytState.isYtLoadInProgress()).toBe(false);
    expect(ytState.isYtPlayerReady()).toBe(true);
  });
  it('cold API timeout clears the attempt and permits a later healthy script load', () => {
    registeredLoad();
    const first = document.querySelector<HTMLScriptElement>(
      'script[src*="youtube.com/iframe_api"]',
    )!;
    vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS + 1);
    expect(first.isConnected).toBe(false);
    expect(ytState.isYtScriptLoading()).toBe(false);
    expect(ytState.isYtLoadInProgress()).toBe(false);
    expect(getState('playback.mode')).toBeNull();
    const player = createMockYtPlayer();
    const ready = installYtNamespace(player);
    registeredLoad();
    ready.fireReady();
    expect(ytState.isYtPlayerReady()).toBe(true);
  });
  it('constructor exception cleans up the load and permits retry', () => {
    const player = createMockYtPlayer();
    installYtNamespace(player);
    vi.mocked(window.YT!.Player).mockImplementationOnce(function () {
      throw new Error('controlled constructor failure');
    });
    registeredLoad();
    expect(window.YT!.Player).toHaveBeenCalledOnce();
    expect(ytState.getYouTubePlayer()).toBeNull();
    expect(ytState.isYtLoadInProgress()).toBe(false);
    expect(getManagedTimer('yt-load-timeout')).toBeNull();
    expect(getState('playback.mode')).toBeNull();
    expect(showToast).toHaveBeenCalledWith('youtube.load_fail');
    registeredLoad();
    expect(ytState.getYouTubePlayer()).toBe(player);
    expect(ytState.isYtLoadInProgress()).toBe(true);
  });
  it('healthy onReady activates runtime and keeps its current player across the deadline', () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    registeredLoad();
    expect(ytState.isYtPlayerReady()).toBe(false);
    handle.fireReady();
    expect(ytState.isYtPlayerReady()).toBe(true);
    expect(ytState.isYtLoadInProgress()).toBe(false);
    expect(getManagedTimer('youtubeUILoop')).not.toBeNull();
    vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS + 1);
    expect(ytState.getYouTubePlayer()).toBe(player);
    expect(getState('playback.mode')).toBe('youtube');
  });
  it('retires a noReady facade at the deadline and ignores its late callbacks after retry', () => {
    const player = createMockYtPlayer();
    const retired = installYtNamespace(player);
    registeredLoad();
    expect(ytState.getYouTubePlayer()).toBe(player);
    expect(ytState.isYtLoadInProgress()).toBe(true);
    expect(ytState.isYtPlayerReady()).toBe(false);
    vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS + 1);
    expect(ytState.isYtLoadInProgress()).toBe(false);
    expect(ytState.isYtPlayerReady()).toBe(false);
    expect(getManagedTimer('yt-load-timeout')).toBeNull();
    expect(getManagedTimer('youtubeUILoop')).toBeNull();
    expect(getState('playback.mode')).toBeNull();
    expect(player.destroy).toHaveBeenCalledOnce();
    expect(ytState.getYouTubePlayer()).toBeNull();
    expect(showToast).toHaveBeenCalledWith('youtube.load_timeout');
    const healthy = createMockYtPlayer();
    const ready = installYtNamespace(healthy);
    registeredLoad();
    retired.fireReady();
    retired.fireStateChange(2);
    retired.fireError(150);
    expect(ytState.isYtPlayerReady()).toBe(false);
    expect(ytState.isYtLoadInProgress()).toBe(true);
    ready.fireReady();
    expect(ytState.isYtPlayerReady()).toBe(true);
    expect(ytState.isYtLoadInProgress()).toBe(false);
  });
  it('replacement made by real reuse failure rejects all retired callbacks', () => {
    const old = createMockYtPlayer();
    vi.mocked(old.getVideoData).mockReturnValue({ video_id: 'vidA000000A' });
    const oldHandle = installYtNamespace(old);
    registeredLoad();
    oldHandle.fireReady();
    const fresh = createMockYtPlayer();
    vi.mocked(fresh.getVideoData).mockReturnValue({ video_id: 'vidB000000B' });
    const freshHandle = installYtNamespace(fresh);
    vi.mocked(old.loadVideoById).mockImplementationOnce(() => {
      throw new Error('retired iframe refuses new command');
    });
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidB000000B');
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(ytState.getYouTubePlayer()).toBe(fresh);
    showToastMock.mockClear();
    broadcastMock.mockClear();
    const next = vi.fn();
    bus.on('playlist:next-track', next);
    oldHandle.fireReady();
    oldHandle.fireStateChange(1);
    oldHandle.fireStateChange(2);
    oldHandle.fireStateChange(0);
    oldHandle.fireError(150);
    oldHandle.fireAutoplayBlocked();
    oldHandle.fireApiChange();
    expect(ytState.isYtPlayerReady()).toBe(false);
    expect(ytState.isYtLoadInProgress()).toBe(true);
    expect(showToastMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    freshHandle.fireReady();
    expect(ytState.isYtPlayerReady()).toBe(true);
  });
  it('rejects the outgoing pause while metadata still belongs to the previous queue occurrence', () => {
    const player = createMockYtPlayer();
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidA000000A' });
    vi.mocked(player.getPlayerState).mockReturnValue(1);
    const handle = installYtNamespace(player);
    registeredLoad();
    handle.fireReady();
    player.cueVideoById = vi.fn();
    vi.mocked(player.pauseVideo).mockImplementationOnce(() => {
      setTimeout(() => {
        vi.mocked(player.getPlayerState).mockReturnValue(2);
        handle.fireStateChange(2);
      }, 0);
    });
    broadcastMock.mockClear();
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidB000000B');
    expect(player.pauseVideo).toHaveBeenCalled();
    expect(player.cueVideoById).toHaveBeenCalledWith('vidB000000B', 0);
    expect(ytState.getYouTubePlayer()).toBe(player);
    vi.advanceTimersByTime(0);
    expect(broadcastMock.mock.calls.some((call) => call[0].type === MSG.YOUTUBE_STATE)).toBe(false);
    expect(getState('playlist.currentQueueItemId')).toBe(SECOND_QUEUE_ITEM_ID);
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidB000000B' });
    handle.fireStateChange(2);
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.YOUTUBE_STATE,
        queueItemId: SECOND_QUEUE_ITEM_ID,
        videoId: 'vidB000000B',
        state: 2,
      }),
    );
  });
  it('matching reused target PAUSED is accepted as a healthy state', () => {
    const player = createMockYtPlayer();
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidA000000A' });
    const handle = installYtNamespace(player);
    registeredLoad();
    handle.fireReady();
    player.cueVideoById = vi.fn();
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidB000000B');
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidB000000B' });
    vi.mocked(player.getPlayerState).mockReturnValue(2);
    broadcastMock.mockClear();
    handle.fireStateChange(2);
    expect(getState('playback.activity')).toBe('paused');
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.YOUTUBE_STATE,
        queueItemId: SECOND_QUEUE_ITEM_ID,
        videoId: 'vidB000000B',
        state: 2,
      }),
    );
  });
  it('a ready reused iframe needs no second onReady and survives the new load deadline', () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    registeredLoad();
    handle.fireReady();
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidB000000B');
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidB000000B' });
    vi.mocked(player.getPlayerState).mockReturnValue(2);
    handle.fireStateChange(2);
    vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS + 1);
    expect(ytState.getYouTubePlayer()).toBe(player);
    expect(ytState.isYtPlayerReady()).toBe(true);
    expect(ytState.isYtLoadInProgress()).toBe(false);
    expect(player.destroy).not.toHaveBeenCalled();
  });
  it('a superseded noReady deadline cannot cancel a later load attempt', () => {
    const old = createMockYtPlayer();
    installYtNamespace(old);
    registeredLoad();
    vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS - 1000);
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    vi.mocked(old.loadVideoById).mockImplementationOnce(() => {
      throw new Error('controlled stale facade');
    });
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidB000000B');
    vi.advanceTimersByTime(1001);
    expect(getState('playback.mode')).toBe('youtube');
    expect(ytState.isYtLoadInProgress()).toBe(true);
    handle.fireReady();
    vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS);
    expect(ytState.getYouTubePlayer()).toBe(player);
    expect(ytState.isYtPlayerReady()).toBe(true);
  });
  it('duplicate same-video occurrences wait for command progress and reject queued stale state', () => {
    const player = createMockYtPlayer();
    player.cueVideoById = vi.fn();
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidA000000A' });
    vi.mocked(player.getPlayerState).mockReturnValue(1);
    const handle = installYtNamespace(player);
    registeredLoad();
    handle.fireReady();
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidA000000A');
    vi.advanceTimersByTime(0); // same-video cue fallback, no playlist-owned handoff
    broadcastMock.mockClear();
    vi.mocked(player.getPlayerState).mockReturnValue(2);
    handle.fireStateChange(2);
    handle.fireStateChange(2);
    expect(broadcastMock).not.toHaveBeenCalled();
    vi.mocked(player.getPlayerState).mockReturnValue(5);
    handle.fireStateChange(5);
    broadcastMock.mockClear();
    handle.fireStateChange(2); // queued PAUSED disagrees with live CUED
    expect(broadcastMock).not.toHaveBeenCalled();
    vi.mocked(player.getPlayerState).mockReturnValue(2);
    handle.fireStateChange(2);
    handle.fireStateChange(2);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.YOUTUBE_STATE,
        queueItemId: SECOND_QUEUE_ITEM_ID,
        videoId: 'vidA000000A',
        state: 2,
      }),
    );
    expect(player.destroy).not.toHaveBeenCalled();
  });
  it('the explicit same-video handoff settles feedback ownership before zero-start takes over', () => {
    const player = createMockYtPlayer();
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidA000000A' });
    vi.mocked(player.getPlayerState).mockReturnValue(2);
    const handle = installYtNamespace(player);
    registeredLoad();
    handle.fireReady();
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidA000000A');
    setPendingAutoSyncOnReady(true, { videoId: 'vidA000000A', zeroStart: true, targetTime: 0 });
    expect(handoffSameVideoOccurrenceRestart(SECOND_QUEUE_ITEM_ID, 'vidA000000A')).toBe(true);
    expect(getManagedTimer('yt-reused-feedback-timeout')).toBeNull();
    vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS + 1);
    expect(ytState.getYouTubePlayer()).toBe(player);
    expect(getState('playback.mode')).toBe('youtube');
  });
  it('a target CUED event consumed by zero-start settles proof during a long owned hold', () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidA000000A' });
    registeredLoad();
    handle.fireReady();
    registeredLoad(SECOND_QUEUE_ITEM_ID, 'vidB000000B');
    zeroStartFacade.handlePlayerState.mockReturnValue(true);
    zeroStartFacade.inFlight = true;
    zeroStartFacade.active = true;
    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidB000000B' });
    vi.mocked(player.getPlayerState).mockReturnValue(5);
    handle.fireStateChange(5);
    expect(getManagedTimer('yt-reused-feedback-timeout')).toBeNull();
    vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS + 1);
    expect(ytState.getYouTubePlayer()).toBe(player);
    expect(getState('playback.mode')).toBe('youtube');
    expect(player.destroy).not.toHaveBeenCalled();
  });
  it.each(['mismatched-video', 'missing-playlist-identity'])(
    'bounds %s target proof and allows a healthy retry',
    (failure) => {
      const player = createMockYtPlayer();
      vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidA000000A' });
      const handle = installYtNamespace(player);
      registeredLoad();
      handle.fireReady();
      choose(SECOND_QUEUE_ITEM_ID, 'vidB000000B');
      loadYouTubeVideo(
        failure === 'mismatched-video' ? 'vidB000000B' : null,
        failure === 'missing-playlist-identity' ? 'PLunknown' : null,
        false,
        1,
      );
      vi.advanceTimersByTime(SCRIPT_LOAD_TIMEOUT_MS + 1);
      expect(getState('playback.mode')).toBeNull();
      expect(showToast).toHaveBeenCalledWith('youtube.load_timeout');
      expect(getManagedTimer('yt-reused-feedback-timeout')).toBeNull();
      const healthy = createMockYtPlayer();
      const ready = installYtNamespace(healthy);
      registeredLoad();
      ready.fireReady();
      expect(ytState.isYtPlayerReady()).toBe(true);
      expect(getState('playback.mode')).toBe('youtube');
    },
  );
  it.each(['PLlifecycle', 'RDlifecycle'])(
    '%s transition rejects old subindex and accepts target pause after progress',
    (playlistId) => {
      const player = createMockYtPlayer(['vidA000000A', 'vidA000000A', 'vidC000000C']);
      vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'vidA000000A' });
      vi.mocked(player.getPlayerState).mockReturnValue(1);
      const handle = installYtNamespace(player);
      registeredLoad();
      handle.fireReady();
      choose(SECOND_QUEUE_ITEM_ID, 'vidA000000A');
      setState(
        'playlist.items',
        getState('playlist.items').map((item) =>
          item.queueItemId === SECOND_QUEUE_ITEM_ID ? { ...item, playlistId } : item,
        ),
      );
      setPlaybackTrackMeta({
        name: 'duplicate list',
        videoId: 'vidA000000A',
        playlistId,
      } as TrackMeta);
      ytState.updateSubItemIds(playlistId, ['vidA000000A', 'vidA000000A', 'vidC000000C']);
      // Native playlist discovery uses the iframe loader before the public
      // queue path can resolve its manifest into single-video commands.
      loadYouTubeVideo('vidA000000A', playlistId, false, 1);
      broadcastMock.mockClear();
      vi.mocked(player.getPlayerState).mockReturnValue(2);
      handle.fireStateChange(2);
      expect(broadcastMock).not.toHaveBeenCalled();
      vi.mocked(player.getPlaylistIndex).mockReturnValue(1);
      handle.fireStateChange(2); // duplicate ID/index alone cannot prove new cue
      expect(broadcastMock).not.toHaveBeenCalled();
      vi.mocked(player.getPlayerState).mockReturnValue(5);
      handle.fireStateChange(5);
      vi.mocked(player.getPlayerState).mockReturnValue(2);
      handle.fireStateChange(2);
      expect(broadcastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          queueItemId: SECOND_QUEUE_ITEM_ID,
          videoId: 'vidA000000A',
          subIndex: 1,
          state: 2,
        }),
      );
      expect(player.destroy).not.toHaveBeenCalled();

      const nativeAdvance = vi.fn();
      bus.on('youtube:sub-video-advanced', nativeAdvance);
      ytState.setCachedYtPlaylistIdx(1);
      vi.mocked(player.getPlaylistIndex).mockReturnValue(2);
      vi.mocked(player.getPlayerState).mockReturnValue(1);
      vi.mocked(player.getDuration).mockReturnValue(120);
      // Native index updates first; the existing UI owner resolves the new
      // playlist ID for its synchronized handoff while metadata still lags.
      updateYouTubeUIForTests();
      expect(nativeAdvance).toHaveBeenCalledOnce();
      expect(getState('youtube.currentSubIndex')).toBe(2);
      expect(broadcastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          videoId: 'vidC000000C',
          subIndex: 2,
        }),
      );
      expect(getManagedTimer('yt-reused-feedback-timeout')).toBeNull();
    },
  );
  it.each(['file', 'system-audio'] as const)(
    'real teardown before %s ownership rejects abandoned iframe callbacks',
    async (mode) => {
      const player = createMockYtPlayer();
      const handle = installYtNamespace(player);
      registeredLoad();
      handle.fireReady();
      if (mode === 'file') {
        stopAllMedia({ silent: true, cancelInFlight: true });
        setPlaybackFilePlaying();
      } else {
        const { beginTrustedSystemAudioReception } =
          await import('../../network/system-audio-guest.ts');
        expect(beginTrustedSystemAudioReception()).toBe(true);
      }
      expect(player.destroy).toHaveBeenCalledOnce();
      expect(ytState.getYouTubePlayer()).toBeNull();
      showToastMock.mockClear();
      broadcastMock.mockClear();
      const next = vi.fn();
      bus.on('playlist:next-track', next);
      handle.fireReady();
      handle.fireStateChange(1);
      handle.fireStateChange(2);
      handle.fireStateChange(0);
      handle.fireError(150);
      expect(getState('playback.mode')).toBe(mode);
      expect(next).not.toHaveBeenCalled();
      expect(showToastMock).not.toHaveBeenCalled();
      expect(broadcastMock).not.toHaveBeenCalled();
      expect(getManagedTimer('youtubeUILoop')).toBeNull();
    },
  );
});
