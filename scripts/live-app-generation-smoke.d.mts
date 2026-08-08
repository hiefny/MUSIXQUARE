export const APP_ORIGIN: string;
export const APP_GENERATION_TIMEOUT_MS: number;
export const APP_GENERATION_REQUEST_TIMEOUT_MS: number;
export const APP_GENERATION_POLL_MS: number;
export const REQUIRED_CONSECUTIVE_GENERATION_READS: number;
export const APP_INDEX_MAX_BYTES: number;
export const APP_ASSET_MAX_BYTES: number;
export const APP_MAIN_ASSET_MAX_BYTES: number;

export interface AppGenerationReadResult {
  status: number;
  mainScript: string | null;
  byteLength?: number | null;
  sha256?: string | null;
}

export interface AppAssetIdentity {
  url: string;
  byteLength?: number;
  sha256?: string;
}

export interface AppGenerationResult {
  expectedMain: string;
  consecutiveReads: number;
  mainAssetBytes: number;
  verifiedAssetCount: number;
}

export interface AppAssetReadResult {
  assetUrl: string;
  status: number;
  contentType: string;
  byteLength: number | null;
  sha256: string | null;
}

export function extractMainScript(html: string): string | null;

export function expectedAppAssetGraph(options?: {
  read?: (path: string) => Promise<Uint8Array | string>;
}): Promise<{
  mainScript: string;
  indexByteLength: number;
  indexSha256: string;
  assets: Array<Required<AppAssetIdentity>>;
}>;

export function expectedMainScript(options?: {
  read?: (path: string, encoding: 'utf8') => Promise<string>;
}): Promise<string>;

export function expectedMainAsset(options: {
  mainScript: string;
  read?: (path: string) => Promise<Uint8Array | string>;
}): Promise<{ byteLength: number; sha256: string }>;

export function readPublicIndex(options: { timeoutMs: number }): Promise<AppGenerationReadResult>;

export function readPublicAsset(options: {
  assetUrl: string;
  timeoutMs: number;
}): Promise<AppAssetReadResult>;

export function readPublicMainAsset(options: {
  mainScript: string;
  timeoutMs: number;
}): Promise<AppAssetReadResult>;

export function verifyPublicAppGeneration(options: {
  expectedMain: string;
  expectedIndexBytes?: number;
  expectedIndexSha256?: string;
  expectedAssets?: AppAssetIdentity[];
  expectedAssetBytes?: number;
  expectedAssetSha256?: string;
  read?: (options: { timeoutMs: number }) => Promise<AppGenerationReadResult>;
  readAsset?: (options: { assetUrl: string; timeoutMs: number }) => Promise<AppAssetReadResult>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollMs?: number;
  requiredConsecutiveReads?: number;
}): Promise<AppGenerationResult>;

export function main(): Promise<void>;
