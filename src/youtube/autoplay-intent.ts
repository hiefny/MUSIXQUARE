/**
 * Leaf state for the "start once the iframe is ready" intent.
 *
 * Both player.ts and iframe.ts consume this state. Keeping it in a leaf avoids
 * making the iframe implementation import its coordinator.
 */

export interface PendingAutoSyncOptions {
  isTrackTransition?: boolean;
  targetTime?: number;
  subIndex?: number;
  videoId?: string;
  skipSeek?: boolean;
  rendezvousDelayMs?: number;
}

let pending = false;
let options: PendingAutoSyncOptions | null = null;

export function setPendingAutoSyncOnReady(
  value: boolean,
  nextOptions: PendingAutoSyncOptions | null = null,
): void {
  pending = value;
  options = value ? nextOptions : null;
}

export function getPendingAutoSyncOnReady(): boolean {
  return pending;
}

export function consumePendingAutoSyncOnReady(): PendingAutoSyncOptions | null {
  if (!pending) return null;
  pending = false;
  const consumed = options ?? {};
  options = null;
  return consumed;
}
