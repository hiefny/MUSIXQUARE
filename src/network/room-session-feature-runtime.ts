/**
 * Room-only audio routes. Importing this module is the initialization
 * boundary; ESM evaluation guarantees the listener graph is installed once.
 */

import { log } from '../core/log.ts';
import { registerSystemAudioHostListeners } from './system-audio-host.ts';
import { registerSystemAudioGuestListeners } from './system-audio-guest.ts';
import { registerSystemAudioSfuListeners } from './system-audio-sfu.ts';
import { registerProSystemAudioServiceListeners } from '../pro-room/system-audio-service.ts';
import { prepareMediaSession } from '../player/media-session-loader.ts';
import { initLocalOutputRejoin } from '../player/local-output-rejoin.ts';

registerSystemAudioHostListeners();
registerSystemAudioGuestListeners();
registerSystemAudioSfuListeners();
registerProSystemAudioServiceListeners();

prepareMediaSession().catch((error: unknown) => {
  log.warn('[RoomSession] Optional MediaSession initialization failed', error);
});

// OS media controls and participant-local output recovery are optional
// enhancements. A browser-specific exception in either one must not reject
// this module after the protocol-critical room listeners are already bound.
for (const [name, initialize] of [['LocalOutputRejoin', initLocalOutputRejoin]] as const) {
  try {
    initialize();
  } catch (error) {
    log.warn(`[RoomSession] Optional ${name} initialization failed`, error);
  }
}
