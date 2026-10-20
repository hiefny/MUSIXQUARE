import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProRoomDiagnostics,
  reportProRoomFrontDiagnostic,
  type ProRoomDiagnosticContext,
  type ProRoomDiagnosticDetail,
  type ProRoomDiagnosticEvent,
} from '../../../cloudflare/pro-room-diagnostics.ts';

const VERSION_ID = '440b001f-acde-4321-9876-abcdefabcdef';
const context: ProRoomDiagnosticContext = {
  scope: 'room',
  roomCode: '098765',
  roomGeneration: 3,
  versionId: VERSION_ID,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded PRO server diagnostics', () => {
  it('bounds maintenance outage details while retaining every failed gate in the summary', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => context);
    for (let i = 0; i < 500; i += 1) {
      diagnostics.record('maintenance_unavailable', { operation: 'maintenance_gate', status: 503 });
    }
    expect(log).toHaveBeenCalledTimes(5);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      kind: 'event',
      event: 'maintenance_unavailable',
      operation: 'maintenance_gate',
      reason: null,
      status: 503,
    });
    diagnostics.record('room_full', { status: 409 });
    expect(log).toHaveBeenCalledTimes(6);
    vi.setSystemTime(1_060_000);
    diagnostics.flushIfDue();
    expect(log.mock.calls[6]?.[0]).toMatchObject({
      kind: 'summary',
      counts: { maintenance_unavailable: 500, room_full: 1 },
      suppressedDetails: 495,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes resident, current, and affected presence and preserves aggregate affected totals', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => context);
    diagnostics.record('presence_expire', {
      livePresence: 5,
      residentPresence: 5,
      affectedCount: 30,
    });
    diagnostics.record('presence_expire', {
      livePresence: 2,
      residentPresence: 2,
      affectedCount: 3,
    });
    diagnostics.flush('sleep');
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      counts: { presence_expire: 2 },
      affectedCounts: { presence_expire: 33 },
      latest: { livePresence: 2, residentPresence: 2, affectedCount: 3 },
    });
  });

  it('records signaling capacity and authority lag without socket or participant identities', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => ({ ...context, scope: 'signaling' }));
    diagnostics.record('room_full', {
      reason: 'signaling_connections',
      socketCount: 100,
      authorityTargetCount: 2,
      authorityPresenceRevision: 2 ** 32,
      ticketPresenceRevision: 2 ** 32 + 1,
    });
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      scope: 'signaling',
      event: 'room_full',
      reason: 'signaling_connections',
      socketCount: 100,
      authorityTargetCount: 2,
      authorityPresenceRevision: 2 ** 32,
      ticketPresenceRevision: 2 ** 32 + 1,
    });
  });

  it('records actual rejection counts and release identity, ignoring credentials and extra fields', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => context);
    diagnostics.record('room_full', {
      operation: 'sessions',
      reason: 'non_owner_presence',
      livePresence: 99,
      nonOwnerPresence: 99,
      storedSessions: 128,
      maxPeerOrdinal: 99,
      sessionReceipts: 240,
      status: 409,
      pin: 'private-pin',
      participantId: 'private-participant',
      error: new Error('private-message'),
      url: 'https://private.example/?token=secret',
    } as ProRoomDiagnosticDetail);

    expect(log).toHaveBeenCalledExactlyOnceWith({
      diagnostic: 'pro_room',
      schema: 1,
      kind: 'event',
      ...context,
      observedAtMs: 1_000_000,
      event: 'room_full',
      reason: 'non_owner_presence',
      operation: 'sessions',
      livePresence: 99,
      nonOwnerPresence: 99,
      storedSessions: 128,
      maxPeerOrdinal: 99,
      sessionReceipts: 240,
      status: 409,
      retryAfterSeconds: null,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|participantId|url|pin/);
  });

  it('coalesces successful lifecycle events and records window peak without heartbeat output or timers', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => context);
    diagnostics.record('presence_join', { livePresence: 1, storedSessions: 1 });
    diagnostics.record('presence_join', { livePresence: 2, storedSessions: 2 });
    diagnostics.record('presence_reenter', { livePresence: 3 });
    diagnostics.record('presence_takeover', { livePresence: 3 });
    diagnostics.record('presence_expire', { livePresence: 2 });
    diagnostics.record('presence_close', { livePresence: 1 });
    diagnostics.record('presence_leave', { livePresence: 0 });
    for (let i = 0; i < 100; i += 1) diagnostics.flushIfDue();
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(log).not.toHaveBeenCalled();
    diagnostics.flushIfDue();
    expect(log).toHaveBeenCalledExactlyOnceWith({
      diagnostic: 'pro_room',
      schema: 1,
      kind: 'summary',
      ...context,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      trigger: 'interval',
      counts: {
        presence_join: 2,
        presence_reenter: 1,
        presence_takeover: 1,
        presence_expire: 1,
        presence_close: 1,
        presence_leave: 1,
      },
      suppressedDetails: 0,
      peakPresence: 3,
      latest: { livePresence: 0, storedSessions: 2 },
    });
    diagnostics.flushIfDue();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('keeps the first later failure reason even after PIN spam exhausts repeated detail allowance', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => context);
    for (let i = 0; i < 500; i += 1) {
      diagnostics.record('rate_limited', { reason: 'pin', retryAfterSeconds: 3600 });
    }
    diagnostics.record('rate_limited', { reason: 'admission', retryAfterSeconds: 600 });
    diagnostics.record('room_full', { reason: 'non_owner_presence', livePresence: 99 });
    diagnostics.record('state_capacity', { reason: 'session_receipt', sessionReceipts: 240 });
    expect(log).toHaveBeenCalledTimes(8);
    expect(log.mock.calls.slice(-3).map(([record]) => [record.event, record.reason])).toEqual([
      ['rate_limited', 'admission'],
      ['room_full', 'non_owner_presence'],
      ['state_capacity', 'session_receipt'],
    ]);

    vi.advanceTimersByTime(60_000);
    diagnostics.flushIfDue();
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({
      counts: {
        'rate_limited:pin': 500,
        'rate_limited:admission': 1,
        'room_full:non_owner_presence': 1,
        'state_capacity:session_receipt': 1,
      },
      suppressedDetails: 495,
      peakPresence: 99,
    });
    diagnostics.record('rate_limited', { reason: 'pin' });
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'event', reason: 'pin' });
  });

  it('cannot reset the failure budget through repeated sleep/close flushes', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => context);
    for (let i = 0; i < 100; i += 1) {
      diagnostics.record('rate_limited', { reason: 'pin' });
      diagnostics.flush(i % 2 === 0 ? 'sleep' : 'close');
    }
    expect(log.mock.calls.filter(([record]) => record.kind === 'event')).toHaveLength(5);
    expect(log.mock.calls.filter(([record]) => record.kind === 'summary')).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    diagnostics.flushIfDue();
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({
      counts: { 'rate_limited:pin': 99 },
      suppressedDetails: 95,
    });
  });

  it('drops unknown strings, mismatched reasons, object getters and non-numeric measurements', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const valueOf = vi.fn(() => 99);
    const diagnostics = new ProRoomDiagnostics(() => ({
      scope: 'room',
      roomCode: '098765?private-token',
      roomGeneration: '3',
      versionId: `${VERSION_ID}?private-token`,
    }));
    diagnostics.record('room_full', {
      operation: 'private-operation',
      reason: 'pin',
      livePresence: { valueOf },
      nonOwnerPresence: '99',
      storedSessions: NaN,
      maxPeerOrdinal: -1,
      sessionReceipts: Infinity,
      status: 99,
      retryAfterSeconds: 86_401,
    } as unknown as ProRoomDiagnosticDetail);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      roomCode: null,
      roomGeneration: null,
      versionId: null,
      reason: null,
      operation: null,
      livePresence: null,
      nonOwnerPresence: null,
      storedSessions: null,
      maxPeerOrdinal: null,
      sessionReceipts: null,
      status: null,
      retryAfterSeconds: null,
    });
    expect(valueOf).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    diagnostics.flush('close');
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({
      counts: { room_full: 1 },
      peakPresence: null,
    });
  });

  it.each(['__proto__', 'constructor', 'private-event', '', null, undefined])(
    'ignores invalid event %s without allocating a counter or emitting a summary',
    (event) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const diagnostics = new ProRoomDiagnostics(() => context);
      diagnostics.record(event as ProRoomDiagnosticEvent);
      diagnostics.flush('sleep');
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('does not retain arbitrary reasons as counter keys or grow first-failure slots', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => context);
    for (let i = 0; i < 1000; i += 1) {
      diagnostics.record('rate_limited', {
        reason: `private-${i}`,
      } as unknown as ProRoomDiagnosticDetail);
    }
    diagnostics.flush('sleep');
    expect(log).toHaveBeenCalledTimes(6);
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({
      counts: { rate_limited: 1000 },
      suppressedDetails: 995,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  });

  it('never throws when the sink, provider, or hostile property getter fails', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('private-logger-failure');
    });
    const diagnostics = new ProRoomDiagnostics(() => context);
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('private-getter');
        },
      },
    );
    expect(() => diagnostics.record('room_full', hostile)).not.toThrow();
    expect(() => diagnostics.flush('close')).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);

    const missingContext = new ProRoomDiagnostics(() => {
      throw new Error('private-provider');
    });
    expect(() => missingContext.record('room_full')).not.toThrow();
    expect(() => missingContext.flush('sleep')).not.toThrow();
    expect(() =>
      reportProRoomFrontDiagnostic(hostile as ProRoomDiagnosticContext, 'upstream_failure'),
    ).not.toThrow();
  });

  it('starts a new summary without carrying over the preceding window peak or counts', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = new ProRoomDiagnostics(() => context);
    diagnostics.record('presence_join', { livePresence: 99 });
    vi.advanceTimersByTime(60_000);
    diagnostics.record('presence_expire', { livePresence: 1 });
    vi.advanceTimersByTime(60_000);
    diagnostics.flushIfDue();
    expect(
      log.mock.calls.map(([record]) => ({ peak: record.peakPresence, counts: record.counts })),
    ).toEqual([
      { peak: 99, counts: { presence_join: 1 } },
      { peak: 1, counts: { presence_expire: 1 } },
    ]);
  });

  it('keeps facade failure detail room context but aggregates without room attribution', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportProRoomFrontDiagnostic({ ...context, scope: 'app' }, 'upstream_timeout', {
      operation: 'heartbeat',
      reason: 'response',
      status: 502,
    });
    reportProRoomFrontDiagnostic(
      { ...context, roomCode: '098766', scope: 'app' },
      'upstream_failure',
      {
        operation: 'sessions',
        reason: 'fetch',
      },
    );
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      scope: 'app',
      roomCode: '098765',
      roomGeneration: 3,
    });
    expect(log.mock.calls[1]?.[0]).toMatchObject({ scope: 'app', roomCode: '098766' });
    vi.advanceTimersByTime(60_000);
    reportProRoomFrontDiagnostic({ ...context, scope: 'app' }, 'upstream_timeout', {
      reason: 'body',
    });
    expect(log.mock.calls[2]?.[0]).toMatchObject({
      kind: 'summary',
      scope: 'app',
      roomCode: null,
      roomGeneration: null,
      versionId: VERSION_ID,
      counts: { 'upstream_timeout:response': 1, 'upstream_failure:fetch': 1 },
    });
  });

  it('does not log facade successes or accept a room scope in the isolate reporter', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportProRoomFrontDiagnostic({ ...context, scope: 'front' }, 'presence_join');
    reportProRoomFrontDiagnostic(context, 'upstream_failure');
    expect(log).not.toHaveBeenCalled();
  });
});
