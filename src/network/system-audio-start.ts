import { MSG } from '../core/constants.ts';
import { getState } from '../core/state.ts';
import {
  normalizeSystemAudioSurface,
  type SystemAudioSurface,
} from '../core/system-audio-profile.ts';
import type { ProtocolMsg } from '../types/index.ts';

/** Build every Standard-room start frame from one normalized metadata owner. */
export function createSystemAudioStartFrame(
  surface: unknown = getState('player.currentTrackMeta')?.systemAudioSurface,
): ProtocolMsg<typeof MSG.SYSTEM_AUDIO_START> {
  return {
    type: MSG.SYSTEM_AUDIO_START,
    surface: normalizeSystemAudioSurface(surface),
  };
}

/**
 * Read a validated START's surface without ever exposing raw text. The
 * validator requires a bounded string; an unknown value (a later surface
 * class, for example) still reads as DISPLAY.
 */
export function readSystemAudioStartSurface(
  frame: Readonly<Record<string, unknown>>,
): SystemAudioSurface {
  return normalizeSystemAudioSurface(frame.surface);
}
