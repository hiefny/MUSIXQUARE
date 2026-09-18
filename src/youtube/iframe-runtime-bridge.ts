import type { YouTubePlayerInstance } from './_state.ts';
import type { RetainedPlayerSyncHandoffRequest } from './retained-player-controller.ts';

type YouTubeIframeRuntimeHooks = {
  expectMetadataVideoId(videoId: string | null): void;
  prepareMediaReplacement(
    player: YouTubePlayerInstance,
    request: RetainedPlayerSyncHandoffRequest,
  ): boolean;
  hideTapToPlayGate(): void;
  invalidateDurationCache(): void;
  cancelGuestEndedFallback(): void;
};

let runtimeHooks: YouTubeIframeRuntimeHooks | null = null;

/**
 * Bind iframe-owned UI/cache mutations without making sync.ts import the
 * iframe module that already depends on sync.ts.
 */
export function configureYouTubeIframeRuntimeHooks(next: YouTubeIframeRuntimeHooks): void {
  runtimeHooks = next;
}

export function hideYouTubeTapToPlayGateFromSync(): void {
  runtimeHooks?.hideTapToPlayGate();
}

export function prepareYouTubeMediaReplacementFromSync(
  player: YouTubePlayerInstance,
  request: RetainedPlayerSyncHandoffRequest,
): boolean {
  if (runtimeHooks && !runtimeHooks.prepareMediaReplacement(player, request)) return false;
  return true;
}

export function expectYouTubeMetadataVideoIdFromSync(videoId: string | null): void {
  runtimeHooks?.expectMetadataVideoId(videoId);
}

export function invalidateYtDurationCacheFromSync(): void {
  runtimeHooks?.invalidateDurationCache();
}

/** Host frames retire the exact ENDED timeout, including an already queued callback. */
export function cancelGuestEndedFallbackFromSync(): void {
  runtimeHooks?.cancelGuestEndedFallback();
}
