export const PRODUCTION_ACCOUNT_CALLBACK: string;
export const ACCOUNT_STAGE2_DEPLOYMENT_ORDER: readonly string[];
export const EXPECTED_ACCOUNT_SCHEMA_OBJECTS: readonly string[];
export const REQUIRED_ACCOUNT_SECRET_NAMES: Readonly<Record<string, readonly string[]>>;

export interface D1BindingValidation {
  binding: { databaseName: string };
  errors: string[];
}
export interface WranglerReadRequest {
  kind: 'd1-schema' | 'd1-nicknames' | 'secret-list';
  databaseName?: string;
  service?: string;
  configPath?: string;
  query?: string;
}

export function parseD1Bindings(configText: string): Array<{
  binding: string;
  databaseName: string;
}>;
export function validateAccountD1Binding(configText: string): D1BindingValidation;
export function validateProductionCallback(
  callback: string,
  accountAuthSource: string,
  appConfig: string,
): string[];
export function normalizeSchemaSql(sql: string): string;
export function extractAccountSchemaObjects(
  schemaSql: string,
): Map<string, { name: string; type: string; sql: string }>;
export function validateAccountSchemaRows(
  remoteRows: Array<Record<string, unknown>>,
  canonicalSchemaSql: string,
): string[];
export function validateAccountNicknameRows(rows: Array<Record<string, unknown>>): string[];
export function parseD1Rows(output: string): Array<Record<string, unknown>>;
export function parseSecretNames(output: string): Set<string>;
export function validateRequiredSecretNames(service: string, names: Set<string>): string[];
export function validateDeploymentOrder(value: string | readonly string[]): string[];
export function verifyLocalAssertionRoundTrips(): Promise<Record<string, unknown>>;
export function buildWranglerReadOnlyCommand(request: WranglerReadRequest): string[];
export function runAccountStage2Preflight(
  options: {
    remote: boolean;
    confirmProduction: boolean;
    callback: string;
    deploymentOrder: string;
  },
  dependencies?: {
    readText?: (path: string) => Promise<string>;
    runWrangler?: (request: Record<string, unknown>) => string;
  },
): Promise<Record<string, unknown>>;
export function parsePreflightArguments(argv: string[]): {
  remote: boolean;
  confirmProduction: boolean;
  callback: string;
  deploymentOrder: string;
};
