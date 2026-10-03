/**
 * @vitest-environment jsdom
 * Real manual-offset, player, iframe, system-capture and ordinary UI composition.
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
import { setPlaybackYouTubePaused } from '../../player/ownership.ts';

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
  getWidener: () => ({ input: {} }),
  getMasterGain: () => ({ disconnect() {}, connect() {} }),
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
  clearPreviewDebounce: vi.fn(),
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
  updateLoader: vi.fn(),
}));

vi.mock('../../ui/dom.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ui/dom.ts')>()),
  animateTransition: (fn: () => void) => fn(),
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
    capabilities: [
      'playback.control',
      'queue.mutate',
      'media.add',
      'asset.upload',
      'system-audio.publish',
    ],
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
    __playlistIdx: -1,
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
  (await import('../../player/playlist.ts')).initPlaylist();
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

async function startB() {
  const h = await fixture();
  await h.playTrack(B, 0, { explicitPlaybackIntent: true });
  h.finishCue();
  await vi.advanceTimersByTimeAsync(4500);
  expect(h.player.getPlayerState()).toBe(1);
  expect(h.player.getVideoData().video_id).toBe(VID_B);
  h.playerMod.cancelYtAutoSync();
  return h;
}

vi.mock('../../audio/context.ts', () => ({
  getExistingAudioContext: () => null,
  getAudioContext: () => ({
    currentTime: 0,
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  }),
}));
vi.mock('../../chat/protocol.ts', () => ({ broadcastSystemMessage: vi.fn() }));

class CaptureTrack extends EventTarget {
  kind = 'audio';
  readyState = 'live';
  contentHint = '';
  stop() {
    this.readyState = 'ended';
  }
}
async function capture(h: Awaited<ReturnType<typeof startB>>, pickerDelay = 0, viaUi = true) {
  const track = new CaptureTrack();
  const stream = {
    active: true,
    getVideoTracks: () => [],
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve(stream), pickerDelay)),
      ),
    },
  });
  const cap = await import('../../audio/system-capture.ts');
  cap.registerSystemCaptureListeners();
  let starting: Promise<void> | null = null;
  if (viaUi) {
    document.getElementById('btn-add-media')!.click();
    expect(document.getElementById('media-source-overlay')!.classList.contains('active')).toBe(
      true,
    );
    const btn = document.getElementById('btn-system-audio') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
  } else {
    starting = cap.startSystemAudioCapture();
  }
  await vi.advanceTimersByTimeAsync(pickerDelay + 10);
  await starting;
  expect(cap.isSystemAudioActive()).toBe(true);
  expect(getState('playback.mode')).toBe('system-audio');
  h.player.__log.length = 0;
  for (const s of [0, 1, 2, 5]) h.yt.fireStateChange(s);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(0);
  broadcastMock.mockClear();
  bus.emit('system-audio:stop');
  expect(cap.isSystemAudioActive()).toBe(false);
  return broadcastMock.mock.calls.map((c) => c[0]).filter((m) => m.type === MSG.YOUTUBE_PLAY);
}

vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  canCaptureSystemAudio: () => true,
}));

it.each([300, 600, 3000])(
  'UI manual editor to system picker with %sms result delay preserves playing intent',
  async (delay) => {
    const h = await startB();
    h.player.seekTo(60, true);
    document.body.insertAdjacentHTML(
      'beforeend',
      `
    <button id="btn-sync">Sync</button>
    <div id="manual-sync-overlay" aria-hidden="true"><div role="dialog"><div id="manual-sync-value" contenteditable="true" tabindex="0"></div><button id="btn-sync-done">Done</button></div></div>
    <button id="btn-add-media">Media</button><div id="media-source-overlay"><button id="btn-system-audio">Share</button></div>
  `,
    );
    (await import('../../ui/player-controls.ts')).initPlayerControls();
    (await import('../../network/sync.ts')).initSync();
    // Preload the same deferred UI module, then let the actual button call it.
    await import('../../ui/manual-sync-overlay-runtime.ts');
    document.getElementById('btn-sync')!.click();
    await vi.advanceTimersByTimeAsync(1);
    const overlay = document.getElementById('manual-sync-overlay')!;
    expect(overlay.classList.contains('show')).toBe(true);
    const editor = document.getElementById('manual-sync-value')!;
    editor.focus();
    editor.textContent = '500';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const gate = await import('../standard-host-manual-offset-gate.ts');
    expect(gate.isStandardHostManualOffsetTransactionPending()).toBe(true);
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.classList.contains('show')).toBe(false);
    const frames = await capture(h, delay);
    expect(frames).toHaveLength(1);
    h.yt.fireReady();
    while (h.cues.length) h.finishCue();
    await vi.advanceTimersByTimeAsync(6500);
    expect(getState('playlist.currentQueueItemId')).toBe(B);
    expect(h.player.getPlayerState()).toBe(1);
  },
);

describe('system capture restoration across a local manual-offset transaction', () => {
  it.each([
    'playing',
    'paused',
    'paused-offset',
    'settled-offset',
    'applying-offset',
    'queued-offset',
    'debounced-offset',
  ] as const)('preserves the semantic playback intent: %s', async (phase) => {
    const h = await startB();
    h.player.seekTo(60, true);
    const paused = phase === 'paused' || phase === 'paused-offset';
    if (paused) bus.emit('youtube:toggle-play');
    const gate = await import('../standard-host-manual-offset-gate.ts');
    if (phase.endsWith('-offset')) {
      gate.requestUserStandardHostManualOffsetTransaction(
        h.player,
        0.5,
        phase === 'debounced-offset' ? 'debounced' : 'committed',
      );
      if (phase === 'settled-offset') await vi.advanceTimersByTimeAsync(6500);
      if (phase === 'queued-offset')
        gate.requestUserStandardHostManualOffsetTransaction(h.player, 0.75, 'committed');
    }
    const frames = await capture(h, 100, false);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ queueItemId: B, videoId: VID_B });
    expect(gate.getStandardHostManualOffsetPlaybackIntent()).toBeNull();
    expect(gate.isStandardHostManualOffsetTransactionPending()).toBe(false);
    h.yt.fireReady();
    while (h.cues.length) h.finishCue();
    await vi.advanceTimersByTimeAsync(6500);
    expect(getState('playlist.currentQueueItemId')).toBe(B);
    expect(h.player.getPlayerState()).toBe(paused ? 2 : 1);
    expect(gate.isStandardHostManualOffsetTransactionPending()).toBe(false);
  });

  it.each(['player', 'session', 'room', 'queue', 'subindex', 'mode', 'cancel', 'reset'] as const)(
    'does not expose a retired transaction intent after %s changes',
    async (part) => {
      const h = await startB();
      const gate = await import('../standard-host-manual-offset-gate.ts');
      gate.requestUserStandardHostManualOffsetTransaction(h.player, 0.5, 'committed');
      expect(h.player.getPlayerState()).toBe(2);
      expect(gate.getStandardHostManualOffsetPlaybackIntent()).toBe(true);
      if (part === 'player') h.state.setYouTubePlayer(null);
      if (part === 'session') h.state.incrementSessionId();
      if (part === 'room') setState('room.context', { ...getState('room.context'), epoch: 2 });
      if (part === 'queue') setState('playlist.currentQueueItemId', A);
      if (part === 'subindex') setState('youtube.currentSubIndex', 1);
      if (part === 'mode') setState('playback.mode', 'file');
      if (part === 'cancel') gate.cancelStandardHostManualOffsetTransaction();
      if (part === 'reset') gate.resetStandardHostManualOffsetTransaction();
      expect(gate.getStandardHostManualOffsetPlaybackIntent()).toBeNull();
    },
  );
});
