/**
 * Tracked source latch for the beta-only bounded file renderer.
 *
 * This latch is deliberately insufficient on its own. A built artifact also
 * needs the exact `beta-bounded` Vite mode and the exact beta environment flag,
 * so an ordinary production or E2E build cannot inherit this experiment.
 */
export const LEGACY_BOUNDED_FILE_BETA_RELEASE_ENABLED: boolean = true;
