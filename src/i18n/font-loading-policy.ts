/**
 * Timing and bounds of the app's font loading: the one home for the values
 * src/i18n/locale-fonts.ts (the only owner of the app's font sheets and face
 * loads) and its tests use. Import them; never retype them.
 *
 * Phase A loads the UI's sheets when a language applies. Phase B declares
 * every other app family after window load and the first idle slice, so every
 * script has its face in every UI. A sheet that fails is retried on its own,
 * a bounded number of times.
 */

/** Phase B waits for an idle slice after window load, but no longer than this. */
export const FONT_SHEETS_IDLE_TIMEOUT_MS = 3_000;

/** Automatic retries per failed sheet ('online' or a later visible idle slice). */
export const FONT_SHEET_RETRY_LIMIT = 3;

/** How long after a failure the next automatic retry waits, unless 'online' fires first. */
export const FONT_SHEET_RETRY_DELAY_MS = 10_000;
