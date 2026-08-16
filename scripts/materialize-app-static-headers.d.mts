export interface AppStaticHeadersOptions {
  repoRoot?: string;
  sourcePath?: string;
  outputDirectory?: string;
}

export function validateAppStaticHeaders(source: string): string;
export function assertHashedAppStaticBypassAssets(outputDirectory: string): Promise<string[]>;
export function materializeAppStaticHeaders(
  options?: AppStaticHeadersOptions,
): Promise<{ sourcePath: string; outputPath: string }>;
export function assertAppStaticHeadersMaterialized(
  options?: AppStaticHeadersOptions,
): Promise<{ sourcePath: string; outputPath: string }>;
