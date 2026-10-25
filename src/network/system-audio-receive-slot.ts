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
 * unchanged, C4-3 the Standard direct call's attach and primer, and C4-4 the
 * Standard SFU guest's. The PRO coordinator still attaches its own source; a
 * later Phase 5 increment moves that attach into this slot. Until then
 * system-audio-guest.ts keeps the old names as aliases, and the timer names
 * keep their `sys-audio-guest-` prefix.
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
   * and another start is refused until it returns.
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

/** The routes that receive into the slot. */
type ReceiveRoute = 'standard-direct' | 'standard-sfu' | 'pro-sfu' | 'pro-direct';

interface ReceiveRoutePort {
  /**
   * Closes what the route holds for the reception when it ends, whichever
   * route ends it: after the restore point is taken and the watchdog cleared,
   * before the receiving flag drops and the title is restored.
   */
  readonly endReception: () => void;
}

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

// ─── Routes ───────────────────────────────────────────────────────

/** A route adapter joins the end of every reception (one port per route). */
export function registerSystemAudioReceiveRoute(route: ReceiveRoute, port: ReceiveRoutePort): void {
  routes.set(route, port);
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
 * SFU).
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
 */
type ReceptionStart = 'first-for-slot' | 'first-for-route';

interface SourceAttachRequest {
  readonly startsReception: ReceptionStart;
  /**
   * The route's step once the audio graph is confirmed and before its
   * previous source is swapped (the SFU reports a context that is not
   * running and primes its track here).
   */
  readonly onGraphReady?: (context: AudioContext) => void;
  /**
   * The route's own bookkeeping once its source is on widener.input, before
   * an attach that starts the reception sets the receiving flag.
   */
  readonly onConnected?: () => void;
  /**
   * The route's own step when its attach starts the reception, before the
   * receiving flag is set (the SFU arms its two-hour limit).
   */
  readonly onReceptionStart?: () => void;
  /** The route's line when its attach starts the reception. */
  readonly connectedLog: string;
}

/**
 * Connects what a route received to widener.input. The route awaits
 * initAudio and re-checks its own identity first; this runs synchronously
 * after that, so no await separates the route's check from the graph.
 * Returns false, changing nothing, while the audio graph is not built.
 * Otherwise it replaces the route's previous source and, when this attach
 * starts the reception (see ReceptionStart), clears the receive deadline if
 * the slot was not receiving, sets the receiving flag, claims the
 * 'system-audio' playback owner and starts the visualizer.
 */
export function attachSystemAudioSource(
  route: ReceiveRoute,
  received: ReceivedAudio,
  request: SourceAttachRequest,
): boolean {
  const ctx = getAudioContext();
  const widener = getWidener();
  if (!widener) return false;
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
    request.startsReception === 'first-for-route' ? !routeWasAttached : !slotWasReceiving;
  if (startsReception) {
    // Setting the flag meets the receive deadline (its state listener in the
    // guest clears the watchdog as well); a flag already set leaves it alone.
    if (!slotWasReceiving) clearSystemAudioReceiveWatchdog();
    request.onReceptionStart?.();
    setSystemAudioReceiving(true);
    claimPlaybackOwner('system-audio');
    bus.emit('visualizer:start');
    log.info(request.connectedLog);
  }
  return true;
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
 * route's /debug keys, and for the Standard SFU whether its cleanup ends the
 * reception.
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
      bus.emit('system-audio:receive-timeout');
      endTrustedSystemAudioReception();
      bus.emit('ui:show-toast', t('system_audio.receive_failed'));
    },
    SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS,
  );
}

/**
 * A Standard route handed delivery to another (the SFU retry or the bounded
 * direct fallback). Keep the placeholder and the restore point, but make the
 * next route earn the receiving state again under the watchdog.
 */
export function interruptTrustedSystemAudioReception(): void {
  setSystemAudioReceiving(false);
  armReceiveWatchdog();
}

// ─── End ──────────────────────────────────────────────────────────

/**
 * Ends the reception for every route (the Standard direct call and SFU, the
 * PRO coordinator, STOP and force-stop). A newer playback owner that already
 * replaced this slot keeps its title and lifecycle; only the slot's own
 * placeholder or 'system-audio' claim is restored.
 */
export function endTrustedSystemAudioReception(): void {
  // Consume the restore point before closing the routes. Synchronous close
  // callbacks and repeated room-leave cleanup must never replay an earlier
  // snapshot.
  const restoreMeta = slot.phase === 'idle' ? null : slot.restoreMeta;
  slot = { phase: 'idle', generation: slot.generation + 1 };
  cancelAllTrustedReceptionWaiters();
  debug.lastCleanupAt = Date.now();
  const wasSystemAudioPlaceholder = isSystemAudioPlaceholder();
  const wasSystemAudioOwner = isSystemAudioOwner();
  clearSystemAudioReceiveWatchdog();
  for (const port of routes.values()) port.endReception();

  setSystemAudioReceiving(false);
  if (!wasSystemAudioOwner && !wasSystemAudioPlaceholder) {
    // A newer playback owner already replaced this receive slot. Tear down
    // the stale graph, but never write its title or lifecycle over the winner.
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
 * `receiveWatchdog: false` leaves the receive deadline to the caller. The PRO
 * coordinator reports a failure once per generation on both routes: the SFU
 * subscription keeps this placeholder through its backed-off retries, and the
 * LAN-direct listener keeps it past its own deadline, while the publisher
 * promotes a listener it cannot reach to the SFU. The watchdog would instead
 * show receive_failed and drop to idle while a longer retry waits, or before a
 * slow attempt's track or a late direct offer arrives.
 */
export function beginTrustedSystemAudioReception(
  surface: unknown = 'display',
  options: { receiveWatchdog?: boolean } = {},
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
  const committed = commitTrustedSystemAudioReception(
    generation,
    surface,
    options.receiveWatchdog ?? true,
  );
  // A reception end nested in the commit (a force-stop from stopAllMedia)
  // has already moved the slot on, and emptied this start's restore point.
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
  receiveWatchdog: boolean,
): boolean {
  if (isSystemAudioPlaceholder()) return false;
  debug.lastStartAt = Date.now();
  debug.lastStartIgnoredReason = '';
  slot = {
    phase: 'claiming',
    generation,
    restoreMeta: getState('player.currentTrackMeta') as TrackMeta | null,
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
  if (receiveWatchdog) armReceiveWatchdog();
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
