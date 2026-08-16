export interface DeclarationTarget {
  label: string;
  directory: string;
  declarationSuffix: string;
  runtimeSuffix: string;
  inspectRuntimeSource?: boolean;
}

export interface DeclarationTargetResult {
  label: string;
  count: number;
}

export function declaredRuntimeNames(source: string): Set<string>;
export function compareRuntimeExports(
  declarationName: string,
  declared: ReadonlySet<string>,
  actual: ReadonlySet<string>,
): string[];
export function runtimeSourceNames(source: string, fileName?: string): Set<string>;
export function runtimeNameForDeclaration(
  declarationName: string,
  declarationSuffix: string,
  runtimeSuffix: string,
): string;
export function checkDeclarationTarget(
  target: DeclarationTarget,
): Promise<{ count: number; failures: string[] }>;
export function runDeclarationExportChecks(targets?: readonly DeclarationTarget[]): Promise<{
  results: DeclarationTargetResult[];
  failures: string[];
}>;
