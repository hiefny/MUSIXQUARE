/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { IS_WINDOWS } from '../../core/platform.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { getSyncPongPlaybackState } from '../../network/sync.ts';
import { createProPlaybackAuthorityToken } from '../../pro-room/playback-authority-hooks.ts';
import { getPlayerNode, setCurrentAudioBuffer, setPlayerNode } from '../_state.ts';
import type { LargeAudioTrack } from '../file-playback-resource.ts';
import { setPlaybackFilePlaying, setPlaybackLifecycleState } from '../ownership.ts';

const mocks = vi.hoisted(() => ({
  currentTime: 100,
  monotonicMs: 1_000,
  start: vi.fn(),
  broadcast: vi.fn(),
  showLoader: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => mocks.currentTime,
  getAudioContext: () => ({
    state: 'running',
    get currentTime() {
      return mocks.currentTime;
    },
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      disconnect() {},
      start: mocks.start,
      stop() {},
      onended: null,
    }),
  }),
  ensureRunning: vi.fn(),
  getPendingForegroundAudioContextClockHealthCheck: () => null,
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
  getFilePlaybackDestination: () => ({}),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  sendToHost: vi.fn(),
}));
vi.mock('../../ui/toast.ts', () => ({
  showLoader: mocks.showLoader,
  showToast: mocks.showToast,
}));

import {
  adjustSync,
  applyProPlaybackFileCommit,
  getTrackPosition,
  isLocalFileStartPending,
  pause,
  play,
  seekTo,
  startHostFileAndBroadcastPlay,
  stopAllMedia,
} from '../transport.ts';

const QUEUE_ITEM_ID = '97111111-1111-4111-8111-111111111111';

function controlledTrack() {
  const pending: Array<{
    position: number;
    signal?: AbortSignal;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];
  const outputs: Array<Parameters<LargeAudioTrack['createPlayback']>[0]> = [];
  const track: LargeAudioTrack = {
    kind: 'large-audio',
    duration: 3_600,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 172_800_000,
    bufferedPcmBytes: 4_096,
    prepare: vi.fn(
      (position, signal) =>
        new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException('superseded', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          pending.push({
            position,
            signal,
            resolve: () => {
              signal?.removeEventListener('abort', abort);
              resolve();
            },
            reject: (error) => {
              signal?.removeEventListener('abort', abort);
              reject(error);
            },
          });
        }),
    ),
    createPlayback: vi.fn((options) => {
      outputs.push(options);
      return { ended: false, stop: vi.fn(), disconnect: vi.fn() };
    }),
    dispose: vi.fn(),
  };
  return { track, pending, outputs };
}

function hostSeek(time: number) {
  return startHostFileAndBroadcastPlay({
    time,
    queueItemId: QUEUE_ITEM_ID,
    context: 'large-track regression seek',
  });
}

async function advance(ms = 0): Promise<void> {
  mocks.currentTime += ms / 1_000;
  mocks.monotonicMs += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
  vi.spyOn(performance, 'now').mockImplementation(() => mocks.monotonicMs);
  resetState();
  bus.clear();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  vi.clearAllMocks();
  mocks.currentTime = 100;
  mocks.monotonicMs = 1_000;
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host-1',
    epoch: 7,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  const blob = new Blob(['large file']);
  setState('files.current', {
    queueItemId: QUEUE_ITEM_ID,
    indexHint: 0,
    name: 'large.mp3',
    sessionId: 1,
    blob,
    mime: 'audio/mpeg',
    size: blob.size,
  });
  setState('sync.localOffset', IS_WINDOWS ? -0.02 : 0);
  setPlaybackLifecycleState(PLAYBACK_STATE.READY);
});

afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded file transport preparation', () => {
  it('cancels the previous near-end deadline while a new host seek is being prepared', async () => {
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    const first = hostSeek(3_599.9);
    await advance();
    pending[0]!.resolve();
    await first;
    expect(getManagedTimer('standard-file-canonical-end')).not.toBeNull();
    const ended = vi.fn();
    bus.on('player:ended', ended);
    const second = hostSeek(600);
    expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'paused' });
    await advance();
    expect(getManagedTimer('standard-file-canonical-end')).toBeNull();
    expect(getPlayerNode()).toBeNull();
    expect(isLocalFileStartPending()).toBe(true);
    expect(getTrackPosition()).toBeCloseTo(600);
    expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'paused' });
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 600,
      queueItemId: QUEUE_ITEM_ID,
      reason: 'seek',
    });
    await advance(500);
    expect(ended).not.toHaveBeenCalled();
    pending[1]!.resolve();
    await expect(second).resolves.toBe(true);
    expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'playing' });
    expect(outputs.at(-1)?.offset).toBeCloseTo(600);
    expect(outputs.at(-1)?.when).toBeCloseTo(mocks.currentTime);
    expect(mocks.broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: MSG.PLAY,
        time: 600,
        queueItemId: QUEUE_ITEM_ID,
      }),
    );
  });

  it('cancels older preparation and commits only the final rapid host seek', async () => {
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    setPlaybackFilePlaying();
    seekTo(100);
    await advance();
    expect(getState('playback.activity')).toBe('playing');
    seekTo(500);
    seekTo(900);
    await advance();
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(pending.map((entry) => entry.position)).toEqual([100, 900]);
    expect(outputs).toHaveLength(0);
    pending[1]!.resolve();
    await advance();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.offset).toBeCloseTo(900);
    expect(mocks.broadcast.mock.calls.filter(([message]) => message.type === MSG.PLAY)).toEqual([
      [expect.objectContaining({ time: 900 })],
    ]);
  });

  it.each(['pause', 'youtube', 'system-audio'] as const)(
    'prevents prepared output from starting after %s takes ownership',
    async (successor) => {
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      setPlaybackFilePlaying();
      const start = hostSeek(100);
      await advance();
      if (successor === 'pause') pause(100, { showToast: false });
      else setState('playback.mode', successor);
      await advance(100);
      expect(pending[0]!.signal?.aborted).toBe(true);
      pending[0]!.resolve();
      await expect(start).resolves.toBe(false);
      expect(outputs).toHaveLength(0);
      expect(mocks.broadcast.mock.calls.some(([message]) => message.type === MSG.PLAY)).toBe(false);
      expect(isLocalFileStartPending()).toBe(false);
    },
  );

  it('settles a failed host preparation at the requested paused position without publishing PLAY', async () => {
    const { track, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    setPlaybackFilePlaying();
    vi.mocked(track.prepare).mockRejectedValueOnce(new Error('corrupt requested segment'));
    await expect(hostSeek(700)).resolves.toBe(false);
    expect(getState('playback.activity')).toBe('paused');
    expect(getTrackPosition()).toBeCloseTo(700);
    expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'paused' });
    expect(outputs).toHaveLength(0);
    expect(mocks.broadcast.mock.calls.some(([message]) => message.type === MSG.PLAY)).toBe(false);
    expect(isLocalFileStartPending()).toBe(false);
  });

  it.each(['standard', 'pro', 'demo'] as const)(
    'keeps healthy %s output playing when preparing a manual-sync adjustment fails',
    async (mode) => {
      if (mode === 'pro') {
        setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
      } else if (mode === 'demo') {
        setState('demo.active', true);
        setState('demo.currentTrackIndex', 0);
      }
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      const start = play(20);
      await advance();
      pending[0]!.resolve();
      await start;
      const originalSource = getPlayerNode();
      vi.mocked(track.prepare).mockRejectedValueOnce(new Error('replacement preparation failed'));

      adjustSync(0.1);
      await advance(200);

      expect(getPlayerNode()).toBe(originalSource);
      expect(getState('playback.activity')).toBe('playing');
      expect(getTrackPosition()).toBeCloseTo(20.2);
      expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'playing' });
      expect(outputs).toHaveLength(1);
      expect(mocks.broadcast).not.toHaveBeenCalled();
      expect(mocks.showToast).toHaveBeenCalledOnce();
      expect(isLocalFileStartPending()).toBe(false);
    },
  );

  it('still pauses obsolete output when an authoritative PRO seek cannot prepare its new position', async () => {
    setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    const first = play(20);
    await advance();
    pending[0]!.resolve();
    await first;
    vi.mocked(track.prepare).mockRejectedValueOnce(new Error('authoritative preparation failed'));

    await expect(
      applyProPlaybackFileCommit({
        authority: createProPlaybackAuthorityToken({
          roomId: '123456',
          roomEpoch: 7,
          basePlaybackRevision: 1,
          transitionId: 'large-authority-seek',
        }),
        committedPlaybackRevision: 2,
        queueItemId: QUEUE_ITEM_ID,
        state: 'playing',
        positionSeconds: 700,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
        isCurrent: () => true,
      }),
    ).resolves.toBe(false);
    expect(getPlayerNode()).toBeNull();
    expect(getState('playback.activity')).toBe('paused');
    expect(outputs).toHaveLength(1);
    expect(isLocalFileStartPending()).toBe(false);
  });

  it('does not pause or warn for a manual adjustment whose room occurrence was superseded', async () => {
    const { track, pending } = controlledTrack();
    setCurrentAudioBuffer(track);
    const first = play(20);
    await advance();
    pending[0]!.resolve();
    await first;
    const originalSource = getPlayerNode();
    adjustSync(0.1);
    await advance(200);
    expect(pending).toHaveLength(2);
    setState('room.context', { ...getState('room.context'), epoch: 8 });
    pending[1]!.reject(new Error('obsolete preparation failed'));
    await advance();
    expect(getPlayerNode()).toBe(originalSource);
    expect(getState('playback.activity')).toBe('playing');
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(isLocalFileStartPending()).toBe(false);
  });

  it.each(['standard', 'pro'] as const)(
    'catches up to the absolute %s start deadline after decoding preparation',
    async (kind) => {
      setState('room.context', { ...getState('room.context'), kind, role: 'member' });
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      const start = play(40, 0.2, performance.now() + 200);
      await advance();
      expect(isLocalFileStartPending()).toBe(true);
      await advance(650);
      pending[0]!.resolve();
      await expect(start).resolves.toBe(true);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.offset).toBeCloseTo(40.45, 6);
      expect(outputs[0]!.when).toBeCloseTo(mocks.currentTime);
      expect(isLocalFileStartPending()).toBe(false);
    },
  );

  it('returns to the native path after replacing a bounded resource with a small track', async () => {
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    const start = hostSeek(20);
    await advance();
    pending[0]!.resolve();
    await start;
    expect(outputs).toHaveLength(1);
    stopAllMedia({ cancelInFlight: true, clearBuffer: true });
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    await expect(play(12)).resolves.toBe(true);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(0, 12);
    expect(track.prepare).toHaveBeenCalledOnce();
    expect(isLocalFileStartPending()).toBe(false);
  });
});
