import { IS_ANDROID } from '../core/platform.ts';
import { getState } from '../core/state.ts';
import { LATENCY_CLAMP_MAX_MS } from './constants.ts';
import { getYouTubeAudibleOutputDelayMs } from './output-latency.ts';

export function getLocalYouTubeAudibleOutputDelayMs(): number {
  return getYouTubeAudibleOutputDelayMs(IS_ANDROID ? 'android' : 'other');
}

/** Participant-local playVideo-to-audible estimate, shared by host and guest scheduling. */
export function getEffectiveYouTubePlayLatencyMs(): number {
  const stored = getState('youtube.guestPlayLatency');
  const learned = Number.isFinite(stored) ? Math.max(0, Math.min(LATENCY_CLAMP_MAX_MS, stored)) : 0;
  return Math.max(learned, getLocalYouTubeAudibleOutputDelayMs());
}
