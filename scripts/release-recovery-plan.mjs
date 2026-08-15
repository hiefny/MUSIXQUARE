const RELEASE_TARGETS = new Set([
  'all',
  'app',
  'developer-api',
  'pro-room',
  'remote-share',
  'signaling',
]);
const WORKER_TARGETS = new Set([
  'app',
  'developer-api',
  'developer-api-facade',
  'pro-room',
  'remote-share',
  'signaling',
]);

function exactBoolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly true or false.`);
}

function outcome(value, name) {
  if (['success', 'failure', 'cancelled', 'skipped'].includes(value)) return value;
  throw new Error(`${name} has an unsupported step outcome.`);
}

function targetList(value, name) {
  if (!value?.trim()) return [];
  const targets = value
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);
  if (targets.some((target) => !WORKER_TARGETS.has(target))) {
    throw new Error(`${name} contains an unsupported Worker target.`);
  }
  return targets;
}

function fallbackR2Targets(releaseTarget) {
  if (releaseTarget === 'all') return ['remote-share', 'pro-room', 'app'];
  if (releaseTarget === 'remote-share') return ['remote-share'];
  if (releaseTarget === 'pro-room') return ['pro-room'];
  return [];
}

function fallbackWorkerFloorTargets(releaseTarget) {
  if (releaseTarget === 'all') {
    return ['pro-room', 'signaling', 'developer-api-facade', 'developer-api', 'app'];
  }
  if (releaseTarget === 'developer-api') return ['developer-api-facade', 'developer-api'];
  return ['pro-room', 'signaling', 'app'].includes(releaseTarget) ? [releaseTarget] : [];
}

function main() {
  const releaseTarget = process.env.RELEASE_TARGET || '';
  if (!RELEASE_TARGETS.has(releaseTarget)) throw new Error('RELEASE_TARGET is invalid.');
  const r2Outcome = outcome(process.env.MXQR_R2_POLICY_OUTCOME || '', 'MXQR_R2_POLICY_OUTCOME');
  const generationOutcome = outcome(
    process.env.MXQR_GENERATION_FENCE_OUTCOME || '',
    'MXQR_GENERATION_FENCE_OUTCOME',
  );
  const workerFloorOutcome = outcome(
    process.env.MXQR_WORKER_FLOOR_OUTCOME || '',
    'MXQR_WORKER_FLOOR_OUTCOME',
  );
  const applyDeveloperApiD1 = exactBoolean(
    process.env.MXQR_APPLY_DEVELOPER_API_D1,
    'MXQR_APPLY_DEVELOPER_API_D1',
  );
  const serviceControlForwardFloor = exactBoolean(
    process.env.MXQR_SERVICE_CONTROL_FORWARD_FLOOR,
    'MXQR_SERVICE_CONTROL_FORWARD_FLOOR',
  );
  const remoteShareForwardFloor = exactBoolean(
    process.env.MXQR_REMOTE_SHARE_FORWARD_FLOOR,
    'MXQR_REMOTE_SHARE_FORWARD_FLOOR',
  );

  const skip = new Set(
    r2Outcome === 'success'
      ? targetList(process.env.MXQR_R2_FORWARD_TARGETS, 'MXQR_R2_FORWARD_TARGETS')
      : fallbackR2Targets(releaseTarget),
  );
  if (generationOutcome === 'failure' || generationOutcome === 'cancelled') {
    for (const target of [
      'pro-room',
      'signaling',
      'developer-api-facade',
      'developer-api',
      'app',
    ]) {
      skip.add(target);
    }
  }
  if (releaseTarget !== 'remote-share') {
    const workerTargets =
      workerFloorOutcome === 'success'
        ? targetList(process.env.MXQR_WORKER_FLOOR_TARGETS, 'MXQR_WORKER_FLOOR_TARGETS')
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
  process.stdout.write([...skip].join(','));
}

try {
  main();
} catch (error) {
  console.error(
    `[release-recovery-plan] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
