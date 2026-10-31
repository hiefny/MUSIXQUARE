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
  isYouTubeAutoSyncPending(): boolean;
  isYouTubeZeroStartExternalFallbackActive(): boolean;
  isYouTubeZeroStartExternalFallbackPending(): boolean;
  isProPlaybackPauseGatePending(): boolean;
  setPendingAutoSyncOnReady(active: boolean, options?: PendingAutoSyncOptions | null): void;
}

const unavailableHooks: YouTubePlayerRuntimeHooks = {
  cancelPendingAutoSync: () => undefined,
  consumePendingAutoSyncOnReady: () => null,
  isYouTubeAutoSyncPending: () => false,
  isYouTubeZeroStartExternalFallbackActive: () => false,
  isYouTubeZeroStartExternalFallbackPending: () => false,
  isProPlaybackPauseGatePending: () => false,
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

/**
 * The legacy rendezvous owns its stage-2 wait ('yt-auto-sync', set by
 * player.ts's scheduleYtAutoSync). Other modules ask its owner rather than
 * reading the timer by name.
 */
export function isYouTubeAutoSyncPending(): boolean {
  return runtimeHooks.isYouTubeAutoSyncPending();
}

/** A participant-local PRO pause keeps iframe audio closed until it settles. */
export function isProPlaybackPauseGatePendingFromIframe(): boolean {
  return runtimeHooks.isProPlaybackPauseGatePending();
}

export function setPendingAutoSyncOnReadyFromIframe(
  active: boolean,
  options: PendingAutoSyncOptions | null = null,
): void {
  runtimeHooks.setPendingAutoSyncOnReady(active, options);
}
