export const EMERGENCY_DEPLOY_CONFIRM_ENV: string;
export const EMERGENCY_DEPLOY_PREFIX: string;
export const EMERGENCY_DEPLOY_TARGETS: readonly string[];
export interface EmergencyDeployAuthorization {
  target: string;
  commitSha: string;
}
export function expectedEmergencyDeployConfirmation(target: string, commitSha: string): string;
export function assertEmergencyDeployAuthorization(input: {
  target: unknown;
  commitSha: unknown;
  branchName: unknown;
  originMainSha: unknown;
  worktreeStatus: unknown;
  confirmation: unknown;
}): EmergencyDeployAuthorization;
export function parseRemoteMainSha(output: string): string;
export function authorizeEmergencyDeploy(
  target: string,
  options?: {
    confirmation?: string;
    readGit?: (args: string[]) => string;
  },
): EmergencyDeployAuthorization;
