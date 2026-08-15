export interface YouTubeAutoSyncOverrides {
  subIndex?: number;
  videoId?: string;
  skipSeek?: boolean;
  rendezvousDelayMs?: number;
  state?: number;
}

interface YouTubeHandlerRuntimeHooks {
  scheduleYtAutoSync(targetTime: number, overrides?: YouTubeAutoSyncOverrides): void;
  tryBeginYouTubeZeroStart(videoId: string, subIndex: number | null): boolean;
}

let runtimeHooks: YouTubeHandlerRuntimeHooks | null = null;

/**
 * Bind player-owned commands without making protocol handlers back-import the
 * player coordinator that already owns their synchronous registration.
 */
export function configureYouTubeHandlerRuntimeHooks(next: YouTubeHandlerRuntimeHooks): void {
  runtimeHooks = next;
}

function requireRuntimeHooks(): YouTubeHandlerRuntimeHooks {
  if (!runtimeHooks) {
    throw new Error('[YouTube] Handler runtime used before player initialization.');
  }
  return runtimeHooks;
}

export function scheduleYtAutoSyncFromHandler(
  targetTime: number,
  overrides?: YouTubeAutoSyncOverrides,
): void {
  const hooks = requireRuntimeHooks();
  if (overrides === undefined) hooks.scheduleYtAutoSync(targetTime);
  else hooks.scheduleYtAutoSync(targetTime, overrides);
}

export function tryBeginYouTubeZeroStartFromHandler(
  videoId: string,
  subIndex: number | null,
): boolean {
  return requireRuntimeHooks().tryBeginYouTubeZeroStart(videoId, subIndex);
}
