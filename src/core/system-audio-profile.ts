/** Coarse, privacy-safe class of the surface selected in the display picker. */
export type SystemAudioSurface = 'browser' | 'window' | 'display';

export const DEFAULT_SYSTEM_AUDIO_SURFACE: SystemAudioSurface = 'display';

/**
 * Product profile for the single native stereo receive track. This is the
 * encoder target requested by MUSIXQUARE, not measured throughput or total
 * host upload; transport overhead and direct fan-out are deliberately absent.
 */
const SYSTEM_AUDIO_PROFILE_MAX_KBPS = 256;

/**
 * Reduce browser-specific Screen Capture values to the three product labels.
 * Missing, malformed, and future values fail closed to the generic DISPLAY
 * class and are never rendered verbatim.
 */
export function normalizeSystemAudioSurface(value: unknown): SystemAudioSurface {
  if (value === 'browser') return 'browser';
  if (value === 'window' || value === 'application') return 'window';
  return DEFAULT_SYSTEM_AUDIO_SURFACE;
}

export function formatSystemAudioProfileLabel(value: unknown): string {
  const surface = normalizeSystemAudioSurface(value).toUpperCase();
  return `≤${SYSTEM_AUDIO_PROFILE_MAX_KBPS} kbps · ${surface}`;
}
