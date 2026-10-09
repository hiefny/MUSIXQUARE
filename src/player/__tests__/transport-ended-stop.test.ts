/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, setState, resetState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { initPlaylist, playTrack, setRepeatMode } from '../../player/playlist.ts';
import { initPlayback } from '../../player/playback.ts';
import { initMediaSession } from '../../player/media-session.ts';
import { setCurrentAudioBuffer, clearFailedTracks } from '../../player/_state.ts';
import { handleEnded, stopAllMedia } from '../../player/transport.ts';
import { resetAllStoredFiles } from '../../storage/storage.ts';
import type { PlaylistItem } from '../../types/index.ts';

const native = vi.hoisted(() => ({ decode: vi.fn(), starts: vi.fn(), clock: 100 }));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: async () => {},
  getFilePlaybackDestination: () => null,
}));
vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => native.clock,
  ensureRunning: async () => {},
  getPendingForegroundAudioContextClockHealthCheck: () => null,
  getAudioContext: () => ({
    state: 'running',
    sampleRate: 48000,
    currentTime: native.clock,
    decodeAudioData: native.decode,
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect() {},
      disconnect() {},
      stop() {},
      start: native.starts,
    }),
  }),
}));
const handlers: Record<string, MediaSessionActionHandler> = {};
Object.defineProperty(navigator, 'mediaSession', {
  configurable: true,
  value: {
    metadata: null,
    playbackState: 'none',
    setPositionState() {},
    setActionHandler(action: string, handler: MediaSessionActionHandler | null) {
      if (handler) handlers[action] = handler;
      else delete handlers[action];
    },
  },
});
globalThis.MediaMetadata = class {
  constructor(init: unknown) {
    Object.assign(this, init);
  }
} as typeof MediaMetadata;
const A = '91300000-0000-4000-8000-000000000001';
const B = '91300000-0000-4000-8000-000000000002';
const C = '91300000-0000-4000-8000-000000000003';
function item(qid: string): PlaylistItem {
  const file = new File(['synthetic encoded boundary'], `${qid}.mp3`, { type: 'audio/mpeg' });
  return { queueItemId: qid, name: file.name, type: 'file', file, videoId: null, playlistId: null };
}
function buffer(duration = 60): AudioBuffer {
  return {
    duration,
    sampleRate: 48000,
    length: duration * 48000,
    numberOfChannels: 2,
  } as AudioBuffer;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  native.decode.mockReset();
  native.clock = 100;
  clearAllManagedTimers();
  resetState();
  bus.clear();
  resetAllStoredFiles();
  setCurrentAudioBuffer(null);
  clearFailedTracks();
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('player.isFirstTrackLoad', false);
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control', 'queue.mutate'],
  });
  setState('playlist.items', [item(A), item(B), item(C)]);
  setState('playlist.revision', 3);
  initPlayback();
  initPlaylist();
  initMediaSession();
});
afterEach(async () => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  resetAllStoredFiles();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

function action(name: string) {
  expect(handlers[name]).toBeTypeOf('function');
  handlers[name]({ action: name as MediaSessionAction });
}
async function naturalEnd(repeatMode: 0 | 2) {
  native.decode.mockResolvedValue(buffer());
  await playTrack(A);
  await vi.advanceTimersByTimeAsync(1);
  setRepeatMode(repeatMode, false);
  native.starts.mockClear();
  native.clock = 161;
  // Standard host completion owns the canonical wall/monotonic timer, not a
  // synthetic jump of AudioContext.currentTime. Let that actual timer call
  // handleEnded, which synchronously invokes the real playlist listener.
  await vi.advanceTimersByTimeAsync(60_010);
  expect(getState('playback.activity')).toBe('idle');
  expect(
    getManagedTimer(repeatMode === 2 ? 'ended-advance-retry' : 'ended-advance-next'),
  ).not.toBeNull();
}
it.each([0, 2] as const)(
  'control: natural end performs intended delayed transition for repeat %s',
  async (mode) => {
    await naturalEnd(mode);
    await vi.advanceTimersByTimeAsync(700);
    expect(getState('playlist.currentQueueItemId')).toBe(mode === 2 ? A : B);
    expect(native.starts).toHaveBeenCalledOnce();
  },
);
it.each([0, 2] as const)(
  'registered native STOP cancels the pending natural-end transition for repeat %s',
  async (mode) => {
    await naturalEnd(mode);
    await vi.advanceTimersByTimeAsync(100);
    action('stop');
    await vi.advanceTimersByTimeAsync(600);
    expect(getState('playlist.currentQueueItemId')).toBe(A);
    expect(getState('playback.activity')).toBe('idle');
    expect(native.starts).not.toHaveBeenCalled();
  },
);
it('control: registered native STOP before natural end suppresses any subsequent transition', async () => {
  native.decode.mockResolvedValue(buffer());
  await playTrack(A);
  await vi.advanceTimersByTimeAsync(1);
  native.starts.mockClear();
  action('stop');
  native.clock = 161;
  expect(handleEnded()).toBe(false);
  await vi.advanceTimersByTimeAsync(700);
  expect(getState('playlist.currentQueueItemId')).toBe(A);
  expect(native.starts).not.toHaveBeenCalled();
});
