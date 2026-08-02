export interface ReleaseIdentity {
  productVersion: string;
  serviceWorkerCacheEpoch: number;
}
export function parseReleaseIdentity(input: {
  packageSource: string;
  lockSource: string;
  serviceWorkerSource: string;
  appWorkerSource?: string;
  adminScriptSource?: string;
}): ReleaseIdentity;
export function readReleaseIdentity(repositoryRoot?: string): ReleaseIdentity;
