export function validateAppStaticHeaders(source: string): void;
export function assertHashedAppStaticBypassAssets(outputDirectory: string): Promise<void>;
export function materializeAppStaticHeaders(options: {
  sourcePath: string;
  outputDirectory: string;
}): Promise<{ sourcePath: string; outputPath: string }>;
export function assertAppStaticHeadersMaterialized(options: {
  sourcePath: string;
  outputDirectory: string;
}): Promise<{ sourcePath: string; outputPath: string }>;
