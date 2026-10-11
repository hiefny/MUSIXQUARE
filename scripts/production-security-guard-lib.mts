import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { experimental_readRawConfig } from 'wrangler';
import {
  readConfigurationAssignment,
  validateAccountRolloutConfig,
  validateRemoteShareRolloutConfig,
} from './production-security-rollout.mts';
import { validateProSignalingCredentialBoundary } from './pro-signaling-credential-boundary.mts';
import { validateStandardRoomPinStorageBoundary } from './standard-room-pin-storage-boundary.mts';

export interface SecurityFlagHit {
  readonly source: string;
  readonly flag: string;
}

export interface ProductionSecurityFindings {
  readonly hits: readonly SecurityFlagHit[];
  readonly rolloutErrors: readonly string[];
  readonly remoteShareRolloutErrors: readonly string[];
  readonly proSignalingCredentialErrors: readonly string[];
  readonly standardRoomPinStorageErrors: readonly string[];
}

/**
 * Both inputs are required on purpose. The release gate CLI passes its own
 * checkout and `process.env`; a default here could silently stop inspecting the
 * deploy environment if a caller forgot one of them.
 */
export interface ProductionSecurityGuardOptions {
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const dangerousFlags = [
  'MXQR_ALLOW_INFERRED_CAPABILITY_FALLBACK',
  'ALLOW_INFERRED_CAPABILITY_FALLBACK',
  'MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK',
  'MXQR_ALLOW_HEADER_CAPABILITY_FALLBACK',
  'ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK',
  'MXQR_ALLOW_UNGUARDED_PAID_APIS',
  'ALLOW_UNGUARDED_PAID_APIS',
  'MXQR_ALLOW_UNGUARDED_REMOTE_SHARE',
  'ALLOW_UNGUARDED_REMOTE_SHARE',
  'MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION',
];

// Static env-style files we always check.
const staticConfigFiles = [
  '.env.cloudflare-turn',
  '.env.cloudflare-turn.example',
  '.env.production',
  '.env.production.local',
  '.dev.vars',
  '.dev.vars.production',
];

// Auto-discover every cloudflare/wrangler*.toml so new workers (and their
// example files) are covered without updating this list. Prevents the
// "added a worker, forgot to extend the guard" failure mode.
function isErrnoException(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

async function discoverWranglerFiles(repoRoot: string): Promise<string[]> {
  const dir = path.join(repoRoot, 'cloudflare');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^wrangler.*\.toml$/i.test(entry.name))
      .map((entry) => `cloudflare/${entry.name}`)
      .sort();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

const truthyValues = new Set(['1', 'true', 'yes', 'on']);

function isTruthy(value: unknown, stripAssignmentQuotes = true): boolean {
  const normalized = String(value || '').trim();
  return truthyValues.has(
    (stripAssignmentQuotes ? normalized.replace(/^['"]|['"]$/g, '') : normalized).toLowerCase(),
  );
}

function inspectWranglerValues(value: unknown, file: string, hits: SecurityFlagHit[]): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (dangerousFlags.includes(key) && isTruthy(entry, false)) {
      hits.push({ source: file, flag: key });
    }
    if (
      file === 'cloudflare/wrangler.pro-room.toml' &&
      (key === 'PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION' ||
        key === 'PRO_ROOM_MEMBER_AUTHORITY_PROJECTION')
    ) {
      hits.push({ source: file, flag: key });
    }
    inspectWranglerValues(entry, file, hits);
  }
}

/**
 * Inspect one checkout and one environment for unapproved bypass flags and
 * retired rollout configuration. Every accumulator is local to the call, so
 * repeated calls (tests) never leak findings into each other.
 */
export async function collectProductionSecurityFindings({
  repoRoot,
  env,
}: ProductionSecurityGuardOptions): Promise<ProductionSecurityFindings> {
  const configFiles = [...staticConfigFiles, ...(await discoverWranglerFiles(repoRoot))];

  const hits: SecurityFlagHit[] = [];

  for (const flag of dangerousFlags) {
    if (isTruthy(env[flag])) {
      hits.push({ source: 'environment', flag });
    }
  }

  for (const file of configFiles) {
    let text: string;
    try {
      text = await readFile(path.join(repoRoot, file), 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') continue;
      throw error;
    }

    if (file.endsWith('.toml')) {
      try {
        // Explicit raw-config reads only parse the local file. Use the same
        // TOML semantics as deployment, including quoted keys and string escapes.
        const config = experimental_readRawConfig({ config: path.join(repoRoot, file) }).rawConfig;
        inspectWranglerValues(config, file, hits);
      } catch {
        // Parser errors can contain source excerpts; never echo those values.
        throw new Error(`Production security configuration is unreadable: ${file}`);
      }
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      if (line.trimStart().startsWith('#')) continue;
      for (const flag of dangerousFlags) {
        const value = readConfigurationAssignment(line, flag);
        if (value !== null && isTruthy(value)) {
          hits.push({ source: `${file}:${i + 1}`, flag });
        }
      }
    }
  }

  // Account identity and least-privilege PRO authority are current-contract
  // invariants. Reject their retired rollout flags and require both Workers to
  // retain the dedicated account database binding. Secrets are verified at
  // deploy/runbook time because Wrangler keeps them out of the repository.
  const proConfigPath = path.join(repoRoot, 'cloudflare', 'wrangler.pro-room.toml');
  const appConfigPath = path.join(repoRoot, 'cloudflare', 'wrangler.app.toml');
  const remoteShareConfigPath = path.join(repoRoot, 'cloudflare', 'wrangler.remote-share.toml');
  const signalingConfigPath = path.join(repoRoot, 'cloudflare', 'wrangler.signaling.toml');
  const signalingWorkerPath = path.join(repoRoot, 'cloudflare', 'signaling-worker.ts');
  const standardRoomPinMembershipPath = path.join(
    repoRoot,
    'cloudflare',
    'standard-room-pin-membership.ts',
  );
  const [
    proConfig,
    appConfig,
    remoteShareConfig,
    signalingConfig,
    signalingWorker,
    standardRoomPinMembership,
  ] = await Promise.all([
    readFile(proConfigPath, 'utf8'),
    readFile(appConfigPath, 'utf8'),
    readFile(remoteShareConfigPath, 'utf8'),
    readFile(signalingConfigPath, 'utf8'),
    readFile(signalingWorkerPath, 'utf8'),
    readFile(standardRoomPinMembershipPath, 'utf8'),
  ]);

  return {
    hits,
    rolloutErrors: [...validateAccountRolloutConfig(proConfig, appConfig)],
    remoteShareRolloutErrors: [
      ...validateRemoteShareRolloutConfig(remoteShareConfig, signalingConfig),
    ],
    proSignalingCredentialErrors: [
      ...validateProSignalingCredentialBoundary({
        workerSource: signalingWorker,
      }),
    ],
    standardRoomPinStorageErrors: [
      ...validateStandardRoomPinStorageBoundary({
        workerSource: signalingWorker,
        signalingConfig,
        membershipSource: standardRoomPinMembership,
      }),
    ],
  };
}

/**
 * The exact stderr lines the release gate prints for unsafe findings, or null
 * when the configuration is clean.
 */
export function formatProductionSecurityFailure(
  findings: ProductionSecurityFindings,
): string[] | null {
  const {
    hits,
    rolloutErrors,
    remoteShareRolloutErrors,
    proSignalingCredentialErrors,
    standardRoomPinStorageErrors,
  } = findings;
  if (
    hits.length === 0 &&
    rolloutErrors.length === 0 &&
    remoteShareRolloutErrors.length === 0 &&
    proSignalingCredentialErrors.length === 0 &&
    standardRoomPinStorageErrors.length === 0
  ) {
    return null;
  }
  return [
    '[prod-security-guard] Unsafe production configuration detected:',
    ...hits.map((hit) => `  - ${hit.source}: ${hit.flag}`),
    ...rolloutErrors.map((error) => `  - account rollout: ${error}`),
    ...remoteShareRolloutErrors.map((error) => `  - Remote Share rollout: ${error}`),
    ...proSignalingCredentialErrors.map(
      (error) => `  - PRO signaling credential boundary: ${error}`,
    ),
    ...standardRoomPinStorageErrors.map(
      (error) => `  - Standard room PIN storage boundary: ${error}`,
    ),
    '[prod-security-guard] Fix the production security/rollout configuration before deploying.',
  ];
}
