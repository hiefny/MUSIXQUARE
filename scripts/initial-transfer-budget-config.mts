export interface InitialTransferBudget {
  readonly entryScriptRawBytes: number;
  readonly entryScriptGzipBytes: number;
  readonly eagerJavaScriptGzipBytes: number;
  readonly eagerTotalRawBytes: number;
  readonly eagerTotalGzipBytes: number;
  readonly eagerFontBytes: number;
}

/**
 * Shared architectural limits for Vite's raw chunk warning and the complete
 * post-build initial-transfer graph guard.
 */
export const INITIAL_TRANSFER_BUDGET: Readonly<InitialTransferBudget> = Object.freeze({
  // Architectural ceilings, not growth targets. The guard reserves 5% of
  // every positive limit in addition to the working room below its ceiling.
  // The 2026-10-14 measured review restores 5% working room in the three
  // near-ceiling aggregate metrics. Entry limits remain at the 2026-09-06
  // baseline; the protected 5% reserve is unchanged.
  // Further changes require measured review in initial-bundle-loading-policy.md;
  // the Chromium 79 floor and eager/deferred loading contracts still apply.
  entryScriptRawBytes: 1_677_500,
  entryScriptGzipBytes: 486_200,
  eagerJavaScriptGzipBytes: 517_440,
  eagerTotalRawBytes: 2_269_575,
  eagerTotalGzipBytes: 600_600,
  eagerFontBytes: 0,
});

export const INITIAL_TRANSFER_MINIMUM_HEADROOM_RATIO = 0.05;
