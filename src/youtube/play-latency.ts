import { IS_ANDROID } from '../core/platform.ts';
import { getState } from '../core/state.ts';
import { ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS, LATENCY_CLAMP_MAX_MS } from './constants.ts';

/** Participant-local playVideo-to-audible estimate, shared by host and guest scheduling. */
export function getEffectiveYouTubePlayLatencyMs(): number {
  const stored = getState('youtube.guestPlayLatency');
  const learned = Number.isFinite(stored) ? Math.max(0, Math.min(LATENCY_CLAMP_MAX_MS, stored)) : 0;
  return IS_ANDROID ? Math.max(learned, ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS) : learned;
}
