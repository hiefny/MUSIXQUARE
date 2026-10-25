import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../core/log.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { LinkLiveness } from '../link-liveness.ts';

/**
 * The side (isolated control) PC's outage as its owner keeps it (registry
 * RO-15, Phase 4 C5-9), on its own: what the owner calls on the side route
 * and logs, in order, against a stand-in route, the original route's
 * readings, and the monotonic clock. The two ends' protocol over a real
 * connection pair is side-route-outage-integration.test.ts.
 */
const GRACE_MS = 15_000;
const CAP_MS = 30_000;
const RECOVERED = '[Transport] Isolated control ICE recovered';
const DID_NOT_RECOVER =
  '[Transport] Isolated control ICE did not recover; closing its logical connection';

let sequence = 0;
const owners: LinkLiveness[] = [];

function owner() {
  const trace: unknown[] = [];
  const original = { connectionState: 'connected' as RTCPeerConnectionState };
  const link = {
    open: true,
    controlOpen: true as boolean | undefined,
    original: original as unknown as RTCPeerConnection | undefined,
  };
  const sidePc = { connectionState: 'new' as RTCPeerConnectionState };
  const route = {
    peerConnection: sidePc as unknown as RTCPeerConnection | undefined,
    outageStarted: () => trace.push('started'),
    outageEnded: () => trace.push('ended'),
    outageExpired: (restartable: boolean) => trace.push(['expired', restartable]),
  };
  const liveness: LinkLiveness = new LinkLiveness(`side-outage-unit-${++sequence}`, {
    route: () => link.original,
    open: () => link.open,
    snapshot: () => ({
      original: link.original,
      side: route.peerConnection,
      channelsOpen: true,
      sideChannelDown: false,
      controlOpen: link.controlOpen,
    }),
    ping: () => undefined,
    close: (cause) => {
      trace.push(['close', cause]);
      liveness.stop();
    },
    changed: () => undefined,
    sideMayRestart: () => trace.push('may-restart'),
    recovered: () => undefined,
  });
  owners.push(liveness);
  // The side lines join this trace, in order; the latest owner records them.
  for (const level of ['info', 'warn'] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      trace.push([level, ...args]);
    });
  }
  return {
    liveness,
    trace,
    link,
    route,
    /** The side PC reads `state` and control isolation reports it. */
    side(state: RTCPeerConnectionState, restartable = true): void {
      sidePc.connectionState = state;
      liveness.sideChanged(route, state, restartable);
    },
    /** The side PC reads `state` without an event. */
    sideReads(state: RTCPeerConnectionState): void {
      sidePc.connectionState = state;
    },
    /** The original PC reads `state` and reports the transition. */
    original(state: RTCPeerConnectionState): void {
      original.connectionState = state;
      liveness.routeChanged(original as unknown as RTCPeerConnection);
    },
    /** The original PC reads `state` without an event. */
    originalReads(state: RTCPeerConnectionState): void {
      original.connectionState = state;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const liveness of owners.splice(0)) liveness.stop();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a side outage of a route that restarts its ICE', () => {
  it('starts once per outage, ends on connected with the recovered line, and logs nothing for a connected without one', () => {
    const o = owner();
    o.side('connected');
    o.side('failed');
    o.side('disconnected');
    o.side('connecting');
    expect(o.trace).toEqual(['started']);
    o.side('connected');
    o.side('connected');
    expect(o.trace).toEqual(['started', 'ended', ['info', RECOVERED]]);
    expect(o.liveness.sideGraceRunning).toBe(false);
  });

  it('ends the link at 15 s after the warning, and ends an outage whose PC reads connected then quietly', async () => {
    const o = owner();
    o.side('failed');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(o.trace).toEqual(['started']);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.trace).toEqual(['started', ['warn', DID_NOT_RECOVER], ['expired', true]]);

    const quiet = owner();
    quiet.side('disconnected');
    quiet.sideReads('connected');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(quiet.trace).toEqual(['started', 'ended']);
    // The outage is over: the next one starts afresh.
    quiet.side('failed');
    expect(quiet.trace).toEqual(['started', 'ended', 'started']);
  });

  it('waits while the original control channel is not open although its PC reads connected, and re-arms 15 s after it recovers', async () => {
    const o = owner();
    o.link.controlOpen = false;
    o.side('failed');
    await vi.advanceTimersByTimeAsync(10_000);
    // The side route may not restart while it waits.
    o.original('connected');
    expect(o.liveness.sideMaySignal()).toBe(false);
    expect(o.trace).toEqual(['started']);
    o.link.controlOpen = true;
    o.original('connected');
    expect(o.trace).toEqual(['started', 'may-restart']);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(o.trace).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.trace.slice(2)).toEqual([
      ['warn', DID_NOT_RECOVER],
      ['expired', true],
    ]);
  });

  it('defers its deadline to the 30 s cap while the original stays down, then ends the link', async () => {
    const o = owner();
    o.originalReads('connecting');
    o.side('failed');
    await vi.advanceTimersByTimeAsync(CAP_MS - 1);
    expect(o.trace).toEqual(['started']);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.trace).toEqual(['started', ['warn', DID_NOT_RECOVER], ['expired', true]]);
  });

  it('keeps the re-armed deadline within 30 s of the outage start', async () => {
    const o = owner();
    o.link.controlOpen = false;
    o.side('failed');
    await vi.advanceTimersByTimeAsync(20_000);
    o.link.controlOpen = true;
    o.original('connected');
    await vi.advanceTimersByTimeAsync(CAP_MS - 20_000 - 1);
    expect(o.trace).toEqual(['started', 'may-restart']);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.trace.slice(2)).toEqual([
      ['warn', DID_NOT_RECOVER],
      ['expired', true],
    ]);
  });

  it('leaves a deadline alone when the original recovers without having been down', async () => {
    const o = owner();
    o.side('failed');
    await vi.advanceTimersByTimeAsync(10_000);
    o.original('connected');
    expect(o.trace).toEqual(['started', 'may-restart']);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 10_000);
    expect(o.trace.slice(2)).toEqual([
      ['warn', DID_NOT_RECOVER],
      ['expired', true],
    ]);
  });

  it('notes an original route that dropped without an event when the side route asks to signal', async () => {
    const o = owner();
    o.side('failed');
    expect(o.liveness.sideMaySignal()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    o.originalReads('connecting');
    expect(o.liveness.sideMaySignal()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    o.original('connected');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(o.trace).toEqual(['started', 'may-restart']);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.trace.slice(2)).toEqual([
      ['warn', DID_NOT_RECOVER],
      ['expired', true],
    ]);
  });

  it('notes an original route that was already down, without an event, when the outage starts', async () => {
    const o = owner();
    o.originalReads('connecting');
    o.side('disconnected');
    await vi.advanceTimersByTimeAsync(8_000);
    o.original('connected');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(o.trace).toEqual(['started', 'may-restart']);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.trace.slice(2)).toEqual([
      ['warn', DID_NOT_RECOVER],
      ['expired', true],
    ]);
  });

  it('reads the original route as down when the link is not open, is stopped or has no PC', () => {
    const o = owner();
    o.link.open = false;
    expect(o.liveness.sideMaySignal()).toBe(false);
    o.link.open = true;
    o.link.original = undefined;
    expect(o.liveness.sideMaySignal()).toBe(false);
    o.link.original = { connectionState: 'connected' } as unknown as RTCPeerConnection;
    o.link.controlOpen = undefined;
    expect(o.liveness.sideMaySignal()).toBe(false);
    o.link.controlOpen = true;
    expect(o.liveness.sideMaySignal()).toBe(true);
    o.liveness.stop();
    expect(o.liveness.sideMaySignal()).toBe(false);
  });

  it('keeps an outage whose side PC is gone at its deadline without a callback', async () => {
    const o = owner();
    o.side('failed');
    o.route.peerConnection = undefined;
    await vi.advanceTimersByTimeAsync(CAP_MS);
    expect(o.trace).toEqual(['started']);
    o.liveness.sideClosed();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the grace of a side route that cannot restart', () => {
  it('is one non-renewing 15 s grace, never deferred by the original route, that fails the setup without a warning', async () => {
    const o = owner();
    o.side('connecting', false);
    expect(o.liveness.sideGraceRunning).toBe(false);
    o.side('disconnected', false);
    expect(o.liveness.sideGraceRunning).toBe(true);
    o.link.controlOpen = false;
    o.original('connected');
    await vi.advanceTimersByTimeAsync(10_000);
    o.side('disconnected', false);
    o.side('connecting', false);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 10_000 - 1);
    expect(o.trace).toEqual(['may-restart']);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.trace).toEqual(['may-restart', ['expired', false]]);
    expect(o.liveness.sideGraceRunning).toBe(false);
  });

  it('is cleared by connected, and at its end does nothing for a PC that reads connected or is gone', async () => {
    const o = owner();
    o.side('disconnected', false);
    o.side('connected', false);
    expect(o.liveness.sideGraceRunning).toBe(false);
    o.side('connected', false);
    await vi.advanceTimersByTimeAsync(60_000);
    o.side('disconnected', false);
    o.sideReads('connected');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    o.side('disconnected', false);
    o.route.peerConnection = undefined;
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(o.trace).toEqual([]);
    expect(o.liveness.sideGraceRunning).toBe(false);
  });

  it('becomes a restart outage that starts when the route can restart (READY)', async () => {
    const o = owner();
    o.side('disconnected', false);
    await vi.advanceTimersByTimeAsync(5_000);
    o.side('disconnected', true);
    expect(o.liveness.sideGraceRunning).toBe(false);
    expect(o.trace).toEqual(['started']);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(o.trace).toEqual(['started']);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.trace).toEqual(['started', ['warn', DID_NOT_RECOVER], ['expired', true]]);

    // A route that reads connected at READY just drops its grace.
    const healed = owner();
    healed.side('disconnected', false);
    healed.side('connected', true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(healed.trace).toEqual([]);
  });
});

describe('the side deadline and the end of the side PC or the link', () => {
  it('clears on the side PC going, and stop clears it and admits nothing after', async () => {
    const gone = owner();
    gone.side('failed');
    gone.liveness.sideClosed();
    gone.liveness.sideClosed();
    expect(vi.getTimerCount()).toBe(0);

    const stopped = owner();
    stopped.side('disconnected', false);
    stopped.liveness.stop();
    expect(vi.getTimerCount()).toBe(0);
    stopped.side('failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gone.trace).toEqual(['started']);
    expect(stopped.trace).toEqual([]);
  });

  it('ends with the link when the original grace closes it', async () => {
    const o = owner();
    o.side('failed');
    o.original('disconnected');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(o.trace).toEqual(['started', ['close', 'original-grace-expired']]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(o.trace).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
