/**
 * The PRO Worker computes Next, Previous and the natural advance over its own
 * playlist. A playlist removal the user sent just before navigating is a
 * separate HTTP mutation, so the playback controller holds navigation
 * commands until the newest sent removal has settled.
 */
let applying: Promise<void> | null = null;

/** Record a sent removal. `settled` must never reject. */
export function noteProQueueRemoval(settled: Promise<void>): void {
  applying = settled;
  const release = (): void => {
    if (applying === settled) applying = null;
  };
  settled.then(release, release);
}

/** The newest removal the Worker may not have applied yet. */
export function pendingProQueueRemoval(): Promise<void> | null {
  return applying;
}
