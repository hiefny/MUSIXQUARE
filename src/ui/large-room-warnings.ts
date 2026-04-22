/**
 * MUSIXQUARE — Large-room warning memory
 *
 * Tracks whether the user has already acknowledged the "this mode is stable
 * for small rooms only" dialog for each data-plane feature (file share,
 * system audio) during the current session.
 *
 * Resets on session leave / re-host so a fresh connection prompts again.
 */

import { bus } from '../core/events.ts';

let _fileShareWarned = false;
let _sysAudioWarned = false;

export function hasFileShareWarned(): boolean {
  return _fileShareWarned;
}

export function markFileShareWarned(): void {
  _fileShareWarned = true;
}

export function hasSysAudioWarned(): boolean {
  return _sysAudioWarned;
}

export function markSysAudioWarned(): void {
  _sysAudioWarned = true;
}

// Session lifecycle: reset flags when sessionCode becomes empty (leave) or
// when a new session starts. Either event is a clean boundary for "ask again".
bus.on('state:network.sessionCode', (code: unknown) => {
  if (!code) {
    _fileShareWarned = false;
    _sysAudioWarned = false;
  }
});

bus.on('state:setup.sessionStarted', (started: unknown) => {
  if (started) {
    _fileShareWarned = false;
    _sysAudioWarned = false;
  }
});
