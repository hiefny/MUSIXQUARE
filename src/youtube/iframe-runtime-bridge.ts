type YouTubeIframeRuntimeHooks = {
  hideTapToPlayGate(): void;
  invalidateDurationCache(): void;
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

export function invalidateYtDurationCacheFromSync(): void {
  runtimeHooks?.invalidateDurationCache();
}
