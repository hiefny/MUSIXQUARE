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
  // These are architectural ceilings, not spendable targets. The assertion
  // reserves a fixed percentage of every positive limit so ordinary
  // maintenance cannot silently consume all remaining capacity.
  entryScriptRawBytes: 1_468_500,
  entryScriptGzipBytes: 440_000,
  eagerJavaScriptGzipBytes: 440_000,
  eagerTotalRawBytes: 1_870_000,
  eagerTotalGzipBytes: 506_000,
  eagerFontBytes: 0,
});

export const INITIAL_TRANSFER_MINIMUM_HEADROOM_RATIO = 0.05;
