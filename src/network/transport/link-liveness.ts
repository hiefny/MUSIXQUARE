// Resource owner: RO-15 (the original route's outage grace, published recovery
// deadline and ICE-restart gate, and the guest background-resume probe, of one
// Standard-room logical data connection).
import { MSG, RTC_INTERRUPTION_GRACE_MS } from '../../core/constants.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../../core/timers.ts';
import type { TransportBackgroundRecoveryStatus, TransportLinkLivenessView } from './types.ts';

/** A disconnected route at resume gets this one short look, not a fresh grace. */
const BACKGROUND_RESUME_DISCONNECTED_PROBE_MS = 1_000;
/** How long the exact reply to the resume challenge may take. */
const BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS = 3_000;

/** The link as the resume probe reads it at one instant: both routes and their channels. */
interface LinkSnapshot {
  readonly original: RTCPeerConnection | undefined;
  /** The isolated control side PC, while the connection has one. */
  readonly side: RTCPeerConnection | undefined;
  /** The original route's bulk and control channels both read open. */
  readonly channelsOpen: boolean;
  /** The side route is active and its channel does not read open. */
  readonly sideChannelDown: boolean;
}

/**
 * What the owner does outside itself. The connection (CloudflareDataConnection)
 * keeps its channels, its send and its close; the side route keeps its own
 * deadline and restart (RO-35).
 */
interface LinkLivenessPorts {
  /** The connection's current original PC; a replaced PC's grace closes nothing. */
  readonly route: () => RTCPeerConnection | undefined;
  readonly open: () => boolean;
  readonly snapshot: () => LinkSnapshot;
  /** Sends the resume challenge (SYNC_PING); throws when it cannot be sent. */
  readonly ping: (pingId: number) => void;
  /** Ends the logical connection with this cause (the connection's terminate). */
  readonly close: (
    cause:
      | 'original-terminal'
      | 'original-grace-expired'
      | 'resume-probe-unanswered'
      | 'resume-stale'
      | 'resume-disconnected',
  ) => void;
  /** The connection's state callback: the guest reconciles, then restarts ICE. */
  readonly changed: () => void;
  /** The side route defers its own restart while the original route recovers. */
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
 * The single owner of whether one Standard-room logical data connection may
 * still recover (registry RO-15). Since Phase 4 C5-6 it owns the original
 * route's interruption, the 15 s grace, the wall-clock recovery deadline it
 * publishes and the gate that admits one ICE restart per interruption; since
 * C5-7 it also owns the guest background-resume probe, which reads both routes
 * and their channels. Since C5-8 the connection exposes it as its
 * `linkLiveness` view, from which transport health reads the original route's
 * phase and the published deadline. It is a module of its own because that
 * state has its own start, cancel, expiry and stop lifecycle with its own
 * tests and two readers (the connection and transport health); the SDP
 * executors and the side route (RO-35) stay with their owners.
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
 */
export class LinkLiveness implements TransportLinkLivenessView {
  /** The negotiation that made this link restartable (the bind input), or null. */
  binding: string | null = null;
  private interrupted = false;
  private restartInFlight = false;
  private deadline = 0;
  private stopped = false;
  private probe: ResumeProbe | null = null;
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
      ports.sideMayRestart();
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
      ports.sideMayRestart();
      return;
    }
    if (state === 'closed' || state === 'failed') {
      if (state === 'failed' && ports.open() && this.binding) {
        this.interrupted = true;
        this.armGrace(pc);
        ports.changed();
        ports.sideMayRestart();
        return;
      }
      ports.close('original-terminal');
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
      () => ports.close('resume-probe-unanswered'),
      BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS,
    );
    const status = this.reconcileResume(signalingDisconnected);
    if (status === 'stale-connection-closed') return status;
    try {
      ports.ping(probe.pingId);
    } catch {
      ports.close('resume-probe-unanswered');
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
      ports.close('resume-stale');
      return 'stale-connection-closed';
    }
    if (rtcState === 'connected' && sideState !== 'disconnected') return 'monitoring';
    if (rtcState === 'disconnected' || sideState === 'disconnected') {
      probe.sawDisconnected = true;
      if (signalingDisconnected) {
        ports.close('resume-stale');
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
            ports.close('resume-disconnected');
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

  /** The connection is closing: cancel the grace and the probe and arm nothing after it. */
  stop(): void {
    this.stopped = true;
    this.cancelGrace();
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
        this.ports.close('original-grace-expired');
      },
      RTC_INTERRUPTION_GRACE_MS,
    );
  }

  private cancelGrace(): void {
    this.deadline = 0;
    clearManagedTimer(this.graceTimerKey);
  }
}
