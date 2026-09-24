/** A parked preload is healthy while this receiver's foreground bytes advance. */
import { getState } from '../core/state.ts';
import { TRANSFER_STATE } from '../core/constants.ts';
import { setManagedTimer } from '../core/timers.ts';

let mainProgress: { queueItemId: string; sessionId: number; revision: number } | null = null;

/** Accepted bytes, rather than headers or a counter that recovery can reset. */
export function recordMainReceiveProgress(queueItemId: string, sessionId: number): void {
  mainProgress = { queueItemId, sessionId, revision: (mainProgress?.revision ?? 0) + 1 };
}

function foregroundProgress(preloadSessionId: number): Map<string, number> {
  const progress = new Map<string, number>();
  const queueItemId = getState('playlist.currentQueueItemId');
  const meta = getState('transfer.meta');
  const state = getState('transfer.state');
  const resident = getState('files.current');
  if (
    queueItemId &&
    meta?.queueItemId === queueItemId &&
    (state === TRANSFER_STATE.RECEIVING ||
      state === TRANSFER_STATE.PROCESSING ||
      (state === TRANSFER_STATE.READY &&
        resident?.queueItemId === queueItemId &&
        resident.sessionId === meta.sessionId)) &&
    getState('transfer.receivedCount') > 0 &&
    mainProgress?.queueItemId === queueItemId &&
    mainProgress.sessionId === meta.sessionId
  ) {
    progress.set('main', mainProgress.revision);
  }
  // A next-track preload can become the current track before all guests finish.
  for (const [sid, session] of getState('preload.sessionState')) {
    if (
      sid !== preloadSessionId &&
      queueItemId &&
      session.queueItemId === queueItemId &&
      !session.skipped
    ) {
      progress.set(`preload:${sid}:${queueItemId}`, session.progress || 0);
    }
  }
  return progress;
}

export function armPreloadAdmissionWatchdog(
  sessionId: number,
  timeoutMs: number,
  onStalled: () => void,
): void {
  // Snapshot accepted progress even for currently ineligible identities. A
  // later selection/state/metadata change must not turn old bytes into progress.
  const checkpoint = new Map(
    [...getState('preload.sessionState')].map(([sid, session]): [string, number] => [
      `preload:${sid}:${session.queueItemId}`,
      session.progress || 0,
    ]),
  );
  checkpoint.set('main', mainProgress?.revision ?? 0);
  setManagedTimer(
    `preload-admission-watchdog-${sessionId}`,
    () => {
      const session = getState('preload.sessionState').get(sessionId);
      if (!session || session.finalized || session.skipped) return;
      const advanced = [...foregroundProgress(sessionId)].some(
        ([identity, count]) => count > (checkpoint.get(identity) ?? 0),
      );
      if (advanced) {
        // Final bytes still count after the receive handler marks the source
        // complete, allowing a parked sender to resume at the deadline. The new
        // checkpoint consumes that progress: no more bytes means expiry in 15 s.
        armPreloadAdmissionWatchdog(sessionId, 15_000, onStalled);
      } else onStalled();
    },
    timeoutMs,
  );
}
