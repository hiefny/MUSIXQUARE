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
 * owner.
 *
 * Phase 5 C4-2 moved it here from system-audio-guest.ts unchanged. The route
 * adapters (the Standard direct call and SFU, the PRO coordinator) still
 * attach their own sources; later Phase 5 increments move those attaches
 * into this slot. Until then system-audio-guest.ts keeps the old names as
 * aliases, and the timer names keep their `sys-audio-guest-` prefix.
 *
 * Deferred-only: it loads with the room session (vite.config.ts
 * DEFERRED_ENTRY_MODULES).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
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
import type { TrackMeta } from '../types/index.ts';

// ─── Tuning ───────────────────────────────────────────────────────

const SYSTEM_AUDIO_RECEIVE_WATCHDOG = 'sys-audio-guest-receive-watchdog';
// A route's track that arrives before the trusted start waits at the boundary
// for as long as a start may wait for a route.
const TRUSTED_BOUNDARY_WAIT_MS = SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS;

// ─── Slot State ───────────────────────────────────────────────────

/**
 * What the slot stores. Only what cannot be read back is kept: the reception
 * generation that fences boundary waits and the restore point a start took.
 * Whether the slot is pending (the system-audio placeholder meta) or receiving
 * (systemAudio.isReceiving) is read from player state at each input, because
 * other writers change both: leaveSession's reset and a successor playback
 * owner.
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

let slot: ReceiveSlot = { phase: 'idle', generation: 0 };
const routes = new Map<ReceiveRoute, ReceiveRoutePort>();

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
