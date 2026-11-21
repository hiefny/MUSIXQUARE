/**
 * Offline room guidance for Standard room setup (room creation and a guest
 * join): a failure names the network only when the browser reports no network
 * at the moment the failure is handled, and no server answered it. Nothing is
 * checked before an attempt, so a stale offline report never blocks one that
 * would work, and while the browser reports a network every failure keeps its
 * own copy.
 */

import { isBrowserReportedOffline } from '../core/browser-offline.ts';

/**
 * A failure that reached setup without a server answer: an error event that
 * holds no HTTP status (a WebSocket error, or the HTTPS bridge's error when
 * its request got no response), a deadline or socket close that the provider
 * raises as type 'network' (Worker frames never use that type), and the peer
 * open and guest join deadlines. A Worker frame keeps its own type and a
 * bridge response keeps its HTTP status, so both stay outside. A refused
 * WebSocket upgrade also reaches the page without its HTTP status, so with a
 * stale offline report that refusal reads as no network too.
 */
function carriesNoServerAnswer(error: unknown): boolean {
  if (typeof Event !== 'undefined' && error instanceof Event) {
    const { status } = error as Event & { status?: unknown };
    return status === undefined || status === null;
  }
  if (!(error instanceof Error)) return false;
  return (
    (error as Error & { type?: unknown }).type === 'network' ||
    error.message === 'PEER_OPEN_TIMEOUT' ||
    error.message === 'HOST_UNREACHABLE'
  );
}

export function isOfflineSignalingSetupFailure(error: unknown): boolean {
  return isBrowserReportedOffline() && carriesNoServerAnswer(error);
}
