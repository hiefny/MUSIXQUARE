export const DEFAULT_LEGACY_BOUNDED_V1_PROTECTED_FILES: readonly string[];
export const DEFAULT_LEGACY_BOUNDED_V1_FORBIDDEN_MODULE_FILES: readonly string[];

export interface LegacyBoundedV1SafetyConfiguration {
  root: string;
  protectedFiles?: readonly string[];
  forbiddenModuleFiles?: readonly string[];
  dataConnectionDeclaration?: {
    file: string;
    name: string;
  };
  tsconfigFile?: string;
}

export interface LegacyBoundedV1SafetyAnalysis {
  protectedFileCount: number;
  violations: readonly string[];
}

export function analyzeLegacyBoundedV1Safety(
  configuration: LegacyBoundedV1SafetyConfiguration,
): LegacyBoundedV1SafetyAnalysis;
