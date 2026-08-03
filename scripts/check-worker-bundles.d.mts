export const PRODUCTION_WRANGLER_CONFIGS: readonly string[];

export function discoverProductionWranglerConfigs(root?: string): string[];
export function assertProductionWranglerConfigCoverage(root?: string): string[];
export function readPinnedWranglerToolchain(root?: string): {
  version: string;
  binary: string;
};
export function workerBundleDryRunArgs(config: string, outdir: string): string[];
export function workerBundleDryRunEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function runWorkerBundleDryRuns(root?: string): void;
