// Resource owner: RO-15 (the original route's outage grace, published recovery
// deadline and ICE-restart gate, the side route's outage deadline, the guest
// background-resume probe, and the one close with its cause, of one Cloudflare
// logical data connection, Standard or PRO room).
import { MSG, RTC_INTERRUPTION_GRACE_MS } from '../../core/constants.ts';
import { log } from '../../core/log.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../../core/timers.ts';
import type { SideOutageOwner, SideRouteFailure } from './control-isolation.ts';
import type {
  TransportBackgroundRecoveryStatus,
  TransportCloseReason,
  TransportLinkLivenessView,
} from './types.ts';

/**
 * Why a logical connection closed (RO-15). The owner names the causes it
 * decides itself (the original route and the resume probe); the connection
 * names its channels', its credit sender's and its side route's; the provider
 * and the application name theirs through close(reason), and a close that
 * names nothing is intentional.
 */
export type LinkCloseCause =
  | 'control-send-failed'
  | `side-failed:${SideRouteFailure}`
  | 'channel-closed'
  | 'original-terminal'
  | 'original-grace-expired'
  | 'resume-probe-unanswered'
  | 'resume-stale'
  | 'resume-disconnected'
  | TransportCloseReason
  | 'intentional';

/** A disconnected route at resume gets this one short look, not a fresh grace. */
const BACKGROUND_RESUME_DISCONNECTED_PROBE_MS = 1_000;
/** How long the exact reply to the resume challenge may take. */
const BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS = 3_000;
/**
 * A side PC's outage gets the original route's grace. While the original route
 * is down the outage waits for it, and once it recovers the outage gets a full
 * grace again, but never runs past two graces from its start. The side route's
 * own 15 s request and 30 s offer windows, which the two ends enforce on each
 * other, stay its literals (control-isolation.ts).
 */
const SIDE_OUTAGE_MS = RTC_INTERRUPTION_GRACE_MS;
const SIDE_OUTAGE_CAP_MS = 2 * RTC_INTERRUPTION_GRACE_MS;

/** The link as the owner reads it at one instant: both routes and their channels. */
interface LinkSnapshot {
  readonly original: RTCPeerConnection | undefined;
  /** The isolated control side PC, while the connection has one. */
  readonly side: RTCPeerConnection | undefined;
  /** The original route's bulk and control channels both read open. */
  readonly channelsOpen: boolean;
  /** The side route is active and its channel does not read open. */
  readonly sideChannelDown: boolean;
  /**
   * The original route's control channel reads open: the side route's restart
   * signaling travels on it. Required, so that no snapshot port can leave it
   * out and hold every side outage to its 30 s cap without a type error.
   */
  readonly controlOpen: boolean;
}

/** The side route (control isolation) as the owner drives its outages. */
interface SideRoute {
  /** The side PC while the route is current (not closed or fallen back). */
  readonly peerConnection: RTCPeerConnection | undefined;
  /** An outage began: the route's restart attempts and request start over. */
  outageStarted(): void;
  /** The outage ended: the side PC connected again. */
  outageEnded(): void;
  /**
   * The outage's deadline ran out: a restartable route ends the link
   * (`side-failed:expired`), one that cannot restart fails its setup.
   */
  outageExpired(restartable: boolean): void;
}

/** One outage of the side PC (monotonic times). */
interface SideOutage {
  readonly route: SideRoute;
  /** false: the grace of a route that cannot restart (before READY, or a peer without restart). */
  readonly restartable: boolean;
  readonly start: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The original route was unavailable during this outage. */
  originalDown: boolean;
}

/**
 * What the owner does outside itself. The connection (CloudflareDataConnection)
 * keeps its channels, its send and its close; the side route keeps its restart
 * protocol.
 */
interface LinkLivenessPorts {
  /** The connection's current original PC; a replaced PC's grace closes nothing. */
  readonly route: () => RTCPeerConnection | undefined;
  readonly open: () => boolean;
  readonly snapshot: () => LinkSnapshot;
  /** Sends the resume challenge (SYNC_PING); throws when it cannot be sent. */
  readonly ping: (pingId: number) => void;
  /**
   * The close port: ends the logical connection with this cause (the
   * connection's terminate, which only this port calls). `first` marks the
   * cause the link closed with, which the connection reports once.
   */
  readonly close: (cause: LinkCloseCause, first: boolean) => void;
  /** The connection's state callback: the guest reconciles, then restarts ICE. */
  readonly changed: () => void;
  /**
   * The original route changed and is not holding back a side outage: the
   * side route restarts its ICE if one is due.
   */
  readonly sideMayRestart: () => void;
  /** A genuine interruption ended on an open link ('ice-recovered'). */
  readonly recovered: () => void;
}

/** One armed background-resume challenge. */
interface ResumeProbe {
  readonly pingId: number;
  /** A route read disconnected while it was armed. */
  sawDisconnected: boolean;
}

function randomResumeProbePingId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  // Reserve the upper half of the safe-integer range so this transport-owned
  // probe cannot realistically collide with the app sync counter.
  return 2 ** 52 + (words[0] & 0xfffff) * 2 ** 32 + words[1];
}

/**
 * The single owner of whether one Cloudflare logical data connection (a
 * Standard or PRO room's; a PRO connection has no side route and binds no
 * restart) may still recover (registry RO-15). Since Phase 4 C5-6 it owns
 * the original route's interruption, the 15 s grace, the wall-clock recovery
 * deadline it publishes and the gate that admits one ICE restart per
 * interruption; since C5-7 it also owns the guest background-resume probe,
 * which reads both routes and their channels. Since C5-8 every connection
 * exposes it as its
 * `linkLiveness` view, from which transport health reads the original route's
 * phase and the published deadline. Since C5-10 every close of the link
 * enters `close(cause)`, which keeps the first cause and is the only caller of
 * the connection's terminate (`npm run guard:transport-health`). Since C5-9 it
 * also owns the side (isolated control) PC's outage deadline, which control
 * isolation reports to it as the SideOutageOwner. It is a
 * module of its own because that state has its own start, cancel, expiry and
 * stop lifecycle with its own tests and two readers (the connection and
 * transport health) besides that reporter; the SDP executors and the side
 * route's restart protocol
 * (its attempts, offer window, epochs, candidates, fence and READY) stay with
 * their owners.
 *
 * Rules kept from the connection:
 * - The grace is measured by its managed timer and published in wall-clock
 *   time. It never renews: a running grace keeps its deadline through later
 *   interruptions and restarts, and only `connected` or stop clears it. A
 *   grace that fired without closing (the route read connected) keeps its
 *   published value until the next transition.
 * - The timer keys are the connection's (`cloudflare-data-disconnected-grace-N`
 *   and its two `-background-resume-*` suffixes). A cleared managed timer
 *   counts as no grace, so the next interruption arms a fresh one.
 * - The deadline is published only once the connection is bound to a
 *   restart-capable negotiation (`binding`); an unbound grace still closes.
 * - Every transition commits its own state before its first outbound effect
 *   and runs the effects in a fixed order. The state callback may re-enter the
 *   gate or close the connection; only the disconnected transition re-checks
 *   for a close after it, before arming its grace.
 * - A resume after a hidden period of at least the grace sends one challenge
 *   and closes unless its exact SYNC_PONG arrives within 3 s. A terminal route
 *   or a channel that is not open closes at once; a disconnected route gets one
 *   1 s look, or closes at once when signaling is lost too. Only the exact
 *   pong settles the probe, or, without a side PC, a genuine disconnected ->
 *   connected transition of the original route. Stop clears the probe and its
 *   timers.
 *
 * Rules kept from control isolation for the side PC's outage (C5-9):
 * - A side route that restarts its ICE gets 15 s per outage, from its first
 *   disconnected or failed reading until connected. While the original route
 *   is down (not connected, or its control channel not open) the outage waits,
 *   and once the original recovers it is re-armed to 15 s from then, never past
 *   30 s from the outage's start. At its deadline a connected side PC ends the
 *   outage quietly; otherwise it ends the link (`side-failed:expired`) after
 *   the did-not-recover warning. The recovered line is the end that saw the
 *   outage; the restart line stays control isolation's.
 * - A side route that cannot restart (before READY, or a peer without restart)
 *   gets one non-renewing 15 s grace while its PC reads disconnected, which
 *   only `connected` clears and which never waits for the original route; at
 *   its end the route fails its setup (decline and fall back, or end the link).
 *   READY turns a running grace into a restart outage that starts then.
 * - The side deadline runs on the monotonic clock, in a timer of its own
 *   that the side PC's close and stop clear.
 */
export class LinkLiveness implements TransportLinkLivenessView, SideOutageOwner {
  /** The negotiation that made this link restartable (the bind input), or null. */
  binding: string | null = null;
  private interrupted = false;
  private restartInFlight = false;
  private deadline = 0;
  private stopped = false;
  /** The cause the link closed with: the first close's. */
  private cause: LinkCloseCause | null = null;
  private probe: ResumeProbe | null = null;
  /** The side PC's current outage or grace (C5-9). */
  private side: SideOutage | null = null;
  private readonly probeTimerKey: string;
  private readonly probeDisconnectedTimerKey: string;

  constructor(
    private readonly graceTimerKey: string,
    private readonly ports: LinkLivenessPorts,
  ) {
    this.probeTimerKey = `${graceTimerKey}-background-resume-liveness`;
    this.probeDisconnectedTimerKey = `${graceTimerKey}-background-resume-disconnected`;
  }

  /** The published recovery deadline (wall clock), or 0. */
  get recoveryDeadline(): number {
    return this.binding ? this.deadline : 0;
  }

  /**
   * The original route as transport health reads it (Phase 4 C5-8):
   * recovering while an interruption is held and the route does not read
   * connected, the condition under which the grace closes the link.
   */
  get phase(): TransportLinkLivenessView['phase'] {
    if (this.stopped) return 'closed';
    if (!this.ports.open()) return 'opening';
    return this.interrupted && this.ports.route()?.connectionState !== 'connected'
      ? 'recovering'
      : 'live';
  }

  /** One `connectionstatechange` of the original PC. */
  routeChanged(pc: RTCPeerConnection): void {
    const ports = this.ports;
    const state = pc.connectionState;
    if (state === 'connected') {
      this.cancelGrace();
      this.restartInFlight = false;
      const recovered = this.interrupted;
      this.interrupted = false;
      // A genuine disconnected -> connected transition is ICE-level proof.
      // A redundant connected event on a stale WebKit object is not, and with
      // a side PC only the exact pong proves both routes.
      const probe = this.probe;
      if (!probe || (probe.sawDisconnected && !ports.snapshot().side)) this.clearProbe();
      ports.changed();
      this.sideFollowsOriginal();
      if (recovered && ports.open()) ports.recovered();
      return;
    }
    if (state === 'disconnected') {
      this.interrupted = true;
      // Let the peer combine this RTC transition with its signaling state
      // before granting a fresh grace period. A long-hidden outage may
      // already have consumed the entire grace while WebKit was suspended.
      this.reconcileResume(false);
      ports.changed();
      if (this.stopped) return;
      this.armGrace(pc);
      this.sideFollowsOriginal();
      return;
    }
    if (state === 'closed' || state === 'failed') {
      if (state === 'failed' && ports.open() && this.binding) {
        this.interrupted = true;
        this.armGrace(pc);
        ports.changed();
        this.sideFollowsOriginal();
        return;
      }
      this.close('original-terminal');
    }
  }

  /** Admits one ICE restart per interruption on an open, bound link. */
  beginRestart(): boolean {
    if (this.stopped || !this.ports.open() || !this.binding || this.restartInFlight) return false;
    this.restartInFlight = true;
    const pc = this.ports.route();
    if (pc) this.armGrace(pc);
    return true;
  }

  finishRestart(): void {
    this.restartInFlight = false;
  }

  /**
   * One state change of the current side PC, as control isolation reports it,
   * with whether that route restarts its ICE. A failed or closed PC of a route
   * that cannot restart fails its setup there, without reaching here.
   */
  sideChanged(route: SideRoute, state: RTCPeerConnectionState, restartable: boolean): void {
    if (this.stopped) return;
    const held = this.side;
    if (!restartable) {
      if (state === 'disconnected') {
        if (!held) this.startSide(route, false);
      } else if (state === 'connected' && held) this.dropSide();
      return;
    }
    // The restart path owns the outage from here on, a grace from before READY included.
    if (held && !held.restartable) this.dropSide();
    if (state === 'connected') {
      if (!this.side) return;
      this.dropSide();
      route.outageEnded();
      log.info('[Transport] Isolated control ICE recovered');
      return;
    }
    if ((state === 'disconnected' || state === 'failed') && !this.side) {
      this.startSide(route, true);
      route.outageStarted();
    }
  }

  /** A grace of a side route that cannot restart is running (READY takes it over). */
  get sideGraceRunning(): boolean {
    return this.side?.restartable === false;
  }

  /**
   * Whether the side route's restart signaling may travel now. When it may
   * not, a side outage waits for the original route.
   */
  sideMaySignal(): boolean {
    if (this.originalUp()) return true;
    if (this.side?.restartable) this.side.originalDown = true;
    return false;
  }

  /** The side PC is gone (fallback or close): its outage ends without a callback. */
  sideClosed(): void {
    this.dropSide();
  }

  /**
   * The page is visible again after `hiddenMs`. visibilitychange can run while
   * WebKit still reports a dead RTC object as connected/open, so require a
   * bounded, connection-bound SYNC_PONG instead of trusting that cached state.
   * Existing hosts already answer SYNC_PING, so the challenge stays compatible
   * across a rolling static deploy.
   */
  backgroundResume(
    hiddenMs: number,
    signalingDisconnected: boolean,
  ): TransportBackgroundRecoveryStatus {
    const ports = this.ports;
    if (
      this.stopped ||
      !ports.open() ||
      !Number.isFinite(hiddenMs) ||
      hiddenMs < RTC_INTERRUPTION_GRACE_MS
    ) {
      return 'not-applicable';
    }
    const probe: ResumeProbe = { pingId: randomResumeProbePingId(), sawDisconnected: false };
    this.probe = probe;
    setManagedTimer(
      this.probeTimerKey,
      () => this.close('resume-probe-unanswered'),
      BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS,
    );
    const status = this.reconcileResume(signalingDisconnected);
    if (status === 'stale-connection-closed') return status;
    try {
      ports.ping(probe.pingId);
    } catch {
      this.close('resume-probe-unanswered');
      return 'stale-connection-closed';
    }
    return status;
  }

  /** Re-reads both routes for an armed probe (on resume, and as states change). */
  reconcileResume(signalingDisconnected: boolean): TransportBackgroundRecoveryStatus {
    const probe = this.probe;
    if (this.stopped || !probe) return 'not-applicable';
    const ports = this.ports;
    const { original, side, channelsOpen, sideChannelDown } = ports.snapshot();
    const rtcState = original?.connectionState;
    const sideState = side?.connectionState;
    // Terminal RTC/data-channel state is already conclusive after an absence
    // longer than the ordinary grace. A disconnected PC with open channels is
    // less certain: iOS can briefly report it while restoring the radio, so
    // give that foreground hand-off one bounded probe instead of another full
    // 15-second grace. Lost signaling strengthens the stale-session evidence
    // and makes that probe unnecessary, but is deliberately not required: the
    // room worker retains guest signaling for the host's 60-second reclaim
    // window even after the host transport has gone away.
    if (
      !original ||
      rtcState === 'failed' ||
      rtcState === 'closed' ||
      sideState === 'failed' ||
      sideState === 'closed' ||
      !channelsOpen ||
      sideChannelDown
    ) {
      this.close('resume-stale');
      return 'stale-connection-closed';
    }
    if (rtcState === 'connected' && sideState !== 'disconnected') return 'monitoring';
    if (rtcState === 'disconnected' || sideState === 'disconnected') {
      probe.sawDisconnected = true;
      if (signalingDisconnected) {
        this.close('resume-stale');
        return 'stale-connection-closed';
      }
      setManagedTimer(
        this.probeDisconnectedTimerKey,
        () => {
          const now = ports.snapshot();
          // A state transition event or the exact pong settles the probe. If
          // WebKit silently mutates the property, keep waiting for the pong.
          if (
            now.original?.connectionState !== 'connected' ||
            !now.channelsOpen ||
            now.side?.connectionState === 'disconnected'
          ) {
            this.close('resume-disconnected');
          }
        },
        BACKGROUND_RESUME_DISCONNECTED_PROBE_MS,
      );
    }
    return 'monitoring';
  }

  /** A frame received on either route: only the exact SYNC_PONG settles the probe. */
  inbound(payload: unknown): void {
    const probe = this.probe;
    if (!probe || !payload || typeof payload !== 'object') return;
    const record = payload as Record<string, unknown>;
    if (record.type === MSG.SYNC_PONG && record.pingId === probe.pingId) this.clearProbe();
  }

  /**
   * Ends the link with this cause: the only way into the connection's close
   * port. The first cause is the link's. Every later close still reaches the
   * port, a close re-entered while the connection disposes its channels
   * included, so the connection's `close` event keeps its place.
   */
  close(cause: LinkCloseCause): void {
    const first = this.cause === null;
    if (first) this.cause = cause;
    this.ports.close(cause, first);
  }

  /**
   * The connection is closing: cancel the grace, the side outage and the probe
   * and arm nothing after it.
   */
  stop(): void {
    this.stopped = true;
    this.cancelGrace();
    this.dropSide();
    this.clearProbe();
  }

  /**
   * Settling the probe clears both of its timers, so a probe timer that fires
   * always finds its probe armed and the connection open.
   */
  private clearProbe(): void {
    this.probe = null;
    clearManagedTimer(this.probeTimerKey);
    clearManagedTimer(this.probeDisconnectedTimerKey);
  }

  private armGrace(pc: RTCPeerConnection): void {
    if (this.stopped || getManagedTimer(this.graceTimerKey) !== null) return;
    this.deadline = Date.now() + RTC_INTERRUPTION_GRACE_MS;
    setManagedTimer(
      this.graceTimerKey,
      () => {
        if (pc !== this.ports.route() || pc.connectionState === 'connected') return;
        this.close('original-grace-expired');
      },
      RTC_INTERRUPTION_GRACE_MS,
    );
  }

  private cancelGrace(): void {
    this.deadline = 0;
    clearManagedTimer(this.graceTimerKey);
  }

  /**
   * The original route can carry the side route's restart signaling: the link
   * is open, its PC reads connected and its control channel reads open.
   */
  private originalUp(): boolean {
    if (this.stopped || !this.ports.open()) return false;
    const link = this.ports.snapshot();
    return link.original?.connectionState === 'connected' && link.controlOpen === true;
  }

  /**
   * The original route changed (connected, disconnected, or a failure the
   * grace holds). A side outage waits while it is down; once it is up again
   * the outage gets a full window, and the side route may restart.
   */
  private sideFollowsOriginal(): void {
    const side = this.side;
    if (side?.restartable) {
      if (!this.originalUp()) {
        side.originalDown = true;
        return;
      }
      if (side.originalDown) {
        side.originalDown = false;
        // Waiting for the original route must not consume the side's own window.
        this.armSide(
          side,
          Math.min(
            side.start + SIDE_OUTAGE_CAP_MS,
            Math.max(side.deadline, performance.now() + SIDE_OUTAGE_MS),
          ),
        );
      }
    }
    this.ports.sideMayRestart();
  }

  private startSide(route: SideRoute, restartable: boolean): void {
    const start = performance.now();
    const side: SideOutage = {
      route,
      restartable,
      start,
      deadline: start + SIDE_OUTAGE_MS,
      timer: null,
      originalDown: restartable && !this.originalUp(),
    };
    this.side = side;
    this.armSide(side, side.deadline);
  }

  private armSide(side: SideOutage, deadline: number): void {
    if (side.timer !== null) clearTimeout(side.timer);
    side.deadline = deadline;
    // eslint-disable-next-line no-restricted-globals -- one bounded deadline per side outage, on the monotonic clock; its end, the side PC's close and stop clear it, and room timer cleanup must not drop it while the connection lives
    side.timer = setTimeout(
      () => this.sideExpired(side),
      Math.max(0, deadline - performance.now()),
    );
  }

  /** Its timer is cleared whenever the outage is replaced or dropped, so it is current. */
  private sideExpired(side: SideOutage): void {
    side.timer = null;
    const pc = side.route.peerConnection;
    if (!side.restartable) {
      this.side = null;
      if (pc && pc.connectionState !== 'connected') side.route.outageExpired(false);
      return;
    }
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      this.side = null;
      side.route.outageEnded();
      return;
    }
    const cap = side.start + SIDE_OUTAGE_CAP_MS;
    if (!this.originalUp() && performance.now() < cap) {
      // The original route owns its own bounded recovery; do not pre-empt it.
      side.originalDown = true;
      this.armSide(side, cap);
      return;
    }
    log.warn('[Transport] Isolated control ICE did not recover; closing its logical connection');
    side.route.outageExpired(true);
  }

  private dropSide(): void {
    const side = this.side;
    if (!side) return;
    if (side.timer !== null) clearTimeout(side.timer);
    this.side = null;
  }
}
