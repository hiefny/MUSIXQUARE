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
  // The Chromium 79 execution floor deliberately spends raw bytes on syntax
  // lowering and exact cascade-layer specificity. Compressed growth is small;
  // these ceilings re-establish the same mandatory 5% maintenance reserve.
  entryScriptRawBytes: 1_525_000,
  entryScriptGzipBytes: 442_000,
  eagerJavaScriptGzipBytes: 448_000,
  eagerTotalRawBytes: 1_965_000,
  eagerTotalGzipBytes: 520_000,
  eagerFontBytes: 0,
});

export const INITIAL_TRANSFER_MINIMUM_HEADROOM_RATIO = 0.05;
