/**
 * Keep-the-app-open guidance.
 *
 * A hidden tab stops its own audio, and in a Standard room a hidden or frozen
 * host stops the whole room. First-time visitors get one dialog saying so when
 * the room's first media appears; in a PRO room, where the server keeps the
 * room, it leaves out the host sentence. Standard-room guests then see the
 * header loader while the host is in the background or not answering, a toast
 * when it returns, and an offer to leave after a long silence.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { scheduleDocumentReload } from '../core/session-reset.ts';
import { hasAppUseRecord } from '../demo/storage.ts';
import { t } from '../i18n/index.ts';
import { getHostPresence } from '../network/host-presence.ts';
import { getRoomContext } from '../rooms/authority.ts';
import type { HostPresence } from '../types/index.ts';
import { showDialog } from './dialog.ts';
import { showLoader, showToast } from './toast.ts';

const HOST_WAIT_LOADER_ID = 'host-presence';
/** A host that only glances at another app should not flash the loader. */
const BACKGROUND_LOADER_DELAY_MS = 2_000;
const BACKGROUND_LOADER_TIMER = 'host-presence-loader-delay';

// ─── First media ────────────────────────────────────────────────────

/** Read at boot, before the Start gesture records this visit as app use. */
let firstVisit = false;
let keepOpenOffered = false;

function offerKeepOpenOnFirstMedia(): void {
  if (!firstVisit || keepOpenOffered) return;
  if (!getState('setup.sessionStarted')) return;
  if (getState('demo.active') || getState('playlist.items').length === 0) return;
  keepOpenOffered = true;
  showDialog({
    title: t('dialog.keep_open_title'),
    message: t(
      getRoomContext().kind === 'pro' ? 'dialog.keep_open_message_pro' : 'dialog.keep_open_message',
    ),
    buttonText: t('dialog.got_it'),
  }).catch((error: unknown) => log.warn('[KeepOpen] First-media notice failed', error));
}

// ─── Host presence ──────────────────────────────────────────────────

let hostWaitShown = false;
let leaveOffer: AbortController | null = null;

function showHostWait(): void {
  clearManagedTimer(BACKGROUND_LOADER_TIMER);
  if (hostWaitShown) return;
  hostWaitShown = true;
  // Nothing else in the room can progress while the host is away, so this
  // loader stays in front of any transfer the guest is also running. Waiting
  // has no progress to show, so its bar stays empty, like a preparing loader.
  showLoader(true, t('network.host_waiting'), HOST_WAIT_LOADER_ID, { priority: true });
}

/** Returns whether the loader was on screen. */
function hideHostWait(): boolean {
  clearManagedTimer(BACKGROUND_LOADER_TIMER);
  if (!hostWaitShown) return false;
  hostWaitShown = false;
  showLoader(false, undefined, HOST_WAIT_LOADER_ID);
  return true;
}

function withdrawLeaveOffer(): void {
  leaveOffer?.abort();
  leaveOffer = null;
}

function offerToLeave(): void {
  if (leaveOffer || getHostPresence() !== 'unresponsive') return;
  const offer = new AbortController();
  leaveOffer = offer;
  showDialog({
    title: t('dialog.host_unresponsive_title'),
    message: t('dialog.host_unresponsive_message'),
    buttonText: t('dialog.keep_waiting'),
    secondaryText: t('dialog.leave_session'),
    signal: offer.signal,
  })
    .then((result) => {
      if (leaveOffer === offer) leaveOffer = null;
      if (result.action === 'secondary') scheduleDocumentReload(t('dialog.leaving_session'));
    })
    .catch((error: unknown) => {
      if (leaveOffer === offer) leaveOffer = null;
      log.warn('[KeepOpen] Leave offer failed', error);
    });
}

function handlePresenceChanged(
  next: HostPresence,
  _previous: HostPresence,
  cause: 'host' | 'reset',
): void {
  if (next !== 'unresponsive') withdrawLeaveOffer();
  if (next === 'ok') {
    if (hideHostWait() && cause === 'host') showToast(t('toast.host_back'));
    return;
  }
  if (next === 'unresponsive') {
    showHostWait();
    return;
  }
  if (!hostWaitShown) {
    setManagedTimer(
      BACKGROUND_LOADER_TIMER,
      () => {
        if (getHostPresence() !== 'ok') showHostWait();
      },
      BACKGROUND_LOADER_DELAY_MS,
    );
  }
}

// ─── Init ───────────────────────────────────────────────────────────

let initialized = false;

export function initKeepOpenNotice(): void {
  if (initialized) return;
  initialized = true;
  firstVisit = !hasAppUseRecord();
  bus.on('state:playlist.items', offerKeepOpenOnFirstMedia);
  bus.on('state:demo.active', offerKeepOpenOnFirstMedia);
  // A guest joining a room with media gets the playlist before its session
  // counts as started, so check again once it does.
  bus.on('state:setup.sessionStarted', offerKeepOpenOnFirstMedia);
  bus.on('host-presence:changed', handlePresenceChanged);
  bus.on('host-presence:long-unresponsive', offerToLeave);
  bus.on('i18n:changed', () => {
    if (hostWaitShown) showLoader(true, t('network.host_waiting'), HOST_WAIT_LOADER_ID);
  });
}
