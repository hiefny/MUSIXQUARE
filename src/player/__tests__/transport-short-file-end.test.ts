/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { IS_WINDOWS } from '../../core/platform.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, clearManagedTimer, getManagedTimer } from '../../core/timers.ts';
import { initPlayback } from '../playback.ts';
import { registerProPlaybackCommandHandler } from '../../pro-room/playback-authority-hooks.ts';
import { getPlayerNode, setCurrentAudioBuffer } from '../_state.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';

const audio = vi.hoisted(() => ({
  wallStart: 0,
  now: (): number => 100,
}));

vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => audio.now(),
  ensureRunning: vi.fn(),
  getPendingForegroundAudioContextClockHealthCheck: () => null,
  getAudioContext: () => ({
    state: 'running',
    get currentTime() {
      return audio.now();
    },
    createBufferSource: () => {
      let endTimer: ReturnType<typeof setTimeout> | undefined;
      const source = {
        buffer: null as AudioBuffer | null,
        onended: null as (() => void) | null,
        connect() {},
        disconnect() {},
        start(when: number, offset: number) {
          // The physical source ends on its own shifted output clock. The
          // transport must independently complete the canonical occurrence.
          const delay = Math.max(0, when - audio.now());
          const remaining = Math.max(0, source.buffer!.duration - offset);
          endTimer = setTimeout(() => source.onended?.(), (delay + remaining) * 1_000);
        },
        stop() {
          clearTimeout(endTimer);
        },
      };
      return source;
    },
  }),
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
  getFilePlaybackDestination: () => null,
}));

import { handleEnded, play, stopAllMedia } from '../transport.ts';

const QUEUE_ITEM_ID = '95111111-1111-4111-8111-111111111111';
const START_LEAD_SECONDS = 0.2;

function clip(duration: number): AudioBuffer {
  return { duration, sampleRate: 48_000, length: Math.round(duration * 48_000) } as AudioBuffer;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  audio.wallStart = Date.now();
  audio.now = () => 100 + (Date.now() - audio.wallStart) / 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - audio.wallStart);
  resetState();
  bus.clear();
  initPlayback();
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host-1',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('playlist.items', [
    { queueItemId: QUEUE_ITEM_ID, name: 'clip.wav', type: 'file', videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  const blob = new Blob(['clip']);
  setState('files.current', {
    queueItemId: QUEUE_ITEM_ID,
    name: 'clip.wav',
    indexHint: 0,
    sessionId: 1,
    size: blob.size,
    mime: 'audio/wav',
    blob,
  });
  setState('sync.localOffset', IS_WINDOWS ? -0.02 : 0);
});

afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  registerProPlaybackCommandHandler(null);
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('positive short file completion', () => {
  it.each([0.001, 0.05, 0.0505, 0.1, 0.2])(
    'ends a Standard %ss clip exactly once after its scheduled canonical deadline',
    async (duration) => {
      setCurrentAudioBuffer(clip(duration));
      const ended = vi.fn();
      bus.on('player:ended', ended);
      await expect(play(0, START_LEAD_SECONDS)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(START_LEAD_SECONDS * 1_000 + duration * 1_000 - 1);
      expect(ended).not.toHaveBeenCalled();
      expect(getState('playback.activity')).toBe('playing');
      await vi.advanceTimersByTimeAsync(30);
      expect(ended).toHaveBeenCalledOnce();
      expect(getState('playback.activity')).toBe('idle');
      expect(getManagedTimer('standard-file-canonical-end')).toBeNull();
      await vi.advanceTimersByTimeAsync(300);
      expect(ended).toHaveBeenCalledOnce();
    },
  );

  it.each([-0.02, 0.02])(
    'keeps the short-clip canonical end when local output is shifted by %ss',
    async (outputOffset) => {
      const duration = 0.05;
      const position = 0.025;
      setCurrentAudioBuffer(clip(duration));
      setState('sync.localOffset', outputOffset - (IS_WINDOWS ? 0.02 : 0));
      const ended = vi.fn();
      bus.on('player:ended', ended);
      await expect(play(position, START_LEAD_SECONDS)).resolves.toBe(true);
      const source = getPlayerNode();
      await vi.advanceTimersByTimeAsync(224);
      expect(ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30);
      expect(ended).toHaveBeenCalledOnce();
      expect(source?.onended).toBeNull();
      expect(getState('playback.activity')).toBe('idle');
    },
  );

  it('reports a short PRO file end through authority without advancing the local queue', async () => {
    setState('room.context', { ...getState('room.context'), kind: 'pro', roomId: 'pro-room' });
    setCurrentAudioBuffer(clip(0.05));
    const command = vi.fn();
    registerProPlaybackCommandHandler(command);
    const ended = vi.fn();
    bus.on('player:ended', ended);
    await expect(play(0, START_LEAD_SECONDS)).resolves.toBe(true);
    expect(getManagedTimer('standard-file-canonical-end')).toBeNull();
    await vi.advanceTimersByTimeAsync(199);
    expect(command).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(command).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'ended', queueItemId: QUEUE_ITEM_ID, durationSeconds: 0.05 }),
    );
    expect(ended).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('playing');
  });

  it.each(['standard', 'pro'] as const)(
    'does not let %s safety polling consume a short clip during its scheduled start',
    async (kind) => {
      if (kind === 'pro') {
        setState('room.context', { ...getState('room.context'), kind, roomId: 'pro-room' });
      }
      const command = vi.fn();
      registerProPlaybackCommandHandler(command);
      const ended = vi.fn();
      bus.on('player:ended', ended);
      setCurrentAudioBuffer(clip(0.05));
      // A scheduled near-end seek is already inside the old end tolerance.
      await expect(play(0.049, START_LEAD_SECONDS)).resolves.toBe(true);
      bus.emit('player:check-ended');
      await vi.advanceTimersByTimeAsync(199);
      bus.emit('player:check-ended');
      expect(ended).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(getState('playback.activity')).toBe('playing');
      await vi.advanceTimersByTimeAsync(30);
      if (kind === 'standard') expect(ended).toHaveBeenCalledOnce();
      else expect(command).toHaveBeenCalledOnce();
    },
  );

  it('does not let PRO safety polling finish a 50ms clip at its beginning or midpoint', async () => {
    setState('room.context', { ...getState('room.context'), kind: 'pro', roomId: 'pro-room' });
    setCurrentAudioBuffer(clip(0.05));
    const command = vi.fn();
    registerProPlaybackCommandHandler(command);
    await expect(play(0)).resolves.toBe(true);
    bus.emit('player:check-ended');
    await vi.advanceTimersByTimeAsync(25);
    bus.emit('player:check-ended');
    expect(command).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(command).toHaveBeenCalledOnce();
  });

  it('advances an already-ended short Standard clip when foreground output is refreshed', async () => {
    setCurrentAudioBuffer(clip(0.05));
    const ended = vi.fn();
    bus.on('player:ended', ended);
    await expect(play(0)).resolves.toBe(true);
    clearManagedTimer('standard-file-canonical-end');
    await vi.advanceTimersByTimeAsync(100);
    expect(ended).not.toHaveBeenCalled();
    bus.emit('playback:refresh-current-position');
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toHaveBeenCalledOnce();
    expect(getPlayerNode()).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it.each([0, -1, NaN, Infinity])(
    'does not treat invalid duration %s as completion',
    (duration) => {
      setCurrentAudioBuffer({ duration } as AudioBuffer);
      setPlaybackFilePlaying();
      const ended = vi.fn();
      bus.on('player:ended', ended);
      handleEnded();
      expect(ended).not.toHaveBeenCalled();
      expect(getState('playback.activity')).toBe('playing');
      expect(getManagedTimer('standard-file-canonical-end')).toBeNull();
    },
  );
});
