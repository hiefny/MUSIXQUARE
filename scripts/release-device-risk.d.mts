export interface ReleaseDeviceRiskContract {
  schemaVersion: 1;
  requiredExactPaths: readonly string[];
  requiredPathPrefixes: readonly string[];
}

export interface ReleaseDeviceRiskReport {
  schemaVersion: 1;
  required: boolean;
  reason: string;
  target: string;
  baseSha: string | null;
  headSha: string;
  changedPaths: readonly string[];
  matchedPaths: readonly string[];
}

export const RELEASE_DEVICE_RISK_CONTRACT_PATH: string;
export function normalizeReleaseDeviceRiskContract(value: unknown): ReleaseDeviceRiskContract;
export function readReleaseDeviceRiskContract(path?: string): ReleaseDeviceRiskContract;
export function classifyReleaseDeviceRisk(
  changedPaths: readonly string[],
  contract: ReleaseDeviceRiskContract,
): {
  required: boolean;
  changedPaths: readonly string[];
  matchedPaths: readonly string[];
};
export function releaseGitShaFromDeployment(value: unknown): string | null;
export function evaluateReleaseDeviceRisk(input: {
  target: string;
  headSha: string;
  deployment: unknown;
  changedPaths: readonly string[];
  contract: ReleaseDeviceRiskContract;
}): ReleaseDeviceRiskReport;
