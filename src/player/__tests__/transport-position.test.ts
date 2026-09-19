/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { IS_WINDOWS } from '../../core/platform.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { initPlayback } from '../playback.ts';
import type { DataConnection } from '../../types/index.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { setCurrentAudioBuffer, setPlayerNode } from '../_state.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';

const mocks = vi.hoisted(() => ({
  currentTime: 100,
  start: vi.fn(),
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
  getFilePlaybackDestination: () => null,
}));

import {
  adjustSync,
  getLocalFilePendingStartDeadlineMs,
  getTrackPosition,
  isLocalFileStartPending,
  pause,
  peekTrackPosition,
  play,
  setLocalManualSyncOffset,
  stopAllMedia,
} from '../transport.ts';

beforeEach(() => {
  resetState();
  bus.clear();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  mocks.currentTime = 100;
  mocks.start.mockClear();
});
afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('transport position', () => {
  it('retains an active Standard demo host start through a large manual nudge', async () => {
    vi.useFakeTimers();
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
    setState('demo.active', true);
    setState('demo.currentTrackIndex', 0);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    await expect(play(0, 0.2)).resolves.toBe(true);
    expect(getLocalFilePendingStartDeadlineMs()).toBeCloseTo(performance.now() + 200);

    adjustSync(9.999);
    mocks.currentTime = 100.06;
    await vi.advanceTimersByTimeAsync(60);

    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.start.mock.calls[1]?.[0]).toBeCloseTo(100.2, 6);
    expect(mocks.start.mock.calls[1]?.[1]).toBeCloseTo(9.999 + (IS_WINDOWS ? 0.02 : 0), 6);
    expect(getTrackPosition()).toBe(0);
    expect(isLocalFileStartPending()).toBe(true);
    pause(undefined, { showToast: false });
    expect(getLocalFilePendingStartDeadlineMs()).toBeUndefined();
  });

  it.each(['standard', 'pro'] as const)(
    'retains the %s source deadline when a manual nudge rebuilds pending output',
    async (kind) => {
      vi.useFakeTimers();
      setState('room.context', { ...getState('room.context'), kind });
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      await play(30, 0.2);
      adjustSync(0.1);
      mocks.currentTime = 100.06;
      await vi.advanceTimersByTimeAsync(60);

      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(mocks.start.mock.calls[1]?.[0]).toBeCloseTo(100.2, 6);
      expect(mocks.start.mock.calls[1]?.[1]).toBeCloseTo(30.1 + (IS_WINDOWS ? 0.02 : 0), 6);
      expect(isLocalFileStartPending()).toBe(true);
      expect(getTrackPosition()).toBeCloseTo(30);
      mocks.currentTime = 100.21;
      expect(isLocalFileStartPending()).toBe(false);
      expect(getTrackPosition()).toBeCloseTo(30.01);
    },
  );

  it.each(['standard', 'pro'] as const)(
    'holds a scheduled %s seek at its target until the source starts',
    async (kind) => {
      setState('room.context', { ...getState('room.context'), kind });
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      setState('sync.localOffset', 0.1);

      await expect(play(30, 0.2)).resolves.toBe(true);

      expect(isLocalFileStartPending()).toBe(true);
      expect(getTrackPosition()).toBeCloseTo(30);
      mocks.currentTime = 100.1;
      setLocalManualSyncOffset(0.2);
      expect(isLocalFileStartPending()).toBe(true);
      expect(getTrackPosition()).toBeCloseTo(30);
      mocks.currentTime = 100.21;
      expect(isLocalFileStartPending()).toBe(false);
      expect(getTrackPosition()).toBeCloseTo(30.01);
      pause(undefined, { showToast: false });
      expect(isLocalFileStartPending()).toBe(false);
      expect(getTrackPosition()).toBeCloseTo(30.01);
    },
  );

  it('keeps a real DEMO_PLAY zero anchor without inventing a queue resident', async () => {
    const { initDemoMode } = await import('../../demo/mode.ts');
    initDemoMode({ suppressFirstRunPrompt: true });
    const host = { open: true, peer: 'demo-host', send: vi.fn() } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    markQueueAuthorityReady(host);
    // loadDemoFile publishes the decoded buffer with files.current=null:
    // bundled demos are addressed by demo index, not queue occurrences.
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    setState('demo.active', true);
    setState('sync.localOffset', IS_WINDOWS ? -0.02 : 0);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      await handleData({ type: MSG.DEMO_PLAY, index: 0, time: 100, hostPlayAt: 0 }, host);
      await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledExactlyOnceWith(0, 100));
      expect(getState('files.current')).toBeNull();
      expect(getState('player.startedAt')).toBe(0);
      mocks.currentTime = 101;
      expect(getTrackPosition()).toBe(101);
      setLocalManualSyncOffset(getState('sync.localOffset') + 0.1);
      expect(getTrackPosition()).toBeCloseTo(101);
      pause(undefined, { showToast: false });
      mocks.currentTime = 102;
      expect(getTrackPosition()).toBeCloseTo(101);
      stopAllMedia({ cancelInFlight: true, clearBuffer: true });
      expect(getTrackPosition()).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps a real host PLAY timeline whose computed audio anchor is exactly zero', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const queueItemId = '11111111-1111-4111-8111-111111111111';
    const file = new File(['audio'], 'a.mp3', { type: 'audio/mpeg' });
    const host = { open: true, peer: 'host', send: vi.fn() } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.connectionType', 'local');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      { queueItemId, type: 'file', name: file.name, videoId: null, playlistId: null },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setState('files.current', {
      queueItemId,
      name: file.name,
      sessionId: 1,
      indexHint: 0,
      size: file.size,
      mime: file.type,
      blob: file,
    });
    setState('sync.localOffset', IS_WINDOWS ? -0.02 : 0);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    setPlaybackFilePlaying();
    initPlayback();
    markQueueAuthorityReady(host);
    // AudioContext time and room position are independent, legal numbers;
    // a normal host PLAY/seek can make now - offset exactly zero.
    await handleData({ type: MSG.PLAY, queueItemId, time: 100 }, host);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(0, 100);
    expect(getState('player.startedAt')).toBe(0);
    mocks.currentTime = 101;
    expect(getTrackPosition()).toBe(101);
    setLocalManualSyncOffset(getState('sync.localOffset') + 0.1);
    expect(getTrackPosition()).toBeCloseTo(101);
    pause(undefined, { showToast: false });
    mocks.currentTime = 102;
    expect(getTrackPosition()).toBeCloseTo(101);
    stopAllMedia({ cancelInFlight: true });
    expect(getTrackPosition()).toBe(0);
    await handleData({ type: MSG.PLAY, queueItemId, time: 50 }, host);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    mocks.currentTime = 103;
    expect(getTrackPosition()).toBeCloseTo(51);
  });

  it('observes an out-of-range offset without scheduling transport repair', async () => {
    setPlaybackFilePlaying();
    setState('player.startedAt', 90);
    setState('sync.localOffset', 40);

    expect(peekTrackPosition()).toBeGreaterThanOrEqual(50);
    await Promise.resolve();

    expect(getState('sync.localOffset')).toBe(40);
    expect(getState('player.startedAt')).toBe(90);
  });

  it('keeps canonical file time unchanged when only the local output is nudged', () => {
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    setPlaybackFilePlaying();
    setState('player.startedAt', 90);
    setState('sync.localOffset', 0.25);
    const canonicalBefore = getTrackPosition();

    setLocalManualSyncOffset(0.5);

    expect(getTrackPosition()).toBeCloseTo(canonicalBefore, 8);
  });
});
