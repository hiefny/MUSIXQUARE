// Resource owner: RO-04 (the device-wide system-audio receive slot; see
// docs/design/resource-ownership-registry.md).
/**
 * MUSIXQUARE — System Audio Receive Slot
 *
 * One device receives one system-audio share at a time. This module owns that
 * slot's trusted reception (registry RO-04): the reception generation that
 * fences the routes' trust-boundary waits, the start (stop the current
 * playback, take the restore point, claim the receive placeholder), the 30 s
 * receive watchdog, and the end of reception that restores the previous title
 * only while this slot still holds the placeholder or the 'system-audio'
 * owner. It also owns what a route attaches: its source on widener.input,
 * its decoder primer, and the receiving flag and owner claim the attach that
 * starts a reception sets.
 *
 * Phase 5 C4-2 moved the trusted reception here from system-audio-guest.ts
 * unchanged, C4-3 the Standard direct call's attach and primer, C4-4 the
 * Standard SFU guest's, and C4-5 the PRO coordinator's receive inputs (its
 * attach, the SFU resume, the interrupts and the detach). C4-6 made the two
 * signals the routes shared on the bus slot inputs: a Standard delivery
 * handoff (handOffTrustedSystemAudioReception) and the receive deadline's
 * expiry with its route reactions (expireTrustedSystemAudioReception and a
 * route's onDeadline), and each start and interrupt names who bounds the wait
 * (ReceiveDeadline). C4-7 gave the slot its adopt
 * (adoptSystemAudioReceiveRoute): the PRO coordinator retires the Standard SFU
 * route through it, so the PRO service reaches the Standard routes through the
 * slot only. C4-8 removed the old names system-audio-guest.ts kept as
 * aliases: every route imports the slot's own. The timer names keep their
 * `sys-audio-guest-` prefix. Since train 5B (5B-G1) a route attaches or
 * resumes only while the slot's placeholder is current; a refused attach or
 * resume writes nothing and drops what that route holds. Since 5B-G4 the end
 * leaves this device's own share (a 'system-audio' owner with sharing meta)
 * alone and the start never takes that meta as its restore point. Since
 * 5B-G5 an end nested in a start before its placeholder claim keeps that
 * start's claim, generation and restore point. The ownership contract is
 * docs/design/system-audio-receive-ownership.md.
 *
 * Deferred-only: it loads with the room session (vite.config.ts
 * DEFERRED_ENTRY_MODULES).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { getAudioContext } from '../audio/context.ts';
import { getWidener } from '../audio/engine.ts';
import { stopAllMedia } from '../player/transport.ts';
import { cancelIncomingFileTransfer } from '../storage/transfer.ts';
import { cancelRemoteShareWait } from '../share/remote-share.ts';
import {
  claimPlaybackOwner,
  createSystemAudioTrackMeta,
  isSystemAudioOwner,
  isSystemAudioPlaceholderMeta,
  releasePlaybackOwner,
  setPlaybackIdle,
  setSystemAudioReceiving,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import { SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS } from './system-audio-media.ts';
import {
  cleanupWebRtcAudioDecoderPrimer,
  primeWebRtcAudioDecoder,
  type WebRtcAudioDecoderPrimer,
} from './webrtc-audio-decoder-primer.ts';
import type { TrackMeta } from '../types/index.ts';

// ─── Tuning ───────────────────────────────────────────────────────

const SYSTEM_AUDIO_RECEIVE_WATCHDOG = 'sys-audio-guest-receive-watchdog';
// A route's track that arrives before the trusted start waits at the boundary
// for as long as a start may wait for a route.
const TRUSTED_BOUNDARY_WAIT_MS = SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS;

// ─── Slot State ───────────────────────────────────────────────────

/**
 * What the slot stores. Only what cannot be read back is kept: the reception
 * generation that fences boundary waits and the restore point a start took
 * (and, apart from the phase, each route's source and primer, see
 * RouteMedia). Whether the slot is pending (the system-audio placeholder
 * meta) or receiving (systemAudio.isReceiving) is read from player state at
 * each input, because other writers change both: leaveSession's reset and a
 * successor playback owner.
 */
type ReceiveSlot =
  /** No restore point held; the next start takes `generation + 1`. */
  | { readonly phase: 'idle'; readonly generation: number }
  /**
   * A start is committing `generation`: a boundary wait opened now joins it,
   * and another start is refused until it returns. An end nested in it
   * before its placeholder claim keeps it, restore point included (5B-G5).
   */
  | {
      readonly phase: 'claiming';
      readonly generation: number;
      readonly restoreMeta: TrackMeta | null;
    }
  /** A committed start's restore point, kept until the reception ends. */
  | {
      readonly phase: 'held';
      readonly generation: number;
      readonly restoreMeta: TrackMeta | null;
    };

/**
 * The routes that receive into the slot. The PRO coordinator is one route for
 * both of its transports (SFU and LAN-direct): it holds one source and one
 * primer whichever transport delivered the track, so its next attach swaps
 * and its detach drops that one, as before the slot.
 */
type ReceiveRoute = 'standard-direct' | 'standard-sfu' | 'pro-coordinator';

interface ReceiveRoutePort {
  /**
   * Closes what the route holds for the reception when it ends, whichever
   * route ends it: after the restore point is taken and the watchdog cleared,
   * before the receiving flag drops and the title is restored.
   */
  readonly endReception?: () => void;
  /**
   * The route's reaction when a receive deadline expires the reception (see
   * expireTrustedSystemAudioReception), before the reception ends: the
   * Standard SFU drops a subscription that never delivered.
   */
  readonly onDeadline?: () => void;
  /**
   * Drops what the route holds when another route adopts the slot (see
   * adoptSystemAudioReceiveRoute), without ending the reception: the Standard
   * SFU closes its subscription and thaws its frozen share route.
   */
  readonly retire?: () => void;
}

/**
 * Who bounds a reception's wait for a route's audio (P5-D7):
 * - 'slot': the slot's 30 s receive deadline, which expires the reception
 *   when nothing plays by then (the Standard routes);
 * - 'route': the route's own deadlines, so the slot arms none (the PRO
 *   coordinator: its backed-off SFU retries and its direct receive deadline
 *   report a failure once and keep the placeholder for a late track).
 */
type ReceiveDeadline = 'slot' | 'route';

/**
 * What one route attached: its source on widener.input and its decoder
 * primer. Kept per route, because a route's attach swaps and its detach drops
 * only its own; another route's source is never touched.
 */
interface RouteMedia {
  source: MediaStreamAudioSourceNode | null;
  primer: WebRtcAudioDecoderPrimer | null;
}

let slot: ReceiveSlot = { phase: 'idle', generation: 0 };
const routes = new Map<ReceiveRoute, ReceiveRoutePort>();
const routeMedia = new Map<ReceiveRoute, RouteMedia>();

interface TrustedReceptionWaiter {
  expectedGeneration: number;
  timerName: string;
  resolve: (ready: boolean) => void;
}

const trustedReceptionWaiters = new Set<TrustedReceptionWaiter>();
let trustedReceptionWaitSeq = 0;

// Read by the Standard guest's /debug snapshot (system-audio-debug.ts).
const debug = {
  lastStartAt: 0,
  lastStartIgnoredAt: 0,
  lastStartIgnoredReason: '',
  lastCleanupAt: 0,
  watchdogArmedAt: 0,
  watchdogTimedOutAt: 0,
  watchdogActive: false,
};

function isSystemAudioPlaceholder(): boolean {
  const currentMeta = getState('player.currentTrackMeta') as TrackMeta | null;
  return isSystemAudioPlaceholderMeta(currentMeta);
}

/**
 * The sharer's own title: the meta src/audio/system-capture.ts claims (and
 * its transition teardown leaves behind, idle) for this device's share. The
 * 'system-audio' owner is that share's claim too, so the slot tells its own
 * claim from the sharer's by this meta (5B-G4).
 */
function isSharerMeta(meta: TrackMeta | null): boolean {
  return meta?.systemAudioMode === 'sharing';
}

/**
 * Whether the slot still holds a reception: a start is claiming or holds its
 * restore point, the receive placeholder is the current meta, or the
 * receiving flag is set. Read-only. The PRO coordinator asks it before it
 * ends the slot over this device's own publication (5B-G4): there an end
 * runs only for a reception this device still held when it began to share,
 * not on every reconcile of the share.
 */
export function hasTrustedSystemAudioReception(): boolean {
  return slot.phase !== 'idle' || isSystemAudioPlaceholder() || getState('systemAudio.isReceiving');
}

// ─── Routes ───────────────────────────────────────────────────────

/**
 * A route adapter joins the end of every reception, the receive deadline's
 * expiry and another route's adopt (one port per route).
 */
export function registerSystemAudioReceiveRoute(route: ReceiveRoute, port: ReceiveRoutePort): void {
  routes.set(route, port);
}

/**
 * `route` takes the slot over from the other routes: each other route's
 * retire runs, and the slot itself changes nothing. The reception, its
 * placeholder and restore point, the receiving flag, the owner claim and the
 * receive deadline stay as they are. A retiring route drops only its own
 * source and primer, so the adopting route's source is never touched (its
 * attach swaps it, its detach drops it). The PRO coordinator adopts where it
 * takes the slot over (the room turning PRO, a retry's cleanup) and so
 * retires the Standard SFU route, the only route with a retire, without an
 * idle flash. A PRO room starts no Standard SFU subscription, so since 5B-OV1
 * a live reconcile no longer adopts.
 */
export function adoptSystemAudioReceiveRoute(route: ReceiveRoute): void {
  for (const [registered, port] of routes) {
    if (registered !== route) port.retire?.();
  }
}

// ─── Route Media ──────────────────────────────────────────────────

function mediaOf(route: ReceiveRoute): RouteMedia {
  let media = routeMedia.get(route);
  if (!media) {
    media = { source: null, primer: null };
    routeMedia.set(route, media);
  }
  return media;
}

interface DecoderPrimerRequest {
  /** One primer per stream key: the same key keeps the route's primer. */
  readonly streamKey: string;
  /** The label the primed line names (the route's channel). */
  readonly label: string;
  /** The route's own prefix on the primed and primer-blocked lines. */
  readonly logPrefix: string;
}

/**
 * Starts the route's WebRTC decoder for these tracks (some Chromium builds
 * leave a received track muted until a playing media element consumes it).
 * A new stream key replaces the route's primer; the same key keeps it.
 */
export function primeSystemAudioDecoder(
  route: ReceiveRoute,
  tracks: readonly MediaStreamTrack[],
  request: DecoderPrimerRequest,
): void {
  const media = mediaOf(route);
  media.primer = primeWebRtcAudioDecoder(
    media.primer,
    tracks,
    request.streamKey,
    request.label,
    request.logPrefix,
  );
}

/**
 * What a route received: a stream it connects as it is (the Standard direct
 * call), or a bare track it connects in a stream of its own (the Standard
 * SFU and the PRO coordinator).
 */
type ReceivedAudio = { readonly stream: MediaStream } | { readonly track: MediaStreamTrack };

/**
 * Which attach starts the reception (sets the receiving flag, claims the
 * 'system-audio' owner, starts the visualizer and logs the route's line):
 * - 'first-for-slot': the first while the slot is not receiving. The Standard
 *   direct call: a replacement call's stream only swaps the source.
 * - 'first-for-route': the route's first since it was last detached, even
 *   while the slot is receiving. The Standard SFU: each subscription starts
 *   the reception again (a re-publication tears the old one down without
 *   dropping the receiving flag), with its own two-hour limit.
 * - 'every-attach': every attach, even while the slot is receiving. The PRO
 *   coordinator: each track its transports deliver (a subscription, a retry,
 *   a promotion or a new direct route) starts the reception again.
 */
type ReceptionStart = 'first-for-slot' | 'first-for-route' | 'every-attach';

interface SourceAttachRequest {
  readonly startsReception: ReceptionStart;
  /**
   * The route's step once the audio graph is confirmed and before its
   * previous source is swapped (the SFU reports a context that is not
   * running and primes its track here; the PRO coordinator primes its track).
   */
  readonly onGraphReady?: (context: AudioContext) => void;
  /**
   * The route's own bookkeeping once its source is on widener.input, before
   * an attach that starts the reception sets the receiving flag (the PRO
   * coordinator clears its direct receive deadline here).
   */
  readonly onConnected?: () => void;
  /**
   * The route's own step when its attach starts the reception, before the
   * receiving flag is set (the SFU arms its two-hour limit).
   */
  readonly onReceptionStart?: () => void;
  /**
   * The route's line when its attach starts the reception. The PRO
   * coordinator logs none (its transports log the track themselves).
   */
  readonly connectedLog?: string;
}

/**
 * The attach fence (5B-G1, P5-D5 A): a route may play into the slot only
 * while the slot's receive placeholder is the current meta. A STOP, a
 * force-stop, a deadline expiry and a share end restore the previous title,
 * and a successor owner sets its own meta, so in each of those cases the
 * placeholder is gone. Only the placeholder is read, not the slot's phase,
 * which a successor or a meta-null writer leaves 'held' when it replaces the
 * placeholder (and before 5B-G5 a start that ran through a nested end left
 * the phase 'idle' over its own placeholder). A refused attach or resume
 * writes nothing and drops what the route still holds, so nothing of the
 * share stays on widener.input once the slot ended or another owner plays.
 */
function admitsRoute(route: ReceiveRoute, input: 'attach' | 'resume'): boolean {
  if (isSystemAudioPlaceholder()) return true;
  log.debug(
    `[SysAudioGuest] Refused ${route} ${input}: the reception ended or another owner plays`,
  );
  detachSystemAudioRoute(route);
  return false;
}

/**
 * What an attach did: 'attached' (the source is on widener.input),
 * 'not-receiving' (the slot ended or another owner plays, see admitsRoute;
 * nothing written and the route's source and primer dropped) or
 * 'graph-unavailable' (the audio graph is not built; nothing changed).
 */
type SourceAttachResult = 'attached' | 'not-receiving' | 'graph-unavailable';

/**
 * Connects what a route received to widener.input. The route awaits
 * initAudio and re-checks its own identity first; this runs synchronously
 * after that, so no await separates the route's check from the graph.
 * The slot's fence comes first (admitsRoute): an attach the slot refuses
 * returns 'not-receiving' and never reaches the graph. Then it returns
 * 'graph-unavailable', changing nothing, while the audio graph is not built.
 * Otherwise it replaces the route's previous source and, when this attach
 * starts the reception (see ReceptionStart), clears the receive deadline if
 * the slot was not receiving, sets the receiving flag, claims the
 * 'system-audio' playback owner and starts the visualizer.
 */
export function attachSystemAudioSource(
  route: ReceiveRoute,
  received: ReceivedAudio,
  request: SourceAttachRequest,
): SourceAttachResult {
  if (!admitsRoute(route, 'attach')) return 'not-receiving';
  const ctx = getAudioContext();
  const widener = getWidener();
  if (!widener) return 'graph-unavailable';
  request.onGraphReady?.(ctx);

  const media = mediaOf(route);
  const routeWasAttached = media.source !== null;
  if (media.source) {
    try {
      media.source.disconnect();
    } catch {
      /* noop */
    }
  }
  media.source = ctx.createMediaStreamSource(
    'stream' in received ? received.stream : new MediaStream([received.track]),
  );
  media.source.connect(widener.input);
  request.onConnected?.();

  // Update state once at least one stream is connected
  const slotWasReceiving = getState('systemAudio.isReceiving');
  const startsReception =
    request.startsReception === 'every-attach' ||
    (request.startsReception === 'first-for-route' ? !routeWasAttached : !slotWasReceiving);
  if (startsReception) {
    // Setting the flag meets the receive deadline (its state listener in the
    // guest clears the watchdog as well); a flag already set leaves it alone.
    if (!slotWasReceiving) clearSystemAudioReceiveWatchdog();
    request.onReceptionStart?.();
    markSystemAudioReceiving();
    if (request.connectedLog) log.info(request.connectedLog);
  }
  return 'attached';
}

/**
 * The reception plays: set the receiving flag, claim the 'system-audio'
 * playback owner and start the visualizer.
 */
function markSystemAudioReceiving(): void {
  setSystemAudioReceiving(true);
  claimPlaybackOwner('system-audio');
  bus.emit('visualizer:start');
}

/**
 * The route's transport is connected again (the PRO SFU subscription's
 * 'subscribed'): while the route still has its source on widener.input, set
 * the receiving flag, claim the 'system-audio' owner and start the visualizer
 * again. A route with no source (its attach still waits, or a retry or a
 * fallback detached it) changes nothing. The resume has the attach's fence
 * (admitsRoute): once the slot ended or another owner plays, it claims
 * nothing and drops the route's source and primer.
 */
export function resumeSystemAudioRoute(route: ReceiveRoute): void {
  if (!routeMedia.get(route)?.source) return;
  if (!admitsRoute(route, 'resume')) return;
  markSystemAudioReceiving();
}

/** Drops what the route attached: its source and its decoder primer. */
export function detachSystemAudioRoute(route: ReceiveRoute): void {
  const media = mediaOf(route);
  if (media.source) {
    try {
      media.source.disconnect();
    } catch {
      /* noop */
    }
    media.source = null;
  }
  cleanupWebRtcAudioDecoderPrimer(media.primer);
  media.primer = null;
}

/**
 * Whether the route has a source on widener.input and holds a primer: the
 * route's /debug keys, for the Standard SFU whether its cleanup ends the
 * reception, and for the PRO coordinator whether its direct receive deadline
 * still has a failure to report.
 */
export function getSystemAudioReceiveRouteSnapshot(route: ReceiveRoute): {
  sourceAttached: boolean;
  decoderPrimed: boolean;
} {
  const media = routeMedia.get(route);
  return { sourceAttached: !!media?.source, decoderPrimed: !!media?.primer };
}

// ─── Trust Boundary ───────────────────────────────────────────────

function settleTrustedReceptionWaiters(generation: number, ready: boolean): void {
  for (const waiter of [...trustedReceptionWaiters]) {
    if (waiter.expectedGeneration !== generation) continue;
    trustedReceptionWaiters.delete(waiter);
    clearManagedTimer(waiter.timerName);
    waiter.resolve(ready);
  }
}

function cancelAllTrustedReceptionWaiters(): void {
  for (const waiter of [...trustedReceptionWaiters]) {
    trustedReceptionWaiters.delete(waiter);
    clearManagedTimer(waiter.timerName);
    waiter.resolve(false);
  }
}

/**
 * Resolves true once a trusted start has committed the receive placeholder
 * (at once while it is up), or false when the reception ends or no start
 * commits within the receive deadline. A route attaches nothing audible
 * before it.
 */
export function awaitTrustedSystemAudioReceptionBoundary(channel: string): Promise<boolean> {
  if (isSystemAudioPlaceholder()) return Promise.resolve(true);

  const expectedGeneration = slot.phase === 'claiming' ? slot.generation : slot.generation + 1;
  const timerName = `sys-audio-guest-trust-gate-${channel}-${++trustedReceptionWaitSeq}`;

  return new Promise<boolean>((resolve) => {
    const waiter: TrustedReceptionWaiter = {
      expectedGeneration,
      timerName,
      resolve,
    };
    trustedReceptionWaiters.add(waiter);
    setManagedTimer(
      timerName,
      () => {
        if (!trustedReceptionWaiters.delete(waiter)) return;
        resolve(false);
      },
      TRUSTED_BOUNDARY_WAIT_MS,
    );

    // The trusted START may have committed between the first placeholder
    // check and waiter publication.
    if (expectedGeneration === slot.generation && isSystemAudioPlaceholder()) {
      trustedReceptionWaiters.delete(waiter);
      clearManagedTimer(timerName);
      resolve(true);
    }
  });
}

// ─── Receive Watchdog ─────────────────────────────────────────────

/** The deadline is met: a route set the receiving flag. */
export function clearSystemAudioReceiveWatchdog(): void {
  clearManagedTimer(SYSTEM_AUDIO_RECEIVE_WATCHDOG);
  debug.watchdogActive = false;
}

function armReceiveWatchdog(): void {
  debug.watchdogArmedAt = Date.now();
  debug.watchdogActive = true;
  setManagedTimer(
    SYSTEM_AUDIO_RECEIVE_WATCHDOG,
    () => {
      if (getState('systemAudio.isReceiving')) return;
      if (!isSystemAudioPlaceholder()) return;

      debug.watchdogActive = false;
      debug.watchdogTimedOutAt = Date.now();
      log.warn('[SysAudioGuest] Timed out waiting for system audio stream');
      expireTrustedSystemAudioReception();
    },
    SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS,
  );
}

/**
 * A receive deadline passed with nothing playing (P5-D7's slot.fail): every
 * route's deadline reaction runs first, then the reception ends, then
 * receive_failed. The slot's 30 s deadline and the Standard direct call's
 * replacement deadline expire the reception here, each after its own line.
 * A reaction that throws is logged and the expiry goes on, as the bus did for
 * the system-audio:receive-timeout listeners these reactions replace.
 */
export function expireTrustedSystemAudioReception(): void {
  for (const [route, port] of routes) {
    try {
      port.onDeadline?.();
    } catch (error) {
      log.error(`[SysAudioGuest] Receive deadline reaction of ${route} failed:`, error);
    }
  }
  endTrustedSystemAudioReception();
  bus.emit('ui:show-toast', t('system_audio.receive_failed'));
}

/**
 * A route stopped playing inside its reception. Keep the placeholder and the
 * restore point, but make the next attach or resume earn the receiving state
 * again. With `deadline: 'slot'` (a Standard delivery handoff, below) the
 * slot deadline bounds the wait from now. The PRO coordinator passes
 * `deadline: 'route'` (its SFU disconnect grace, a retry, a receiver
 * fallback): it owns its deadlines, the retry backoff and the direct receive
 * deadline, as it does at its start.
 */
export function interruptTrustedSystemAudioReception(options: {
  readonly deadline: ReceiveDeadline;
}): void {
  setSystemAudioReceiving(false);
  if (options.deadline === 'slot') armReceiveWatchdog();
}

/**
 * A Standard route handed delivery to another (the SFU retry to a pending
 * READY, or the SFU giving way to a direct call): while the placeholder is
 * up, interrupt the reception under the slot deadline, so the next route
 * earns the receiving state again within it. The SFU adapter keeps the
 * guest-role check.
 */
export function handOffTrustedSystemAudioReception(): void {
  if (!isSystemAudioPlaceholder()) return;
  interruptTrustedSystemAudioReception({ deadline: 'slot' });
}

// ─── End ──────────────────────────────────────────────────────────

/**
 * Ends the reception for every route (the Standard direct call and SFU, the
 * PRO coordinator, STOP and force-stop). A newer playback owner that already
 * replaced this slot keeps its title and lifecycle; only the slot's own
 * placeholder or 'system-audio' claim is restored. Since 5B-G4 a
 * 'system-audio' owner with the sharer's meta is this device's own share,
 * not the slot's claim: the end does all of its own work and leaves that
 * claim to the capture module.
 *
 * Since 5B-G5 an end nested in a start before its placeholder claim (the
 * start's stopAllMedia emits force-stop while local capture runs) ends what
 * preceded that start, not the start: the slot stays 'claiming' with the
 * start's generation and restore point, so the start commits into 'held'
 * and its own end restores what it took, and a boundary wait opened after
 * this end joins the start. Such an end still answers the open waiters,
 * clears the deadline, runs the route ports and drops the receiving flag,
 * and writes no title (the start claims the slot right after). An end once
 * the start's placeholder is up ends that start, as any end does.
 */
export function endTrustedSystemAudioReception(): void {
  const nestedInStart = slot.phase === 'claiming' && !isSystemAudioPlaceholder();
  // Consume the restore point before closing the routes. Synchronous close
  // callbacks and repeated room-leave cleanup must never replay an earlier
  // snapshot. A nested end leaves the start's restore point to the start.
  const restoreMeta = slot.phase === 'idle' || nestedInStart ? null : slot.restoreMeta;
  if (!nestedInStart) slot = { phase: 'idle', generation: slot.generation + 1 };
  cancelAllTrustedReceptionWaiters();
  debug.lastCleanupAt = Date.now();
  const wasSystemAudioPlaceholder = isSystemAudioPlaceholder();
  const wasSlotClaim =
    !nestedInStart &&
    isSystemAudioOwner() &&
    !isSharerMeta(getState('player.currentTrackMeta') as TrackMeta | null);
  clearSystemAudioReceiveWatchdog();
  for (const port of routes.values()) port.endReception?.();

  setSystemAudioReceiving(false);
  if (!wasSystemAudioPlaceholder && !wasSlotClaim) {
    // A newer playback owner already replaced this receive slot, the
    // 'system-audio' owner is the sharer's own claim, or the end is nested
    // in a start that claims the slot right after. Tear down the stale
    // graph, but never write its title or lifecycle over that owner.
    return;
  }

  // Restore the previous title before releasing system-audio ownership.
  setPlaybackTrackMeta(restoreMeta);
  releasePlaybackOwner('system-audio', {
    force: wasSystemAudioPlaceholder,
  });
  setPlaybackIdle();
}

// ─── Start ────────────────────────────────────────────────────────

/**
 * Enter the trusted receive placeholder without requiring a legacy host
 * frame. PRO rooms call this only after authenticating the server-owned
 * live-share lease.
 *
 * `deadline` names who bounds the wait (ReceiveDeadline): the Standard routes
 * pass 'slot', the PRO coordinator 'route'. The coordinator reports a failure
 * once per generation on both of its routes: the SFU subscription keeps this
 * placeholder through its backed-off retries, and the LAN-direct listener
 * keeps it past its own deadline, while the publisher promotes a listener it
 * cannot reach to the SFU. The slot deadline would instead show
 * receive_failed and drop to idle while a longer retry waits, or before a
 * slow attempt's track or a late direct offer arrives.
 */
export function beginTrustedSystemAudioReception(
  surface: unknown = 'display',
  options: { readonly deadline: ReceiveDeadline },
): boolean {
  if (isSystemAudioPlaceholder() || slot.phase === 'claiming') {
    return false;
  }
  const previous = slot;
  const generation = previous.generation + 1;
  slot = {
    phase: 'claiming',
    generation,
    restoreMeta: previous.phase === 'idle' ? null : previous.restoreMeta,
  };
  const committed = commitTrustedSystemAudioReception(generation, surface, options.deadline);
  // A reception end nested in the commit before the placeholder claim (a
  // force-stop from stopAllMedia) keeps this claim and its restore point
  // (5B-G5). Only an end once the placeholder is up (from a listener of the
  // claim) has ended this start and moved the slot on.
  if (slot.phase === 'claiming' && slot.generation === generation) {
    slot =
      committed || previous.phase === 'held'
        ? { phase: 'held', generation, restoreMeta: slot.restoreMeta }
        : { phase: 'idle', generation };
  }
  settleTrustedReceptionWaiters(generation, committed);
  return committed;
}

function commitTrustedSystemAudioReception(
  generation: number,
  surface: unknown,
  deadline: ReceiveDeadline,
): boolean {
  if (isSystemAudioPlaceholder()) return false;
  debug.lastStartAt = Date.now();
  debug.lastStartIgnoredReason = '';
  // Never the sharer's title (5B-G4): whether the share is still claimed or
  // its transition teardown left that title idle, the share is over by the
  // time this reception ends, and restoring it would show 'System Audio
  // Sharing' while idle.
  const currentMeta = getState('player.currentTrackMeta') as TrackMeta | null;
  slot = {
    phase: 'claiming',
    generation,
    restoreMeta: isSharerMeta(currentMeta) ? null : currentMeta,
  };
  stopAllMedia({ silent: true, cancelInFlight: true });
  cancelIncomingFileTransfer('system-audio-start');
  cancelRemoteShareWait('system-audio-start');
  clearManagedTimer('preloadRecoveryWatchdog');
  clearManagedTimer('preloadUiWatchdog');
  claimPlaybackOwner('system-audio', {
    pending: true,
    currentTrackMeta: createSystemAudioTrackMeta('receiving', undefined, surface),
  });
  bus.emit('system-audio:host-started');
  if (deadline === 'slot') armReceiveWatchdog();
  else clearSystemAudioReceiveWatchdog();
  return true;
}

// ─── Debug ────────────────────────────────────────────────────────

/** The Standard guest's START trust gate records a start it ignored. */
export function noteIgnoredSystemAudioStart(reason: string): void {
  debug.lastStartIgnoredAt = Date.now();
  debug.lastStartIgnoredReason = reason;
}

export function getSystemAudioReceiveSlotDebugSnapshot() {
  return { ...debug };
}
