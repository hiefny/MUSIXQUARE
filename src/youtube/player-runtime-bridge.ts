export interface PendingAutoSyncOptions {
  isTrackTransition?: boolean;
  /** Fresh 0-second shared start; eligible for the zero-start barrier. */
  zeroStart?: boolean;
  targetTime?: number;
  subIndex?: number;
  videoId?: string;
  skipSeek?: boolean;
  rendezvousDelayMs?: number;
  state?: 1 | 2;
}

interface YouTubePlayerRuntimeHooks {
  cancelPendingAutoSync(): void;
  consumePendingAutoSyncOnReady(): PendingAutoSyncOptions | null;
  isYouTubeZeroStartExternalFallbackActive(): boolean;
  isYouTubeZeroStartExternalFallbackPending(): boolean;
  setPendingAutoSyncOnReady(active: boolean, options?: PendingAutoSyncOptions | null): void;
}

const unavailableHooks: YouTubePlayerRuntimeHooks = {
  cancelPendingAutoSync: () => undefined,
  consumePendingAutoSyncOnReady: () => null,
  isYouTubeZeroStartExternalFallbackActive: () => false,
  isYouTubeZeroStartExternalFallbackPending: () => false,
  setPendingAutoSyncOnReady: () => undefined,
};

let runtimeHooks = unavailableHooks;

/**
 * Bind player-owned rendezvous state without making iframe.ts import the
 * player coordinator that already imports iframe.ts.
 */
export function configureYouTubePlayerRuntimeHooks(next: YouTubePlayerRuntimeHooks): void {
  runtimeHooks = next;
}

/** A trusted newer host command owns any still-pending participant-local start. */
export function cancelPendingYouTubeStartFromSync(): void {
  runtimeHooks.cancelPendingAutoSync();
}

export function consumePendingAutoSyncOnReadyFromIframe(): PendingAutoSyncOptions | null {
  return runtimeHooks.consumePendingAutoSyncOnReady();
}

export function isYouTubeZeroStartExternalFallbackActiveFromIframe(): boolean {
  return runtimeHooks.isYouTubeZeroStartExternalFallbackActive();
}

/** Includes the release acknowledgement after ordinary iframe events resume. */
export function isYouTubeZeroStartExternalFallbackPendingFromSync(): boolean {
  return runtimeHooks.isYouTubeZeroStartExternalFallbackPending();
}

export function setPendingAutoSyncOnReadyFromIframe(
  active: boolean,
  options: PendingAutoSyncOptions | null = null,
): void {
  runtimeHooks.setPendingAutoSyncOnReady(active, options);
}
