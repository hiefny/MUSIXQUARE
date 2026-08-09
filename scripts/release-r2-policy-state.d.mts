export interface R2PolicyStateOptions {
  root?: string;
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
  requirePairedPlan?: boolean;
  verifyWorkers?: (directory: string, options?: Record<string, unknown>) => Record<string, unknown>;
  workerOptions?: Record<string, unknown>;
}

export function captureR2PolicyCheckpoint(
  releaseTarget: string,
  directory: string,
  options?: R2PolicyStateOptions,
): Promise<Record<string, unknown>>;
export function assessR2PolicyRecovery(
  directory: string,
  options?: R2PolicyStateOptions,
): Promise<Record<string, unknown>>;
export function restoreR2Policies(
  directory: string,
  options?: R2PolicyStateOptions,
): Promise<Record<string, unknown>>;
export function reconcileR2PoliciesWithWorkerBoundary(
  directory: string,
  workerDirectory: string,
  options?: R2PolicyStateOptions,
): Promise<Record<string, unknown>>;
export function verifyR2PolicyRecovery(
  directory: string,
  options?: R2PolicyStateOptions,
): Promise<Record<string, unknown>>;
export function verifyPairedRecoveryBoundary(
  directory: string,
  workerDirectory: string,
  options?: R2PolicyStateOptions,
): Promise<Record<string, unknown>>;
export function verifyR2PolicyPreflight(
  policyId: string,
  directory: string,
  options?: R2PolicyStateOptions,
): Promise<Record<string, unknown>>;
export function readR2ForwardRepairTargets(directory: string): string;
