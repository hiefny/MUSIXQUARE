/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { setPlaybackTrackMeta } from '../../player/ownership.ts';
import type { TrackMeta } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';

const QUEUE_ITEM_ID = '88888888-8888-4888-8888-888888888888';

const zeroStartFacade = vi.hoisted(() => ({
  handlePlayerState: vi.fn<(state: number) => boolean>(() => false),
  inFlight: false,
  active: false,
}));
const outputDelay = vi.hoisted(() => ({ ms: 0 }));
vi.mock('../play-latency.ts', async (original) => ({
  ...(await original<typeof import('../play-latency.ts')>()),
  getLocalYouTubeAudibleOutputDelayMs: () => outputDelay.ms,
}));

// Real iframe lifecycle and native authority; network/provider calls stay local.

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

function installYtNamespace(player: YouTubePlayerInstance) {
  let onStateChange: (event: { data: number; target: YouTubePlayerInstance }) => void;
  let onReady: (event: { target: YouTubePlayerInstance }) => void;
  window.YT = {
    Player: vi.fn(function (
      _target: string,
      options: {
        events: {
          onStateChange: typeof onStateChange;
          onReady: typeof onReady;
        };
      },
    ) {
      onStateChange = options.events.onStateChange;
      onReady = options.events.onReady;
      return player;
    }) as unknown as NonNullable<typeof window.YT>['Player'],
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  };
  return {
    fireStateChange(state: number) {
      onStateChange({ data: state, target: player });
    },
    fireReady() {
      onReady({ target: player });
    },
  };
}
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initYouTube } from '../player.ts';
import { updateYouTubeUIForTests } from '../iframe.ts';
import { VIDEO_DATA_POLL_EVERY_NTH_TICK } from '../constants.ts';
import { initPlayback } from '../../player/playback.ts';
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
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  ytState.resetYouTubeModuleState();
  zeroStartFacade.inFlight = false;
  zeroStartFacade.active = false;
  zeroStartFacade.handlePlayerState.mockReturnValue(false);
  outputDelay.ms = 0;
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

import { safeSend } from '../../network/peer.ts';
import { registerHandlers } from '../../network/protocol.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import { clearYouTubeStableControlExpectations } from '../../youtube/native-control-origin.ts';
import {
  initYouTubeNativeControlAuthority,
  setYouTubeNativeControlHostAdActive,
} from '../../youtube/native-control-authority.ts';

function readyOperator(
  initialState: 1 | 2,
  options: { readonlySeek?: boolean; throwingSeek?: boolean; listener?: 'standard' | 'pro' } = {},
) {
  const calls: Array<[string, number?]> = [];
  let state: number = initialState;
  let time = 40;
  let duration = 300;
  let videoId = 'vidA000000A';
  const player: YouTubePlayerInstance = {
    loadVideoById() {},
    loadPlaylist() {},
    cueVideoById() {},
    cuePlaylist() {},
    playVideo() {
      calls.push(['play']);
    },
    pauseVideo() {
      calls.push(['pause']);
    },
    stopVideo() {},
    destroy() {},
    seekTo(seconds) {
      if (options.throwingSeek) throw new Error('seek unavailable');
      time = seconds;
      calls.push(['seek', seconds]);
    },
    getCurrentTime() {
      return time;
    },
    getDuration() {
      return duration;
    },
    getPlayerState() {
      return state;
    },
    getPlaylistIndex() {
      return -1;
    },
    getVideoData() {
      return { video_id: videoId, title: 'Video' };
    },
    getPlaylist() {
      return [];
    },
    setVolume() {},
    mute() {},
    unMute() {},
    isMuted() {
      return false;
    },
  };
  if (options.readonlySeek)
    Object.defineProperty(player, 'seekTo', {
      value: player.seekTo,
      writable: false,
      configurable: false,
    });
  const handle = installYtNamespace(player);
  registeredLoad(QUEUE_ITEM_ID, 'vidA000000A', false);
  handle.fireReady();
  const conn = { peer: 'host', open: true, send() {} } as never;
  setState('network.appRole', 'guest');
  setState('network.hostConn', conn);
  setState('network.isOperator', !options.listener);
  setState('network.standardRoomCapabilities', options.listener ? [] : ['playback.control']);
  if (options.listener === 'pro') {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 11,
      capabilities: [],
    });
  }
  ytState.setYtAutoplayIntent(initialState === 1);
  if (initialState === 1) setPlaybackYouTubePlaying();
  else setPlaybackYouTubePaused();
  clearAllManagedTimers();
  clearYouTubeStableControlExpectations(player);
  initYouTubeNativeControlAuthority();
  calls.length = 0;
  vi.mocked(safeSend).mockClear();
  vi.mocked(safeSend).mockReturnValue(true);
  const receive = (
    type: keyof Parameters<typeof registerHandlers>[0],
    data: Record<string, unknown>,
  ) => {
    const handlers = vi.mocked(registerHandlers).mock.calls.map((call) => call[0]);
    const handler = handlers.map((h) => h[type]).find(Boolean);
    if (!handler) throw new Error('Handler missing: ' + type);
    return handler({ type, ...data } as never, conn);
  };
  return {
    player,
    calls,
    receive,
    focus() {
      const frame = document.createElement('iframe');
      document.getElementById('youtube-player-container')!.append(frame);
      frame.focus();
      expect(document.activeElement).toBe(frame);
    },
    poll() {
      updateYouTubeUIForTests();
    },
    setDuration(value: number) {
      duration = value;
    },
    setVideoId(value: string) {
      videoId = value;
    },
    setTime(value: number) {
      time = value;
    },
    emit(next: number) {
      state = next;
      handle.fireStateChange(next);
    },
  };
}

describe('Standard operator native iframe integration', () => {
  it('preserves native PLAY after a canonical pause and requests the host', async () => {
    const h = readyOperator(1);
    await h.receive(MSG.YOUTUBE_STATE, {
      queueItemId: QUEUE_ITEM_ID,
      time: 40,
      state: 2,
      videoId: 'vidA000000A',
      subIndex: -1,
    });
    h.emit(2);
    expect(ytState.getYtAutoplayIntent()).toBe(false);
    h.calls.length = 0;
    h.emit(1);
    expect(h.calls).not.toContainEqual(['pause']);
    expect(getState('playback.activity')).toBe('playing');
    expect(
      vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type === MSG.REQUEST_YOUTUBE_PLAY),
    ).toHaveLength(1);
  });

  it('routes a focused native 10 second seek once without promoting its PAUSED/PLAYING feedback', () => {
    const h = readyOperator(1);
    h.focus();
    h.poll();
    h.setTime(50);
    h.emit(3);
    h.emit(2);
    h.emit(1);
    expect(
      vi
        .mocked(safeSend)
        .mock.calls.map(([, frame]) => frame)
        .filter((frame) => frame.type.startsWith('request-')),
    ).toEqual([{ type: MSG.REQUEST_SEEK, time: 50, queueItemId: QUEUE_ITEM_ID }]);
    h.emit(2);
    expect(vi.mocked(safeSend).mock.calls.map(([, frame]) => frame)).toContainEqual({
      type: MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId: QUEUE_ITEM_ID,
    });
  });

  it('reads getVideoData once per UI tick for a focused guest, sharing it with the metadata poll', () => {
    const h = readyOperator(1);
    h.focus();
    const reads = vi.spyOn(h.player, 'getVideoData');
    for (let tick = 0; tick < VIDEO_DATA_POLL_EVERY_NTH_TICK; tick += 1) {
      reads.mockClear();
      h.poll();
      expect(reads).toHaveBeenCalledOnce();
    }
    // The shared read still feeds the native seek observer.
    h.setTime(50);
    h.poll();
    expect(vi.mocked(safeSend).mock.calls.map(([, frame]) => frame)).toContainEqual({
      type: MSG.REQUEST_SEEK,
      time: 50,
      queueItemId: QUEUE_ITEM_ID,
    });
  });

  it('promotes the first iframe interaction when focus and seek arrive together', () => {
    const h = readyOperator(1);
    h.poll(); // Recent media baseline before the user enters the provider frame.
    h.focus();
    window.dispatchEvent(new Event('blur')); // Parent window loses focus to its iframe.
    h.setTime(50);
    h.emit(3);
    h.emit(2);
    h.emit(1);
    expect(
      vi
        .mocked(safeSend)
        .mock.calls.map(([, frame]) => frame)
        .filter((frame) => frame.type.startsWith('request-')),
    ).toEqual([{ type: MSG.REQUEST_SEEK, time: 50, queueItemId: QUEUE_ITEM_ID }]);
  });

  it('does not promote an unfocused jump when the iframe is focused later', () => {
    const h = readyOperator(1);
    h.poll();
    h.setTime(50);
    h.poll();
    h.focus();
    h.emit(3);
    h.emit(1);
    expect(
      vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type === MSG.REQUEST_SEEK),
    ).toEqual([]);
  });

  it('drops the baseline when the browser window loses focus even without a background poll', () => {
    const h = readyOperator(1);
    h.poll();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    vi.mocked(document.hasFocus).mockReturnValue(true);
    h.focus();
    h.setTime(50);
    h.emit(3);
    h.emit(1);
    expect(
      vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type === MSG.REQUEST_SEEK),
    ).toEqual([]);
  });

  it.each([1, 2] as const)(
    'keeps manual and Android output compensation local during native seek from state %s',
    (state) => {
      const h = readyOperator(state);
      setState('sync.youtubeLocalOffset', 1.2);
      outputDelay.ms = 250;
      const offset = 1.2 + (state === 1 ? 0.25 : 0);
      h.setTime(40 + offset);
      h.focus();
      h.poll();
      h.setTime(50 + offset);
      h.poll();
      expect(vi.mocked(safeSend).mock.calls.map(([, frame]) => frame)).toContainEqual({
        type: MSG.REQUEST_SEEK,
        time: 50,
        queueItemId: QUEUE_ITEM_ID,
      });
    },
  );

  it.each([
    'unfocused',
    'no-authority',
    'duration',
    'empty-video',
    'long-gap',
    'visibility',
    'background-window',
    'manual-offset',
    'host-ad',
    'clock-step',
    'readonly-seek',
  ] as const)('does not promote an ambiguous %s position discontinuity', (reason) => {
    const h = readyOperator(1, { readonlySeek: reason === 'readonly-seek' });
    if (reason !== 'unfocused') h.focus();
    h.poll();
    if (reason === 'no-authority') setState('network.standardRoomCapabilities', []);
    if (reason === 'duration') h.setDuration(30);
    if (reason === 'empty-video') h.setVideoId('');
    if (reason === 'long-gap') vi.advanceTimersByTime(2_000);
    if (reason === 'visibility') document.dispatchEvent(new Event('visibilitychange'));
    if (reason === 'background-window') vi.mocked(document.hasFocus).mockReturnValue(false);
    if (reason === 'manual-offset') setState('sync.youtubeLocalOffset', 10);
    if (reason === 'host-ad') setYouTubeNativeControlHostAdActive(true);
    if (reason === 'clock-step') vi.setSystemTime(Date.now() + 5_000);
    h.setTime(50);
    h.poll();
    expect(
      vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type === MSG.REQUEST_SEEK),
    ).toHaveLength(0);
  });

  it('does not interpret programmatic seek as input and releases a silent seek within one second', () => {
    const h = readyOperator(1);
    h.focus();
    h.poll();
    h.player.seekTo(50, true);
    h.poll();
    expect(
      vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type === MSG.REQUEST_SEEK),
    ).toHaveLength(0);
    vi.advanceTimersByTime(1_001);
    h.emit(2);
    expect(vi.mocked(safeSend).mock.calls.map(([, frame]) => frame)).toContainEqual({
      type: MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId: QUEUE_ITEM_ID,
    });
  });

  it('releases a throwing programmatic seek and resets the position baseline', () => {
    const h = readyOperator(1, { throwingSeek: true });
    h.focus();
    h.poll();
    expect(() => h.player.seekTo(50, true)).toThrow('seek unavailable');
    h.setTime(50);
    h.poll();
    expect(
      vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type === MSG.REQUEST_SEEK),
    ).toHaveLength(0);
    h.emit(2);
    expect(vi.mocked(safeSend).mock.calls.map(([, frame]) => frame)).toContainEqual({
      type: MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId: QUEUE_ITEM_ID,
    });
  });

  it('does not promote heartbeat seek feedback into operator commands', async () => {
    const h = readyOperator(1);
    h.setTime(50);
    await h.receive(MSG.YOUTUBE_SYNC, {
      queueItemId: QUEUE_ITEM_ID,
      time: 40,
      state: 1,
      videoId: 'vidA000000A',
      subIndex: -1,
    });
    expect(h.calls.some(([kind, seconds]) => kind === 'seek' && seconds === 40)).toBe(true);
    // A plausible iframe trace after the real host heartbeat seek. We inject
    // provider callbacks, not a real networked iframe; cadence is not proven.
    h.emit(3);
    h.emit(2);
    h.emit(1);
    const commands = vi
      .mocked(safeSend)
      .mock.calls.map(([, frame]) => frame)
      .filter((f) => f.type.startsWith('request-'));
    expect(commands).toEqual([]);
    h.emit(2);
    expect(vi.mocked(safeSend).mock.calls.map(([, frame]) => frame)).toContainEqual({
      type: MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId: QUEUE_ITEM_ID,
    });
  });

  it('does not promote an ordinary app-issued pause callback', () => {
    const h = readyOperator(1);
    h.player.pauseVideo();
    h.emit(2);
    expect(
      vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type.startsWith('request-')),
    ).toHaveLength(0);
  });

  it.each([
    { label: 'tiny seek', readonlySeek: false, target: 40.02, delay: 0 },
    { label: 'readonly seek', readonlySeek: true, target: 50, delay: 0 },
    { label: 'late target buffering', readonlySeek: false, target: 50, delay: 2_000 },
  ])(
    'does not promote $label provider feedback into room commands',
    ({ readonlySeek, target, delay }) => {
      const h = readyOperator(1, { readonlySeek });
      h.player.seekTo(target, true);
      vi.advanceTimersByTime(delay);
      h.emit(3);
      h.emit(2);
      h.emit(1);
      expect(
        vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type.startsWith('request-')),
      ).toHaveLength(0);
    },
  );

  it('keeps an unfinished buffering seek owned beyond the silent timeout but releases on PLAYING', () => {
    const h = readyOperator(1);
    h.player.seekTo(50, true);
    h.emit(3);
    vi.advanceTimersByTime(2_000);
    h.emit(2);
    h.emit(1);
    expect(
      vi.mocked(safeSend).mock.calls.filter(([, frame]) => frame.type.startsWith('request-')),
    ).toHaveLength(0);
    h.emit(2);
    expect(vi.mocked(safeSend).mock.calls.map(([, frame]) => frame)).toContainEqual({
      type: MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId: QUEUE_ITEM_ID,
    });
  });
});

describe('listener native iframe integration', () => {
  it.each(['standard', 'pro'] as const)(
    'rejoins a visible %s listener whose iframe PAUSE is followed by iframe PLAY',
    (listener) => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const h = readyOperator(1, { listener });
      const rejoin = vi.fn();
      bus.on('playback:local-output-rejoin', rejoin);

      h.emit(2);
      expect(ytState.getYtAutoplayIntent()).toBe(true);
      h.emit(1);
      vi.advanceTimersByTime(300);

      expect(rejoin).toHaveBeenCalledExactlyOnceWith({
        reason: 'media-session-play',
        mode: 'youtube',
      });
    },
  );
});
