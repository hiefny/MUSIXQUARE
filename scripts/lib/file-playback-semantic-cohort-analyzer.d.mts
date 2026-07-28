export interface FilePlaybackRelativeSupportEdge {
  readonly importer: string;
  readonly target: string;
  readonly reason: string;
}

export interface FilePlaybackBareSupportEdge {
  readonly importer: string;
  readonly specifier: string;
  readonly reason: string;
}

export interface FilePlaybackSemanticCohortConfiguration {
  readonly bareSupportAllowlist: readonly FilePlaybackBareSupportEdge[];
  readonly cohortDeclaration: string;
  readonly cohortExport: string;
  readonly criticalEntryFiles: readonly string[];
  readonly flacPackageRoot: string;
  readonly integrationFiles: readonly string[];
  readonly mp3PackageRoot: string;
  readonly packageRoots: readonly string[];
  readonly relativeSupportAllowlist: readonly FilePlaybackRelativeSupportEdge[];
  readonly schema: string;
  readonly surfaceFiles: readonly string[];
}

export interface FilePlaybackRuntimeEdge {
  readonly specifier: string;
  readonly kind: string;
  readonly line: number;
}

export interface FilePlaybackRuntimeEdgeCollection {
  readonly edges: readonly FilePlaybackRuntimeEdge[];
  readonly violations: readonly string[];
}

export interface FilePlaybackSemanticPackage {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly dependencies: readonly string[];
}

export interface FilePlaybackSemanticCohortAnalysis {
  readonly canonicalPrefix: string;
  readonly coreFileCount: number;
  readonly declaredCohortId: string | null;
  readonly digest: string;
  readonly edgeCount: number;
  readonly expectedCohortId: string;
  readonly fileCount: number;
  readonly integrationBoundaryEdgeCount: number;
  readonly integrationFileCount: number;
  readonly packageClosure: readonly FilePlaybackSemanticPackage[];
  readonly suffix: string;
  readonly violations: readonly string[];
}

export function collectFilePlaybackRuntimeEdgesForTests(
  file: string,
  text: string,
): FilePlaybackRuntimeEdgeCollection;

export function normalizeSemanticSource(file: string, text: string): string;

export function analyzeFilePlaybackSemanticCohort(options: {
  readonly root: string;
  readonly configuration?: Partial<FilePlaybackSemanticCohortConfiguration>;
}): FilePlaybackSemanticCohortAnalysis;
