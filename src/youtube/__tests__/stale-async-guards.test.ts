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
import {
  IOS_WATCHDOG_MS,
  UNAVAILABLE_STUCK_THRESHOLD_MS,
  YOUTUBE_PRIME_VIDEO_ID,
} from '../constants.ts';
import { setManagedTimer } from '../../core/timers.ts';
import { showToast } from '../../ui/toast.ts';
import { broadcast } from '../../network/peer.ts';
import { broadcastSystemMessage } from '../../chat/protocol.ts';
import {
  setPlaybackFilePlaying,
  setPlaybackTrackMeta,
  setPlaybackYouTubePlaying,
} from '../../player/ownership.ts';
import type { DataConnection, PlaylistItem, TrackMeta } from '../../types/index.ts';
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

// This suite exercises the persistent-player and gesture-gate paths that are
// specific to iOS WebKit. Other YouTube suites retain the default jsdom
// (non-iOS) platform, so both branches remain covered.
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  IS_IOS: true,
  IS_ANDROID: false,
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

vi.mock('../sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
  guestRendezvousSync: vi.fn(() => ({ status: 'not-ready' })),
  resetAdDetection: vi.fn(),
  initYouTubeSync: vi.fn(),
  resetYouTubeSyncState: vi.fn(),
  suppressDriftUntil: vi.fn(),
}));

vi.mock('../standard-host-manual-offset-gate.ts', () => ({
  cancelStandardHostManualOffsetTransaction: vi.fn(() => false),
  isStandardHostManualOffsetTransactionPending: vi.fn(() => false),
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
const broadcastSystemMessageMock = vi.mocked(broadcastSystemMessage);

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
    | ((event: { data: number; target: YouTubePlayerInstance }) => void)
    | undefined;
  let capturedOnReady: ((event: { target: YouTubePlayerInstance }) => void) | undefined;
  let capturedOnError:
    | ((event: { data: number; target: YouTubePlayerInstance }) => void)
    | undefined;
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

describe('IFrame runtime readiness identity', () => {
  it('does not expose the synchronous player facade as ready before onReady', async () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const { isYtPlayerReady } = await import('../_state.ts');
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();

    loadYouTubeVideo('readyEpoch1', null, false, 0);
    expect(isYtPlayerReady()).toBe(false);

    handle.fireReady();
    expect(isYtPlayerReady()).toBe(true);
  });

  it('keeps a successor load guarded while a shared API attempt flushes its stale predecessor', async () => {
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const { isYtLoadInProgress } = await import('../_state.ts');
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();

    loadYouTubeVideo('staleLoad01', null, false, 0);
    loadYouTubeVideo('freshLoad02', null, false, 0);

    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const script = document.querySelector<HTMLScriptElement>(
      'script[src*="youtube.com/iframe_api"]',
    );
    expect(script).not.toBeNull();

    script!.dispatchEvent(new Event('load'));

    // The stale task runs first, but only the successor owns this shared flag.
    expect(isYtLoadInProgress()).toBe(true);

    handle.fireReady();
    expect(isYtLoadInProgress()).toBe(false);
  });

  it.each([
    { capabilities: [] as const, label: 'ordinary member' },
    { capabilities: ['playback.control'] as const, label: 'authorized controller' },
  ])('reports YouTube readiness independently for a PRO $label', async ({ capabilities }) => {
    const player = createMockYtPlayer();
    installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [...capabilities],
    });
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    const buttonStates: boolean[] = [];
    bus.on('ui:play-btn-state', (enabled) => buttonStates.push(enabled));

    loadYouTubeVideo('readyEpoch2', null, false, 0);

    expect(buttonStates.at(-1)).toBe(true);
  });

  it('applies caption policy only to the current player while YouTube mode is active', async () => {
    const setOption = vi.fn();
    const player = {
      ...createMockYtPlayer(),
      getOptions: vi.fn((module?: string) => (module ? ['track', 'fontSize'] : ['captions'])),
      getOption: vi.fn(() => ({ languageCode: 'en' })),
      setOption,
    } satisfies YouTubePlayerInstance;
    const staleSetOption = vi.fn();
    const stalePlayer = {
      ...createMockYtPlayer(),
      getOptions: vi.fn((module?: string) => (module ? ['track', 'fontSize'] : ['captions'])),
      getOption: vi.fn(() => ({ languageCode: 'ko' })),
      setOption: staleSetOption,
    } satisfies YouTubePlayerInstance;
    const handle = installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();

    loadYouTubeVideo('captionVid1', null, false, 0);
    handle.fireApiChange();
    expect(setOption).toHaveBeenCalledWith('captions', 'track', {});
    expect(setOption).toHaveBeenCalledWith('captions', 'fontSize', -1);

    handle.fireApiChange(stalePlayer);
    expect(staleSetOption).not.toHaveBeenCalled();

    vi.mocked(player.getVideoData).mockReturnValue({ video_id: 'captionVid2' });
    setPlaybackFilePlaying();
    handle.fireApiChange();
    expect(setOption).toHaveBeenCalledTimes(2);
  });
});

describe('autoplay-policy recovery', () => {
  it.each([
    ['CUED', 5],
    ['UNSTARTED', -1],
  ])(
    'does not gate or classify an intentional %s iOS pause before play is requested',
    async (_stateName, intentionalPausedState) => {
      const player = createMockYtPlayer(['firstVideo1', 'secondVideo']);
      vi.mocked(player.getPlayerState!).mockReturnValue(intentionalPausedState);
      vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'firstVideo1' });
      const handle = installYtNamespace(player);
      const { loadYouTubeVideo } = await import('../iframe.ts');

      setPlaybackYouTubePlaying();
      wireStopAllMediaChain();
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'Manual-start playlist',
          videoId: 'firstVideo1',
          playlistId: 'PL_MANUAL',
        } as unknown as PlaylistItem,
      ]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('youtube.subItemsMap', {
        PL_MANUAL: {
          ids: ['firstVideo1', 'secondVideo'],
          titles: ['First', 'Second'],
        },
      });

      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(20_000);
      loadYouTubeVideo('firstVideo1', null, false, 0);
      handle.fireReady();
      const uiTick = lastTimerCallback('youtubeUILoop');
      expect(uiTick).toBeTypeOf('function');

      const tryNext = vi.fn();
      const nextTrack = vi.fn();
      bus.on('youtube:try-next-internal', tryNext);
      bus.on('playlist:next-track', nextTrack);

      uiTick?.();
      now.mockReturnValue(20_000 + UNAVAILABLE_STUCK_THRESHOLD_MS + IOS_WATCHDOG_MS + 1);
      uiTick?.();

      expect(document.getElementById('youtube-ios-sync-overlay')).toBeNull();
      expect(tryNext).not.toHaveBeenCalled();
      expect(nextTrack).not.toHaveBeenCalled();
      expect(getState('youtube.currentSubIndex')).toBe(0);
    },
  );

  it('turns a persistently CUED iOS play attempt into a tap gate before unavailable recovery can advance it', async () => {
    const player = createMockYtPlayer(['firstVideo1', 'secondVideo']);
    vi.mocked(player.getPlayerState!).mockReturnValue(5);
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'firstVideo1' });
    const handle = installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const { setYtAutoplayIntent } = await import('../_state.ts');

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Indexed playlist',
        videoId: 'firstVideo1',
        playlistId: 'PL_INDEXED',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setState('youtube.subItemsMap', {
      PL_INDEXED: {
        ids: ['firstVideo1', 'secondVideo'],
        titles: ['First', 'Second'],
      },
    });

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(10_000);
    loadYouTubeVideo('firstVideo1', null, false, 0);
    handle.fireReady();
    setYtAutoplayIntent(true);
    const uiTick = lastTimerCallback('youtubeUILoop');
    expect(uiTick).toBeTypeOf('function');

    const tryNext = vi.fn();
    const nextTrack = vi.fn();
    bus.on('youtube:try-next-internal', tryNext);
    bus.on('playlist:next-track', nextTrack);

    uiTick?.();
    now.mockReturnValue(10_000 + IOS_WATCHDOG_MS + 1);
    uiTick?.();

    expect(document.getElementById('youtube-ios-sync-overlay')).not.toBeNull();
    expect(getState('youtube.currentSubIndex')).toBe(0);

    // Even after the generic unavailable threshold, the visible policy gate
    // owns this stall and must protect the selected first item from #2.
    now.mockReturnValue(10_000 + UNAVAILABLE_STUCK_THRESHOLD_MS + IOS_WATCHDOG_MS + 2);
    uiTick?.();
    expect(tryNext).not.toHaveBeenCalled();
    expect(nextTrack).not.toHaveBeenCalled();
    expect(getState('youtube.currentSubIndex')).toBe(0);
  });

  it('keeps the first indexed playlist video selected and asks for a tap when scripted play is blocked', async () => {
    const player = createMockYtPlayer(['firstVideo1', 'secondVideo']);
    vi.mocked(player.getPlayerState!).mockReturnValue(-1);
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'firstVideo1' });
    const handle = installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const { setYtAutoplayIntent } = await import('../_state.ts');

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Indexed playlist',
        videoId: 'firstVideo1',
        playlistId: 'PL_INDEXED',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setState('youtube.subItemsMap', {
      PL_INDEXED: {
        ids: ['firstVideo1', 'secondVideo'],
        titles: ['First', 'Second'],
      },
    });

    // Mirrors the post-indexing handoff: the native playlist indexer has
    // resolved IDs and playback is forced to the first concrete video.
    loadYouTubeVideo('firstVideo1', null, false, 0);
    // The rendezvous/zero-start owner has now committed to scripted playback.
    // A policy block before this point is only a harmless cue/indexing event;
    // after this point it needs one explicit user gesture.
    setYtAutoplayIntent(true);

    const tryNext = vi.fn();
    const nextTrack = vi.fn();
    bus.on('youtube:try-next-internal', tryNext);
    bus.on('playlist:next-track', nextTrack);
    showToastMock.mockClear();
    broadcastSystemMessageMock.mockClear();

    handle.fireAutoplayBlocked();

    const gate = document.getElementById('youtube-ios-sync-overlay');
    expect(gate).toBeInstanceOf(HTMLButtonElement);
    expect((gate as HTMLButtonElement | null)?.type).toBe('button');
    expect(gate?.getAttribute('aria-label')).toBe('youtube.tap_to_play');
    expect(getState('youtube.currentSubIndex')).toBe(0);
    expect(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
    expect(tryNext).not.toHaveBeenCalled();
    expect(nextTrack).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalledWith('youtube.video_unavailable');
    expect(broadcastSystemMessageMock).not.toHaveBeenCalledWith('youtube.video_unavailable');

    // A canonical pause must remove the stale shield. If a later scripted
    // PLAY is blocked again, the same occurrence can recreate the gate.
    handle.fireStateChange(2);
    expect(document.getElementById('youtube-ios-sync-overlay')).toBeNull();
    handle.fireAutoplayBlocked();
    expect(document.getElementById('youtube-ios-sync-overlay')).not.toBeNull();

    vi.mocked(player.playVideo!).mockClear();
    vi.mocked(player.pauseVideo!).mockClear();
    document.getElementById('youtube-ios-sync-overlay')?.click();

    // Host tap: synchronously acquire the iframe gesture with play/pause,
    // dismiss the gate, then retry the selected first video in-place.
    expect(player.playVideo).toHaveBeenCalledTimes(2);
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    expect(document.getElementById('youtube-ios-sync-overlay')).toBeNull();
    expect(getState('youtube.currentSubIndex')).toBe(0);
    expect(tryNext).not.toHaveBeenCalled();
    expect(nextTrack).not.toHaveBeenCalled();
  });

  it('uses a PRO gate tap only to unlock the iframe before rejoining the server timeline', async () => {
    const player = createMockYtPlayer();
    vi.mocked(player.getPlayerState!).mockReturnValue(5);
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'proVideo001' });
    const handle = installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const { setYtAutoplayIntent } = await import('../_state.ts');

    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'PRO playlist entry',
        videoId: 'proVideo001',
        playlistId: 'PL_PRO',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

    loadYouTubeVideo('proVideo001', null, false, 0);
    setYtAutoplayIntent(true);

    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    handle.fireAutoplayBlocked();
    expect(document.getElementById('youtube-ios-sync-overlay')).not.toBeNull();

    vi.mocked(player.playVideo!).mockClear();
    vi.mocked(player.pauseVideo!).mockClear();
    document.getElementById('youtube-ios-sync-overlay')?.click();

    // The synchronous pair captures WebKit's gesture for this endpoint.
    // Canonical playback still comes from the PRO server rejoin path, so
    // there must be no second direct local play command.
    expect(player.playVideo).toHaveBeenCalledTimes(1);
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    expect(rejoin).toHaveBeenCalledOnce();
    expect(rejoin).toHaveBeenCalledWith({
      reason: 'media-session-play',
      mode: 'youtube',
    });
    expect(document.getElementById('youtube-ios-sync-overlay')).toBeNull();
  });
});

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
    vi.mocked(player.pauseVideo!).mockClear();
    vi.mocked(player.stopVideo!).mockClear();
    loadYouTubeVideo('vidB000000B', null, false, 0);
    expect(player.loadVideoById).toHaveBeenCalledWith('vidB000000B');
    expect(player.pauseVideo).toHaveBeenCalledOnce();
    expect(player.stopVideo).not.toHaveBeenCalled();

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

  it('ignores an unavailable callback emitted by a retired player after replacement', async () => {
    const retiredPlayer = createMockYtPlayer();
    const handle = await createPlayerInYouTubeMode(retiredPlayer);
    const replacementPlayer = createMockYtPlayer();
    vi.mocked(replacementPlayer.getVideoData!).mockReturnValue({ video_id: 'vidB000000B' });
    vi.mocked(replacementPlayer.getPlayerState!).mockReturnValue(3);

    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'B',
        videoId: 'vidB000000B',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    const stateMod = await import('../_state.ts');
    stateMod.setYouTubePlayer(replacementPlayer);
    stateMod.setYtLoadInProgress(true);

    const nextTrack = vi.fn();
    const tryNext = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    bus.on('youtube:try-next-internal', tryNext);
    showToastMock.mockClear();

    handle.fireError(150, retiredPlayer);

    expect(stateMod.getYouTubePlayer()).toBe(replacementPlayer);
    expect(stateMod.isYtLoadInProgress()).toBe(true);
    expect(nextTrack).not.toHaveBeenCalled();
    expect(tryNext).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
    expect(broadcastSystemMessageMock).not.toHaveBeenCalled();
  });

  it('ignores an ENDED callback emitted by a retired player after replacement', async () => {
    const retiredPlayer = createMockYtPlayer();
    const handle = await createPlayerInYouTubeMode(retiredPlayer);
    const replacementPlayer = createMockYtPlayer();

    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'B',
        videoId: 'vidB000000B',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    const { setYouTubePlayer } = await import('../_state.ts');
    setYouTubePlayer(replacementPlayer);

    const nextTrack = vi.fn();
    const tryNext = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    bus.on('youtube:try-next-internal', tryNext);

    handle.fireStateChange(0, retiredPlayer);

    expect(nextTrack).not.toHaveBeenCalled();
    expect(tryNext).not.toHaveBeenCalled();
    expect(setManagedTimerMock).not.toHaveBeenCalledWith(
      'yt-guest-ended-fallback',
      expect.any(Function),
      expect.any(Number),
    );
  });

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
    expect(broadcastSystemMessageMock).not.toHaveBeenCalled();
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
    expect(broadcastSystemMessageMock).not.toHaveBeenCalled();
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
    expect(broadcastSystemMessageMock).toHaveBeenCalledWith('youtube.video_unavailable');
    expect(nextTrack).toHaveBeenCalledTimes(1);
  });

  it('a guest-local unavailable error gives feedback but leaves the room-wide skip to the host', async () => {
    const player = createMockYtPlayer();
    const handle = await createPlayerInYouTubeMode(player);
    setState('network.hostConn', { open: true } as unknown as DataConnection);
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
    expect(broadcastSystemMessageMock).not.toHaveBeenCalled();
    expect(nextTrack).not.toHaveBeenCalled();
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
    expect(broadcastSystemMessageMock).not.toHaveBeenCalled();
    expect(nextTrack).not.toHaveBeenCalled();
  });
});

describe('retained iOS player teardown', () => {
  async function startActivePlayer(player: YouTubePlayerInstance): Promise<YtTestHandle> {
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const handle = installYtNamespace(player);
    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Last YouTube item',
        videoId: 'lastVideo01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('lastVideo01', null, true, 0);
    handle.fireReady();
    return handle;
  }

  it('mutes and parks a retained cross-mode iframe, then fences its stale ENDED callback', async () => {
    let residentVideoId = 'lastVideo01';
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
    } satisfies YouTubePlayerInstance;
    const handle = await startActivePlayer(player);
    const { initYouTube, stopYouTubeMode } = await import('../player.ts');
    const stateMod = await import('../_state.ts');
    stateMod.setYtPrimed(true);
    initYouTube();

    vi.mocked(player.pauseVideo).mockClear();
    stopYouTubeMode({ silent: true });

    expect(stateMod.getYouTubePlayer()).toBe(player);
    expect(player.mute).toHaveBeenCalledOnce();
    expect(player.pauseVideo).toHaveBeenCalledOnce();
    expect(player.cueVideoById).toHaveBeenCalledWith(YOUTUBE_PRIME_VIDEO_ID, 0);
    expect(player.destroy).not.toHaveBeenCalled();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();

    // Desired volume may change while another mode owns the page, but the
    // parked iframe must stay physically muted until the intended next-video
    // state completes the parking handoff.
    bus.emit('youtube:set-volume', 80);
    expect(player.setVolume).toHaveBeenCalledWith(80);
    expect(player.unMute).not.toHaveBeenCalled();
    expect(player.mute).toHaveBeenCalledTimes(2);

    // The transport claims file mode immediately after its silent stop. A
    // queued native PLAYING callback must close physical output again.
    setPlaybackFilePlaying();
    handle.fireStateChange(1);
    expect(player.mute).toHaveBeenCalledTimes(3);
    expect(player.pauseVideo).toHaveBeenCalledTimes(2);

    // Reuse the exact iframe for a later item. An outgoing ENDED callback may
    // arrive after cueVideoById(next), while getVideoData still reports the
    // parked prime; it must not advance the new occurrence.
    const nextTrack = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Next YouTube item',
        videoId: 'nextVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    const { loadYouTubeVideo } = await import('../iframe.ts');
    zeroStartFacade.handlePlayerState.mockClear();
    loadYouTubeVideo('nextVideo02', null, false, 0);
    handle.fireStateChange(0);
    handle.fireStateChange(2);
    handle.fireStateChange(5);
    expect(nextTrack).not.toHaveBeenCalled();
    expect(zeroStartFacade.handlePlayerState).not.toHaveBeenCalled();

    // Only two stable post-command snapshots may release the fence. All
    // native states above can be queued from the outgoing occurrence even
    // though getVideoData() already flipped to the requested target.
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(nextTrack).not.toHaveBeenCalled();
    expect(zeroStartFacade.handlePlayerState).toHaveBeenCalledTimes(1);
    expect(zeroStartFacade.handlePlayerState).toHaveBeenLastCalledWith(5);

    // Even after release, a queued event must agree with the exact player's
    // live state. A stale PAUSED cannot mutate the active target whose live
    // snapshot remains CUED.
    handle.fireStateChange(2);
    expect(zeroStartFacade.handlePlayerState).toHaveBeenCalledTimes(1);
    handle.fireStateChange(5);
    expect(zeroStartFacade.handlePlayerState).toHaveBeenCalledTimes(2);
    bus.emit('youtube:set-volume', 80);
    expect(player.unMute).toHaveBeenCalledOnce();
  });

  it('fences parked PRIME metadata while a retained target load is deferred', async () => {
    let residentVideoId = 'lastVideo01';
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() =>
        residentVideoId === YOUTUBE_PRIME_VIDEO_ID
          ? {
              video_id: residentVideoId,
              title: 'Silent prime title',
              author: 'Silent prime channel',
            }
          : { video_id: residentVideoId, title: 'Previous title', author: 'Previous channel' },
      ),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode({ silent: true });
    expect(residentVideoId).toBe(YOUTUBE_PRIME_VIDEO_ID);

    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Requested target',
        videoId: 'nextVideo02',
      } as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    setPlaybackTrackMeta({
      queueItemId: SECOND_QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Requested target',
      title: 'Requested target',
      videoId: 'nextVideo02',
    });

    // Do not complete the two-sample PRIME parking proof. The controller must
    // defer the physical target cue while the metadata fence is already live.
    loadYouTubeVideo('nextVideo02', null, false, 0);
    lastTimerCallback('youtubeUILoop')?.();

    expect(residentVideoId).toBe(YOUTUBE_PRIME_VIDEO_ID);
    expect(getState('player.currentTrackMeta')).toMatchObject({ title: 'Requested target' });
    expect(getState('player.currentTrackMeta')?.artist).toBeUndefined();
  });

  it('publishes prime readiness only after live PRIME and delayed hard-mute convergence', async () => {
    let residentVideoId = 'lastVideo01';
    let physicallyMuted = false;
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      mute: vi.fn(),
      isMuted: vi.fn(() => physicallyMuted),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    stateMod.setYtPrimed(false);

    stopYouTubeMode();

    // mute() is a postMessage command: a synchronous false snapshot does not
    // force destruction, but neither cue acceptance nor player readiness may
    // expose a gesture bounce against the still-unconfirmed occurrence.
    expect(stateMod.getYouTubePlayer()).toBe(player);
    expect(stateMod.isYtPrimeReady()).toBe(false);
    physicallyMuted = true;
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(stateMod.isYtPrimeReady()).toBe(false);
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(stateMod.isYtPrimeReady()).toBe(true);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it('requires consecutive PRIME samples after an uncertain hard-mute interval', async () => {
    let residentVideoId = 'lastVideo01';
    let physicallyMuted = false;
    let muteConverges = true;
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      mute: vi.fn(() => {
        if (muteConverges) physicallyMuted = true;
      }),
      isMuted: vi.fn(() => physicallyMuted),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    stateMod.setYtPrimed(false);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(stateMod.isYtPrimeReady()).toBe(false);

    // A false read followed by an ineffective re-mute breaks the stable PRIME
    // sequence even though identity itself never changed.
    muteConverges = false;
    physicallyMuted = false;
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    physicallyMuted = true;
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(stateMod.isYtPrimeReady()).toBe(false);

    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(stateMod.isYtPrimeReady()).toBe(true);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it('allows only a live silent-PRIME gesture bounce through the off-mode fence', async () => {
    let residentVideoId = 'lastVideo01';
    let liveState = 5;
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
        liveState = 5;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => liveState),
    } satisfies YouTubePlayerInstance;
    const handle = await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { primeYouTubePlayer } = await import('../iframe.ts');
    stateMod.setYtPrimed(false);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(stateMod.isYtPrimeReady()).toBe(true);
    expect(primeYouTubePlayer()).toBe(true);

    // A queued PLAYING event is not proof while the exact iframe still says
    // CUED, even though the gesture bounce is pending on the silent ID.
    handle.fireStateChange(1);
    expect(stateMod.isYtPrimed()).toBe(false);
    expect(stateMod.isYtPrimeBouncePending()).toBe(true);

    // Only the matching live PLAYING snapshot may establish WebKit gesture
    // proof. The normal prime handler pauses and re-mutes the parked iframe.
    liveState = 1;
    handle.fireStateChange(1);
    expect(stateMod.isYtPrimed()).toBe(true);
    expect(stateMod.isYtPrimeBouncePending()).toBe(false);
    expect(player.pauseVideo).toHaveBeenCalled();
    expect(player.isMuted?.()).toBe(true);

    // Even during a new bounce attempt, old room-media identity is forbidden.
    stateMod.setYtPrimed(false);
    stateMod.setYtPrimeReady(true);
    liveState = 2;
    expect(primeYouTubePlayer()).toBe(true);
    residentVideoId = 'lastVideo01';
    liveState = 1;
    handle.fireStateChange(1);
    expect(stateMod.isYtPrimed()).toBe(false);
    expect(player.isMuted?.()).toBe(true);
  });

  it('retains gesture proof when post-bounce mute converges at live PRIME PAUSED', async () => {
    let residentVideoId = 'lastVideo01';
    let liveState = 5;
    let physicallyMuted = false;
    let muteConvergesImmediately = true;
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
        liveState = 5;
      }),
      mute: vi.fn(() => {
        if (muteConvergesImmediately) physicallyMuted = true;
      }),
      unMute: vi.fn(() => {
        physicallyMuted = false;
      }),
      isMuted: vi.fn(() => physicallyMuted),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => liveState),
    } satisfies YouTubePlayerInstance;
    const handle = await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { primeYouTubePlayer } = await import('../iframe.ts');
    stateMod.setYtPrimed(false);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(primeYouTubePlayer()).toBe(true);
    muteConvergesImmediately = false;
    liveState = 1;
    handle.fireStateChange(1);
    expect(stateMod.isYtPrimed()).toBe(true);
    expect(physicallyMuted).toBe(false);

    // WebKit applies pause/mute asynchronously after the proven bounce. This
    // post-bounce confirmation may accept PAUSED, but never PLAYING.
    physicallyMuted = true;
    liveState = 2;
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(player.destroy).not.toHaveBeenCalled();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    for (let poll = 0; poll < 25; poll += 1) {
      lastTimerCallback('yt-retained-player-park-confirm')?.();
    }

    expect(stateMod.getYouTubePlayer()).toBe(player);
    expect(stateMod.isYtPrimed()).toBe(true);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it('revalidates retained PRIME identity at the gesture-bound unmute seam', async () => {
    let residentVideoId = 'lastVideo01';
    let liveState = 5;
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
        liveState = 5;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => liveState),
    } satisfies YouTubePlayerInstance;
    const handle = await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { primeYouTubePlayer } = await import('../iframe.ts');
    stateMod.setYtPrimed(false);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(stateMod.isYtPrimeReady()).toBe(true);
    vi.mocked(player.cueVideoById).mockClear();
    vi.mocked(player.playVideo).mockClear();
    vi.mocked(player.unMute!).mockClear();

    // A non-PLAYING native transition can be queued after ready publication
    // and replace the resident ID without entering the audible-state guard.
    residentVideoId = 'lastVideo01';
    liveState = 2;
    handle.fireStateChange(2);
    expect(stateMod.isYtPrimeReady()).toBe(true);

    expect(primeYouTubePlayer()).toBe(false);
    expect(player.unMute).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(player.cueVideoById).toHaveBeenCalledWith(YOUTUBE_PRIME_VIDEO_ID, 0);
    expect(stateMod.isYtPrimeReady()).toBe(false);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'throw', 'iframe-error'] as const)(
    'recovers retained PRIME silence before retrying a %s bounce',
    async (failure) => {
      let residentVideoId = 'lastVideo01';
      let liveState = 5;
      let physicallyMuted = false;
      let rejectNextPlay = failure === 'throw';
      const playVideo = vi.fn(() => {
        if (!rejectNextPlay) return;
        rejectNextPlay = false;
        throw new Error('transient gesture rejection');
      });
      const player = {
        ...createMockYtPlayer(),
        playVideo,
        cueVideoById: vi.fn((videoId: string) => {
          residentVideoId = videoId;
          liveState = 5;
        }),
        mute: vi.fn(() => {
          physicallyMuted = true;
        }),
        unMute: vi.fn(() => {
          physicallyMuted = false;
        }),
        isMuted: vi.fn(() => physicallyMuted),
        getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
        getPlayerState: vi.fn(() => liveState),
      } satisfies YouTubePlayerInstance;
      const handle = await startActivePlayer(player);
      const stateMod = await import('../_state.ts');
      const { stopYouTubeMode } = await import('../player.ts');
      const { primeYouTubePlayer } = await import('../iframe.ts');
      stateMod.setYtPrimed(false);

      stopYouTubeMode();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      expect(stateMod.isYtPrimeReady()).toBe(true);

      primeYouTubePlayer();
      expect(playVideo).toHaveBeenCalledOnce();
      if (failure === 'timeout') {
        lastTimerCallback('yt-prime-bounce-timeout')?.();
      } else if (failure === 'iframe-error') {
        showToastMock.mockClear();
        handle.fireError(5);
        expect(showToastMock).not.toHaveBeenCalled();
      }

      // Every retained failure branch must undo the gesture-bound unMute and
      // withhold readiness until the exact PRIME occurrence is parked again.
      expect(physicallyMuted).toBe(true);
      expect(stateMod.isYtPrimeBouncePending()).toBe(false);
      expect(stateMod.isYtPrimeReady()).toBe(false);
      expect(player.cueVideoById).toHaveBeenCalledTimes(2);
      expect(player.destroy).not.toHaveBeenCalled();

      lastTimerCallback('yt-retained-player-park-confirm')?.();
      expect(stateMod.isYtPrimeReady()).toBe(false);
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      expect(stateMod.isYtPrimeReady()).toBe(true);

      // Recovery itself never plays asynchronously. The next direct gesture
      // spends its activation on a new playVideo(), rather than only reparking.
      expect(playVideo).toHaveBeenCalledOnce();
      expect(primeYouTubePlayer()).toBe(true);
      expect(playVideo).toHaveBeenCalledTimes(2);
      expect(stateMod.isYtPrimeBouncePending()).toBe(true);
      expect(stateMod.isYtPrimeReady()).toBe(false);
    },
  );

  it('keeps a false-intent retained target muted until PLAYING pause-back converges', async () => {
    let residentVideoId = 'lastVideo01';
    let liveState = 5;
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
        liveState = videoId === YOUTUBE_PRIME_VIDEO_ID ? 5 : 1;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => liveState),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { initYouTube, stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);
    initYouTube();

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Paused target',
        videoId: 'nextVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    loadYouTubeVideo('nextVideo02', null, false, 0);

    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(player.pauseVideo).toHaveBeenCalled();
    bus.emit('youtube:set-volume', 80);
    expect(player.unMute).not.toHaveBeenCalled();

    liveState = 2;
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    bus.emit('youtube:set-volume', 80);
    expect(player.unMute).toHaveBeenCalledOnce();
  });

  it('does not release when the synthetic callback live snapshot changes before admission', async () => {
    let residentVideoId = 'lastVideo01';
    let targetSnapshotReads = 0;
    let settledTargetState: number | null = null;
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => {
        if (residentVideoId !== 'nextVideo02') return 5;
        if (settledTargetState !== null) return settledTargetState;
        targetSnapshotReads += 1;
        return targetSnapshotReads <= 2 ? 5 : 1;
      }),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { initYouTube, stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);
    initYouTube();

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Racing target',
        videoId: 'nextVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    zeroStartFacade.handlePlayerState.mockClear();
    loadYouTubeVideo('nextVideo02', null, false, 0);

    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(zeroStartFacade.handlePlayerState).not.toHaveBeenCalled();
    bus.emit('youtube:set-volume', 80);
    expect(player.unMute).not.toHaveBeenCalled();

    settledTargetState = 2;
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(zeroStartFacade.handlePlayerState).toHaveBeenCalledWith(2);
    bus.emit('youtube:set-volume', 80);
    expect(player.unMute).toHaveBeenCalledOnce();
  });

  it('destroys an active retained target if IDLE-before-stop receives PLAYING after mute breaks', async () => {
    let residentVideoId = 'lastVideo01';
    let liveState = 5;
    let physicallyMuted = false;
    let muteThrows = false;
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      mute: vi.fn(() => {
        if (muteThrows) throw new Error('mute broke after handoff');
        physicallyMuted = true;
      }),
      unMute: vi.fn(() => {
        physicallyMuted = false;
      }),
      isMuted: vi.fn(() => physicallyMuted),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => liveState),
    } satisfies YouTubePlayerInstance;
    const handle = await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    const { setPlaybackIdle } = await import('../../player/ownership.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Active target',
        videoId: 'nextVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    liveState = 2;
    loadYouTubeVideo('nextVideo02', null, false, 0);
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();

    physicallyMuted = false;
    muteThrows = true;
    liveState = 1;
    setPlaybackIdle();
    const freshPrime = createMockYtPlayer();
    const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
    ytConstructor.mockImplementationOnce(function () {
      return freshPrime;
    });

    handle.fireStateChange(1);

    expect(player.destroy).toHaveBeenCalledOnce();
    expect(stateMod.getYouTubePlayer()).toBe(freshPrime);
  });

  it('parks the final ended occurrence on the silent prime without losing its gesture proof', async () => {
    let residentVideoId = 'lastVideo01';
    const endedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 0),
    } satisfies YouTubePlayerInstance;
    const handle = await startActivePlayer(endedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    stateMod.setYtPrimed(true);

    const nextTrack = vi.fn(() => stopYouTubeMode());
    bus.on('playlist:next-track', nextTrack);
    vi.mocked(endedPlayer.pauseVideo).mockClear();

    handle.fireStateChange(0);

    expect(nextTrack).toHaveBeenCalledOnce();
    expect(endedPlayer.mute).toHaveBeenCalledOnce();
    expect(endedPlayer.pauseVideo).toHaveBeenCalledOnce();
    expect(endedPlayer.cueVideoById).toHaveBeenCalledWith(YOUTUBE_PRIME_VIDEO_ID, 0);
    expect(endedPlayer.stopVideo).not.toHaveBeenCalled();
    expect(endedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(endedPlayer);
    expect(stateMod.isYtPrimed()).toBe(true);

    // The same object can flush an outgoing ENDED after parking; occurrence
    // fencing must keep it from advancing again.
    handle.fireStateChange(0, endedPlayer);
    expect(nextTrack).toHaveBeenCalledOnce();
    expect(stateMod.getYouTubePlayer()).toBe(endedPlayer);
  });

  it('quiesces a guest-ended occurrence even when IDLE was written before stop-mode', async () => {
    const endedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn(),
      getVideoData: vi.fn(() => ({ video_id: 'lastVideo01' })),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(endedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    stateMod.setYtPrimed(true);

    // Mirrors the guest ENDED fallback: it fences queue advancement by
    // writing IDLE first, then asks the YouTube teardown owner to quiesce the
    // still-resident room occurrence.
    setPlaybackFilePlaying();
    const { setPlaybackIdle } = await import('../../player/ownership.ts');
    setPlaybackIdle();
    stopYouTubeMode();

    expect(endedPlayer.mute).toHaveBeenCalledOnce();
    expect(endedPlayer.cueVideoById).toHaveBeenCalledWith(YOUTUBE_PRIME_VIDEO_ID, 0);
    expect(endedPlayer.stopVideo).not.toHaveBeenCalled();
    expect(endedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(endedPlayer);
  });

  it('carries explicit Stop ownership across its IDLE-before-stop-mode ordering', async () => {
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn(),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(player);
    const { initYouTube } = await import('../player.ts');
    const stateMod = await import('../_state.ts');
    const { setPlaybackIdle } = await import('../../player/ownership.ts');
    stateMod.setYtPrimed(true);
    initYouTube();

    // Make resident identity unreadable so this exercises the explicit
    // stop-playback marker, not the guest-ended identity fallback.
    vi.mocked(player.getVideoData).mockReturnValue({});
    setPlaybackIdle();
    bus.emit('youtube:stop-playback');
    bus.emit('youtube:stop-mode');

    expect(player.mute).toHaveBeenCalledOnce();
    expect(player.cueVideoById).toHaveBeenCalledWith(YOUTUBE_PRIME_VIDEO_ID, 0);
    expect(player.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(player);
  });

  it('revokes a pending PRO pause gate before a late settlement can unmute parking', async () => {
    let residentVideoId = 'lastVideo01';
    const player = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(player);
    const stateMod = await import('../_state.ts');
    const { initYouTube, stopYouTubeMode } = await import('../player.ts');
    stateMod.setYtPrimed(true);
    setState('audio.masterVolume', 0.8);
    initYouTube();

    bus.emit('pro-playback:ui-control-pending', {
      token: 91,
      kind: 'pause',
      queueItemId: QUEUE_ITEM_ID,
      targetSeconds: 12,
      wasPlaying: true,
    });
    stopYouTubeMode();
    vi.mocked(player.unMute!).mockClear();

    bus.emit('pro-playback:ui-control-settled', {
      token: 91,
      kind: 'pause',
      queueItemId: QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 12.7,
    });

    expect(player.unMute).not.toHaveBeenCalled();
    expect(player.isMuted?.()).toBe(true);
    expect(stateMod.getYouTubePlayer()).toBe(player);
  });

  it('destroys and rebuilds only when silent-prime parking is unavailable', async () => {
    const unsafePlayer = {
      ...createMockYtPlayer(),
      getVideoData: vi.fn(() => ({ video_id: 'lastVideo01' })),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(unsafePlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    stateMod.setYtPrimed(true);

    const freshPrime = {
      ...createMockYtPlayer(),
      getVideoData: vi.fn(() => ({ video_id: YOUTUBE_PRIME_VIDEO_ID })),
    } satisfies YouTubePlayerInstance;
    const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
    ytConstructor.mockImplementationOnce(function () {
      return freshPrime;
    });

    stopYouTubeMode();

    expect(unsafePlayer.stopVideo).toHaveBeenCalled();
    expect(unsafePlayer.destroy).toHaveBeenCalledOnce();
    expect(stateMod.getYouTubePlayer()).toBe(freshPrime);
    expect(stateMod.isYtPrimed()).toBe(false);
  });

  it('clears transient fresh-prime state when a failed park hands off to a real target', async () => {
    const unsafePlayer = {
      ...createMockYtPlayer(),
      cueVideoById: undefined,
      getVideoData: vi.fn(() => ({ video_id: 'lastVideo01' })),
    } satisfies YouTubePlayerInstance;
    const handle = await startActivePlayer(unsafePlayer);
    const stateMod = await import('../_state.ts');
    const { initYouTube } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);
    initYouTube();

    const freshPrime = {
      ...createMockYtPlayer(),
      // Real pre-ready IFrame postMessages can no-op. The outer real load must
      // never depend on this facade accepting loadVideoById synchronously.
      loadVideoById: vi.fn(),
      getVideoData: vi.fn(() => ({ video_id: YOUTUBE_PRIME_VIDEO_ID })),
      getPlayerState: vi.fn(() => -1),
    } satisfies YouTubePlayerInstance;
    const freshTarget = {
      ...createMockYtPlayer(),
      getVideoData: vi.fn(() => ({ video_id: 'nextVideo02' })),
      getPlayerState: vi.fn(() => -1),
    } satisfies YouTubePlayerInstance;
    const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
    ytConstructor.mockImplementationOnce(function () {
      return freshPrime;
    });
    ytConstructor.mockImplementationOnce(function () {
      return freshTarget;
    });
    setPlaybackFilePlaying();
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Real target after failed park',
        videoId: 'nextVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);

    loadYouTubeVideo('nextVideo02', null, true, 0);

    expect(unsafePlayer.destroy).toHaveBeenCalledOnce();
    expect(freshPrime.loadVideoById).not.toHaveBeenCalled();
    expect(freshPrime.destroy).toHaveBeenCalledOnce();
    expect(stateMod.getYouTubePlayer()).toBe(freshTarget);
    expect(stateMod.isYtPriming()).toBe(false);
    expect(ytConstructor).toHaveBeenLastCalledWith(
      'youtube-player',
      expect.objectContaining({ videoId: 'nextVideo02' }),
    );

    const nextTrack = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    showToastMock.mockClear();
    handle.fireError(150, freshTarget);

    expect(showToastMock).toHaveBeenCalledWith('youtube.video_unavailable');
    expect(nextTrack).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'throwing'] as const)(
    'destroys the exact iframe when its hard-mute method is %s',
    async (muteFailure) => {
      const base = createMockYtPlayer();
      const unsafePlayer = {
        ...base,
        cueVideoById: vi.fn(),
        mute:
          muteFailure === 'missing'
            ? undefined
            : vi.fn(() => {
                throw new Error('mute unavailable');
              }),
        getVideoData: vi.fn(() => ({ video_id: 'lastVideo01' })),
      } satisfies YouTubePlayerInstance;
      await startActivePlayer(unsafePlayer);
      const stateMod = await import('../_state.ts');
      const { stopYouTubeMode } = await import('../player.ts');
      stateMod.setYtPrimed(true);

      const freshPrime = createMockYtPlayer();
      const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
      ytConstructor.mockImplementationOnce(function () {
        return freshPrime;
      });

      stopYouTubeMode();

      expect(unsafePlayer.cueVideoById).not.toHaveBeenCalled();
      expect(unsafePlayer.destroy).toHaveBeenCalledOnce();
      expect(stateMod.getYouTubePlayer()).toBe(freshPrime);
      expect(stateMod.isYtPrimed()).toBe(false);
    },
  );

  it('keeps a hard-muted off-mode iframe past 3 seconds while PRIME is still cold', async () => {
    let residentVideoId = 'lastVideo01';
    let liveState = 0;
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn(),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => liveState),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    for (let poll = 0; poll < 80; poll += 1) {
      lastTimerCallback('yt-retained-player-park-confirm')?.();
    }

    expect(retainedPlayer.isMuted?.()).toBe(true);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);

    residentVideoId = YOUTUBE_PRIME_VIDEO_ID;
    liveState = 2;
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();

    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
    expect(stateMod.isYtPrimed()).toBe(true);
  });

  it.each(['empty video ID', 'throwing video data'] as const)(
    'keeps a hard-muted off-mode iframe while PRIME identity is %s',
    async (identityFailure) => {
      let residentVideoId = 'lastVideo01';
      let liveState = 5;
      let identityReadable = true;
      const retainedPlayer = {
        ...createMockYtPlayer(),
        cueVideoById: vi.fn((videoId: string) => {
          residentVideoId = videoId;
          liveState = 2;
        }),
        getVideoData: vi.fn(() => {
          if (identityReadable) return { video_id: residentVideoId };
          if (identityFailure === 'throwing video data') {
            throw new Error('video identity not ready');
          }
          return {};
        }),
        getPlayerState: vi.fn(() => liveState),
      } satisfies YouTubePlayerInstance;
      await startActivePlayer(retainedPlayer);
      const stateMod = await import('../_state.ts');
      const { stopYouTubeMode } = await import('../player.ts');
      stateMod.setYtPrimed(true);

      identityReadable = false;
      stopYouTubeMode();
      for (let poll = 0; poll < 80; poll += 1) {
        lastTimerCallback('yt-retained-player-park-confirm')?.();
      }

      // Identity can be cold for longer than three seconds, but every sample
      // independently proves the exact offscreen iframe is still muted.
      expect(retainedPlayer.isMuted?.()).toBe(true);
      expect(retainedPlayer.destroy).not.toHaveBeenCalled();
      expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);

      identityReadable = true;
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      lastTimerCallback('yt-retained-player-park-confirm')?.();

      expect(retainedPlayer.destroy).not.toHaveBeenCalled();
      expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
    },
  );

  it.each(['false', 'unreadable'] as const)(
    'quickly rebuilds an off-mode iframe whose hard-mute proof stays %s',
    async (muteFailure) => {
      let residentVideoId = 'lastVideo01';
      let physicallyMuted = false;
      let muteProofBroken = false;
      const unsafePlayer = {
        ...createMockYtPlayer(),
        cueVideoById: vi.fn((videoId: string) => {
          residentVideoId = videoId;
        }),
        mute: vi.fn(() => {
          if (!muteProofBroken) physicallyMuted = true;
        }),
        isMuted: vi.fn(() => {
          if (muteProofBroken && muteFailure === 'unreadable') {
            throw new Error('mute state unreadable');
          }
          return physicallyMuted;
        }),
        getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
        getPlayerState: vi.fn(() => 5),
      } satisfies YouTubePlayerInstance;
      await startActivePlayer(unsafePlayer);
      const stateMod = await import('../_state.ts');
      const { stopYouTubeMode } = await import('../player.ts');
      stateMod.setYtPrimed(true);

      const freshPrime = createMockYtPlayer();
      const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
      ytConstructor.mockImplementationOnce(function () {
        return freshPrime;
      });
      muteProofBroken = true;
      physicallyMuted = false;
      stopYouTubeMode();
      vi.mocked(unsafePlayer.unMute!).mockClear();

      for (let poll = 0; poll < 25; poll += 1) {
        lastTimerCallback('yt-retained-player-park-confirm')?.();
      }

      expect(unsafePlayer.mute).toHaveBeenCalled();
      expect(unsafePlayer.unMute).not.toHaveBeenCalled();
      expect(unsafePlayer.destroy).toHaveBeenCalledOnce();
      expect(stateMod.getYouTubePlayer()).toBe(freshPrime);
    },
  );

  it('destroys a hard-muted iframe when the silent-prime cue never becomes resident', async () => {
    const unsafePlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn(), // accepted/no-op: live identity never changes
      getVideoData: vi.fn(() => ({ video_id: 'lastVideo01' })),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(unsafePlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    stateMod.setYtPrimed(true);

    const freshPrime = createMockYtPlayer();
    const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
    ytConstructor.mockImplementationOnce(function () {
      return freshPrime;
    });

    stopYouTubeMode();
    for (let poll = 0; poll < 250; poll += 1) {
      lastTimerCallback('yt-retained-player-park-confirm')?.();
    }

    expect(unsafePlayer.destroy).toHaveBeenCalledOnce();
    expect(stateMod.getYouTubePlayer()).toBe(freshPrime);
    expect(stateMod.isYtPrimed()).toBe(false);
  });

  it.each(['late PLAYING callback', 'parked volume update'] as const)(
    'destroys a parked iframe when hard mute later throws during a %s',
    async (trigger) => {
      let residentVideoId = 'lastVideo01';
      let physicallyMuted = false;
      let muteThrows = false;
      const player = {
        ...createMockYtPlayer(),
        cueVideoById: vi.fn((videoId: string) => {
          residentVideoId = videoId;
        }),
        mute: vi.fn(() => {
          if (muteThrows) throw new Error('late mute failure');
          physicallyMuted = true;
        }),
        unMute: vi.fn(() => {
          physicallyMuted = false;
        }),
        isMuted: vi.fn(() => physicallyMuted),
        getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
        getPlayerState: vi.fn(() => 5),
      } satisfies YouTubePlayerInstance;
      const handle = await startActivePlayer(player);
      const stateMod = await import('../_state.ts');
      const { initYouTube, stopYouTubeMode } = await import('../player.ts');
      stateMod.setYtPrimed(true);
      initYouTube();

      stopYouTubeMode();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      physicallyMuted = false;
      muteThrows = true;
      const freshPrime = createMockYtPlayer();
      const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
      ytConstructor.mockImplementationOnce(function () {
        return freshPrime;
      });

      if (trigger === 'late PLAYING callback') {
        setPlaybackFilePlaying();
        handle.fireStateChange(1);
      } else {
        expect(() => bus.emit('youtube:set-volume', 80)).not.toThrow();
      }

      expect(player.destroy).toHaveBeenCalledOnce();
      expect(stateMod.getYouTubePlayer()).toBe(freshPrime);
    },
  );

  it('rebuilds and preserves the requested target when a retained target cue is unconfirmed', async () => {
    let residentVideoId = 'lastVideo01';
    let acceptCue = true;
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        if (acceptCue) residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    acceptCue = false;

    const freshTarget = createMockYtPlayer();
    const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
    ytConstructor.mockImplementationOnce(function () {
      return freshTarget;
    });
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Requested target',
        videoId: 'nextVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);

    loadYouTubeVideo('nextVideo02', null, false, 0);
    for (let poll = 0; poll < 250; poll += 1) {
      lastTimerCallback('yt-retained-player-target-confirm')?.();
    }

    expect(retainedPlayer.destroy).toHaveBeenCalledOnce();
    expect(stateMod.getYouTubePlayer()).toBe(freshTarget);
    expect(ytConstructor).toHaveBeenLastCalledWith(
      'youtube-player',
      expect.objectContaining({ videoId: 'nextVideo02' }),
    );
  });

  it.each(['empty video ID', 'throwing video data'] as const)(
    'keeps a hard-muted target handoff while target identity is %s',
    async (identityFailure) => {
      let residentVideoId = 'lastVideo01';
      let liveState = 5;
      let identityReadable = true;
      const retainedPlayer = {
        ...createMockYtPlayer(),
        cueVideoById: vi.fn((videoId: string) => {
          residentVideoId = videoId;
          liveState = 5;
        }),
        getVideoData: vi.fn(() => {
          if (identityReadable) return { video_id: residentVideoId };
          if (identityFailure === 'throwing video data') {
            throw new Error('target identity not ready');
          }
          return {};
        }),
        getPlayerState: vi.fn(() => liveState),
      } satisfies YouTubePlayerInstance;
      await startActivePlayer(retainedPlayer);
      const stateMod = await import('../_state.ts');
      const { stopYouTubeMode } = await import('../player.ts');
      const { loadYouTubeVideo } = await import('../iframe.ts');
      stateMod.setYtPrimed(true);

      stopYouTubeMode();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      setState('playlist.items', [
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'Cold target identity',
          videoId: 'nextVideo02',
        } as unknown as PlaylistItem,
      ]);
      setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
      loadYouTubeVideo('nextVideo02', null, false, 0);
      identityReadable = false;

      for (let poll = 0; poll < 80; poll += 1) {
        lastTimerCallback('yt-retained-player-target-confirm')?.();
      }

      expect(retainedPlayer.isMuted?.()).toBe(true);
      expect(retainedPlayer.destroy).not.toHaveBeenCalled();
      expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
      expect(stateMod.isYtLoadInProgress()).toBe(true);

      identityReadable = true;
      liveState = 2;
      lastTimerCallback('yt-retained-player-target-confirm')?.();
      lastTimerCallback('yt-retained-player-target-confirm')?.();

      expect(retainedPlayer.destroy).not.toHaveBeenCalled();
      expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
      expect(stateMod.isYtLoadInProgress()).toBe(false);
    },
  );

  it('requires consecutive target samples after an uncertain hard-mute interval', async () => {
    let residentVideoId = 'lastVideo01';
    let physicallyMuted = false;
    let muteConverges = true;
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      mute: vi.fn(() => {
        if (muteConverges) physicallyMuted = true;
      }),
      isMuted: vi.fn(() => physicallyMuted),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 2),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Target across mute uncertainty',
        videoId: 'nextVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    loadYouTubeVideo('nextVideo02', null, false, 0);

    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(stateMod.isYtLoadInProgress()).toBe(true);
    muteConverges = false;
    physicallyMuted = false;
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    physicallyMuted = true;
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(stateMod.isYtLoadInProgress()).toBe(true);

    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(stateMod.isYtLoadInProgress()).toBe(false);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
  });

  it.each(['false', 'unreadable'] as const)(
    'rebuilds the latest retained target whose hard-mute proof stays %s',
    async (muteFailure) => {
      let residentVideoId = 'lastVideo01';
      let physicallyMuted = false;
      let muteProofBroken = false;
      const retainedPlayer = {
        ...createMockYtPlayer(),
        cueVideoById: vi.fn((videoId: string) => {
          residentVideoId = videoId;
        }),
        mute: vi.fn(() => {
          if (!muteProofBroken) physicallyMuted = true;
        }),
        isMuted: vi.fn(() => {
          if (muteProofBroken && muteFailure === 'unreadable') {
            throw new Error('target mute state unreadable');
          }
          return physicallyMuted;
        }),
        getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
        getPlayerState: vi.fn(() => 5),
      } satisfies YouTubePlayerInstance;
      await startActivePlayer(retainedPlayer);
      const stateMod = await import('../_state.ts');
      const { stopYouTubeMode } = await import('../player.ts');
      const { loadYouTubeVideo } = await import('../iframe.ts');
      stateMod.setYtPrimed(true);

      stopYouTubeMode();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      const freshTarget = createMockYtPlayer();
      const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
      ytConstructor.mockImplementationOnce(function () {
        return freshTarget;
      });
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'Superseding unsafe target',
          videoId: 'latestTarget03',
        } as unknown as PlaylistItem,
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'Unsafe target mute',
          videoId: 'nextVideo02',
        } as unknown as PlaylistItem,
      ]);
      setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
      muteProofBroken = true;
      physicallyMuted = false;
      vi.mocked(retainedPlayer.unMute!).mockClear();
      loadYouTubeVideo('nextVideo02', null, false, 0);

      for (let poll = 0; poll < 20; poll += 1) {
        lastTimerCallback('yt-retained-player-target-confirm')?.();
      }
      expect(retainedPlayer.destroy).not.toHaveBeenCalled();

      // A-to-B supersession changes target identity/session, but not the physical
      // iframe whose mute is still unproven. It must not buy a fresh safety
      // window or an attacker could keep unknown hidden audio resident.
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      loadYouTubeVideo('latestTarget03', null, false, 0);
      for (let poll = 0; poll < 5; poll += 1) {
        lastTimerCallback('yt-retained-player-target-confirm')?.();
      }

      expect(retainedPlayer.mute).toHaveBeenCalled();
      expect(retainedPlayer.unMute).not.toHaveBeenCalled();
      expect(retainedPlayer.destroy).toHaveBeenCalledOnce();
      expect(stateMod.getYouTubePlayer()).toBe(freshTarget);
      expect(ytConstructor).toHaveBeenLastCalledWith(
        'youtube-player',
        expect.objectContaining({ videoId: 'latestTarget03' }),
      );
    },
  );

  it('queues a new target behind silent-prime confirmation without replacing the iframe', async () => {
    let residentVideoId = 'lastVideo01';
    let liveState = 0;
    let settlePrimeCue = false;
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        if (videoId !== YOUTUBE_PRIME_VIDEO_ID || settlePrimeCue) {
          residentVideoId = videoId;
          liveState = videoId === YOUTUBE_PRIME_VIDEO_ID ? 2 : 5;
        }
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => liveState),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);
    const applyVolume = vi.fn();
    bus.on('audio:apply-youtube-volume', applyVolume);

    stopYouTubeMode();
    vi.mocked(retainedPlayer.unMute!).mockClear();
    // Deliberately do not run the PRIME confirmation timer.
    const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
    const constructorCallsBeforeTarget = ytConstructor.mock.calls.length;
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Immediate target',
        videoId: 'nextVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);

    loadYouTubeVideo('nextVideo02', null, false, 0);

    // The target is not allowed to overwrite the old occurrence until PRIME
    // itself has produced the stable identity boundary.
    expect(retainedPlayer.cueVideoById).toHaveBeenCalledTimes(1);
    expect(retainedPlayer.cueVideoById).toHaveBeenLastCalledWith(YOUTUBE_PRIME_VIDEO_ID, 0);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();

    // Model a cold iPhone iframe taking longer than the former 1 s limit to
    // expose the cue. It remains hard-muted, so the exact gesture-bearing
    // iframe is safe to retain while the real target waits.
    for (let poll = 0; poll < 30; poll += 1) {
      lastTimerCallback('yt-retained-player-park-confirm')?.();
    }
    expect(retainedPlayer.cueVideoById).toHaveBeenCalledTimes(1);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.isYtLoadInProgress()).toBe(true);
    expect(applyVolume).not.toHaveBeenCalled();
    expect(retainedPlayer.unMute).not.toHaveBeenCalled();

    // iOS may settle cueVideoById at PAUSED rather than CUED after ENDED. The
    // exact muted PRIME identity is still a valid occurrence boundary.
    settlePrimeCue = true;
    residentVideoId = YOUTUBE_PRIME_VIDEO_ID;
    liveState = 2;
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();

    expect(retainedPlayer.cueVideoById).toHaveBeenLastCalledWith('nextVideo02', 0);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
    expect(stateMod.isYtPrimed()).toBe(true);
    expect(ytConstructor).toHaveBeenCalledTimes(constructorCallsBeforeTarget);

    // Loading remains owned by the hard-muted handoff until two target
    // snapshots agree. No control or volume path may reopen output earlier.
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(stateMod.isYtLoadInProgress()).toBe(true);
    expect(applyVolume).not.toHaveBeenCalled();
    expect(retainedPlayer.unMute).not.toHaveBeenCalled();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(stateMod.isYtLoadInProgress()).toBe(false);
    expect(applyVolume).toHaveBeenCalledOnce();
  });

  it('supersedes a deferred retained target without loading the stale occurrence', async () => {
    let residentVideoId = 'lastVideo01';
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Deferred A',
        videoId: 'deferredA01',
      } as unknown as PlaylistItem,
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Deferred B',
        videoId: 'deferredB02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('deferredA01', null, false, 0);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    loadYouTubeVideo('deferredB02', null, false, 0);

    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();

    expect(retainedPlayer.cueVideoById).not.toHaveBeenCalledWith('deferredA01', 0);
    expect(retainedPlayer.cueVideoById).toHaveBeenLastCalledWith('deferredB02', 0);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
  });

  it('renews the PRIME proof window when a target arrives near the parking deadline', async () => {
    let residentVideoId = 'lastVideo01';
    let liveState = 0;
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        if (videoId !== YOUTUBE_PRIME_VIDEO_ID) {
          residentVideoId = videoId;
          liveState = 5;
        }
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => liveState),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    for (let poll = 0; poll < 70; poll += 1) {
      lastTimerCallback('yt-retained-player-park-confirm')?.();
    }
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Late target',
        videoId: 'lateTarget01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    loadYouTubeVideo('lateTarget01', null, false, 0);

    // Cross both the old absolute deadline and a fresh 3 s deadline after the
    // request. A user-visible target gets the 10 s handoff budget while every
    // sample keeps proving hard mute, so a 3.2 s cold iPhone cue stays resident.
    for (let poll = 0; poll < 80; poll += 1) {
      lastTimerCallback('yt-retained-player-park-confirm')?.();
    }
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();

    residentVideoId = YOUTUBE_PRIME_VIDEO_ID;
    liveState = 2;
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();

    expect(retainedPlayer.cueVideoById).toHaveBeenLastCalledWith('lateTarget01', 0);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
  });

  it('drops a deferred target when playback ownership leaves YouTube before PRIME settles', async () => {
    let residentVideoId = 'lastVideo01';
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Stale deferred target',
        videoId: 'staleTarget',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    loadYouTubeVideo('staleTarget', null, false, 0);
    setPlaybackFilePlaying();

    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();

    expect(retainedPlayer.cueVideoById).not.toHaveBeenCalledWith('staleTarget', 0);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(retainedPlayer.unMute).not.toHaveBeenCalled();
  });

  it('reuses a confirmed PRIME iframe when replaying the just-ended video', async () => {
    let residentVideoId = 'lastVideo01';
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();

    const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
    const constructorCallsBeforeReplay = ytConstructor.mock.calls.length;
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Replay target',
        videoId: 'lastVideo01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);

    loadYouTubeVideo('lastVideo01', null, false, 0);

    expect(retainedPlayer.cueVideoById).toHaveBeenLastCalledWith('lastVideo01', 0);
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
    expect(stateMod.isYtPrimed()).toBe(true);
    expect(ytConstructor).toHaveBeenCalledTimes(constructorCallsBeforeReplay);
  });

  it('accepts a watch-plus-list target whose live playlist item differs from the URL video', async () => {
    let residentVideoId = 'lastVideo01';
    let livePlaylistIndex = -1;
    let livePlaylistIds: string[] = [];
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      cuePlaylist: vi.fn(({ index = 0 }: { index?: number }) => {
        livePlaylistIds = ['actualListItem02'];
        livePlaylistIndex = index;
        residentVideoId = livePlaylistIds[index] || '';
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
      getPlaylistIndex: vi.fn(() => livePlaylistIndex),
      getPlaylist: vi.fn(() => livePlaylistIds),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);
    const applyVolume = vi.fn();
    bus.on('audio:apply-youtube-volume', applyVolume);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Playlist target',
        videoId: 'urlEntryVideo01',
        playlistId: 'playlist01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);

    loadYouTubeVideo('urlEntryVideo01', 'playlist01', false, 0);

    expect(retainedPlayer.cuePlaylist).toHaveBeenCalledOnce();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(applyVolume).not.toHaveBeenCalled();
    lastTimerCallback('yt-retained-player-target-confirm')?.();

    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
    expect(stateMod.isYtPrimed()).toBe(true);
    expect(applyVolume).toHaveBeenCalledOnce();
  });

  it('completes a pure-playlist target on the confirmed PRIME iframe', async () => {
    let residentVideoId = 'lastVideo01';
    let livePlaylistIndex = -1;
    const livePlaylistIds = ['pureListItem01', 'pureListItem02'];
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      cuePlaylist: vi.fn(({ index = 0 }: { index?: number }) => {
        livePlaylistIndex = index;
        residentVideoId = livePlaylistIds[index] || '';
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 2),
      getPlaylistIndex: vi.fn(() => livePlaylistIndex),
      getPlaylist: vi.fn(() => livePlaylistIds),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    // Model the early guest fallback that still has only a playlist ID.
    setState('network.hostConn', {} as DataConnection);
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Pure playlist target',
        playlistId: 'purePlaylist01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);

    loadYouTubeVideo(null, 'purePlaylist01', false, 1.8);

    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(retainedPlayer.cuePlaylist).toHaveBeenLastCalledWith(
      expect.objectContaining({ list: 'purePlaylist01', index: 1 }),
    );
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(stateMod.isYtLoadInProgress()).toBe(true);
    lastTimerCallback('yt-retained-player-target-confirm')?.();

    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
    expect(stateMod.isYtLoadInProgress()).toBe(false);
  });

  it.each(['wrong live index', 'playlist entry mismatch'] as const)(
    'rebuilds when playlist handoff proof has a %s',
    async (mismatch) => {
      let residentVideoId = 'lastVideo01';
      let livePlaylistIndex = -1;
      let livePlaylistIds: string[] = [];
      const retainedPlayer = {
        ...createMockYtPlayer(),
        cueVideoById: vi.fn((videoId: string) => {
          residentVideoId = videoId;
        }),
        cuePlaylist: vi.fn(() => {
          livePlaylistIndex = mismatch === 'wrong live index' ? 0 : 1;
          livePlaylistIds = ['liveAtZero01', 'listedAtOne02'];
          residentVideoId =
            mismatch === 'wrong live index' ? livePlaylistIds[0] || '' : 'unlistedLive03';
        }),
        getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
        getPlayerState: vi.fn(() => 5),
        getPlaylistIndex: vi.fn(() => livePlaylistIndex),
        getPlaylist: vi.fn(() => livePlaylistIds),
      } satisfies YouTubePlayerInstance;
      await startActivePlayer(retainedPlayer);
      const stateMod = await import('../_state.ts');
      const { stopYouTubeMode } = await import('../player.ts');
      const { loadYouTubeVideo } = await import('../iframe.ts');
      stateMod.setYtPrimed(true);

      stopYouTubeMode();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      lastTimerCallback('yt-retained-player-park-confirm')?.();
      const freshTarget = createMockYtPlayer();
      const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
      ytConstructor.mockImplementationOnce(function () {
        return freshTarget;
      });
      setState('playlist.items', [
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'Mismatched playlist target',
          videoId: 'urlEntryVideo01',
          playlistId: 'playlistMismatch01',
        } as unknown as PlaylistItem,
      ]);
      setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);

      loadYouTubeVideo('urlEntryVideo01', 'playlistMismatch01', false, 1);
      for (let poll = 0; poll < 250; poll += 1) {
        lastTimerCallback('yt-retained-player-target-confirm')?.();
      }

      expect(retainedPlayer.destroy).toHaveBeenCalledOnce();
      expect(stateMod.getYouTubePlayer()).toBe(freshTarget);
      expect(ytConstructor).toHaveBeenLastCalledWith(
        'youtube-player',
        expect.objectContaining({ videoId: 'urlEntryVideo01' }),
      );
    },
  );

  it('releases only the latest superseding playlist target generation', async () => {
    let residentVideoId = 'lastVideo01';
    let livePlaylistIndex = -1;
    let livePlaylistIds: string[] = [];
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      cuePlaylist: vi.fn(({ list, index = 0 }: { list: string; index?: number }) => {
        livePlaylistIds =
          list === 'playlistLatest02' ? ['latestZero01', 'latestLive02'] : ['staleLive01'];
        livePlaylistIndex = index;
        residentVideoId = livePlaylistIds[index] || '';
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
      getPlaylistIndex: vi.fn(() => livePlaylistIndex),
      getPlaylist: vi.fn(() => livePlaylistIds),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);
    const applyVolume = vi.fn();
    bus.on('audio:apply-youtube-volume', applyVolume);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Stale playlist target',
        videoId: 'staleUrl01',
        playlistId: 'playlistStale01',
      } as unknown as PlaylistItem,
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Latest playlist target',
        videoId: 'latestUrl02',
        playlistId: 'playlistLatest02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('staleUrl01', 'playlistStale01', false, 0);
    const staleGenerationPoll = lastTimerCallback('yt-retained-player-target-confirm');

    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    loadYouTubeVideo('latestUrl02', 'playlistLatest02', false, 1);
    staleGenerationPoll?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(applyVolume).not.toHaveBeenCalled();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(applyVolume).not.toHaveBeenCalled();
    lastTimerCallback('yt-retained-player-target-confirm')?.();

    expect(retainedPlayer.cuePlaylist).toHaveBeenLastCalledWith(
      expect.objectContaining({ list: 'playlistLatest02', index: 1 }),
    );
    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
    expect(applyVolume).toHaveBeenCalledOnce();
  });

  it('returns an active playlist through PRIME before accepting an identical live tuple', async () => {
    let residentVideoId = 'lastVideo01';
    let livePlaylistIndex = -1;
    let livePlaylistIds: string[] = [];
    let holdNextPrimeCue = false;
    let holdSecondPlaylistCue = false;
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        if (videoId === YOUTUBE_PRIME_VIDEO_ID && holdNextPrimeCue) return;
        residentVideoId = videoId;
        livePlaylistIndex = -1;
        livePlaylistIds = [];
      }),
      cuePlaylist: vi.fn(({ list }: { list: string }) => {
        if (list === 'playlistBoundary02' && holdSecondPlaylistCue) return;
        residentVideoId = 'sharedLiveTuple01';
        livePlaylistIndex = 0;
        livePlaylistIds = ['sharedLiveTuple01'];
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
      getPlaylistIndex: vi.fn(() => livePlaylistIndex),
      getPlaylist: vi.fn(() => livePlaylistIds),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);
    const applyVolume = vi.fn();
    bus.on('audio:apply-youtube-volume', applyVolume);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'First shared tuple playlist',
        videoId: 'firstUrl01',
        playlistId: 'playlistBoundary01',
      } as unknown as PlaylistItem,
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Second shared tuple playlist',
        videoId: 'secondUrl02',
        playlistId: 'playlistBoundary02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('firstUrl01', 'playlistBoundary01', false, 0);
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(applyVolume).toHaveBeenCalledOnce();

    applyVolume.mockClear();
    vi.mocked(retainedPlayer.unMute!).mockClear();
    holdNextPrimeCue = true;
    holdSecondPlaylistCue = true;
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    loadYouTubeVideo('secondUrl02', 'playlistBoundary02', false, 0);

    // The outgoing playlist already exposes the exact video/index/state tuple
    // that the new list will eventually resolve to. It is not command proof:
    // no target command or release occurs until PRIME itself is observed.
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(retainedPlayer.cuePlaylist).not.toHaveBeenCalledWith(
      expect.objectContaining({ list: 'playlistBoundary02' }),
    );
    expect(applyVolume).not.toHaveBeenCalled();
    expect(retainedPlayer.unMute).not.toHaveBeenCalled();
    expect(stateMod.isYtLoadInProgress()).toBe(true);

    holdNextPrimeCue = false;
    residentVideoId = YOUTUBE_PRIME_VIDEO_ID;
    livePlaylistIndex = -1;
    livePlaylistIds = [];
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    expect(retainedPlayer.cuePlaylist).toHaveBeenCalledWith(
      expect.objectContaining({ list: 'playlistBoundary02', index: 0 }),
    );

    // Even after the command is issued, PRIME (or any non-matching tuple) is
    // not enough. The requested list occurrence needs two stable live samples.
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    expect(applyVolume).not.toHaveBeenCalled();
    holdSecondPlaylistCue = false;
    residentVideoId = 'sharedLiveTuple01';
    livePlaylistIndex = 0;
    livePlaylistIds = ['sharedLiveTuple01'];
    lastTimerCallback('yt-retained-player-target-confirm')?.();
    lastTimerCallback('yt-retained-player-target-confirm')?.();

    expect(retainedPlayer.destroy).not.toHaveBeenCalled();
    expect(stateMod.getYouTubePlayer()).toBe(retainedPlayer);
    expect(applyVolume).toHaveBeenCalledOnce();
  });

  it('rebuilds instead of loading the silent-prime sentinel as room media', async () => {
    let residentVideoId = 'lastVideo01';
    const retainedPlayer = {
      ...createMockYtPlayer(),
      cueVideoById: vi.fn((videoId: string) => {
        residentVideoId = videoId;
      }),
      getVideoData: vi.fn(() => ({ video_id: residentVideoId })),
      getPlayerState: vi.fn(() => 5),
    } satisfies YouTubePlayerInstance;
    await startActivePlayer(retainedPlayer);
    const stateMod = await import('../_state.ts');
    const { stopYouTubeMode } = await import('../player.ts');
    const { loadYouTubeVideo } = await import('../iframe.ts');
    stateMod.setYtPrimed(true);

    stopYouTubeMode();
    lastTimerCallback('yt-retained-player-park-confirm')?.();
    lastTimerCallback('yt-retained-player-park-confirm')?.();

    const freshTarget = createMockYtPlayer();
    const ytConstructor = window.YT!.Player as unknown as ReturnType<typeof vi.fn>;
    ytConstructor.mockImplementationOnce(function () {
      return freshTarget;
    });
    setState('playlist.items', [
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Invalid sentinel target',
        videoId: YOUTUBE_PRIME_VIDEO_ID,
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);

    loadYouTubeVideo(YOUTUBE_PRIME_VIDEO_ID, null, false, 0);

    expect(retainedPlayer.destroy).toHaveBeenCalledOnce();
    expect(stateMod.getYouTubePlayer()).toBe(freshTarget);
  });
});

describe('persistent prime transition supersession', () => {
  it('keeps a precreated player retryable when the setup tap beats onReady', async () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const { precreateYouTubePlayer, primeYouTubePlayer } = await import('../iframe.ts');
    const stateMod = await import('../_state.ts');

    precreateYouTubePlayer();

    // The setup-start gesture arrived before the iframe was ready. It must not
    // invent an asynchronous play later from onReady.
    primeYouTubePlayer();
    expect(player.playVideo).not.toHaveBeenCalled();

    handle.fireReady();
    expect(stateMod.isYtPrimeReady()).toBe(true);
    expect(player.playVideo).not.toHaveBeenCalled();

    // A later, direct media gesture calls the same synchronous seam again.
    primeYouTubePlayer();
    expect(player.playVideo).toHaveBeenCalledOnce();
    expect(stateMod.isYtPrimeReady()).toBe(false);
    expect(stateMod.isYtPrimeBouncePending()).toBe(true);
  });

  it('re-arms a timed-out bounce without replaying outside the next gesture', async () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const { precreateYouTubePlayer, primeYouTubePlayer } = await import('../iframe.ts');
    const stateMod = await import('../_state.ts');

    precreateYouTubePlayer();
    handle.fireReady();
    primeYouTubePlayer();
    expect(player.playVideo).toHaveBeenCalledOnce();

    const timeout = lastTimerCallback('yt-prime-bounce-timeout');
    expect(timeout).toBeDefined();
    timeout?.();

    // The timer is intentionally state-only: autoplay from this async callback
    // would lose the iOS user-activation token.
    expect(player.playVideo).toHaveBeenCalledOnce();
    expect(stateMod.isYtPrimeBouncePending()).toBe(false);
    expect(stateMod.isYtPrimeReady()).toBe(true);

    primeYouTubePlayer();
    expect(player.playVideo).toHaveBeenCalledTimes(2);
    expect(stateMod.isYtPrimeBouncePending()).toBe(true);
    expect(stateMod.isYtPrimeReady()).toBe(false);
  });

  it('lets the final gesture replace a pending bounce without an old timeout clearing it', async () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const { precreateYouTubePlayer, primeYouTubePlayer } = await import('../iframe.ts');
    const stateMod = await import('../_state.ts');

    precreateYouTubePlayer();
    handle.fireReady();
    expect(primeYouTubePlayer()).toBe(true);
    expect(player.playVideo).toHaveBeenCalledOnce();
    const staleTimeout = lastTimerCallback('yt-prime-bounce-timeout');

    // The media-submit tap is the final usable activation. It must spend that
    // gesture on a fresh playVideo() call even while popup-open priming is
    // pending, and supersede every callback owned by the earlier attempt.
    expect(primeYouTubePlayer({ retryPending: true })).toBe(true);
    expect(player.playVideo).toHaveBeenCalledTimes(2);
    const activeTimeout = lastTimerCallback('yt-prime-bounce-timeout');
    expect(activeTimeout).not.toBe(staleTimeout);

    staleTimeout?.();
    expect(stateMod.isYtPrimeBouncePending()).toBe(true);
    expect(stateMod.isYtPrimeReady()).toBe(false);

    activeTimeout?.();
    expect(stateMod.isYtPrimeBouncePending()).toBe(false);
    expect(stateMod.isYtPrimeReady()).toBe(true);
    expect(player.playVideo).toHaveBeenCalledTimes(2);
  });

  it('re-arms a synchronous bounce failure for a later direct gesture', async () => {
    const player = createMockYtPlayer();
    const playVideo = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error('transient iframe rejection');
      })
      .mockImplementation(() => {});
    player.playVideo = playVideo;
    const handle = installYtNamespace(player);
    const { precreateYouTubePlayer, primeYouTubePlayer } = await import('../iframe.ts');
    const stateMod = await import('../_state.ts');

    precreateYouTubePlayer();
    handle.fireReady();
    primeYouTubePlayer();

    expect(playVideo).toHaveBeenCalledOnce();
    expect(stateMod.isYtPrimeBouncePending()).toBe(false);
    expect(stateMod.isYtPrimeReady()).toBe(true);

    primeYouTubePlayer();
    expect(playVideo).toHaveBeenCalledTimes(2);
    expect(stateMod.isYtPrimeBouncePending()).toBe(true);
    expect(stateMod.isYtPrimeReady()).toBe(false);
  });

  it('keeps an iframe-reported bounce error retryable and silent', async () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const { precreateYouTubePlayer, primeYouTubePlayer } = await import('../iframe.ts');
    const stateMod = await import('../_state.ts');

    precreateYouTubePlayer();
    handle.fireReady();
    primeYouTubePlayer();
    showToastMock.mockClear();

    handle.fireError(5);

    expect(showToastMock).not.toHaveBeenCalled();
    expect(stateMod.isYtPrimeBouncePending()).toBe(false);
    expect(stateMod.isYtPrimeReady()).toBe(true);

    primeYouTubePlayer();
    expect(player.playVideo).toHaveBeenCalledTimes(2);
    expect(stateMod.isYtPrimeBouncePending()).toBe(true);
    expect(stateMod.isYtPrimeReady()).toBe(false);
  });

  it('accepts a late PLAYING proof after the retry timeout without another play call', async () => {
    const player = createMockYtPlayer();
    const handle = installYtNamespace(player);
    const { precreateYouTubePlayer, primeYouTubePlayer } = await import('../iframe.ts');
    const stateMod = await import('../_state.ts');

    precreateYouTubePlayer();
    handle.fireReady();
    primeYouTubePlayer();
    lastTimerCallback('yt-prime-bounce-timeout')?.();

    expect(stateMod.isYtPrimeReady()).toBe(true);
    expect(player.playVideo).toHaveBeenCalledOnce();

    handle.fireStateChange(1);

    expect(player.playVideo).toHaveBeenCalledOnce();
    expect(player.pauseVideo).toHaveBeenCalledOnce();
    expect(stateMod.isYtPrimed()).toBe(true);
    expect(stateMod.isYtPrimeReady()).toBe(false);
  });

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

describe('same-video queue occurrence handoff', () => {
  it('does not depend on a fresh CUED event and ignores the late old callback', async () => {
    const player = createMockYtPlayer();
    const cueVideoById = vi.fn();
    player.cueVideoById = cueVideoById;
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'sameVideo01' });
    const handle = installYtNamespace(player);
    const {
      handoffSameVideoOccurrenceRestart,
      loadYouTubeVideo,
      prepareSameVideoOccurrenceRestart,
    } = await import('../iframe.ts');
    const { setPendingAutoSyncOnReady } = await import('../player.ts');

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'First occurrence',
        videoId: 'sameVideo01',
      } as unknown as PlaylistItem,
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Second occurrence',
        videoId: 'sameVideo01',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('sameVideo01', null, false, 0);

    vi.mocked(player.pauseVideo!).mockClear();
    vi.mocked(player.stopVideo!).mockClear();
    vi.mocked(player.loadVideoById!).mockClear();
    vi.mocked(player.loadPlaylist!).mockClear();
    vi.mocked(player.cuePlaylist!).mockClear();
    cueVideoById.mockClear();
    setManagedTimerMock.mockClear();

    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    expect(prepareSameVideoOccurrenceRestart(SECOND_QUEUE_ITEM_ID, 'sameVideo01')).toBe(true);
    vi.mocked(player.getPlayerState!).mockReturnValue(1);
    loadYouTubeVideo('sameVideo01', 'resolved-playlist', false, 0);

    expect(player.pauseVideo).toHaveBeenCalledOnce();
    expect(player.stopVideo).not.toHaveBeenCalled();
    expect(player.loadVideoById).not.toHaveBeenCalled();
    expect(player.loadPlaylist).not.toHaveBeenCalled();
    expect(player.cuePlaylist).not.toHaveBeenCalled();
    expect(cueVideoById).not.toHaveBeenCalled();
    const staleFallback = lastTimerCallback('yt-same-video-occurrence-handoff');
    expect(staleFallback).toBeDefined();

    setPendingAutoSyncOnReady(true, {
      isTrackTransition: true,
      zeroStart: true,
      targetTime: 0,
      videoId: 'sameVideo01',
      skipSeek: true,
    });
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);

    expect(handoffSameVideoOccurrenceRestart(SECOND_QUEUE_ITEM_ID, 'sameVideo01')).toBe(true);
    expect(autoPlay).not.toHaveBeenCalled();

    // The outgoing occurrence's delayed PLAYING cannot consume the new start.
    handle.fireStateChange(1);
    expect(autoPlay).not.toHaveBeenCalled();

    vi.mocked(player.getPlayerState!).mockReturnValue(2);
    handle.fireStateChange(2);
    expect(autoPlay).toHaveBeenCalledOnce();
    expect(autoPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        isTrackTransition: true,
        zeroStart: true,
        videoId: 'sameVideo01',
      }),
    );

    // A CUED callback from the outgoing occurrence has no pending intent left
    // to consume, and a manually invoked stale fallback cannot cue it again.
    handle.fireStateChange(5);
    staleFallback!();
    expect(autoPlay).toHaveBeenCalledOnce();
    expect(cueVideoById).not.toHaveBeenCalled();
  });

  it('keeps the old cue behavior for a same-video load without playlist handoff', async () => {
    const player = createMockYtPlayer();
    const cueVideoById = vi.fn();
    player.cueVideoById = cueVideoById;
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'sameVideo02' });
    installYtNamespace(player);
    const { loadYouTubeVideo } = await import('../iframe.ts');

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Repeated URL',
        videoId: 'sameVideo02',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('sameVideo02', null, false, 0);
    cueVideoById.mockClear();
    setManagedTimerMock.mockClear();

    loadYouTubeVideo('sameVideo02', null, false, 0);
    expect(cueVideoById).not.toHaveBeenCalled();

    lastTimerCallback('yt-same-video-occurrence-handoff')!();
    expect(cueVideoById).toHaveBeenCalledOnce();
    expect(cueVideoById).toHaveBeenCalledWith('sameVideo02', 0);
  });

  it('forces a bounded handoff when PAUSED never arrives', async () => {
    const player = createMockYtPlayer();
    player.cueVideoById = vi.fn();
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'sameVideo03' });
    vi.mocked(player.getPlayerState!).mockReturnValue(1);
    installYtNamespace(player);
    const {
      handoffSameVideoOccurrenceRestart,
      loadYouTubeVideo,
      prepareSameVideoOccurrenceRestart,
    } = await import('../iframe.ts');
    const { isYtLoadInProgress } = await import('../_state.ts');
    const { setPendingAutoSyncOnReady } = await import('../player.ts');
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'First occurrence',
        videoId: 'sameVideo03',
      } as unknown as PlaylistItem,
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Second occurrence',
        videoId: 'sameVideo03',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('sameVideo03', null, false, 0);
    setManagedTimerMock.mockClear();

    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    expect(prepareSameVideoOccurrenceRestart(SECOND_QUEUE_ITEM_ID, 'sameVideo03')).toBe(true);
    loadYouTubeVideo('sameVideo03', null, false, 0);
    setPendingAutoSyncOnReady(true, {
      isTrackTransition: true,
      zeroStart: true,
      videoId: 'sameVideo03',
    });
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);

    expect(handoffSameVideoOccurrenceRestart(SECOND_QUEUE_ITEM_ID, 'sameVideo03')).toBe(true);
    expect(isYtLoadInProgress()).toBe(true);
    expect(autoPlay).not.toHaveBeenCalled();

    now += 501;
    lastTimerCallback('yt-same-video-occurrence-handoff')!();
    expect(autoPlay).toHaveBeenCalledOnce();
    expect(isYtLoadInProgress()).toBe(false);
  });

  it('releases quarantine and loading when pending consumption fails', async () => {
    const player = createMockYtPlayer();
    player.cueVideoById = vi.fn();
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'sameVideo04' });
    const handle = installYtNamespace(player);
    const {
      handoffSameVideoOccurrenceRestart,
      loadYouTubeVideo,
      prepareSameVideoOccurrenceRestart,
    } = await import('../iframe.ts');
    const { isYtLoadInProgress } = await import('../_state.ts');
    const { setPendingAutoSyncOnReady } = await import('../player.ts');

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'First occurrence',
        videoId: 'sameVideo04',
      } as unknown as PlaylistItem,
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Second occurrence',
        videoId: 'sameVideo04',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('sameVideo04', null, false, 0);
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    expect(prepareSameVideoOccurrenceRestart(SECOND_QUEUE_ITEM_ID, 'sameVideo04')).toBe(true);
    loadYouTubeVideo('sameVideo04', null, false, 0);
    setPendingAutoSyncOnReady(true, {
      isTrackTransition: true,
      zeroStart: true,
      videoId: 'differentVideo',
    });
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);

    expect(handoffSameVideoOccurrenceRestart(SECOND_QUEUE_ITEM_ID, 'sameVideo04')).toBe(true);
    expect(autoPlay).not.toHaveBeenCalled();
    expect(isYtLoadInProgress()).toBe(false);

    zeroStartFacade.handlePlayerState.mockClear();
    handle.fireStateChange(1);
    expect(zeroStartFacade.handlePlayerState).toHaveBeenCalledWith(1);
    setPendingAutoSyncOnReady(false);
  });

  it('releases a superseded occurrence without cueing or leaving loading active', async () => {
    const player = createMockYtPlayer();
    const cueVideoById = vi.fn();
    player.cueVideoById = cueVideoById;
    vi.mocked(player.getVideoData!).mockReturnValue({ video_id: 'sameVideo05' });
    installYtNamespace(player);
    const { loadYouTubeVideo, prepareSameVideoOccurrenceRestart } = await import('../iframe.ts');
    const { isYtLoadInProgress } = await import('../_state.ts');

    setPlaybackYouTubePlaying();
    wireStopAllMediaChain();
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'First occurrence',
        videoId: 'sameVideo05',
      } as unknown as PlaylistItem,
      {
        queueItemId: SECOND_QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Second occurrence',
        videoId: 'sameVideo05',
      } as unknown as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    loadYouTubeVideo('sameVideo05', null, false, 0);
    setManagedTimerMock.mockClear();
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    expect(prepareSameVideoOccurrenceRestart(SECOND_QUEUE_ITEM_ID, 'sameVideo05')).toBe(true);
    loadYouTubeVideo('sameVideo05', null, false, 0);
    const staleFallback = lastTimerCallback('yt-same-video-occurrence-handoff');

    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    staleFallback!();
    expect(cueVideoById).not.toHaveBeenCalled();
    expect(isYtLoadInProgress()).toBe(false);
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

  it('does not broadcast iframe state as legacy host authority in a PRO room', async () => {
    const player = createMockYtPlayer();
    const handle = await startPlainYouTubeVideo(player);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    zeroStartFacade.inFlight = false;
    zeroStartFacade.active = false;
    zeroStartFacade.handlePlayerState.mockReturnValue(false);
    broadcastMock.mockClear();

    handle.fireStateChange(1);

    expect(
      broadcastMock.mock.calls.filter(([message]) => message.type === MSG.YOUTUBE_STATE),
    ).toHaveLength(0);
  });

  it('rejects stale outgoing metadata while an explicit playlist target is loading', async () => {
    const player = createMockYtPlayer(['oldVideo01', 'newVideo02']);
    vi.mocked(player.getPlaylistIndex!).mockReturnValue(0);
    const handle = await startPlainYouTubeVideo(player);
    handle.fireReady();
    vi.mocked(player.getVideoData!).mockReturnValue({
      video_id: 'oldVideo01',
      title: 'Outgoing title',
      author: 'Outgoing channel',
    });

    const stateMod = await import('../_state.ts');
    stateMod.setCachedYtPlaylistIdx(0);
    const { expectYouTubeMetadataVideoIdFromSync } = await import('../iframe-runtime-bridge.ts');
    // This fixture morphs the initial plain-video player into native-playlist
    // state without calling loadYouTubeVideo(null, playlistId), so mirror that
    // load's metadata-target reset explicitly.
    expectYouTubeMetadataVideoIdFromSync(null);
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Playlist',
        title: 'Playlist',
        videoId: 'oldVideo01',
        playlistId: 'PL_METADATA',
      } as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setState('youtube.currentSubIndex', 1);
    setState('youtube.subItemsMap', {
      PL_METADATA: {
        ids: ['oldVideo01', 'newVideo02'],
        titles: ['Outgoing title', 'Expected next title'],
      },
    });
    setPlaybackTrackMeta({
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Expected next title',
      title: 'Expected next title',
      videoId: 'oldVideo01',
      playlistId: 'PL_METADATA',
    });

    lastTimerCallback('youtubeUILoop')?.();

    expect(getState('player.currentTrackMeta')).toMatchObject({ title: 'Expected next title' });
    expect(getState('player.currentTrackMeta')?.artist).toBeUndefined();
  });

  it('keeps the explicit video identity fence closed before a playlist manifest arrives', async () => {
    const player = createMockYtPlayer(['oldVideo01', 'newVideo02']);
    vi.mocked(player.getPlaylistIndex!).mockReturnValue(0);
    const handle = await startPlainYouTubeVideo(player);
    handle.fireReady();
    vi.mocked(player.getVideoData!).mockReturnValue({
      video_id: 'oldVideo01',
      title: 'Outgoing title',
      author: 'Outgoing channel',
    });

    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Playlist',
        title: 'Playlist',
        videoId: 'oldVideo01',
        playlistId: 'PL_METADATA',
      } as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setState('youtube.currentSubIndex', 1);
    setState('youtube.subItemsMap', {});
    setPlaybackTrackMeta({
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Expected next title',
      title: 'Expected next title',
      videoId: 'oldVideo01',
      playlistId: 'PL_METADATA',
    });

    const { loadYouTubeVideo } = await import('../iframe.ts');
    loadYouTubeVideo('newVideo02', null, false, 1);
    lastTimerCallback('youtubeUILoop')?.();

    expect(getState('player.currentTrackMeta')).toMatchObject({ title: 'Expected next title' });
    expect(getState('player.currentTrackMeta')?.artist).toBeUndefined();
  });

  it('accepts exact metadata from a native playlist index transition', async () => {
    const player = createMockYtPlayer(['oldVideo01', 'newVideo02']);
    vi.mocked(player.getPlaylistIndex!).mockReturnValue(1);
    const handle = await startPlainYouTubeVideo(player);
    handle.fireReady();
    vi.mocked(player.getVideoData!).mockReturnValue({
      video_id: 'newVideo02',
      title: 'New exact title',
      author: 'New exact channel',
    });

    const stateMod = await import('../_state.ts');
    stateMod.setCachedYtPlaylistIdx(0);
    const { expectYouTubeMetadataVideoIdFromSync } = await import('../iframe-runtime-bridge.ts');
    expectYouTubeMetadataVideoIdFromSync(null);
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Playlist',
        title: 'Playlist',
        videoId: 'oldVideo01',
        playlistId: 'PL_METADATA',
      } as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setState('youtube.currentSubIndex', 0);
    setState('youtube.subItemsMap', {
      PL_METADATA: {
        ids: ['oldVideo01', 'newVideo02'],
        titles: ['Outgoing title', 'New exact title'],
      },
    });
    setPlaybackTrackMeta({
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Outgoing title',
      title: 'Outgoing title',
      artist: 'Outgoing channel',
      videoId: 'oldVideo01',
      playlistId: 'PL_METADATA',
    });
    const metadataEvents: Array<TrackMeta | null> = [];
    bus.on('state:player.currentTrackMeta', (metadata) =>
      metadataEvents.push(metadata as TrackMeta | null),
    );

    lastTimerCallback('youtubeUILoop')?.();

    expect(getState('youtube.currentSubIndex')).toBe(1);
    expect(metadataEvents).toContainEqual(
      expect.objectContaining({ title: 'New exact title', artist: 'New exact channel' }),
    );
    expect(getState('player.currentTrackMeta')).toMatchObject({
      title: 'New exact title',
      artist: 'New exact channel',
    });
  });

  it('clears the outgoing channel when exact native metadata has no author yet', async () => {
    const player = createMockYtPlayer(['oldVideo01', 'newVideo02']);
    vi.mocked(player.getPlaylistIndex!).mockReturnValue(1);
    const handle = await startPlainYouTubeVideo(player);
    handle.fireReady();
    vi.mocked(player.getVideoData!).mockReturnValue({
      video_id: 'newVideo02',
      title: 'New exact title',
    });

    const stateMod = await import('../_state.ts');
    stateMod.setCachedYtPlaylistIdx(0);
    const { expectYouTubeMetadataVideoIdFromSync } = await import('../iframe-runtime-bridge.ts');
    expectYouTubeMetadataVideoIdFromSync(null);
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Playlist',
        title: 'Playlist',
        videoId: 'oldVideo01',
        playlistId: 'PL_METADATA',
      } as PlaylistItem,
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setState('youtube.currentSubIndex', 0);
    setState('youtube.subItemsMap', {
      PL_METADATA: {
        ids: ['oldVideo01', 'newVideo02'],
        titles: ['Outgoing title', 'New exact title'],
      },
    });
    setPlaybackTrackMeta({
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Outgoing title',
      title: 'Outgoing title',
      artist: 'Outgoing channel',
      videoId: 'oldVideo01',
      playlistId: 'PL_METADATA',
    });

    lastTimerCallback('youtubeUILoop')?.();

    expect(getState('player.currentTrackMeta')).toMatchObject({ title: 'New exact title' });
    expect(getState('player.currentTrackMeta')?.artist).toBeUndefined();
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
