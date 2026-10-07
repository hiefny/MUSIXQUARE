import { isYouTubeZeroStartProtocolActive } from './zero-start.ts';
import { isYouTubeZeroStartExternalFallbackPendingFromSync } from './player-runtime-bridge.ts';

/**
 * Ordinary synchronization may touch the iframe only after both zero-start
 * owners retire. A failed prepare leaves the protocol in `error`, but its
 * bounded player recovery can still own a muted, delayed local release.
 */
export function isYouTubeZeroStartSyncOwned(): boolean {
  return isYouTubeZeroStartProtocolActive() || isYouTubeZeroStartExternalFallbackPendingFromSync();
}
