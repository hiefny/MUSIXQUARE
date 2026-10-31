/**
 * Timing and bounds of the app's font loading: the one home for the values
 * src/i18n/locale-fonts.ts (the only owner of the app's font sheets and face
 * loads) and its tests use. Import them; never retype them.
 *
 * Phase A loads the UI's sheets when a language applies. Phase B declares
 * every other app family after window load and the first idle slice, so every
 * script has its face in every UI. A sheet that fails is retried on its own,
 * a bounded number of times. Phase C loads the most frequent shards of the
 * Korean, Japanese and Chinese UIs' own family in idle time, within a face and
 * byte budget per page load (src/i18n/font-prefetch-samples.ts lists them).
 */

/** Phase B waits for an idle slice after window load, but no longer than this. */
export const FONT_SHEETS_IDLE_TIMEOUT_MS = 3_000;

/** Automatic retries per failed sheet ('online' or a later visible idle slice). */
export const FONT_SHEET_RETRY_LIMIT = 3;

/** How long after a failure the next automatic retry waits, unless 'online' fires first. */
export const FONT_SHEET_RETRY_DELAY_MS = 10_000;

/** Phase C, the idle prefetch of the UI language's frequent shards, starts this long after phase B. */
export const FONT_PREFETCH_QUIET_MS = 10_000;

/** Faces per prefetch batch. A face load cannot be aborted, so a batch stays small. */
export const FONT_PREFETCH_BATCH_FACES = 3;

/** At most this many faces are prefetched per page load. */
export const FONT_PREFETCH_MAX_FACES = 20;

/** At most this many bytes of font files are prefetched per page load. */
export const FONT_PREFETCH_MAX_BYTES = 400_000;

/** Without requestIdleCallback, each prefetch batch waits this long instead of an idle slice. */
export const FONT_PREFETCH_IDLE_FALLBACK_MS = 2_000;
