/**
 * MUSIXQUARE 4.0 — System Audio Host (PCM DataChannel Broadcaster)
 *
 * PCM chunks are broadcast via the existing DataConnection (broadcast()).
 * This module handles late-joining guests during active sharing.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { isSystemAudioActive } from '../audio/system-capture.ts';
import { broadcast } from './peer-state.ts';
import { getAudioContext } from '../audio/context.ts';

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioHostListeners(): void {
  // When a new guest connects during active sharing, send them START
  bus.on('network:peer-connected', () => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;

    // Small delay to let DataConnection establish
    setTimeout(() => {
      const ctx = getAudioContext();
      broadcast({ type: MSG.SYSTEM_AUDIO_START, sampleRate: ctx.sampleRate });
      log.info('[SysAudioHost] Sent SYSTEM_AUDIO_START to late-joining guest');
    }, 500);
  });

  bus.on('system-audio:force-stop', () => {
    // Nothing to clean up — PCM sender is stopped by system-capture.ts
  });

  bus.on('system-audio:stop', () => {
    // Nothing to clean up — PCM sender is stopped by system-capture.ts
  });
}
