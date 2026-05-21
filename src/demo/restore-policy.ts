import { PLAYBACK_STATE } from '../core/constants.ts';
import type { PlaybackModeActivity } from '../player/ownership.ts';

export function shouldRestoreDemoSnapshotMedia(
  playback: PlaybackModeActivity,
  lifecycle: unknown,
): boolean {
  if (playback.mode === 'youtube' || playback.mode === 'system-audio') return false;
  if (playback.mode === 'file' && playback.activity !== 'idle') return false;
  return lifecycle === PLAYBACK_STATE.IDLE;
}
