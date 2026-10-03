/**
 * @vitest-environment jsdom
 * Real playlist selection, YouTube load listener, and native indexing callbacks.
 * External peers/metadata and iframe are modeled; timers, ownership, sync and UI handlers are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { broadcast } from '../../network/peer.ts';
import type { DataConnection } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { makeFakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { setPlaybackYouTubePaused, setPlaybackSystemAudioPlaying } from '../../player/ownership.ts';

// Only external peers, metadata, audio initialization and incidental UI are mocked.

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(() => true),
  sendToHost: vi.fn(),
}));

type Handler = (data: Record<string, unknown>, conn: DataConnection) => unknown;
const registered = vi.hoisted(() => new Map<string, Handler>());
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn((handlers: Record<string, Handler>) => {
    for (const [type, handler] of Object.entries(handlers)) registered.set(type, handler);
  }),
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

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../../ui/dom.ts', () => ({
  animateTransition: vi.fn((fn: () => void) => fn()),
}));

// ─── Harness ───────────────────────────────────────────────────────────────

const broadcastMock = vi.mocked(broadcast);

interface YtTestHandle {
  fireReady: () => void;
  fireStateChange: (state: number) => void;
}

function installYtNamespace(player: YouTubePlayerInstance): YtTestHandle {
  let capturedOnReady: ((event: { target: YouTubePlayerInstance }) => void) | undefined;
  let capturedOnStateChange:
    ((event: { data: number; target: YouTubePlayerInstance }) => void) | undefined;
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
  registered.clear();
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
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document
    .querySelectorAll('script[src*="youtube.com/iframe_api"]')
    .forEach((script) => script.remove());
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

const A = '77777777-7777-4777-8777-777777777777';
const B = '88888888-8888-4888-8888-888888888888';
const VID_A = 'abcdefghijk';
const VID_B = 'lmnopqrstuv';

function makeNativePlayer(initial: Parameters<typeof makeFakeYtPlayer>[0]) {
  return Object.assign(makeFakeYtPlayer(initial), {
    loadPlaylist: vi.fn(),
    cuePlaylist: vi.fn(),
  });
}

async function fixture() {
  const { playTrack } = await import('../../player/playlist.ts');
  const { seekTo, stopPlayback } = await import('../../player/transport.ts');
  const playerMod = await import('../player.ts');
  const state = await import('../_state.ts');
  await (
    await import('../standard-host-manual-offset-gate.ts')
  ).prepareStandardHostManualOffsetRuntimeForTests();
  setState('network.appRole', 'host');
  setState('network.myId', 'host');
  setState('network.sessionCode', '100001');
  setState('setup.sessionStarted', true);
  (await import('../../network/shared-clock.ts')).setIsHostClock(true);
  setState('room.context', {
    kind: 'standard',
    roomId: '100001',
    role: 'coordinator',
    coordinatorId: 'host',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control', 'queue.mutate'],
  });
  setState('playlist.items', [
    { queueItemId: A, type: 'youtube', name: 'A', videoId: VID_A, playlistId: null },
    { queueItemId: B, type: 'youtube', name: 'B', videoId: VID_B, playlistId: null },
  ]);
  const player = makeNativePlayer({
    __videoId: VID_A,
    __state: 2,
    __currentTime: 20,
    __duration: 180,
    __advanceClock: true,
    __autoPlayOnLoad: true,
  });
  const completeCue = player.cueVideoById;
  const cues: Array<[string, number]> = [];
  player.cueVideoById = (id, seconds = 0) => {
    cues.push([id, seconds]);
  };
  const yt = installYtNamespace(player);
  const sync = await import('../sync.ts');
  sync.resetYouTubeSyncState();
  sync.initYouTubeSync();
  playerMod.initYouTube();
  wireStopAllMediaChain();
  // Build one real iframe ownership epoch before issuing successor selections.
  await playTrack(A, 0, { explicitPlaybackIntent: false });
  yt.fireReady();
  player.__onStateChange = (e) => yt.fireStateChange(e.data);
  playerMod.cancelYtAutoSync();
  setPlaybackYouTubePaused();
  player.__setState(2, false);
  cues.length = 0;
  player.__log.length = 0;
  broadcastMock.mockClear();
  return {
    player,
    state,
    playerMod,
    playTrack,
    seekTo,
    stopPlayback,
    cues,
    yt,
    finishCue() {
      const cue = cues.shift();
      expect(cue).toBeDefined();
      completeCue(...cue!);
    },
  };
}

describe('pending cue and latest accepted playback intent', () => {
  it('control: resolved successor cue starts at zero', async () => {
    const h = await fixture();
    await h.playTrack(B, 0, { explicitPlaybackIntent: true });
    h.finishCue();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.player.getVideoData().video_id).toBe(VID_B);
    expect(h.player.getPlayerState()).toBe(1);
    expect(h.player.getCurrentTime()).toBeLessThan(6);
  });

  it('pending cue must retain latest pause after user selects next track', async () => {
    const h = await fixture();
    await h.playTrack(B, 0, { explicitPlaybackIntent: true });
    bus.emit('youtube:set-local-paused', true);
    h.finishCue();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.player.getPlayerState()).not.toBe(1);
  });
});
it.each([
  ['legacy', 'event'],
  ['legacy', 'watchdog'],
  ['v2', 'event'],
  ['v2', 'watchdog'],
] as const)(
  'physical cue before event: %s UI seek remains authoritative through %s readiness',
  async (protocol, readiness) => {
    const h = await fixture();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<input id="seek-slider" type="range" min="0" max="180" step="1"><span id="time-curr"></span><span id="time-dur"></span>',
    );
    const { initSeekBar } = await import('../../ui/seekbar.ts');
    initSeekBar();
    const peer = { peer: 'peer-guest', open: true, send: vi.fn(), close: vi.fn(), on: vi.fn() };
    setState('network.activeHostConnByPeerId', new Map([['peer-guest', peer]]));
    if (protocol === 'v2') {
      const z = await import('../zero-start.ts');
      expect(
        z.handleYouTubeZeroStartCapability('peer-guest', {
          type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
          version: 2,
          platform: 'other',
          ready: true,
        }),
      ).toBe(true);
      expect(z.canUseYouTubeZeroStart()).toBe(true);
    }
    await h.playTrack(B, 0, { explicitPlaybackIntent: true });
    // Complete the cue command before the seek. Delay only delivery of its CUED event.
    const callback = h.player.__onStateChange;
    h.player.__onStateChange = undefined;
    h.finishCue();
    h.player.__onStateChange = callback;
    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-disabled')).toBe('false');
    // Existing duration is still present until the iframe UI refresh; no product state injection.
    expect(Number(slider.max)).toBeGreaterThanOrEqual(70);
    slider.value = '70';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.player.getCurrentTime()).toBe(70);
    broadcastMock.mockClear();
    if (readiness === 'event') h.yt.fireStateChange(5);
    await vi.advanceTimersByTimeAsync(100);
    const stateFrames = broadcastMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === MSG.YOUTUBE_STATE);
    expect(stateFrames).not.toHaveLength(0);
    expect(stateFrames.every((frame) => frame.time >= 70)).toBe(true);
    if (protocol === 'v2') {
      await vi.advanceTimersByTimeAsync(4000);
      expect(h.player.getCurrentTime()).toBeGreaterThanOrEqual(70);
    } else {
      h.playerMod.cancelYtAutoSync();
      clearAllManagedTimers();
      const sync = await import('../sync.ts');
      sync.resetYouTubeSyncState();
      const host = { ...peer, peer: 'host' };
      setState('network.appRole', 'guest');
      setState('network.hostConn', host);
      setState('room.context', { ...getState('room.context'), role: 'member', capabilities: [] });
      const guest = makeNativePlayer({
        __videoId: VID_B,
        __state: 2,
        __currentTime: 70,
        __duration: 180,
      });
      h.state.setYouTubePlayer(guest);
      h.state.markYtPlayerReady(guest);
      setPlaybackYouTubePaused();
      for (const frame of stateFrames) registered.get(MSG.YOUTUBE_STATE)!(frame, host);
      expect(guest.getCurrentTime()).toBeGreaterThanOrEqual(70);
    }
  },
);

async function cueWithoutNotification(h: Awaited<ReturnType<typeof fixture>>) {
  await h.playTrack(B, 0, { explicitPlaybackIntent: true });
  const callback = h.player.__onStateChange;
  h.player.__onStateChange = undefined;
  h.finishCue();
  h.player.__onStateChange = callback;
}

it.each(['paused', 'stale-playing'] as const)(
  'retains readiness while native cue and later seeks are queued FIFO (%s)',
  async (reportedState) => {
    const h = await fixture();
    await h.playTrack(B, 0, { explicitPlaybackIntent: true });
    const seek = h.player.seekTo;
    const getPlayerState = h.player.getPlayerState;
    const queuedSeeks: Array<[number, boolean?]> = [];
    h.player.seekTo = (...args) => {
      queuedSeeks.push(args);
    };
    // Native API state can lag behind the earlier stop/cue commands. This
    // models only the external iframe boundary, not application ownership.
    if (reportedState === 'stale-playing') h.player.getPlayerState = () => 1;
    h.seekTo(70);
    h.seekTo(95);
    expect(h.playerMod.getPendingAutoSyncOnReadyForTests()).toBe(true);
    expect(h.player.getVideoData().video_id).toBe(VID_A);
    const callback = h.player.__onStateChange;
    h.player.__onStateChange = undefined;
    h.player.getPlayerState = getPlayerState;
    h.player.seekTo = seek;
    h.finishCue();
    for (const args of queuedSeeks) seek(...args);
    h.player.__onStateChange = callback;
    broadcastMock.mockClear();
    h.yt.fireStateChange(5);
    await vi.advanceTimersByTimeAsync(4500);
    expect(h.player.getVideoData().video_id).toBe(VID_B);
    expect(h.player.getPlayerState()).toBe(1);
    expect(h.player.getCurrentTime()).toBeGreaterThanOrEqual(95);
    const starts = broadcastMock.mock.calls
      .map((call) => call[0])
      .filter((frame) => frame.type === MSG.YOUTUBE_STATE)
      .filter((frame) => frame.state === 1);
    // The native PLAYING event also broadcasts; the scheduled Stage 1
    // must be emitted only once, and every frame must carry the new target.
    expect(starts.filter((frame) => frame.hostPlayAt === 0)).toHaveLength(1);
    expect(starts.every((frame) => frame.videoId === VID_B && frame.time === 95)).toBe(true);
    expect(starts[0]).toMatchObject({ videoId: VID_B, time: 95 });
  },
);

it('keeps the last absolute/relative seek and the canonical target with a host offset', async () => {
  const h = await fixture();
  await cueWithoutNotification(h);
  setState('sync.youtubeLocalOffset', 0.75);
  h.seekTo(70);
  h.seekTo(95);
  bus.emit('youtube:skip-time', -5);
  broadcastMock.mockClear();
  h.yt.fireStateChange(5);
  await vi.advanceTimersByTimeAsync(100);
  const frames = broadcastMock.mock.calls
    .map((call) => call[0])
    .filter((frame) => frame.type === MSG.YOUTUBE_STATE);
  expect(frames).not.toHaveLength(0);
  expect(frames.every((frame) => frame.time === 90)).toBe(true);
  await vi.advanceTimersByTimeAsync(4500);
  expect(h.player.getCurrentTime()).toBeGreaterThan(89);
  expect(h.playerMod.getPendingAutoSyncOnReadyForTests()).toBe(false);
});

it.each([false, true])(
  'a newer play while cue is pending preserves the intended target (seek=%s)',
  async (seek) => {
    const h = await fixture();
    const peer = { peer: 'peer-guest', open: true, send: vi.fn(), close: vi.fn(), on: vi.fn() };
    setState('network.activeHostConnByPeerId', new Map([['peer-guest', peer]]));
    const zeroStart = await import('../zero-start.ts');
    zeroStart.handleYouTubeZeroStartCapability('peer-guest', {
      type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
      version: 2,
      platform: 'other',
      ready: true,
    });
    // Leave the previous native video at zero: an explicit PLAY must not start
    // a zero-start barrier for that old video before B's cue completes.
    h.player.seekTo(0, true);
    await h.playTrack(B, 0, { explicitPlaybackIntent: true });
    if (seek) h.seekTo(70);
    h.player.__log.length = 0;
    const { handleRequestYouTubePlay } = await import('../handlers.ts');
    handleRequestYouTubePlay({ queueItemId: B }, peer);
    expect(h.playerMod.getPendingAutoSyncOnReadyForTests()).toBe(true);
    expect(h.player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
    h.finishCue();
    await vi.advanceTimersByTimeAsync(4500);
    expect(h.player.getVideoData().video_id).toBe(VID_B);
    expect(h.player.getPlayerState()).toBe(1);
    if (seek) expect(h.player.getCurrentTime()).toBeGreaterThanOrEqual(70);
    else expect(h.player.getCurrentTime()).toBeLessThan(6);
  },
);

it.each(['play', 'seek', 'seek-then-play'] as const)(
  'paused room restoration honors a newer %s without borrowing the old iframe position',
  async (action) => {
    const h = await fixture();
    bus.emit('youtube:restore-room-playback', {
      queueItemId: B,
      videoId: VID_B,
      playlistId: null,
      positionSeconds: 42,
      autoplay: false,
    });
    expect(h.playerMod.getPendingAutoSyncOnReadyForTests()).toBe(true);
    // Until the native cue arrives, its old PLAYING value cannot turn a seek
    // of a paused restoration into an explicit PLAY command.
    const getPlayerState = h.player.getPlayerState;
    if (action !== 'play') {
      h.player.getPlayerState = () => 1;
      h.seekTo(70);
      h.player.getPlayerState = getPlayerState;
    }
    if (action !== 'seek') {
      const { handleRequestYouTubePlay } = await import('../handlers.ts');
      handleRequestYouTubePlay({ queueItemId: B }, {
        peer: 'operator',
        open: true,
      } as DataConnection);
    }
    h.finishCue();
    await vi.advanceTimersByTimeAsync(4500);
    expect(h.player.getVideoData().video_id).toBe(VID_B);
    expect(h.player.getPlayerState()).toBe(action === 'seek' ? 2 : 1);
    expect(h.player.getCurrentTime()).toBeGreaterThanOrEqual(action === 'play' ? 42 : 70);
  },
);

it.each(['local-pause', 'operator-pause', 'stop', 'system-audio'] as const)(
  'a newer %s retires the pending seek/start before late readiness',
  async (action) => {
    const h = await fixture();
    await cueWithoutNotification(h);
    h.seekTo(70);
    if (action === 'local-pause') bus.emit('youtube:set-local-paused', true);
    else if (action === 'operator-pause') {
      const { handleRequestYouTubePause } = await import('../handlers.ts');
      handleRequestYouTubePause({ queueItemId: B }, {
        peer: 'operator',
        open: true,
      } as DataConnection);
    } else if (action === 'stop') h.stopPlayback();
    else {
      bus.emit('youtube:stop-mode', { silent: true });
      setPlaybackSystemAudioPlaying();
    }
    expect(h.playerMod.getPendingAutoSyncOnReadyForTests()).toBe(false);
    h.player.__log.length = 0;
    broadcastMock.mockClear();
    h.yt.fireStateChange(5);
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
    expect(
      broadcastMock.mock.calls
        .map((call) => call[0])
        .filter((frame) => frame.type === MSG.YOUTUBE_STATE && frame.state === 1),
    ).toHaveLength(0);
    if (action === 'system-audio') expect(getState('playback.mode')).toBe('system-audio');
  },
);

it('does not lend a superseded seek to a new queue occurrence', async () => {
  const h = await fixture();
  await cueWithoutNotification(h);
  h.seekTo(70);
  await h.playTrack(A, 0, { explicitPlaybackIntent: true });
  // B's late event still observes B; it cannot consume A's fresh intent.
  h.yt.fireStateChange(5);
  expect(h.playerMod.getPendingAutoSyncOnReadyForTests()).toBe(true);
  h.finishCue();
  await vi.advanceTimersByTimeAsync(4500);
  expect(h.player.getVideoData().video_id).toBe(VID_A);
  expect(h.player.getPlayerState()).toBe(1);
  expect(h.player.getCurrentTime()).toBeLessThan(6);
});

it('healthy control: new seek after completed CUED/start remains at the latest target', async () => {
  const h = await fixture();
  await h.playTrack(B, 0, { explicitPlaybackIntent: true });
  h.finishCue();
  await vi.advanceTimersByTimeAsync(4000);
  h.seekTo(70);
  await vi.advanceTimersByTimeAsync(2500);
  expect(h.player.getCurrentTime()).toBeGreaterThanOrEqual(70);
  expect(h.playerMod.getPendingAutoSyncOnReadyForTests()).toBe(false);
});
