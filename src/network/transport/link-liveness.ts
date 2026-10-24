/**
 * Liveness of one Standard-room logical connection: a CloudflareDataConnection
 * with its original PC and optional isolated control route (RO-15).
 *
 * For now this holds only why the link closed. The connection keeps its
 * grace, restart gate and resume probe, and records the first cause at the
 * top of terminate(); the close itself is unchanged.
 */
import { log } from '../../core/log.ts';
import type { SideRouteFailure } from './control-isolation.ts';
import type { TransportCloseReason } from './types.ts';

/**
 * The connection names the causes it decides itself. The provider and the
 * application name theirs through close(reason); a close that names nothing
 * is intentional.
 */
export type LinkCloseCause =
  | 'control-send-failed'
  | `side-failed:${SideRouteFailure}`
  | 'channel-closed'
  | 'original-terminal'
  | 'original-grace-expired'
  | 'resume-probe-unanswered'
  | 'resume-stale'
  | 'resume-disconnected'
  | TransportCloseReason
  | 'intentional';

/**
 * Returns the cause the close keeps, reporting it once. The first cause wins:
 * disposing the PC and channels re-enters terminate() with their own causes.
 */
export function recordLinkClose(
  recorded: LinkCloseCause | null,
  cause: LinkCloseCause,
  peerId: string,
): LinkCloseCause {
  if (recorded) return recorded;
  log.info(`[Transport] Logical connection closed (${cause}) for ${peerId}`);
  return cause;
}
