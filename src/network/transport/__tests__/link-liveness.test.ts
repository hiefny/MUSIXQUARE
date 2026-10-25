/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../core/log.ts';
import { clearAllManagedTimers, clearManagedTimer, getManagedTimer } from '../../../core/timers.ts';
import { CloudflareDataConnection } from '../cloudflare-signaling.ts';
import { LinkLiveness } from '../link-liveness.ts';

/**
 * The original route's outage owner (registry RO-15, Phase 4 C5-6): the 15 s
 * grace, the published wall-clock recovery deadline and the one-restart gate
 * of one Standard-room logical data connection. These cases pin, through the
 * public connection surface, what the move must keep: the order of every
 * transition's effects (also when the state callback re-enters the gate or
 * closes the connection), the pre-open grace, the non-renewing deadline
 * across restarts, and the host-side connection that has no state callback.
 */
const GRACE_MS = 15_000;
const RESUME_LIVENESS_TIMEOUT_MS = 3_000;

class Channel extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  sent: Array<string | ArrayBuffer> = [];
  constructor(
    readonly label: string,
    public readyState: RTCDataChannelState = 'open',
  ) {
    super();
  }
  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('native-send-failed');
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class PeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'connected';
  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  state(value: RTCPeerConnectionState): void {
    this.connectionState = value;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const connections: CloudflareDataConnection[] = [];

async function flush(): Promise<void> {
  for (let index = 0; index < 24; index++) await Promise.resolve();
}

type Trace = unknown[];

/**
 * One logical connection. `bound` models a restart-capable negotiation,
 * `opened: false` keeps both channels connecting, and `onStateChange` is the
 * state callback a guest connection gets (a host connection gets none).
 */
async function connection(
  options: {
    bound?: boolean;
    opened?: boolean;
    onStateChange?: (conn: CloudflareDataConnection, trace: Trace) => void;
  } = {},
) {
  const trace: Trace = [];
  let conn!: CloudflareDataConnection;
  const callback = options.onStateChange;
  conn = new CloudflareDataConnection(
    `peer-${connections.length}`,
    undefined,
    null,
    callback ? () => callback(conn, trace) : undefined,
    undefined,
    // A control-isolated connection, so the side route's notification can be
    // observed; its side PC is never created before bulk flow control starts.
    () => null,
  );
  connections.push(conn);
  if (options.bound) conn.iceRestartBinding = 'negotiation_liveness_01';
  const channelState: RTCDataChannelState = options.opened === false ? 'connecting' : 'open';
  const pc = new PeerConnection();
  const bulk = new Channel('musixquare-data', channelState);
  const control = new Channel('musixquare-control', channelState);
  conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  await flush();
  vi.spyOn(conn.controlIsolation!, 'originalChanged').mockImplementation(() => {
    trace.push('side');
  });
  conn.on('ice-recovered', () => trace.push('ice-recovered'));
  conn.on('close', () => trace.push('close'));
  return { conn, pc, bulk, control, trace };
}

let closeLines: () => string[];

/** Silences info logging and reads back only the close-cause lines. */
function spyCloseCauseLines(): () => string[] {
  const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
  return () =>
    info.mock.calls
      .map(([line]) => line)
      .filter(
        (line): line is string =>
          typeof line === 'string' && line.startsWith('[Transport] Logical connection closed'),
      );
}

beforeEach(() => {
  vi.useFakeTimers();
  closeLines = spyCloseCauseLines();
});
afterEach(() => {
  for (const conn of connections.splice(0)) conn.close();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('original-route transitions with a re-entrant state callback', () => {
  it('on connected: grace cleared, gate reopened and probe settled before the callback, then side route, then ice-recovered', async () => {
    let recording = false;
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        if (!recording) return;
        // Read the deadline first: beginIceRestart arms a fresh grace.
        trace.push([
          'callback',
          conn.iceRecoveryDeadline,
          conn.reconcileBackgroundResumeRecovery(false),
          conn.beginIceRestart(),
        ]);
      },
    });
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    e.pc.state('disconnected');
    expect(e.conn.beginIceRestart()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    e.trace.length = 0;
    recording = true;
    const recoveredAt = Date.now();
    e.pc.state('connected');
    expect(e.trace).toEqual([['callback', 0, 'not-applicable', true], 'side', 'ice-recovered']);
    // The restart begun inside the callback armed one grace on the still-connected route.
    expect(e.conn.iceRecoveryDeadline).toBe(recoveredAt + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
  });

  it('on connected: a callback that closes the connection still notifies the side route but emits no recovery', async () => {
    let recording = false;
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        if (!recording) return;
        trace.push('callback');
        conn.close();
      },
    });
    e.pc.state('disconnected');
    e.trace.length = 0;
    recording = true;
    e.pc.state('connected');
    expect(e.trace).toEqual(['callback', 'close', 'side']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (intentional) for peer-0',
    ]);
  });

  it('on disconnected: a restart begun in the callback publishes the deadline before the side route hears it', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        trace.push([
          'callback',
          conn.iceRecoveryDeadline,
          conn.beginIceRestart(),
          conn.iceRecoveryDeadline,
        ]);
      },
    });
    const start = Date.now();
    e.pc.state('disconnected');
    expect(e.trace).toEqual([['callback', 0, true, start + GRACE_MS], 'side']);
    // The listener's own grace does not re-arm or extend the restart's.
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace.at(-1)).toBe('close');
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-grace-expired) for peer-0',
    ]);
  });

  it('on disconnected: a callback that closes the connection arms no grace and skips the side route', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        trace.push('callback');
        conn.close();
      },
    });
    e.pc.state('disconnected');
    expect(e.trace).toEqual(['callback', 'close']);
    expect(e.conn.iceRecoveryDeadline).toBe(0);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.trace).toEqual(['callback', 'close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (intentional) for peer-0',
    ]);
  });

  it('on a restartable failed: the grace is armed before the callback, whose restart keeps that deadline', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        trace.push(['callback', conn.iceRecoveryDeadline, conn.beginIceRestart()]);
      },
    });
    const start = Date.now();
    e.pc.state('failed');
    expect(e.trace).toEqual([['callback', start + GRACE_MS, true], 'side']);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    expect(e.conn.open).toBe(true);
  });

  it.each(['failed', 'closed'] as const)(
    'on a non-restartable %s: closes as original-terminal without the callback or the side route',
    async (state) => {
      const e = await connection({ onStateChange: (_conn, trace) => trace.push('callback') });
      e.pc.state(state);
      expect(e.trace).toEqual(['close']);
      expect(closeLines()).toEqual([
        '[Transport] Logical connection closed (original-terminal) for peer-0',
      ]);
    },
  );

  it('ignores the transitional states', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (_conn, trace) => trace.push('callback'),
    });
    e.pc.state('new');
    e.pc.state('connecting');
    expect(e.trace).toEqual([]);
    expect(e.conn.iceRecoveryDeadline).toBe(0);
  });
});

describe('original-route grace before the link opens', () => {
  it('arms the grace on disconnected and closes exactly 15 s later', async () => {
    const e = await connection({ bound: true, opened: false });
    const start = Date.now();
    e.pc.state('disconnected');
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    expect(e.trace).toEqual(['side']);
    // The restart gate needs an open link.
    expect(e.conn.beginIceRestart()).toBe(false);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(e.trace).toEqual(['side']);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace).toEqual(['side', 'close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-grace-expired) for peer-0',
    ]);
  });

  it('cancels the pre-open grace on connected and lets the link open afterwards', async () => {
    const e = await connection({ bound: true, opened: false });
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    e.pc.state('connected');
    expect(e.conn.iceRecoveryDeadline).toBe(0);
    // Not open yet: the interruption is not reported as a recovery.
    expect(e.trace).toEqual(['side', 'side']);
    e.bulk.open();
    e.control.open();
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
    expect(e.trace).toEqual(['side', 'side']);
  });

  it('closes a bound link that fails before it opens', async () => {
    const e = await connection({ bound: true, opened: false });
    e.pc.state('failed');
    expect(e.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-terminal) for peer-0',
    ]);
  });
});

describe('non-renewing deadline across restarts', () => {
  it('keeps the first deadline through restart, failed, finish and a second restart', async () => {
    const e = await connection({ bound: true });
    const start = Date.now();
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(e.conn.beginIceRestart()).toBe(true);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(3_000);
    e.pc.state('failed');
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    e.conn.finishIceRestart();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(e.conn.beginIceRestart()).toBe(true);
    expect(e.conn.beginIceRestart()).toBe(false);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 9_000 - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace.filter((entry) => entry === 'close')).toHaveLength(1);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-grace-expired) for peer-0',
    ]);
  });

  it('gives an interruption that starts inside a connected restart only its remaining grace', async () => {
    // A host answers a guest restart while its own PC still reads connected.
    const e = await connection({ bound: true });
    const start = Date.now();
    expect(e.conn.beginIceRestart()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    e.pc.state('disconnected');
    // The restart's grace is still armed: the interruption keeps its deadline.
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 3_000);
    expect(e.trace.at(-1)).toBe('close');
  });

  it('withholds the deadline from an unbound link while its grace still runs', async () => {
    const e = await connection();
    e.pc.state('disconnected');
    expect(e.conn.iceRecoveryDeadline).toBe(0);
    e.conn.iceRestartBinding = 'negotiation_liveness_02';
    expect(e.conn.iceRecoveryDeadline).toBeGreaterThan(0);
  });
});

describe('host-side connection without a state callback', () => {
  it('closes exactly 15 s after disconnected, through an in-place restart answer', async () => {
    const e = await connection({ bound: true });
    const start = Date.now();
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(2_000);
    // The host answers the guest's restart offer: the gate admits it once.
    expect(e.conn.beginIceRestart()).toBe(true);
    e.conn.finishIceRestart();
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 2_000 - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace).toEqual(['side', 'close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-grace-expired) for peer-0',
    ]);
  });

  it('keeps the link when the route recovers inside the grace and reports one recovery', async () => {
    const e = await connection({ bound: true });
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    e.pc.state('connected');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
    expect(e.trace).toEqual(['side', 'side', 'ice-recovered']);
  });

  it('settles a resume probe on a genuine disconnected to connected transition', async () => {
    const e = await connection();
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    e.pc.state('disconnected');
    e.pc.state('connected');
    // A genuine disconnected -> connected transition settled the probe.
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS);
    expect(e.conn.open).toBe(true);
  });
});

/**
 * The owner on its own: every port call in order, so a transition that
 * reorders, drops or adds an effect fails here before any connection test.
 */
describe('LinkLiveness ports', () => {
  const KEY = 'cloudflare-data-disconnected-grace-test';

  function owner(options: { open?: boolean; bound?: boolean } = {}) {
    const trace: unknown[] = [];
    let open = options.open ?? true;
    let route: PeerConnection | undefined = new PeerConnection();
    let reenter: ((liveness: LinkLiveness) => void) | null = null;
    const liveness: LinkLiveness = new LinkLiveness(KEY, {
      route: () => route as unknown as RTCPeerConnection | undefined,
      open: () => open,
      close: (cause) => {
        trace.push(['close', cause]);
        liveness.stop();
        open = false;
      },
      probeConnected: () => trace.push(['probe-connected', liveness.recoveryDeadline]),
      probeDisconnected: () => trace.push(['probe-disconnected', liveness.recoveryDeadline]),
      changed: () => {
        trace.push(['changed', liveness.recoveryDeadline]);
        reenter?.(liveness);
      },
      sideMayRestart: () => trace.push('side'),
      recovered: () => trace.push('recovered'),
    });
    if (options.bound ?? true) liveness.binding = 'negotiation_liveness_03';
    return {
      liveness,
      trace,
      route: () => route,
      transition: (state: RTCPeerConnectionState) => {
        route!.connectionState = state;
        liveness.routeChanged(route as unknown as RTCPeerConnection);
      },
      setOpen: (value: boolean) => (open = value),
      replaceRoute: (value: PeerConnection | undefined) => (route = value),
      onChanged: (fn: ((liveness: LinkLiveness) => void) | null) => (reenter = fn),
    };
  }

  it('runs connected as: cancel grace, reopen gate, probe, callback, side route, recovered', () => {
    const o = owner();
    o.transition('disconnected');
    expect(o.liveness.beginRestart()).toBe(true);
    o.trace.length = 0;
    o.onChanged((liveness) => o.trace.push(['gate', liveness.beginRestart()]));
    o.transition('connected');
    expect(o.trace).toEqual([
      ['probe-connected', 0],
      ['changed', 0],
      ['gate', true],
      'side',
      'recovered',
    ]);
  });

  it('reports no recovery for a connected route that was not interrupted or is not open', () => {
    const o = owner();
    o.transition('connected');
    expect(o.trace).toEqual([['probe-connected', 0], ['changed', 0], 'side']);
    o.transition('disconnected');
    o.setOpen(false);
    o.trace.length = 0;
    o.transition('connected');
    expect(o.trace).toEqual([['probe-connected', 0], ['changed', 0], 'side']);
  });

  it('runs disconnected as: probe, callback, then the grace, then the side route', () => {
    const o = owner();
    const start = Date.now();
    o.transition('disconnected');
    expect(o.trace).toEqual([['probe-disconnected', 0], ['changed', 0], 'side']);
    expect(o.liveness.recoveryDeadline).toBe(start + GRACE_MS);
    expect(getManagedTimer(KEY)).not.toBeNull();
  });

  it('arms no grace and skips the side route when the callback closes on disconnected', () => {
    const o = owner();
    o.onChanged((liveness) => liveness.stop());
    o.transition('disconnected');
    expect(o.trace).toEqual([
      ['probe-disconnected', 0],
      ['changed', 0],
    ]);
    expect(o.liveness.recoveryDeadline).toBe(0);
    expect(getManagedTimer(KEY)).toBeNull();
  });

  it('runs a restartable failed as: grace, callback, side route', () => {
    const o = owner();
    const start = Date.now();
    o.transition('failed');
    expect(o.trace).toEqual([['changed', start + GRACE_MS], 'side']);
  });

  it.each([
    { name: 'an unbound failed', state: 'failed' as const, bound: false, open: true },
    { name: 'a failed before open', state: 'failed' as const, bound: true, open: false },
    { name: 'a closed', state: 'closed' as const, bound: true, open: true },
  ])('closes $name as original-terminal with no other effect', ({ state, bound, open }) => {
    const o = owner({ bound, open });
    o.transition(state);
    expect(o.trace).toEqual([['close', 'original-terminal']]);
  });

  it.each(['new', 'connecting'] as const)('does nothing on %s', (state) => {
    const o = owner();
    o.transition(state);
    expect(o.trace).toEqual([]);
  });

  it('closes on grace expiry only while the same route is still not connected', async () => {
    const expired = owner();
    expired.transition('disconnected');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(expired.trace.at(-1)).toBe('side');
    await vi.advanceTimersByTimeAsync(1);
    expect(expired.trace.at(-1)).toEqual(['close', 'original-grace-expired']);
  });

  it('closes nothing when the grace outlives a replaced route', async () => {
    const replaced = owner();
    replaced.transition('disconnected');
    replaced.replaceRoute(new PeerConnection());
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(replaced.trace.at(-1)).toBe('side');
  });

  it('closes nothing when the route silently reads connected when the grace ends', async () => {
    const silent = owner();
    silent.transition('disconnected');
    silent.route()!.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(silent.trace.at(-1)).toBe('side');
    // The fired grace stays published until the next transition.
    expect(silent.liveness.recoveryDeadline).toBeGreaterThan(0);
  });

  it('keeps a fired grace published until the next transition and re-arms a cleared timer', async () => {
    const o = owner();
    const start = Date.now();
    expect(o.liveness.beginRestart()).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    // The route read connected when the grace fired.
    expect(o.trace).toEqual([]);
    expect(o.liveness.recoveryDeadline).toBe(start + GRACE_MS);
    o.transition('disconnected');
    expect(o.liveness.recoveryDeadline).toBe(start + 2 * GRACE_MS);
    // A page-wide timer clear counts as no grace: the next arm is fresh.
    clearManagedTimer(KEY);
    await vi.advanceTimersByTimeAsync(1_000);
    o.transition('failed');
    expect(o.liveness.recoveryDeadline).toBe(start + 2 * GRACE_MS + 1_000);
  });

  it('withholds the deadline until the owner is bound', () => {
    const o = owner({ bound: false });
    const start = Date.now();
    o.transition('disconnected');
    expect(o.liveness.recoveryDeadline).toBe(0);
    o.liveness.binding = 'negotiation_liveness_04';
    expect(o.liveness.recoveryDeadline).toBe(start + GRACE_MS);
  });

  it('admits one restart per interruption on an open, bound, running owner', () => {
    expect(owner({ bound: false }).liveness.beginRestart()).toBe(false);
    expect(owner({ open: false }).liveness.beginRestart()).toBe(false);
    const stopped = owner();
    stopped.liveness.stop();
    expect(stopped.liveness.beginRestart()).toBe(false);

    const o = owner();
    o.replaceRoute(undefined);
    // Without a route there is nothing to grace, but the gate still closes.
    expect(o.liveness.beginRestart()).toBe(true);
    expect(o.liveness.recoveryDeadline).toBe(0);
    expect(o.liveness.beginRestart()).toBe(false);
    o.liveness.finishRestart();
    expect(o.liveness.beginRestart()).toBe(true);
  });

  it('cancels the grace and arms nothing once stopped', async () => {
    const o = owner();
    o.transition('disconnected');
    o.liveness.stop();
    expect(o.liveness.recoveryDeadline).toBe(0);
    expect(getManagedTimer(KEY)).toBeNull();
    o.transition('failed');
    expect(getManagedTimer(KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(o.trace).not.toContainEqual(['close', 'original-grace-expired']);
  });
});
