import { ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS } from './constants.ts';
import type { YouTubeZeroStartPlatform } from '../types/index.ts';

/**
 * Fixed media-timeline-to-audible delay, independent of startup and timer lag.
 * The owner verified the Android default on multiple tablets and phones.
 * This is an application compensation policy, not a browser timing guarantee.
 */
export function getYouTubeAudibleOutputDelayMs(platform: YouTubeZeroStartPlatform): number {
  return platform === 'android' ? ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS : 0;
}
