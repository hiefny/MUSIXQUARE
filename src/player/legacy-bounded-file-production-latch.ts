/**
 * Tracked production release latch for the redesigned bounded V1 file path.
 *
 * The normal production build flag and exact production-artifact identity are
 * deliberately insufficient on their own. Rollback changes this line to
 * `false`, keeps the retired V2 latch and flags disabled, bumps the service
 * worker cache version, and rebuilds the static application.
 */
export const LEGACY_BOUNDED_FILE_PRODUCTION_RELEASE_ENABLED: boolean = false;
