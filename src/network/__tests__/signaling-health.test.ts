import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState, getState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  canRecoverSignalingInPlace,
  publishSignalingExhausted,
  publishSignalingReconnectAttempt,
  publishSignalingRecovered,
  resetSignalingHealth,
  __signalingHealthForTests,
} from '../signaling-health.ts';

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  resetState();
  bus.clear();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

function beginStandardHostSessionWithLivePeer(): void {
  setState('setup.sessionStarted', true);
  setState('network.appRole', 'host');
  setState('network.connectedPeers', [
    {
      id: 'peer-1',
      slot: 1,
      label: 'Peer',
      joinOrder: 1,
      status: 'connected',
      isOp: false,
      preloadedQueueItemIds: new Set(),
      isDataTarget: true,
      connectionType: 'local',
      lastHeartbeat: Date.now(),
      conn: { open: true } as DataConnection,
    },
  ]);
}

describe('signaling health state', () => {
  it('does not publish a partial-outage state for a fully lost ordinary session', () => {
    setState('setup.sessionStarted', true);
    setState('network.appRole', 'guest');
    setState('network.hostConn', null);

    expect(publishSignalingReconnectAttempt(1)).toBe(false);
    expect(getState('network.signalingHealth')).toEqual({
      status: 'healthy',
      attempt: 0,
      maxAttempts: 5,
    });
  });

  it('keeps an idle host room recoverable before its first participant joins', () => {
    setState('setup.sessionStarted', true);
    setState('network.appRole', 'host');
    setState('network.sessionCode', '123456');

    expect(canRecoverSignalingInPlace()).toBe(true);
    expect(publishSignalingReconnectAttempt(1)).toBe(true);
    expect(getState('network.signalingHealth')).toMatchObject({
      status: 'reconnecting',
      attempt: 1,
    });
  });

  it('publishes attempts and exhaustion while an existing data channel remains', () => {
    beginStandardHostSessionWithLivePeer();

    expect(publishSignalingReconnectAttempt(2)).toBe(true);
    expect(getState('network.signalingHealth')).toEqual({
      status: 'reconnecting',
      attempt: 2,
      maxAttempts: 5,
    });

    expect(publishSignalingExhausted()).toBe(true);
    expect(getState('network.signalingHealth')).toEqual({
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });
  });

  it('briefly publishes recovery and then clears to healthy', () => {
    beginStandardHostSessionWithLivePeer();
    publishSignalingReconnectAttempt(1);

    publishSignalingRecovered();
    expect(getState('network.signalingHealth').status).toBe('recovered');

    vi.advanceTimersByTime(__signalingHealthForTests.SIGNALING_RECOVERED_VISIBLE_MS - 1);
    expect(getState('network.signalingHealth').status).toBe('recovered');
    vi.advanceTimersByTime(1);
    expect(getState('network.signalingHealth').status).toBe('healthy');
  });

  it('keeps a media-only ordinary session and an accepted PRO room eligible', () => {
    setState('setup.sessionStarted', true);
    setState('network.appRole', 'guest');
    setState('playback.activity', 'playing');
    expect(canRecoverSignalingInPlace()).toBe(true);

    resetSignalingHealth();
    setState('playback.activity', 'idle');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    expect(canRecoverSignalingInPlace()).toBe(true);
  });
});
