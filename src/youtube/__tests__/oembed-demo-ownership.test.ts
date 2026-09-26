/**
 * @vitest-environment jsdom
 *
 * Real chat-link add, oEmbed body reader, and demo entry publish competing
 * metadata. The asynchronous boundary is an incomplete HTTP response body;
 * media decoding/output is outside this metadata ownership contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';
import { setPlaybackFilePlaying, setPlaybackIdle } from '../../player/ownership.ts';
import { createDemoTrackMeta, DEMO_TRACKS } from '../../demo/tracks.ts';
import { makeFakeYtPlayer } from './__helpers__/fake-yt-player.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
vi.mock('../../audio/engine.ts', () => ({ initAudio: vi.fn(async () => {}) }));
vi.mock('../../audio/effects.ts', () => ({
  applySettings: vi.fn(),
  applySettingsAsync: vi.fn(),
  syncRoomEffectsUI: vi.fn(),
}));
vi.mock('../../player/transport.ts', () => ({
  fmtTime: (seconds: number) => String(seconds),
  getTrackPosition: () => 0,
  getLocalFilePendingStartDeadlineMs: () => undefined,
  isLocalFileStartPending: () => false,
  isFilePipelineBusyForPlay: () => false,
  pause: vi.fn(),
  seekTo: vi.fn(),
  play: vi.fn(async () => {
    setPlaybackFilePlaying();
    return true;
  }),
  stopAllMedia: vi.fn(() => {
    bus.emit('youtube:stop-playback');
    bus.emit('youtube:stop-mode', { silent: true });
    setPlaybackIdle();
  }),
}));
vi.mock('../../player/decode.ts', () => ({
  loadDemoFile: vi.fn(async () => {
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
  }),
}));
vi.mock('../../player/media-session-loader.ts', () => ({
  prepareMediaSession: vi.fn(async () => {}),
}));
vi.mock('../../ui/player-controls.ts', () => ({
  fmtTime: (seconds: number) => String(seconds),
  showPlacementToastForChannel: vi.fn(),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  getRoleLabelByChannelMode: vi.fn(),
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: vi.fn() }));
vi.mock('../../ui/setup-shared.ts', () => ({ hideSetupOverlay: vi.fn() }));
vi.mock('../../ui/dom.ts', () => ({
  animateTransition: (callback: () => void) => callback(),
  updateOverlayOpenClass: vi.fn(),
}));
vi.mock('../../ui/theme-chrome.ts', () => ({
  syncAppThemeChrome: vi.fn(),
  syncDemoThemeChrome: vi.fn(),
}));

class DemoXHR {
  static pending: DemoXHR[] = [];
  status = 200;
  response = new Blob(['demo bytes']);
  responseType = '';
  timeout = 0;
  onload: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    DemoXHR.pending.push(this);
  }
  abort(): void {
    this.onabort?.();
  }
}

let videoSequence = 0;
let fireYouTubeReady: () => void;

function delayedMetadataBody() {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      title: 'Delayed YouTube title',
      author_name: 'YouTube author',
    }),
  );
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(bytes.slice(0, -1));
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  return {
    response,
    finish() {
      controller.enqueue(bytes.slice(-1));
      controller.close();
    },
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();
  DemoXHR.pending = [];
  vi.stubGlobal('XMLHttpRequest', DemoXHR);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const player = makeFakeYtPlayer();
  vi.stubGlobal('YT', {
    Player: function (
      _element: string,
      options: {
        videoId?: string;
        events: {
          onReady: (event: { target: typeof player }) => void;
          onStateChange: NonNullable<typeof player.__onStateChange>;
        };
      },
    ) {
      player.__videoId = options.videoId ?? '';
      player.__onStateChange = options.events.onStateChange;
      fireYouTubeReady = () => options.events.onReady({ target: player });
      return player;
    },
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  });
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
  delete document.body.dataset.demoBound;
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', true);
  const youtubeState = await import('../_state.ts');
  youtubeState.resetYouTubeModuleState();
  const { initYouTube } = await import('../player.ts');
  initYouTube();
  const { initDemoMode } = await import('../../demo/mode.ts');
  initDemoMode({ suppressFirstRunPrompt: true });
});

afterEach(() => {
  bus.emit('demo:authority-reset');
  bus.emit('youtube:stop-mode', { silent: true });
  setCurrentAudioBuffer(null);
  clearAllManagedTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function addYouTubeWithPendingTitle() {
  const body = delayedMetadataBody();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => body.response),
  );
  const videoId = `qa15${String(++videoSequence).padStart(7, '0')}`;
  bus.emit('youtube:load-from-chat', `https://www.youtube.com/watch?v=${videoId}`);
  await vi.advanceTimersByTimeAsync(1);
  expect(body.response.body?.locked).toBe(true);
  const item = getState('playlist.items')[0];
  expect(item?.videoId).toBe(videoId);
  expect(getState('playlist.currentQueueItemId')).toBe(item.queueItemId);
  expect(getState('playback.mode')).toBe('youtube');
  return { body, queueItemId: item.queueItemId };
}

describe('background YouTube title ownership across demo entry', () => {
  it.each(['loading', 'ready'] as const)(
    'keeps %s demo metadata while updating the old queue row',
    async (phase) => {
      const { body, queueItemId } = await addYouTubeWithPendingTitle();
      bus.emit('demo:enter');
      await vi.advanceTimersByTimeAsync(1);
      expect(getState('demo.active')).toBe(true);
      expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
      if (phase === 'ready') {
        DemoXHR.pending[0]?.onload?.();
        await vi.advanceTimersByTimeAsync(1);
        expect(getState('demo.loading')).toBe(false);
      }
      const demoMeta = getState('player.currentTrackMeta');
      expect(demoMeta).toMatchObject(createDemoTrackMeta(DEMO_TRACKS[0]));
      body.finish();
      await vi.advanceTimersByTimeAsync(1);
      expect(getState('playlist.items')[0].title).toBe('Delayed YouTube title');
      expect(getState('player.currentTrackMeta')).toBe(demoMeta);
      expect(getState('playback.mode')).toBe('file');
    },
  );

  it('updates now-playing metadata when the YouTube row still owns playback', async () => {
    const { body, queueItemId } = await addYouTubeWithPendingTitle();
    body.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('player.currentTrackMeta')).toMatchObject({
      queueItemId,
      type: 'youtube',
      title: 'Delayed YouTube title',
      artist: 'YouTube author',
    });
  });

  it('does not restore YouTube metadata after demo exits with the old row still selected', async () => {
    const { body, queueItemId } = await addYouTubeWithPendingTitle();
    bus.emit('demo:enter');
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('demo.active')).toBe(true);
    bus.emit('demo:request-exit');
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('demo.active')).toBe(false);
    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    body.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('playlist.items')[0].title).toBe('Delayed YouTube title');
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('refreshes metadata for an owned YouTube player after a local pause', async () => {
    const { body, queueItemId } = await addYouTubeWithPendingTitle();
    fireYouTubeReady();
    bus.emit('youtube:set-local-paused', true);
    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('playback.activity')).toBe('paused');
    body.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('player.currentTrackMeta')).toMatchObject({
      queueItemId,
      type: 'youtube',
      title: 'Delayed YouTube title',
      artist: 'YouTube author',
    });
    expect(getState('playback.activity')).toBe('paused');
  });
});
