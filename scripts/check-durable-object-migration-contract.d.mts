export const DURABLE_OBJECT_MIGRATION_MANIFEST_PATH: string;

export interface DurableObjectMigration {
  tag: string;
  new_classes?: string[];
  new_sqlite_classes?: string[];
  renamed_classes?: string[];
  deleted_classes?: string[];
}
export interface DurableObjectMigrationConfig {
  config: string;
  scriptName: string;
  migrations: DurableObjectMigration[];
}
export interface DurableObjectMigrationManifest {
  schemaVersion: number;
  configs: DurableObjectMigrationConfig[];
}
export type DurableObjectGitRunner = (
  command: string,
  args: string[],
  options?: unknown,
) => string | Buffer;

export function parseProductionWranglerMigrations(
  source: string,
  label?: string,
): { scriptName: string; migrations: DurableObjectMigration[] };
export function discoverProductionWranglerMigrationConfigs(root?: string): string[];
export function loadDurableObjectMigrationManifest(root?: string): DurableObjectMigrationManifest;
export function assertDurableObjectMigrationContract(options?: {
  root?: string;
  manifest?: DurableObjectMigrationManifest;
}): { schemaVersion: number; configCount: number; migrationCount: number };
export function assertDurableObjectMigrationManifestAppendOnly(options: {
  previousManifest: DurableObjectMigrationManifest;
  currentManifest: DurableObjectMigrationManifest;
}): { previousConfigCount: number };
export function assertDurableObjectMigrationRepositoryHistory(options?: {
  root?: string;
  currentManifest?: DurableObjectMigrationManifest;
  runner?: DurableObjectGitRunner;
}): { visibleRevisionCount: number };
