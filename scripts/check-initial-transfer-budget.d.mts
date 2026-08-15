export interface InitialTransferBudget {
  readonly entryScriptRawBytes: number;
  readonly entryScriptGzipBytes: number;
  readonly eagerJavaScriptGzipBytes: number;
  readonly eagerTotalRawBytes: number;
  readonly eagerTotalGzipBytes: number;
  readonly eagerFontBytes: number;
}

export interface InitialTransferEntry {
  readonly url: string;
  readonly file: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

export interface InitialTransferMeasurement extends InitialTransferBudget {
  readonly entryScriptUrl: string;
  readonly entries: readonly InitialTransferEntry[];
}

export const INITIAL_TRANSFER_BUDGET: Readonly<InitialTransferBudget>;
export const INITIAL_TRANSFER_MINIMUM_HEADROOM_RATIO: number;

export function collectEagerAssetUrls(html: string): {
  urls: string[];
  entryScriptUrl: string;
};

export function measureInitialTransfer(distDirectory?: string): Promise<InitialTransferMeasurement>;

export function assertInitialTransferBudget(
  measurement: InitialTransferBudget,
  budget?: InitialTransferBudget,
): void;
