// Resource owner: RO-15 (the original route's outage grace, published recovery
// deadline and ICE-restart gate of one Standard-room logical data connection).
import { RTC_INTERRUPTION_GRACE_MS } from '../../core/constants.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../../core/timers.ts';

/**
 * What one original-route transition does outside this owner. The connection
 * (CloudflareDataConnection) keeps its channels, its close and the
 * background-resume probe; the probe's two hooks move here with Phase 4 C5-7.
 */
interface LinkLivenessPorts {
  /** The connection's current original PC; a replaced PC's grace closes nothing. */
  readonly route: () => RTCPeerConnection | undefined;
  readonly open: () => boolean;
  /** Ends the logical connection with this cause (the connection's terminate). */
  readonly close: (cause: 'original-terminal' | 'original-grace-expired') => void;
  /** The resume probe's reaction to a connected route, before the state callback. */
  readonly probeConnected: () => void;
  /** The resume probe's reaction to a disconnected route, before the state callback. */
  readonly probeDisconnected: () => void;
  /** The connection's state callback: the guest reconciles, then restarts ICE. */
  readonly changed: () => void;
  /** The side route defers its own restart while the original route recovers. */
  readonly sideMayRestart: () => void;
  /** A genuine interruption ended on an open link ('ice-recovered'). */
  readonly recovered: () => void;
}

/**
 * The single owner of whether one Standard-room logical data connection's
 * original route may still recover (registry RO-15, Phase 4 C5-6): its
 * interruption, the 15 s grace, the wall-clock recovery deadline it publishes,
 * and the gate that admits one ICE restart per interruption. It is a module of
 * its own because that state has its own start, cancel, expiry and stop
 * lifecycle with its own tests, which the background-resume probe joins in
 * C5-7; the SDP executors and the side route (RO-35) stay with their owners.
 *
 * Rules kept from the connection:
 * - The grace is measured by its managed timer and published in wall-clock
 *   time. It never renews: a running grace keeps its deadline through later
 *   interruptions and restarts, and only `connected` or stop clears it. A
 *   grace that fired without closing (the route read connected) keeps its
 *   published value until the next transition.
 * - The timer key is the connection's (`cloudflare-data-disconnected-grace-N`).
 *   A cleared managed timer counts as no grace, so the next interruption
 *   arms a fresh one.
 * - The deadline is published only once the connection is bound to a
 *   restart-capable negotiation (`binding`); an unbound grace still closes.
 * - Every transition commits its own state before its first outbound effect
 *   and runs the effects in a fixed order. The state callback may re-enter the
 *   gate or close the connection; only the disconnected transition re-checks
 *   for a close after it, before arming its grace.
 */
export class LinkLiveness {
  /** The negotiation that made this link restartable (the bind input), or null. */
  binding: string | null = null;
  private interrupted = false;
  private restartInFlight = false;
  private deadline = 0;
  private stopped = false;

  constructor(
    private readonly graceTimerKey: string,
    private readonly ports: LinkLivenessPorts,
  ) {}

  /** The published recovery deadline (wall clock), or 0. */
  get recoveryDeadline(): number {
    return this.binding ? this.deadline : 0;
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
      ports.probeConnected();
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
      ports.probeDisconnected();
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

  /** The connection is closing: cancel the grace and arm nothing after it. */
  stop(): void {
    this.stopped = true;
    this.cancelGrace();
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
