export type EffectsScopeMigrationOperation = 'apply' | 'rollback';
export interface EffectsScopeD1Row extends Record<string, unknown> {
  sql?: string;
}
export type EffectsScopeRunner = (args: string[], options?: { capture?: boolean }) => string;
export interface EffectsScopeMigrationDependencies {
  runner?: EffectsScopeRunner;
  outputPath?: string | null;
  stdout?: { write(value: string): unknown };
  journalPath?: string | null;
}
export interface EffectsScopeMigrationResult {
  applied: boolean;
  scopeMaskLimit: number;
}

export function parseD1Rows(output: string): EffectsScopeD1Row[];
export function scopeMaskLimitFromSchema(sql: unknown): number | null;
export function developerApiKeySchemaStateFromSql(sql: unknown): {
  scopeMaskLimit: number | null;
  hasRoomGeneration: boolean;
};
export function migrationDisposition(
  currentLimit: number,
  operation: EffectsScopeMigrationOperation,
): 'apply' | 'skip';
export function runEffectsScopeMigration(
  operation: EffectsScopeMigrationOperation,
  dependencies?: EffectsScopeMigrationDependencies,
): EffectsScopeMigrationResult;
export function runEffectsScopeReleaseRollback(
  dependencies?: EffectsScopeMigrationDependencies,
): EffectsScopeMigrationResult | { applied: false; scopeMaskLimit: null };
