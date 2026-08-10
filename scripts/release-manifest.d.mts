export type ReleaseManifestOptions = {
  distDirectory?: string;
  manifestPath?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

export function createReleaseManifest(options?: ReleaseManifestOptions): Record<string, unknown>;
export function verifyReleaseManifest(options?: ReleaseManifestOptions): Record<string, unknown>;
