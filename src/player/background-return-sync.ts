/**
 * Background-return Sync.
 *
 * Owner decision 2026-10-20: every return from the background inside an
 * active room performs the same room alignment as pressing the Sync button,
 * whatever the room kind, media, role, or play/pause state. The button's
 * nudge panel, toasts, and pending label are interaction feedback and are not
 * part of this step.
 *
 * It runs once per return, as the last stage of the background-resume
 * recovery (after peer, wake-lock, and audio-output recovery), and chooses
 * the button's branch for the current room:
 *
 *   PRO, file or YouTube, any role ...... full playback reconciliation
 *                                          (the button's youtubeOnly:false
 *                                          rendezvous), merged with the PRO
 *                                          runtime's own foreground repair
 *   Standard host, YouTube .............. manual YouTube sync broadcast
 *   Standard guest, YouTube ............. guest rendezvous, retried while busy
 *                                          or still waiting for a live host
 *                                          snapshot
 *   Standard guest, file ................ forced file re-sync
 *   Standard host, file ................. nothing room-wide: the button only
 *                                          opens the nudge panel. Audio
 *                                          recovery still rebuilds this
 *                                          device's own output when it broke
 *   System audio, demo, no media ........ nothing (Sync does not apply)
 *
 * Threshold: the step runs for every return the background-resume guard
 * recognizes, i.e. every hidden period of at least
 * DEFAULT_RECOVER_THRESHOLD_MS (1 s), with no further minimum. Shorter
 * visibility bounces (tab previews, DevTools, browser chrome) are not returns
 * from the background, and a Sync on a Standard host makes every guest
 * re-rendezvous. Bursts are absorbed by the guard's single flight plus one
 * coalesced follow-up, the PRO reconciliation merge, the guest rendezvous
 * cooldown, and the single retry chain below, which a newer return replaces.
 *
 * Local-file output that audio recovery already owns for this return is left
 * to it: a recovery dialog's gesture, a pending native AudioContext recovery,
 * or a published `playback:local-output-rejoin` each perform this same
 * participant-local alignment once the output is back, so a second Sync here
 * would only fight them.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { TransportBackgroundRecoveryResult } from '../network/transport/types.ts';
import { getRoomContext, isActiveStandardRoomCoordinator } from '../rooms/authority.ts';
import { broadcastYouTubeSync, guestRendezvousSync } from '../youtube/sync.ts';
import { isYouTubeZeroStartSyncOwned } from '../youtube/zero-start-ownership.ts';
import { getCurrentAudioBuffer } from './_state.ts';
import { isPlaybackModeFile, isPlaybackModeYouTube } from './ownership.ts';
import { getCurrentQueueItemId } from './queue-model.ts';
import { isFilePipelineBusyForPlay } from './transport.ts';

/** Same bounded schedule as the local-output rejoin router. */
const RENDEZVOUS_RETRY_MS = [250, 750, 1_500, 3_000, 5_000] as const;
const RENDEZVOUS_RETRY_TIMER = 'background-return-sync-rendezvous-retry';

type BackgroundReturnSyncAction =
  | 'pro-reconcile'
  | 'host-youtube-broadcast'
  | 'guest-youtube-rendezvous'
  | 'guest-file-resync'
  | 'host-file-local'
  | 'none';

interface BackgroundReturnSyncContext {
  /** Foreground transport reconciliation for this return. */
  readonly peerRecovery: TransportBackgroundRecoveryResult | null;
  /** Audio recovery owns, or already published, this return's file alignment. */
  readonly fileOutputOwned: boolean;
}

interface RendezvousRetryIdentity {
  readonly hostConn: unknown;
  readonly roomKind: string;
  readonly roomId: string | null;
  readonly roomEpoch: number;
  readonly queueItemId: string | null;
}

// Each return replaces the previous return's retry chain.
let rendezvousChain = 0;

function captureRendezvousIdentity(): RendezvousRetryIdentity {
  const room = getRoomContext();
  return {
    hostConn: getState('network.hostConn'),
    roomKind: room.kind,
    roomId: room.roomId,
    roomEpoch: room.epoch,
    queueItemId: getCurrentQueueItemId(),
  };
}

function rendezvousIdentityStillCurrent(identity: RendezvousRetryIdentity): boolean {
  const room = getRoomContext();
  const hostConn = getState('network.hostConn');
  return (
    document.visibilityState === 'visible' &&
    getState('setup.sessionStarted') &&
    isPlaybackModeYouTube() &&
    hostConn === identity.hostConn &&
    hostConn?.open === true &&
    room.kind === identity.roomKind &&
    room.roomId === identity.roomId &&
    room.epoch === identity.roomEpoch &&
    getCurrentQueueItemId() === identity.queueItemId
  );
}

function attemptGuestRendezvous(
  chain: number,
  identity: RendezvousRetryIdentity,
  attempt: number,
): void {
  if (chain !== rendezvousChain || !rendezvousIdentityStillCurrent(identity)) return;
  // A guest-local alignment: it sends nothing to the host and acts only on a
  // fresh host snapshot. After a long absence every snapshot queued before
  // the suspension is too old, so it waits ('awaiting-snapshot') until the
  // live connection delivers a heartbeat. That also makes it safe while the
  // transport is still probing a possibly stale connection ('monitoring'): a
  // dead connection is closed instead and ends this chain.
  const result = guestRendezvousSync({
    silent: true,
    suppressProgressToast: true,
    deferMissingHostSnapshot: true,
  });
  if (
    result.status !== 'busy' &&
    result.status !== 'awaiting-snapshot' &&
    result.status !== 'no-data'
  ) {
    return;
  }
  const scheduledDelay = RENDEZVOUS_RETRY_MS[attempt];
  if (scheduledDelay === undefined) {
    log.info('[BackgroundReturnSync] Guest rendezvous retries exhausted', {
      status: result.status,
    });
    return;
  }
  const delayMs =
    result.status === 'busy' ? (result.retryAfterMs ?? scheduledDelay) : scheduledDelay;
  setManagedTimer(
    RENDEZVOUS_RETRY_TIMER,
    () => attemptGuestRendezvous(chain, identity, attempt + 1),
    Math.max(10, delayMs),
  );
}

function cancelGuestRendezvousRetry(): number {
  clearManagedTimer(RENDEZVOUS_RETRY_TIMER);
  return ++rendezvousChain;
}

function requestProReconciliation(): void {
  // Keep the ordinary initial bundle free of the PRO runtime, matching the
  // Sync button's own boundary.
  void import('../pro-room/runtime.ts')
    .then(({ requestProRoomBackgroundReturnSync }) => {
      requestProRoomBackgroundReturnSync();
    })
    .catch((error: unknown) => {
      log.warn('[BackgroundReturnSync] PRO reconciliation failed to start', error);
    });
}

function resolveAction(context: BackgroundReturnSyncContext): BackgroundReturnSyncAction {
  if (document.visibilityState !== 'visible') return 'none';
  if (!getState('setup.sessionStarted') || getState('demo.active')) return 'none';
  const isFile = isPlaybackModeFile();
  const isYouTube = isPlaybackModeYouTube();
  // System audio has no Sync; with no media there is nothing to align.
  if (!isFile && !isYouTube) return 'none';
  if (isYouTube && isYouTubeZeroStartSyncOwned()) return 'none';
  if (isFile && context.fileOutputOwned) return 'none';

  if (getRoomContext().kind === 'pro') return 'pro-reconcile';

  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    if (!isActiveStandardRoomCoordinator()) return 'none';
    return isYouTube ? 'host-youtube-broadcast' : 'host-file-local';
  }
  // A probe that already closed a stale guest connection hands the room to
  // the HOST_DISCONNECTED reconnect path, which re-syncs on rejoin.
  if (!hostConn.open || context.peerRecovery?.status === 'stale-connection-closed') {
    return 'none';
  }
  if (isYouTube) return 'guest-youtube-rendezvous';
  if (isFilePipelineBusyForPlay() || !getCurrentAudioBuffer()) return 'none';
  return 'guest-file-resync';
}

/** Perform this return's Sync-button-equivalent action; returns which one ran. */
export function runBackgroundReturnSync(
  context: BackgroundReturnSyncContext,
): BackgroundReturnSyncAction {
  const chain = cancelGuestRendezvousRetry();
  const action = resolveAction(context);
  if (action !== 'none') log.info(`[BackgroundReturnSync] ${action}`);
  switch (action) {
    case 'pro-reconcile':
      requestProReconciliation();
      break;
    case 'host-youtube-broadcast':
      broadcastYouTubeSync(true);
      break;
    case 'guest-youtube-rendezvous':
      attemptGuestRendezvous(chain, captureRendezvousIdentity(), 0);
      break;
    case 'guest-file-resync':
      bus.emit('sync:force-resync');
      break;
    case 'host-file-local':
    case 'none':
      break;
  }
  return action;
}
