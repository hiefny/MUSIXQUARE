export const TRACKED_SCHEMA_PATHS: readonly string[];
export interface DeveloperApiDeployment {
  annotations?: Record<string, string | undefined>;
}
export type DeveloperApiSchemaGitRunner = (
  command: string,
  args: string[],
  options?: { encoding: 'utf8' },
) => string | Buffer;
export interface DeveloperApiSchemaReleaseResult {
  previousCommit: string | null;
  changed: string[];
}

export function releaseCommitFromDeployment(
  deployment: DeveloperApiDeployment | null | undefined,
): string | null;
export function assertBaselineContractChanged(options: {
  previousCommit: string;
  runner?: DeveloperApiSchemaGitRunner;
}): { adopted: boolean };
export function assertDeveloperApiSchemaRelease(options: {
  deployment: DeveloperApiDeployment;
  currentCommit: string;
  applyRequested: boolean;
  runner?: DeveloperApiSchemaGitRunner;
}): DeveloperApiSchemaReleaseResult;
