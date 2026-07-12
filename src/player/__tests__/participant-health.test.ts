import { describe, expect, it } from 'vitest';

import {
  PARTICIPANT_HEALTH_STATES,
  ParticipantHealthMonitor,
  type ParticipantHealthDimension,
  type ParticipantHealthSignal,
} from '../participant-health.ts';

interface Clock {
  now: number;
}

function monitor(clock: Clock, participantId = 'peer-1'): ParticipantHealthMonitor {
  return new ParticipantHealthMonitor({
    participantId,
    now: () => clock.now,
    initialLeaseUntilMs: 10_000,
    degradationGraceMs: 1_000,
    reconnectGraceMs: 2_000,
    maxLeaseDurationMs: 20_000,
  });
}

function signal(
  dimension: ParticipantHealthDimension,
  value: ParticipantHealthSignal['value'],
  observedAtMs: number,
  leaseUntilMs = value === 'healthy' ? observedAtMs + 5_000 : observedAtMs,
): ParticipantHealthSignal {
  return { dimension, value, observedAtMs, leaseUntilMs };
}

describe('ParticipantHealthMonitor', () => {
  it('absorbs a transient interruption without a notice or rejoin action', () => {
    const clock = { now: 0 };
    const health = monitor(clock);

    clock.now = 100;
    const interrupted = health.report(signal('renderer', 'unhealthy', 100));
    expect(interrupted.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.DEGRADED);
    expect(interrupted.actions).toEqual([]);

    clock.now = 900;
    const recovered = health.report(signal('renderer', 'healthy', 900));
    expect(recovered.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
    expect(recovered.actions).toEqual([]);
    expect(recovered.snapshot.activeEpisode).toBeNull();
  });

  it('emits one sustained renderer notice and requests a participant-only rejoin', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 100;
    health.report(signal('renderer', 'unhealthy', 100));

    clock.now = 1_099;
    expect(health.tick().actions).toEqual([]);
    clock.now = 1_100;
    const sustained = health.tick();
    expect(sustained.actions.map((action) => action.type)).toEqual([
      'emit-degraded-system-message',
      'request-rejoin',
    ]);
    expect(sustained.actions[0]).toMatchObject({
      participantId: 'peer-1',
      episode: 1,
      unhealthyDimensions: ['renderer'],
    });
    expect(health.tick().actions).toEqual([]);

    expect(health.beginRejoin().snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.REJOINING);
    clock.now = 1_200;
    expect(health.report(signal('renderer', 'healthy', 1_200)).snapshot.state).toBe(
      PARTICIPANT_HEALTH_STATES.REJOINING,
    );
    const recovered = health.completeRejoin(true);
    expect(recovered.accepted).toBe(true);
    expect(recovered.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
    expect(recovered.snapshot.activeEpisode).toBeNull();
  });

  it('keeps a matured rejoin latched until the delayed action is completed', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 100;
    health.report(signal('renderer', 'unhealthy', 100));

    clock.now = 1_100;
    const matured = health.tick();
    expect(matured.actions.map((action) => action.type)).toContain('request-rejoin');
    expect(matured.snapshot.rejoinRequired).toBe(true);

    // The renderer can recover before the consumer handles the queued action.
    // It must not bypass clock recalibration, prime, and rendezvous completion.
    clock.now = 1_200;
    const locallyHealthy = health.report(signal('renderer', 'healthy', 1_200));
    expect(locallyHealthy.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.DEGRADED);
    expect(locallyHealthy.snapshot.rejoinRequired).toBe(true);

    expect(health.beginRejoin().snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.REJOINING);
    expect(health.completeRejoin(true).snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
  });

  it('never affects a healthy peer represented by a separate instance', () => {
    const clock = { now: 0 };
    const failing = monitor(clock, 'peer-1');
    const healthy = monitor(clock, 'peer-2');
    clock.now = 100;
    failing.report(signal('clock', 'unhealthy', 100));

    clock.now = 1_100;
    expect(failing.tick().actions.map((action) => action.type)).toContain('request-rejoin');
    expect(healthy.tick().snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
    expect(healthy.tick().actions).toEqual([]);
  });

  it('retains identity when transport reconnects within grace', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 100;
    const disconnected = health.report(signal('transport', 'unhealthy', 100));
    expect(disconnected.snapshot.identityRetained).toBe(true);
    expect(disconnected.snapshot.reconnectDeadlineMs).toBe(2_100);

    clock.now = 700;
    const reconnected = health.report(signal('transport', 'healthy', 700));
    expect(reconnected.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
    expect(reconnected.snapshot.identityRetained).toBe(true);
    expect(reconnected.actions).toEqual([]);
  });

  it('marks a disconnected participant offline when reconnect grace expires', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 100;
    health.report(signal('transport', 'unhealthy', 100));

    clock.now = 2_100;
    const expired = health.tick();
    expect(expired.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.OFFLINE);
    expect(expired.snapshot.identityRetained).toBe(false);
    expect(expired.actions).toEqual([
      expect.objectContaining({
        type: 'mark-offline',
        reason: 'reconnect-grace-expired',
      }),
    ]);

    clock.now = 2_101;
    expect(health.report(signal('transport', 'healthy', 2_101)).accepted).toBe(false);
    expect(health.getSnapshot().state).toBe(PARTICIPANT_HEALTH_STATES.OFFLINE);
  });

  it('marks an explicit leave offline immediately and idempotently', () => {
    const clock = { now: 100 };
    const health = monitor(clock);

    const left = health.explicitLeave();
    expect(left.accepted).toBe(true);
    expect(left.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.OFFLINE);
    expect(left.actions).toEqual([
      expect.objectContaining({ type: 'mark-offline', reason: 'explicit-leave' }),
    ]);

    expect(health.explicitLeave()).toMatchObject({ accepted: false, actions: [] });
  });

  it.each(['explicit-leave', 'session-ended'] as const)(
    'makes %s terminal without first maturing recovery side effects',
    (reason) => {
      const clock = { now: 0 };
      const health = monitor(clock);
      clock.now = 100;
      health.report(signal('renderer', 'unhealthy', 100));

      clock.now = 1_100;
      const terminal = health.markOffline(reason);
      expect(terminal.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.OFFLINE);
      expect(terminal.actions).toEqual([expect.objectContaining({ type: 'mark-offline', reason })]);
    },
  );

  it('does not treat document.hidden alone as a health failure', () => {
    const clock = { now: 100 };
    const health = monitor(clock);
    const hidden = health.setDocumentHidden(true);
    expect(hidden.snapshot.hidden).toBe(true);
    expect(hidden.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
    expect(hidden.snapshot.unhealthyDimensions).toEqual([]);
    expect(hidden.actions).toEqual([]);
  });

  it('deduplicates an episode until SYNCED, then permits one notice for a new episode', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 100;
    health.report(signal('renderer', 'unhealthy', 100));
    clock.now = 1_100;
    expect(health.tick().actions.filter((action) => action.type.includes('message'))).toHaveLength(
      1,
    );

    expect(health.beginRejoin().accepted).toBe(true);
    expect(health.completeRejoin(false).snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.DEGRADED);
    clock.now = 1_500;
    expect(health.tick().actions).toEqual([]);

    health.report(signal('renderer', 'healthy', 1_500));
    expect(health.getSnapshot().state).toBe(PARTICIPANT_HEALTH_STATES.DEGRADED);
    expect(health.getSnapshot().rejoinRequired).toBe(true);
    expect(health.beginRejoin().accepted).toBe(true);
    expect(health.completeRejoin(true).snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
    expect(health.getSnapshot().episode).toBe(1);

    clock.now = 2_000;
    health.report(signal('renderer', 'unhealthy', 2_000));
    clock.now = 3_000;
    const secondEpisode = health.tick();
    expect(secondEpisode.snapshot.episode).toBe(2);
    expect(
      secondEpisode.actions.filter((action) => action.type === 'emit-degraded-system-message'),
    ).toHaveLength(1);
  });

  it('makes stale signals inert', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 500;
    health.report(signal('clock', 'unhealthy', 500));

    clock.now = 600;
    const stale = health.report(signal('clock', 'healthy', 400));
    expect(stale.accepted).toBe(false);
    expect(stale.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.DEGRADED);
    expect(stale.snapshot.dimensions.clock.value).toBe('unhealthy');
    expect(stale.actions).toEqual([]);
  });

  it('fences an old first signal against the constructor health observation', () => {
    const clock = { now: 500 };
    const health = monitor(clock);

    clock.now = 600;
    const old = health.report(signal('renderer', 'unhealthy', 400));
    expect(old.accepted).toBe(false);
    expect(old.actions).toEqual([]);
    expect(old.snapshot.state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
    expect(old.snapshot.dimensions.renderer.value).toBe('healthy');
    expect(old.snapshot.dimensions.renderer.observedAtMs).toBe(500);
  });

  it('rejects a healthy lease that is already expired when received', () => {
    const clock = { now: 0 };
    const health = monitor(clock);

    clock.now = 500;
    expect(() => health.report(signal('clock', 'healthy', 100, 400))).toThrow(RangeError);
    expect(health.getSnapshot().dimensions.clock.observedAtMs).toBe(0);
  });

  it('can return matured actions with accepted false for a stale input', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 100;
    const interruption = signal('renderer', 'unhealthy', 100);
    health.report(interruption);

    clock.now = 1_100;
    const staleAtDeadline = health.report(interruption);
    expect(staleAtDeadline.accepted).toBe(false);
    expect(staleAtDeadline.actions.map((action) => action.type)).toEqual([
      'emit-degraded-system-message',
      'request-rejoin',
    ]);
  });

  it('rejects invalid leases and a reversing injected clock without mutation', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 100;
    expect(() =>
      health.report({
        dimension: 'clock',
        value: 'healthy',
        observedAtMs: 100,
        leaseUntilMs: 100,
      }),
    ).toThrow(RangeError);
    expect(health.getSnapshot().state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);

    clock.now = 99;
    expect(() => health.tick()).toThrow('now() moved backwards');
    expect(health.getSnapshot().state).toBe(PARTICIPANT_HEALTH_STATES.SYNCED);
  });

  it('returns deeply immutable snapshots, actions, and dimension arrays', () => {
    const clock = { now: 0 };
    const health = monitor(clock);
    clock.now = 100;
    health.report(signal('renderer', 'unhealthy', 100));
    clock.now = 1_100;
    const result = health.tick();

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.actions)).toBe(true);
    expect(Object.isFrozen(result.actions[0])).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.dimensions)).toBe(true);
    expect(Object.isFrozen(result.snapshot.dimensions.renderer)).toBe(true);
    expect(Object.isFrozen(result.snapshot.unhealthyDimensions)).toBe(true);
  });
});
