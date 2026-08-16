import { pathToFileURL } from 'node:url';

import {
  EMERGENCY_DEPLOY_TARGETS,
  authorizeEmergencyDeploy,
  expectedEmergencyDeployConfirmation,
  type EmergencyDeployTarget,
} from './guard-emergency-deploy.mts';
import { executeNpm, npmInvocation } from './npm-invocation.mts';
import {
  captureDeploymentCheckpoint,
  preflight,
  recordCurrentDeployment,
  recheckPartialReleaseCompatibility,
  verifyEmergencyCodeOnly,
  verifyCurrentRelease,
  verifyPartialReleaseCompatibility,
} from './release-deployment-state.mts';

const WORKER_CONFIGS = {
  'remote-share': 'cloudflare/wrangler.remote-share.toml',
  'pro-room': 'cloudflare/wrangler.pro-room.toml',
  signaling: 'cloudflare/wrangler.signaling.toml',
  'developer-api-facade': 'cloudflare/wrangler.developer-api-facade.toml',
  'developer-api': 'cloudflare/wrangler.developer-api.toml',
  app: 'cloudflare/wrangler.app.toml',
} as const;

type EmergencyWorker = keyof typeof WORKER_CONFIGS;

const EMERGENCY_WORKERS = [
  'remote-share',
  'pro-room',
  'signaling',
  'developer-api-facade',
  'developer-api',
  'app',
] as const satisfies readonly EmergencyWorker[];

type EmergencyRunner = (command: string[]) => void;
type CompatibilityCheck = (releaseTarget: string, headSha: string, directory: string) => unknown;
type Checkpoint = (releaseTarget: string, message: string, directory: string) => unknown;
type CodeOnlyCheck = (headSha: string, directory: string) => unknown;
type WorkerDirectoryOperation = (worker: string, directory: string) => unknown;
type FinalVerification = (directory: string) => unknown;

export interface EmergencyDeploymentOptions {
  target: string;
  authorize?: (target: string) => unknown;
  runner?: EmergencyRunner;
  compatibilityCheck?: CompatibilityCheck;
  compatibilityRecheck?: CompatibilityCheck;
  checkpoint?: Checkpoint;
  codeOnlyCheck?: CodeOnlyCheck;
  selectedPreflight?: WorkerDirectoryOperation;
  recordDeployment?: WorkerDirectoryOperation;
  finalVerification?: FinalVerification;
}

export interface EmergencyDeploymentResult {
  target: string;
  commitSha: string;
  message: string;
  commands: string[][];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmergencyTarget(value: unknown): value is EmergencyDeployTarget {
  return typeof value === 'string' && EMERGENCY_DEPLOY_TARGETS.some((target) => target === value);
}

function npmRun(script: string): string[] {
  return ['run', '--silent', script];
}

function deployWorker(worker: EmergencyWorker, message: string): string[] {
  const config = WORKER_CONFIGS[worker];
  if (!config) throw new Error(`Unknown emergency Worker: ${worker}`);
  return ['run', '--silent', 'wrangler', '--', 'deploy', '--config', config, '--message', message];
}

export function emergencyDeploymentMessage(target: string, commitSha: string): string {
  // Reuse the authorization contract to validate both the target and the full,
  // lowercase immutable commit before it can enter deployment provenance.
  // Cloudflare exposes only the first 50 annotation characters in deployment
  // status. Keep the message at the canonical 44-character git:<SHA> identity
  // so the post-deploy exact ownership check never depends on truncation. The
  // emergency target remains in the checkpoint/report path and authorization.
  expectedEmergencyDeployConfirmation(target, commitSha);
  return `git:${commitSha}`;
}

export function emergencyDeploymentPlan(target: string, commitSha: string): string[][] {
  const message = emergencyDeploymentMessage(target, commitSha);
  const deploy = (worker: EmergencyWorker): string[] => deployWorker(worker, message);

  switch (target) {
    case 'remote-share':
      return [deploy('remote-share')];
    case 'pro-room':
      return [npmRun('check:pro-room-worker'), deploy('pro-room')];
    case 'developer-api-facade':
    case 'developer-api':
      throw new Error(
        'Standalone Developer API emergency deployment is disabled; use developer-api-stack so the facade, schema, and API remain one contract.',
      );
    case 'developer-api-stack':
      return [
        npmRun('check:developer-api-workers'),
        deploy('developer-api-facade'),
        deploy('developer-api'),
      ];
    case 'signaling':
      return [deploy('signaling')];
    case 'app':
      return [npmRun('smoke:live:signaling'), npmRun('build:checked'), deploy('app')];
    case 'all-workers':
      return [
        npmRun('check:workers'),
        npmRun('build:checked'),
        deploy('pro-room'),
        deploy('remote-share'),
        deploy('signaling'),
        deploy('developer-api-facade'),
        deploy('developer-api'),
        deploy('app'),
      ];
    default:
      throw new Error(`Unknown emergency deployment target: ${target}`);
  }
}

export function emergencyCompatibilityTarget(target: string): string | null {
  switch (target) {
    case 'remote-share':
    case 'pro-room':
    case 'signaling':
    case 'app':
      return target;
    case 'developer-api-stack':
      return 'developer-api';
    case 'all-workers':
      return null;
    case 'developer-api-facade':
    case 'developer-api':
      throw new Error(
        'Standalone Developer API emergency deployment is disabled; use developer-api-stack.',
      );
    default:
      throw new Error(`Unknown emergency deployment target: ${target}`);
  }
}

export function parseEmergencyDeploymentArgs(args: readonly string[]): EmergencyDeployTarget {
  const target = args[0];
  if (args.length !== 1 || !isEmergencyTarget(target)) {
    throw new Error(
      'Usage: node scripts/emergency-deploy.mts ' +
        `<${EMERGENCY_DEPLOY_TARGETS.join('|')}> (trailing arguments are not accepted)`,
    );
  }
  return target;
}

function runNpm(args: string[]): void {
  executeNpm(args);
}

export function emergencyWorkerForDeploymentCommand(
  command: readonly string[],
): EmergencyWorker | null {
  const configIndex = command.indexOf('--config');
  if (!command.includes('deploy') || configIndex < 0 || configIndex + 1 >= command.length) {
    return null;
  }
  const config = command[configIndex + 1];
  if (config === undefined) return null;
  return EMERGENCY_WORKERS.find((worker) => WORKER_CONFIGS[worker] === config) ?? null;
}

export function runEmergencyDeployment({
  target,
  authorize = authorizeEmergencyDeploy,
  runner = runNpm,
  compatibilityCheck = verifyPartialReleaseCompatibility,
  compatibilityRecheck = recheckPartialReleaseCompatibility,
  checkpoint = captureDeploymentCheckpoint,
  codeOnlyCheck = verifyEmergencyCodeOnly,
  selectedPreflight = preflight,
  recordDeployment = recordCurrentDeployment,
  finalVerification = verifyCurrentRelease,
}: EmergencyDeploymentOptions): EmergencyDeploymentResult {
  const rawAuthorization: unknown = authorize(target);
  if (
    !isRecord(rawAuthorization) ||
    rawAuthorization.target !== target ||
    typeof rawAuthorization.commitSha !== 'string'
  ) {
    throw new Error('Emergency deployment authorization returned an invalid result.');
  }
  const authorization = {
    target: rawAuthorization.target,
    commitSha: rawAuthorization.commitSha,
  };
  const message = emergencyDeploymentMessage(target, authorization.commitSha);
  const compatibilityTarget = emergencyCompatibilityTarget(target);
  const directory = `release-artifacts/emergency-deployments/${authorization.commitSha}-${target}`;
  if (compatibilityTarget) {
    compatibilityCheck(compatibilityTarget, authorization.commitSha, directory);
  }
  const checkpointTarget = compatibilityTarget || 'all';
  checkpoint(checkpointTarget, message, directory);
  codeOnlyCheck(authorization.commitSha, directory);
  const commands = emergencyDeploymentPlan(target, authorization.commitSha);
  process.stdout.write(`Emergency deployment provenance: ${message}\n`);
  for (const command of commands) {
    const worker = emergencyWorkerForDeploymentCommand(command);
    if (worker) {
      if (compatibilityTarget) {
        compatibilityRecheck(compatibilityTarget, authorization.commitSha, directory);
      }
      selectedPreflight(worker, directory);
    }
    runner(command);
    if (worker) recordDeployment(worker, directory);
  }
  finalVerification(directory);
  return { target, commitSha: authorization.commitSha, message, commands };
}

function main(): void {
  const target = parseEmergencyDeploymentArgs(process.argv.slice(2));
  runEmergencyDeployment({ target });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { npmInvocation as emergencyNpmInvocation };
