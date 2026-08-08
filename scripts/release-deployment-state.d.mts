export interface DeploymentVersion {
  deployment?: unknown;
  deploymentId?: string;
  versionId: string;
  message: string | null;
}
export interface ReleaseState extends Record<string, unknown> {
  target: string;
}
export interface CommandRunnerOptions {
  runner?: (args: string[], options?: { capture?: boolean }) => unknown;
  [key: string]: unknown;
}

export function attemptedStates(directory: string): ReleaseState[];
export function changedRuntimePaths(
  baseSha: string,
  headSha: string,
  paths: string[],
  options?: CommandRunnerOptions,
): string[];
export function contractCutoverRequiresForwardRepair(
  headSha: string,
  markerPath: string,
  targets: string[],
  directory?: string,
  options?: CommandRunnerOptions,
): boolean;
export function changedAppRuntimeDependencies(
  baseSha: string,
  headSha: string,
  options?: CommandRunnerOptions,
): string[];
export function deploymentMessage(deployment: unknown): string | null;
export function npmInvocation(
  platform?: string,
  options?: {
    nodeExecutable?: string;
    environment?: Record<string, string | undefined>;
    fileExists?: (path: string) => boolean;
  },
): { executable: string; prefixArgs: string[] };
export function preflight(
  target: string,
  directory: string,
  options?: CommandRunnerOptions,
): unknown;
export function productionVersion(deployment: unknown, label: string): string;
export function queryCurrent(
  target: string,
  config: string,
  outputPath: string,
  options?: CommandRunnerOptions,
): DeploymentVersion;
export function recheckPartialReleaseCompatibility(
  target: string,
  headSha: string,
  directory: string,
  options?: CommandRunnerOptions,
): Record<string, unknown>;
export function releaseGitSha(message: string | null): string | null;
export function releaseTargetWorkers(target: string): ReadonlySet<string>;
export function runtimePathsForWorker(worker: string): string[];
export function rollbackDeploymentMessage(state: Record<string, unknown>, fallback: string): string;
export function retrySync<T>(
  label: string,
  operation: () => T,
  options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (delayMs: number) => void;
    onRetry?: (event: unknown) => void;
  },
): T;
export function rollbackDisposition(
  state: Record<string, unknown>,
  current: DeploymentVersion,
): string;
export function rollbackDependencyBlock(
  target: string,
  states: Array<Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
): Record<string, unknown> | null;
export function rollbackSkipTargets(value: string): ReadonlySet<string>;
export function runRollbackWithRetry(
  state: Record<string, unknown>,
  message: string,
  options?: CommandRunnerOptions,
): Record<string, unknown>;
export function verifyPartialReleaseCompatibility(
  target: string,
  headSha: string,
  directory: string,
  options?: CommandRunnerOptions,
): Record<string, unknown>;
export function verifyCurrentRelease(
  directory: string,
  options?: CommandRunnerOptions,
): Record<string, unknown>;
export function verifyProductionVersion(
  target: string,
  config: string,
  expectedVersionId: string,
  outputPath: string,
  options?: CommandRunnerOptions,
): DeploymentVersion;
