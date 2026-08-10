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
  consumePendingAutoSyncOnReady(): PendingAutoSyncOptions | null;
  isYouTubeZeroStartExternalFallbackActive(): boolean;
  setPendingAutoSyncOnReady(active: boolean, options?: PendingAutoSyncOptions | null): void;
}

const unavailableHooks: YouTubePlayerRuntimeHooks = {
  consumePendingAutoSyncOnReady: () => null,
  isYouTubeZeroStartExternalFallbackActive: () => false,
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

export function consumePendingAutoSyncOnReadyFromIframe(): PendingAutoSyncOptions | null {
  return runtimeHooks.consumePendingAutoSyncOnReady();
}

export function isYouTubeZeroStartExternalFallbackActiveFromIframe(): boolean {
  return runtimeHooks.isYouTubeZeroStartExternalFallbackActive();
}

export function setPendingAutoSyncOnReadyFromIframe(
  active: boolean,
  options: PendingAutoSyncOptions | null = null,
): void {
  runtimeHooks.setPendingAutoSyncOnReady(active, options);
}
