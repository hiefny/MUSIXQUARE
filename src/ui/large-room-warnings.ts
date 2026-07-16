/** Per-session acknowledgement state for large-room data-plane warnings. */

import { bus } from '../core/events.ts';

let _fileShareWarned = false;

export function hasFileShareWarned(): boolean {
  return _fileShareWarned;
}

export function markFileShareWarned(): void {
  _fileShareWarned = true;
}

// Leaving and starting are separate state transitions, so either one resets
// the acknowledgement for the next session.
bus.on('state:network.sessionCode', (code: unknown) => {
  if (!code) {
    _fileShareWarned = false;
  }
});

bus.on('state:setup.sessionStarted', (started: unknown) => {
  if (started) {
    _fileShareWarned = false;
  }
});
