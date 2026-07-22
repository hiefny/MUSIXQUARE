export const D1_MIGRATION_MANIFEST_PATH: string;

export interface D1RecoveryContract {
  strategy: string;
  runbook: string;
  note: string;
}
export interface D1MigrationContract {
  id: string;
  forward: string;
  forwardSha256: string;
  reversibility: string;
  rollback: string | null;
  rollbackSha256: string | null;
  recovery: D1RecoveryContract;
}
export interface D1DatabaseContract {
  database: string;
  baseline: string;
  baselineRevision: number;
  baselineSha256: string;
  baselineMigration: string | null;
  baselineRecovery: D1RecoveryContract;
  migrations: D1MigrationContract[];
}
export interface D1MigrationManifest {
  schemaVersion: number;
  databases: D1DatabaseContract[];
}
export type GitRunner = (command: string, args: string[], options?: unknown) => string | Buffer;

export function loadD1MigrationManifest(root?: string): D1MigrationManifest;
export function assertD1MigrationContract(options?: {
  root?: string;
  manifest?: D1MigrationManifest;
}): Record<string, number>;
export function assertD1MigrationManifestAppendOnly(options: {
  previousManifest: D1MigrationManifest;
  currentManifest: D1MigrationManifest;
}): { previousDatabaseCount: number };
export function assertD1MigrationRepositoryHistory(options?: {
  root?: string;
  currentManifest?: D1MigrationManifest;
  runner?: GitRunner;
}): { visibleRevisionCount: number };
export function trackedD1PathsForDatabase(
  manifest: D1MigrationManifest,
  databaseName: string,
): string[];
