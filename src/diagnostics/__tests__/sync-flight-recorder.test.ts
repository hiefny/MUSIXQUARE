/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';

const mocks = vi.hoisted(() => ({
  audioReady: false,
  getAudioContext: vi.fn(),
  peekTrackPosition: vi.fn(() => 0),
  getCurrentAudioBuffer: vi.fn(() => null),
  getPlayerNode: vi.fn(() => null),
  hostNow: 0,
  proNow: 0,
}));

vi.mock('../../audio/engine.ts', () => ({
  isAudioReady: () => mocks.audioReady,
  getAudioContext: mocks.getAudioContext,
}));
vi.mock('../../player/transport.ts', () => ({
  peekTrackPosition: mocks.peekTrackPosition,
}));
vi.mock('../../player/_state.ts', () => ({
  getCurrentAudioBuffer: mocks.getCurrentAudioBuffer,
  getPlayerNode: mocks.getPlayerNode,
}));
vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: () => mocks.hostNow,
  getSharedClockDiagnostics: () => ({
    isHostClock: false,
    calibrated: true,
    sampleCount: 4,
    pendingPingCount: 0,
    pongsReceived: 4,
    bestOffsetMs: 2,
    bestRttMs: 8,
    newestSampleAgeMs: 10,
  }),
}));
vi.mock('../../pro-room/network-bridge.ts', () => ({
  getProRoomServerNow: () => mocks.proNow,
  getProRoomServerClockDiagnostics: () => ({
    connected: false,
    calibrated: false,
    bestOffsetMs: 0,
    bestRttMs: null,
    readyCalibrationAgeMs: null,
  }),
}));

import {
  captureSyncFlightRecorderSampleForTests,
  collectSyncFlightRecorderText,
  initSyncFlightRecorder,
  markSyncFlightRecorderIncident,
  resetSyncFlightRecorderForTests,
} from '../sync-flight-recorder.ts';

const RAW_QUEUE_ID = '00000000-0000-4000-8000-0000000000aa';

function startStandardGuest(): void {
  setState('setup.sessionStarted', true);
  setState('network.appRole', 'guest');
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'member',
    coordinatorId: null,
    epoch: 1,
    snapshotRevision: 1,
    capabilities: [],
  });
  setState('playlist.currentQueueItemId', RAW_QUEUE_ID);
  setState('playback.mode', 'file');
  setState('playback.activity', 'playing');
}

function sampleCount(report: string): number {
  return Number(/samples:(\d+)/.exec(report)?.[1] ?? -1);
}

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  resetSyncFlightRecorderForTests();
  bus.clear();
  resetState();
  mocks.audioReady = false;
  mocks.getAudioContext.mockReset();
  mocks.peekTrackPosition.mockReset();
  mocks.peekTrackPosition.mockReturnValue(0);
  mocks.getCurrentAudioBuffer.mockReset();
  mocks.getCurrentAudioBuffer.mockReturnValue(null);
  mocks.getPlayerNode.mockReset();
  mocks.getPlayerNode.mockReturnValue(null);
  mocks.hostNow = 0;
  mocks.proNow = 0;
});

afterEach(() => {
  resetSyncFlightRecorderForTests();
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('sync flight recorder', () => {
  it('aliases raw queue identity and reports canonical logical drift', () => {
    startStandardGuest();
    initSyncFlightRecorder();
    mocks.hostNow = 6_000;
    mocks.peekTrackPosition.mockReturnValue(4.9);
    bus.emit('sync:diagnostic-standard-pong', {
      trackKey: RAW_QUEUE_ID,
      trackMatches: true,
      playing: true,
      hostTimeMs: 5_000,
      positionSeconds: 4,
      rttMs: 8,
      offsetMs: 2,
    });

    captureSyncFlightRecorderSampleForTests();
    const report = collectSyncFlightRecorderText();
    const last = JSON.parse(report.trim().split('\n').at(-1) ?? '{}');

    expect(report).not.toContain(RAW_QUEUE_ID);
    expect(last.track).toBe('q1');
    expect(last.canonicalPositionSeconds).toBe(5);
    expect(last.localPositionSeconds).toBe(4.9);
    expect(last.logicalDriftMs).toBe(100);
  });

  it('records a PRO canonical checkpoint against server time', () => {
    setState('setup.sessionStarted', true);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 2,
      snapshotRevision: 3,
      capabilities: [],
    });
    setState('playlist.currentQueueItemId', RAW_QUEUE_ID);
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initSyncFlightRecorder();
    mocks.proNow = 12_500;
    mocks.peekTrackPosition.mockReturnValue(12.2);
    bus.emit('sync:diagnostic-pro-checkpoint', {
      trackKey: RAW_QUEUE_ID,
      state: 'playing',
      positionSeconds: 10,
      updatedAtMs: 10_000,
      revision: 7,
    });

    captureSyncFlightRecorderSampleForTests();
    const last = JSON.parse(collectSyncFlightRecorderText().trim().split('\n').at(-1) ?? '{}');

    expect(last.room).toBe('pro');
    expect(last.canonicalPositionSeconds).toBe(12.5);
    expect(last.logicalDriftMs).toBe(300);
  });

  it('starts, stops, and restarts the managed sampler with session state', async () => {
    vi.useFakeTimers();
    initSyncFlightRecorder();
    expect(sampleCount(collectSyncFlightRecorderText())).toBe(0);

    startStandardGuest();
    await vi.advanceTimersByTimeAsync(2_100);
    const during = sampleCount(collectSyncFlightRecorderText());
    expect(during).toBe(3);

    setState('setup.sessionStarted', false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sampleCount(collectSyncFlightRecorderText())).toBe(during);

    setState('setup.sessionStarted', true);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sampleCount(collectSyncFlightRecorderText())).toBe(during + 2);
  });

  it('does not carry a canonical anchor across a session boundary', () => {
    startStandardGuest();
    initSyncFlightRecorder();
    mocks.hostNow = 6_000;
    mocks.peekTrackPosition.mockReturnValue(4.9);
    bus.emit('sync:diagnostic-standard-pong', {
      trackKey: RAW_QUEUE_ID,
      trackMatches: true,
      playing: true,
      hostTimeMs: 5_000,
      positionSeconds: 4,
      rttMs: 8,
      offsetMs: 2,
    });
    captureSyncFlightRecorderSampleForTests();

    setState('setup.sessionStarted', false);
    setState('setup.sessionStarted', true);
    mocks.hostNow = 60_000;
    captureSyncFlightRecorderSampleForTests();

    const last = JSON.parse(collectSyncFlightRecorderText().trim().split('\n').at(-1) ?? '{}');
    expect(last.canonicalPositionSeconds).toBeNull();
    expect(last.logicalDriftMs).toBeNull();
  });

  it('keeps the sample ring bounded and never creates AudioContext while observing', () => {
    startStandardGuest();
    for (let index = 0; index < 1_250; index += 1) {
      captureSyncFlightRecorderSampleForTests();
    }
    markSyncFlightRecorderIncident();

    expect(sampleCount(collectSyncFlightRecorderText())).toBe(1_200);
    expect(mocks.getAudioContext).not.toHaveBeenCalled();
  });
});
