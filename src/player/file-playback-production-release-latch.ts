/**
 * Tracked production release latch for the V2 file-playback engine.
 *
 * Environment flags may remain configured on a remote builder, so they are
 * deliberately insufficient on their own. An approved production enablement
 * changes only this line to `true`; rollback changes the same line back to
 * `false` and rebuilds the static application.
 */
export const FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED: boolean = false;
