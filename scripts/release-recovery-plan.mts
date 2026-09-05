import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE_TARGET_VALUES = [
  'all',
  'app',
  'developer-api',
  'pro-room',
  'remote-share',
  'signaling',
] as const;
const WORKER_TARGET_VALUES = [
  'app',
  'developer-api',
  'developer-api-facade',
  'pro-room',
  'remote-share',
  'signaling',
] as const;

type ReleaseTarget = (typeof RELEASE_TARGET_VALUES)[number];
export type RecoveryWorkerTarget = (typeof WORKER_TARGET_VALUES)[number];
type StepOutcome = 'success' | 'failure' | 'cancelled' | 'skipped';

const RELEASE_TARGETS: ReadonlySet<string> = new Set(RELEASE_TARGET_VALUES);
const WORKER_TARGETS: ReadonlySet<string> = new Set(WORKER_TARGET_VALUES);
const GENERATION_FLOOR_TARGETS = [
  'pro-room',
  'signaling',
  'developer-api-facade',
  'developer-api',
  'app',
] as const satisfies readonly RecoveryWorkerTarget[];

function isReleaseTarget(value: unknown): value is ReleaseTarget {
  return typeof value === 'string' && RELEASE_TARGETS.has(value);
}

function isWorkerTarget(value: unknown): value is RecoveryWorkerTarget {
  return typeof value === 'string' && WORKER_TARGETS.has(value);
}

function exactBoolean(value: unknown, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly true or false.`);
}

function outcome(value: unknown, name: string): StepOutcome {
  if (value === 'success' || value === 'failure' || value === 'cancelled' || value === 'skipped') {
    return value;
  }
  throw new Error(`${name} has an unsupported step outcome.`);
}

function targetList(value: unknown, name: string): RecoveryWorkerTarget[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const targets = value
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);
  if (targets.some((target) => !isWorkerTarget(target))) {
    throw new Error(`${name} contains an unsupported Worker target.`);
  }
  return targets.filter(isWorkerTarget);
}

function fallbackR2Targets(releaseTarget: ReleaseTarget): RecoveryWorkerTarget[] {
  if (releaseTarget === 'all') return ['remote-share', 'pro-room', 'app'];
  if (releaseTarget === 'remote-share') return ['remote-share'];
  if (releaseTarget === 'pro-room') return ['pro-room'];
  return [];
}

function fallbackWorkerFloorTargets(releaseTarget: ReleaseTarget): RecoveryWorkerTarget[] {
  if (releaseTarget === 'all') {
    return ['pro-room', 'signaling', 'developer-api-facade', 'developer-api', 'app'];
  }
  if (releaseTarget === 'developer-api') return ['developer-api-facade', 'developer-api'];
  return ['pro-room', 'signaling', 'app'].includes(releaseTarget) ? [releaseTarget] : [];
}

export function releaseRecoverySkipTargets(
  environment: NodeJS.ProcessEnv = process.env,
): RecoveryWorkerTarget[] {
  const releaseTarget = environment.RELEASE_TARGET;
  if (!isReleaseTarget(releaseTarget)) throw new Error('RELEASE_TARGET is invalid.');
  const r2Outcome = outcome(environment.MXQR_R2_POLICY_OUTCOME, 'MXQR_R2_POLICY_OUTCOME');
  const generationOutcome = outcome(
    environment.MXQR_GENERATION_FENCE_OUTCOME,
    'MXQR_GENERATION_FENCE_OUTCOME',
  );
  const workerFloorOutcome = outcome(
    environment.MXQR_WORKER_FLOOR_OUTCOME,
    'MXQR_WORKER_FLOOR_OUTCOME',
  );
  const signalingDomainRecoveryOutcome = outcome(
    environment.MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME,
    'MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME',
  );
  const applyDeveloperApiD1 = exactBoolean(
    environment.MXQR_APPLY_DEVELOPER_API_D1,
    'MXQR_APPLY_DEVELOPER_API_D1',
  );
  const serviceControlForwardFloor = exactBoolean(
    environment.MXQR_SERVICE_CONTROL_FORWARD_FLOOR,
    'MXQR_SERVICE_CONTROL_FORWARD_FLOOR',
  );
  const remoteShareForwardFloor = exactBoolean(
    environment.MXQR_REMOTE_SHARE_FORWARD_FLOOR,
    'MXQR_REMOTE_SHARE_FORWARD_FLOOR',
  );
  const proSystemAudioForwardFloor = exactBoolean(
    environment.MXQR_PRO_SYSTEM_AUDIO_FORWARD_FLOOR,
    'MXQR_PRO_SYSTEM_AUDIO_FORWARD_FLOOR',
  );
  const standardRoomPinForwardFloor = exactBoolean(
    environment.MXQR_STANDARD_ROOM_PIN_FORWARD_FLOOR,
    'MXQR_STANDARD_ROOM_PIN_FORWARD_FLOOR',
  );
  const soroArticleVisibilityForwardFloor = exactBoolean(
    environment.MXQR_SORO_ARTICLE_VISIBILITY_FORWARD_FLOOR,
    'MXQR_SORO_ARTICLE_VISIBILITY_FORWARD_FLOOR',
  );

  const skip = new Set(
    r2Outcome === 'success'
      ? targetList(environment.MXQR_R2_FORWARD_TARGETS, 'MXQR_R2_FORWARD_TARGETS')
      : fallbackR2Targets(releaseTarget),
  );
  if (generationOutcome === 'failure' || generationOutcome === 'cancelled') {
    for (const target of GENERATION_FLOOR_TARGETS) {
      skip.add(target);
    }
  }
  if (releaseTarget !== 'remote-share') {
    const workerTargets =
      workerFloorOutcome === 'success'
        ? targetList(environment.MXQR_WORKER_FLOOR_TARGETS, 'MXQR_WORKER_FLOOR_TARGETS')
        : fallbackWorkerFloorTargets(releaseTarget);
    for (const target of workerTargets) skip.add(target);
  }
  if (applyDeveloperApiD1) {
    skip.add('developer-api-facade');
    skip.add('developer-api');
  }
  if (serviceControlForwardFloor) {
    skip.add('pro-room');
    skip.add('app');
  }
  if (remoteShareForwardFloor) {
    skip.add('remote-share');
    skip.add('app');
  }
  if (proSystemAudioForwardFloor) {
    skip.add('pro-room');
    skip.add('signaling');
    skip.add('app');
  }
  if (standardRoomPinForwardFloor) {
    skip.add('signaling');
  }
  if (soroArticleVisibilityForwardFloor) {
    skip.add('app');
  }
  if (
    (releaseTarget === 'all' || releaseTarget === 'signaling') &&
    signalingDomainRecoveryOutcome !== 'success'
  ) {
    // Never roll an older signaling version back under an alternate hostname
    // that automatic recovery could not prove it safely detached.
    skip.add('signaling');
  }
  return [...skip];
}

function main(): void {
  process.stdout.write(releaseRecoverySkipTargets().join(','));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `[release-recovery-plan] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
