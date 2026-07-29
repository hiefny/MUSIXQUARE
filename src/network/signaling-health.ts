import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getState, setState } from '../core/state.ts';
import type { DataConnection, SignalingHealthState } from '../types/index.ts';

export const SIGNALING_RECOVERY_MAX_ATTEMPTS = 5;
const SIGNALING_RECOVERED_VISIBLE_MS = 4_000;

const RECOVERED_CLEAR_TIMER = 'signaling-health-recovered-clear';
const HEALTHY_STATE: SignalingHealthState = Object.freeze({
  status: 'healthy',
  attempt: 0,
  maxAttempts: SIGNALING_RECOVERY_MAX_ATTEMPTS,
});

function hasOpenStandardRoomChannel(): boolean {
  const role = getState('network.appRole');
  if (role === 'host') {
    return getState('network.connectedPeers').some(
      (peer) => (peer.conn as DataConnection | null)?.open === true,
    );
  }
  if (role === 'guest') return getState('network.hostConn')?.open === true;
  return false;
}

/**
 * Whether a signaling outage is a partial outage rather than a dead session.
 * PRO authority is server-backed, so an accepted PRO room remains an active
 * session surface while its control channel is rebuilt. Ordinary rooms need
 * a live data channel or media that can continue locally.
 */
function canContinueWithoutSignaling(): boolean {
  if (!getState('setup.sessionStarted')) return false;
  const room = getState('room.context');
  if (room.kind === 'pro') return room.roomId !== null;
  return (
    hasOpenStandardRoomChannel() ||
    getState('playback.activity') !== 'idle' ||
    getState('systemAudio.isReceiving')
  );
}

/**
 * Whether the current session can keep an in-place signaling recovery surface.
 *
 * A standard-room host with no participants or active media cannot "continue"
 * meaningful playback yet, but its room identity is still recoverable and is
 * exactly where an unavailable invite path needs an explicit retry action.
 * Keep that case separate from the stricter live-session survival predicate.
 */
export function canRecoverSignalingInPlace(): boolean {
  if (!getState('setup.sessionStarted')) return false;
  const room = getState('room.context');
  if (room.kind === 'pro') return room.roomId !== null;
  if (canContinueWithoutSignaling()) return true;
  return getState('network.appRole') === 'host' && /^\d{6}$/.test(getState('network.sessionCode'));
}

function setHealth(next: SignalingHealthState): void {
  const current = getState('network.signalingHealth');
  if (
    current.status === next.status &&
    current.attempt === next.attempt &&
    current.maxAttempts === next.maxAttempts
  ) {
    return;
  }
  setState('network.signalingHealth', next);
}

export function publishSignalingReconnectAttempt(
  attempt: number,
  maxAttempts = SIGNALING_RECOVERY_MAX_ATTEMPTS,
): boolean {
  clearManagedTimer(RECOVERED_CLEAR_TIMER);
  if (!canRecoverSignalingInPlace()) {
    resetSignalingHealth();
    return false;
  }
  const normalizedMax = Math.max(1, Math.trunc(maxAttempts));
  setHealth({
    status: 'reconnecting',
    attempt: Math.min(normalizedMax, Math.max(1, Math.trunc(attempt))),
    maxAttempts: normalizedMax,
  });
  return true;
}

export function publishSignalingExhausted(maxAttempts = SIGNALING_RECOVERY_MAX_ATTEMPTS): boolean {
  clearManagedTimer(RECOVERED_CLEAR_TIMER);
  if (!canRecoverSignalingInPlace()) {
    resetSignalingHealth();
    return false;
  }
  setHealth({
    status: 'exhausted',
    attempt: 0,
    maxAttempts: Math.max(1, Math.trunc(maxAttempts)),
  });
  return true;
}

export function publishSignalingRecovered(): void {
  const current = getState('network.signalingHealth');
  if (current.status === 'healthy' || current.status === 'recovered') return;
  if (!canRecoverSignalingInPlace()) {
    resetSignalingHealth();
    return;
  }

  const recovered: SignalingHealthState = {
    status: 'recovered',
    attempt: 0,
    maxAttempts: current.maxAttempts,
  };
  setHealth(recovered);
  clearManagedTimer(RECOVERED_CLEAR_TIMER);
  setManagedTimer(
    RECOVERED_CLEAR_TIMER,
    () => {
      if (getState('network.signalingHealth') === recovered) {
        setHealth(HEALTHY_STATE);
      }
    },
    SIGNALING_RECOVERED_VISIBLE_MS,
  );
}

export function resetSignalingHealth(): void {
  clearManagedTimer(RECOVERED_CLEAR_TIMER);
  setHealth(HEALTHY_STATE);
}

export const __signalingHealthForTests = {
  RECOVERED_CLEAR_TIMER,
  SIGNALING_RECOVERED_VISIBLE_MS,
};
