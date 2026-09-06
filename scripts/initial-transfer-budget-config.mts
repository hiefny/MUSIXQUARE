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
  // The 2026-09-06 readability re-baseline raises positive limits by 10%:
  // routine fixes should not require source compression to recover a few bytes.
  // Further changes require measured review in initial-bundle-loading-policy.md;
  // the Chromium 79 floor and eager/deferred loading contracts still apply.
  entryScriptRawBytes: 1_677_500,
  entryScriptGzipBytes: 486_200,
  eagerJavaScriptGzipBytes: 492_800,
  eagerTotalRawBytes: 2_161_500,
  eagerTotalGzipBytes: 572_000,
  eagerFontBytes: 0,
});

export const INITIAL_TRANSFER_MINIMUM_HEADROOM_RATIO = 0.05;
