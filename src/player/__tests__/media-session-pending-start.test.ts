/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setCurrentAudioBuffer, getPlayerNode, getPendingPlayTime } from '../../player/_state.ts';
import { setPlaybackFilePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';

const audio = vi.hoisted(() => ({
  resume: vi.fn<() => Promise<void>>(async () => undefined),
  init: vi.fn<() => Promise<void>>(async () => undefined),
  start: vi.fn(),
  broadcast: vi.fn(),
  now: 100,
}));
vi.mock('../../audio/context.ts', () => ({
  ensureRunning: audio.resume,
  getCurrentTime: () => audio.now,
  getPendingForegroundAudioContextClockHealthCheck: () => null,
  getAudioContext: () => ({
    state: 'running',
    currentTime: audio.now,
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect() {},
      disconnect() {},
      start: audio.start,
      stop() {},
    }),
  }),
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: audio.init,
  getFilePlaybackDestination: () => null,
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: audio.broadcast,
  sendToHost: vi.fn(),
  safeSend: vi.fn(() => true),
}));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));

import { initMediaSession } from '../../player/media-session.ts';
import { getPlayLockSnapshot, pause, play, seekTo, stopAllMedia } from '../../player/transport.ts';

const Q = '22000000-0000-4000-8000-000000000001';
const actions = new Map<MediaSessionAction, MediaSessionActionHandler>();
const action = (name: MediaSessionAction) => actions.get(name)!({ action: name });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function flush() {
  for (let n = 0; n < 25; n++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  audio.resume.mockResolvedValue(undefined);
  audio.init.mockResolvedValue(undefined);
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('playlist.items', [
    { queueItemId: Q, type: 'file', name: 'probe.wav', videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', Q);
  const blob = new Blob(['wave']);
  setState('files.current', {
    queueItemId: Q,
    name: 'probe.wav',
    indexHint: 0,
    sessionId: 1,
    size: blob.size,
    mime: 'audio/wav',
    blob,
  });
  setCurrentAudioBuffer({ duration: 120, sampleRate: 48_000, length: 5_760_000 } as AudioBuffer);
  setPlaybackFilePaused();
  setState('player.pausedAt', 12);
  actions.clear();
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null,
      playbackState: 'none',
      setActionHandler(name: MediaSessionAction, handler: MediaSessionActionHandler | null) {
        if (handler) actions.set(name, handler);
      },
    },
  });
  initMediaSession();
});
afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  clearAllManagedTimers();
  bus.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('public cancellation while Standard host resumes a paused file', () => {
  for (const seam of ['resume', 'init'] as const) {
    it.each([
      'none',
      'hardware-pause',
      'hardware-stop',
      'transport-pause',
      'paused-seek',
      'youtube-takeover',
    ] as const)(`${seam} await / %s has latest-intent ownership`, async (cancel) => {
      const held = gate();
      audio[seam].mockReturnValueOnce(held.promise);
      action('play');
      await flush();
      expect(getPlayLockSnapshot().locked).toBe(true);
      expect(getState('playback.activity')).toBe('paused');
      expect(audio.start).not.toHaveBeenCalled();
      if (cancel === 'hardware-pause') action('pause');
      if (cancel === 'hardware-stop') action('stop');
      if (cancel === 'transport-pause') pause(undefined, { showToast: false });
      if (cancel === 'paused-seek') seekTo(42);
      if (cancel === 'youtube-takeover') {
        stopAllMedia({ silent: true, cancelInFlight: true });
        setPlaybackYouTubePlaying();
      }
      held.resolve();
      await flush();
      expect(getPlayLockSnapshot().locked).toBe(false);
      if (cancel === 'none') {
        expect(audio.start).toHaveBeenCalledOnce();
        expect(getState('playback.activity')).toBe('playing');
      } else {
        expect(audio.start).not.toHaveBeenCalled();
        if (cancel === 'hardware-pause' || cancel === 'transport-pause' || cancel === 'paused-seek')
          expect(getState('playback.activity')).toBe('paused');
        if (cancel === 'paused-seek') expect(getState('player.pausedAt')).toBe(42);
      }
    });
  }
  it('control: hardware PAUSE after the source starts stops current output', async () => {
    action('play');
    await flush();
    expect(audio.start).toHaveBeenCalledOnce();
    expect(getPlayerNode()).not.toBeNull();
    action('pause');
    await flush();
    expect(getState('playback.activity')).toBe('paused');
    expect(getPlayerNode()).toBeNull();
  });
  it('control: direct PAUSE clears a queued successor and permits a later explicit PLAY', async () => {
    const held = gate();
    audio.resume.mockReturnValueOnce(held.promise);
    const first = play(10);
    await flush();
    expect(await play(20)).toBe(false);
    expect(getPendingPlayTime()).toBe(20);
    pause(30, { showToast: false });
    held.resolve();
    await first;
    await flush();
    expect(audio.start).not.toHaveBeenCalled();
    expect(getPendingPlayTime()).toBeUndefined();
    expect(await play(30)).toBe(true);
    expect(audio.start).toHaveBeenCalledOnce();
  });
});
