import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EMERGENCY_DEPLOY_CONFIRM_ENV = 'MXQR_EMERGENCY_DEPLOY_CONFIRM';
export const EMERGENCY_DEPLOY_PREFIX = 'MUSIXQUARE_EMERGENCY_DEPLOY';
export const EMERGENCY_DEPLOY_TARGETS = [
  'remote-share',
  'pro-room',
  'developer-api-facade',
  'developer-api',
  'developer-api-stack',
  'signaling',
  'app',
  'all-workers',
] as const;

export type EmergencyDeployTarget = (typeof EMERGENCY_DEPLOY_TARGETS)[number];

export interface EmergencyDeployAuthorization {
  target: EmergencyDeployTarget;
  commitSha: string;
}

export interface EmergencyDeployAuthorizationInput {
  target: unknown;
  commitSha: unknown;
  branchName: unknown;
  originMainSha: unknown;
  worktreeStatus: unknown;
  confirmation: unknown;
}

type GitReader = (args: string[]) => string;

export interface AuthorizeEmergencyDeployOptions {
  confirmation?: string;
  readGit?: GitReader;
}

function isTarget(value: unknown): value is EmergencyDeployTarget {
  return typeof value === 'string' && EMERGENCY_DEPLOY_TARGETS.some((target) => target === value);
}

export function expectedEmergencyDeployConfirmation(target: unknown, commitSha: unknown): string {
  if (!isTarget(target)) throw new Error(`Unknown emergency deployment target: ${target}`);
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new Error('Emergency deployment requires a full lowercase Git commit SHA.');
  }
  return `${EMERGENCY_DEPLOY_PREFIX}:${target}:${commitSha}`;
}

export function assertEmergencyDeployAuthorization({
  target,
  commitSha,
  branchName,
  originMainSha,
  worktreeStatus,
  confirmation,
}: EmergencyDeployAuthorizationInput): EmergencyDeployAuthorization {
  if (!isTarget(target) || typeof commitSha !== 'string') {
    throw new Error('Emergency deployment authorization returned an invalid target or commit.');
  }
  const expected = expectedEmergencyDeployConfirmation(target, commitSha);
  if (branchName !== 'main') {
    throw new Error('Emergency deployment refused: the checked-out branch must be main.');
  }
  if (originMainSha !== commitSha) {
    throw new Error(
      'Emergency deployment refused: HEAD must already be pushed and equal to origin/main.',
    );
  }
  if (worktreeStatus !== '') {
    throw new Error(
      'Emergency deployment refused: commit or remove every tracked and untracked worktree change first.',
    );
  }
  if (confirmation !== expected) {
    throw new Error(
      `Emergency deployment refused. Set ${EMERGENCY_DEPLOY_CONFIRM_ENV} exactly to:\n${expected}`,
    );
  }
  return { target, commitSha };
}

function readGit(args: string[]): string {
  return String(execFileSync('git', args, { encoding: 'utf8' })).trim();
}

export function parseRemoteMainSha(output: unknown): string {
  const match = /^([0-9a-f]{40})\s+refs\/heads\/main\s*$/iu.exec(String(output));
  if (!match) {
    throw new Error(
      'Emergency deployment refused: origin did not return one valid refs/heads/main commit.',
    );
  }
  const commitSha = match[1];
  if (commitSha === undefined) {
    throw new Error(
      'Emergency deployment refused: origin did not return one valid refs/heads/main commit.',
    );
  }
  return commitSha.toLowerCase();
}

function readLiveOriginMainSha(reader: GitReader = readGit): string {
  try {
    return parseRemoteMainSha(reader(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']));
  } catch {
    throw new Error(
      'Emergency deployment refused: the live origin/main commit could not be verified.',
    );
  }
}

export function authorizeEmergencyDeploy(
  target: string,
  options: AuthorizeEmergencyDeployOptions = {},
): EmergencyDeployAuthorization {
  if (!isTarget(target)) throw new Error(`Unknown emergency deployment target: ${target}`);
  const reader = options.readGit ?? readGit;
  const commitSha = reader(['rev-parse', '--verify', 'HEAD']);
  const branchName = reader(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const worktreeStatus = reader(['status', '--porcelain=v1', '--untracked-files=normal']);
  // A local remote-tracking ref can be stale. Query the actual remote as the
  // last authorization read so an old checkout cannot overwrite a newer main.
  // Network and authentication failures deliberately fail closed.
  const originMainSha = readLiveOriginMainSha(reader);
  const authorization = assertEmergencyDeployAuthorization({
    target,
    commitSha,
    branchName,
    originMainSha,
    worktreeStatus,
    confirmation:
      options.confirmation === undefined
        ? process.env[EMERGENCY_DEPLOY_CONFIRM_ENV]
        : options.confirmation,
  });
  process.stdout.write(
    `Emergency production deployment authorized for ${authorization.target} at ${authorization.commitSha}.\n`,
  );
  return authorization;
}

function rejectDirectDeploy(target: string): never {
  if (!isTarget(target)) throw new Error(`Unknown deployment target: ${target}`);
  throw new Error(
    `Direct production deployment is disabled. Use the approved GitHub Production Release workflow.\n` +
      `For a documented emergency only, use npm run emergency:deploy:${target} with ` +
      `${EMERGENCY_DEPLOY_CONFIRM_ENV}=<target-and-current-SHA confirmation>.`,
  );
}

function main(): void {
  const [mode, target, ...extra] = process.argv.slice(2);
  if (
    (mode !== 'authorize' && mode !== 'reject') ||
    !target ||
    (mode === 'authorize' && extra.length)
  ) {
    throw new Error('Usage: node scripts/guard-emergency-deploy.mts <authorize|reject> <target>');
  }
  if (mode === 'reject') rejectDirectDeploy(target);
  authorizeEmergencyDeploy(target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
