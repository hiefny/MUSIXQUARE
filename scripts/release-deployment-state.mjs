import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const DEFAULT_DIRECTORY = 'release-artifacts/deployments';
const QUERY_RETRY = Object.freeze({ maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 2_000 });
const ROLLBACK_RETRY = Object.freeze({ maxAttempts: 3, baseDelayMs: 750, maxDelayMs: 2_000 });
const VERIFY_RETRY = Object.freeze({ maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 4_000 });

const TARGETS = {
  'remote-share': {
    config: 'cloudflare/wrangler.remote-share.toml',
    rollbackOrder: 1,
  },
  signaling: {
    config: 'cloudflare/wrangler.signaling.toml',
    rollbackOrder: 3,
  },
  'pro-room': {
    config: 'cloudflare/wrangler.pro-room.toml',
    rollbackOrder: 2,
  },
  'developer-api-facade': {
    config: 'cloudflare/wrangler.developer-api-facade.toml',
    rollbackOrder: 4,
  },
  'developer-api': {
    config: 'cloudflare/wrangler.developer-api.toml',
    rollbackOrder: 5,
  },
  app: {
    config: 'cloudflare/wrangler.app.toml',
    rollbackOrder: 6,
  },
};

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function targetDefinition(target) {
  const definition = TARGETS[target];
  if (!definition) {
    throw new Error(`Unknown release target: ${target}`);
  }
  return definition;
}

function productionVersion(deployment, label) {
  if (!deployment || !Array.isArray(deployment.versions)) {
    throw new Error(`${label} is not a Wrangler deployment status payload.`);
  }
  const productionVersions = deployment.versions.filter(
    (version) => Number(version?.percentage) === 100 && typeof version?.version_id === 'string',
  );
  if (productionVersions.length !== 1) {
    throw new Error(
      `${label} must contain exactly one 100% production version; found ${productionVersions.length}.`,
    );
  }
  return productionVersions[0].version_id;
}

function deploymentMessage(deployment) {
  return deployment?.annotations?.['workers/message'] || null;
}

function pathsFor(target, directory) {
  const base = resolve(directory);
  return {
    before: resolve(base, `${target}-before.json`),
    preflight: resolve(base, `${target}-preflight.json`),
    after: resolve(base, `${target}.json`),
    state: resolve(base, `${target}-state.json`),
    finalCurrent: resolve(base, `${target}-final-current.json`),
    rollbackCurrent: resolve(base, `${target}-rollback-current.json`),
    rollback: resolve(base, `${target}-rollback.json`),
  };
}

function sleepSync(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function retrySync(label, operation, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 1);
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 0);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || baseDelayMs);
  const sleep = options.sleep || sleepSync;
  const onRetry =
    options.onRetry ||
    ((error, attempt, delayMs) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `${label} failed on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs} ms: ${detail}`,
      );
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation(attempt);
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      onRetry(error, attempt, delayMs);
      sleep(delayMs);
    }
  }

  throw new Error(`${label} exhausted its retry budget.`);
}

function prepare(target, directory) {
  const definition = targetDefinition(target);
  const paths = pathsFor(target, directory);
  const before = readJson(paths.before);
  const releaseMessage = process.env.RELEASE_MESSAGE;
  if (!releaseMessage) throw new Error('RELEASE_MESSAGE is required to prepare a deployment.');

  writeJson(paths.state, {
    schemaVersion: SCHEMA_VERSION,
    target,
    config: definition.config,
    releaseMessage,
    beforeDeploymentId: before.id || null,
    beforeVersionId: productionVersion(before, `${target} before deployment`),
    attempted: false,
    afterDeploymentId: null,
    afterVersionId: null,
    changed: false,
  });
  console.log(`Prepared rollback state for ${target}.`);
}

function updateState(target, directory, update) {
  const paths = pathsFor(target, directory);
  const state = readJson(paths.state);
  if (state.schemaVersion !== SCHEMA_VERSION || state.target !== target) {
    throw new Error(`Malformed deployment state for ${target}.`);
  }
  writeJson(paths.state, { ...state, ...update });
  return { paths, state: { ...state, ...update } };
}

function markAttempt(target, directory) {
  updateState(target, directory, {
    attempted: true,
    attemptedAt: new Date().toISOString(),
  });
  console.log(`Marked ${target} deployment as attempted.`);
}

function record(target, directory) {
  const paths = pathsFor(target, directory);
  const after = readJson(paths.after);
  const afterVersionId = productionVersion(after, `${target} after deployment`);
  const previousState = readJson(paths.state);
  const afterMessage = deploymentMessage(after);
  const changed = afterVersionId !== previousState.beforeVersionId;
  const ownedByRelease = afterMessage === previousState.releaseMessage;
  const { state } = updateState(target, directory, {
    afterDeploymentId: after.id || null,
    afterVersionId,
    afterMessage,
    changed,
    ownedByRelease,
    recordedAt: new Date().toISOString(),
  });
  console.log(`${target} production version ${state.beforeVersionId} -> ${state.afterVersionId}`);
  if (!changed) {
    throw new Error(`${target} deploy did not create a new 100% production version.`);
  }
  if (!ownedByRelease) {
    throw new Error(`${target} production deployment is not owned by this release.`);
  }
}

function recordedVersion(target, directory) {
  const state = readJson(pathsFor(target, directory).state);
  if (!state.afterVersionId) throw new Error(`No recorded deployment version for ${target}.`);
  process.stdout.write(state.afterVersionId);
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runWrangler(args, options = {}) {
  return execFileSync(npmExecutable(), ['run', '--silent', 'wrangler', '--', ...args], {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

function queryCurrentOnce(target, config, outputPath, runner = runWrangler) {
  const stdout = runner(['deployments', 'status', '--config', config, '--json'], {
    capture: true,
  });
  writeFileSync(outputPath, stdout, 'utf8');
  const deployment = JSON.parse(stdout);
  return {
    deployment,
    deploymentId: deployment.id || null,
    versionId: productionVersion(deployment, `${target} current deployment`),
    message: deploymentMessage(deployment),
  };
}

function queryCurrent(target, config, outputPath, options = {}) {
  return retrySync(
    `${target} production deployment query`,
    () => queryCurrentOnce(target, config, outputPath, options.runner),
    { ...QUERY_RETRY, ...options.retry },
  );
}

function preflight(target, directory, options = {}) {
  const paths = pathsFor(target, directory);
  const state = readJson(paths.state);
  if (state.schemaVersion !== SCHEMA_VERSION || state.target !== target) {
    throw new Error(`Malformed deployment state for ${target}.`);
  }

  const current = (options.queryCurrent || queryCurrent)(
    target,
    state.config,
    paths.preflight,
    options.queryOptions,
  );
  const deploymentChanged = current.deploymentId !== state.beforeDeploymentId;
  const versionChanged = current.versionId !== state.beforeVersionId;
  if (deploymentChanged || versionChanged) {
    throw new Error(
      `${target} production changed after release preparation; expected deployment ` +
        `${state.beforeDeploymentId || '(none)'} / version ${state.beforeVersionId}, got ` +
        `${current.deploymentId || '(none)'} / version ${current.versionId}. Deploy was stopped.`,
    );
  }

  updateState(target, directory, {
    preflightDeploymentId: current.deploymentId,
    preflightVersionId: current.versionId,
    preflightCheckedAt: new Date().toISOString(),
  });
  console.log(`Verified unchanged production deployment for ${target}.`);
}

function runRollbackWithRetry(state, rollbackMessage, options = {}) {
  const runner = options.runner || runWrangler;
  const query = options.queryCurrent || queryCurrent;
  if (!options.outputPath) {
    throw new Error(`A current-deployment output path is required to roll back ${state.target}.`);
  }

  return retrySync(
    `${state.target} rollback attempt`,
    () => {
      const current = query(state.target, state.config, options.outputPath, options.queryOptions);
      const disposition = rollbackDisposition(state, current);
      if (disposition !== 'rollback') {
        return { status: disposition, current, commandIssued: false };
      }

      runner([
        'rollback',
        state.beforeVersionId,
        '--config',
        state.config,
        '--message',
        rollbackMessage,
        '--yes',
      ]);
      return { status: 'command-issued', current, commandIssued: true };
    },
    { ...ROLLBACK_RETRY, ...options.retry },
  );
}

function verifyProductionVersion(target, config, expectedVersionId, outputPath, options = {}) {
  return retrySync(
    `${target} rollback verification`,
    () => {
      const current = queryCurrentOnce(target, config, outputPath, options.runner);
      if (current.versionId !== expectedVersionId) {
        throw new Error(
          `Rollback verification expected ${expectedVersionId}, got ${current.versionId}.`,
        );
      }
      return current;
    },
    { ...VERIFY_RETRY, ...options.retry },
  );
}

function attemptedStates(directory) {
  return Object.entries(TARGETS)
    .map(([target, definition]) => {
      const statePath = pathsFor(target, directory).state;
      if (!existsSync(statePath)) return null;
      const state = readJson(statePath);
      if (state.schemaVersion !== SCHEMA_VERSION || state.target !== target) {
        throw new Error(`Malformed deployment state for ${target}.`);
      }
      return state.attempted ? { ...state, rollbackOrder: definition.rollbackOrder } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.rollbackOrder - left.rollbackOrder);
}

function verifyCurrentRelease(directory, options = {}) {
  const reportPath = resolve(directory, 'final-verification-report.json');
  const report = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    status: 'pending',
    results: [],
  };
  let failed = false;
  const query = options.queryCurrent || queryCurrent;
  const states = attemptedStates(directory).reverse();

  if (states.length === 0) {
    report.status = 'failed';
    report.results.push({
      target: 'release-state',
      status: 'failed',
      error: 'No attempted Worker deployment state was found for final verification.',
    });
    failed = true;
  }

  for (const state of states) {
    const result = {
      target: state.target,
      expectedDeploymentId: state.afterDeploymentId || null,
      expectedVersionId: state.afterVersionId || null,
      expectedMessage: state.releaseMessage || null,
      status: 'pending',
    };
    report.results.push(result);

    if (
      state.ownedByRelease !== true ||
      !state.afterDeploymentId ||
      !state.afterVersionId ||
      !state.releaseMessage
    ) {
      result.status = 'failed';
      result.error =
        'The attempted deployment was not completely recorded as owned by this release.';
      failed = true;
      continue;
    }

    try {
      const current = query(
        state.target,
        state.config,
        pathsFor(state.target, directory).finalCurrent,
        options.queryOptions,
      );
      result.currentDeploymentId = current.deploymentId || null;
      result.currentVersionId = current.versionId || null;
      result.currentMessage = current.message || null;

      const matchesRelease =
        current.deploymentId === state.afterDeploymentId &&
        current.versionId === state.afterVersionId &&
        current.message === state.releaseMessage;
      if (!matchesRelease) {
        result.status = 'conflict';
        result.error =
          'Current production no longer matches the deployment recorded by this release.';
        failed = true;
        continue;
      }

      result.status = 'verified';
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
  }

  report.completedAt = new Date().toISOString();
  report.status = failed ? 'failed' : 'verified';
  writeJson(reportPath, report);
  console.log(`Final deployment verification: ${reportPath} (${report.status})`);
  if (failed) {
    throw new Error(
      'Final production deployment verification failed; another deployment may have replaced this release.',
    );
  }
  return report;
}

function rollbackSkipTargets(value = process.env.MXQR_ROLLBACK_SKIP_TARGETS) {
  if (!value?.trim()) return new Set();
  const targets = new Set(
    value
      .split(/[\s,]+/)
      .map((target) => target.trim())
      .filter(Boolean),
  );
  for (const target of targets) targetDefinition(target);
  return targets;
}

function rollbackDisposition(state, current) {
  if (current.versionId === state.beforeVersionId) return 'already-restored';
  const isRecordedDeployment =
    state.ownedByRelease === true &&
    Boolean(state.afterVersionId) &&
    current.versionId === state.afterVersionId &&
    (!state.afterDeploymentId || current.deploymentId === state.afterDeploymentId);
  const isReleaseMessageMatch = current.message === state.releaseMessage;
  return isRecordedDeployment || isReleaseMessageMatch ? 'rollback' : 'conflict';
}

function rollbackDependencyBlock(target, states, results) {
  // First-frame host authentication is deliberately forward-compatible:
  // the new signaling Worker accepts both the new frame and the legacy URL,
  // while the legacy Worker cannot authenticate a new app that omits the URL
  // secret. If app recovery is uncertain, retaining the new signaling Worker
  // is the only combination that keeps both cached and current clients usable.
  if (target === 'signaling' && states.some((state) => state.target === 'app')) {
    const appResult = results.find((result) => result.target === 'app');
    if (appResult && ['restored', 'already-restored'].includes(appResult.status)) return null;
    return {
      dependency: 'app',
      dependencyStatus: appResult?.status || 'not-processed',
    };
  }

  // Signaling authorization is server-owned by the PRO room Durable Object.
  // A release that rolled signaling forward must restore signaling before it
  // can safely restore PRO. Otherwise a newer signaling Worker would call an
  // authority endpoint that no longer exists on the previous PRO Worker.
  if (target === 'pro-room' && states.some((state) => state.target === 'signaling')) {
    const signalingResult = results.find((result) => result.target === 'signaling');
    if (signalingResult && ['restored', 'already-restored'].includes(signalingResult.status)) {
      return null;
    }
    return {
      dependency: 'signaling',
      dependencyStatus: signalingResult?.status || 'not-processed',
    };
  }

  return null;
}

function rollback(directory) {
  const reportPath = resolve(directory, 'rollback-report.json');
  const report = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    status: 'not-required',
    results: [],
  };
  let failed = false;

  let states;
  let skipTargets;
  try {
    states = attemptedStates(directory);
    skipTargets = rollbackSkipTargets();
  } catch (error) {
    report.status = 'partial-failure';
    report.results.push({
      target: 'release-state',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    report.completedAt = new Date().toISOString();
    writeJson(reportPath, report);
    process.exitCode = 1;
    return;
  }

  for (const state of states) {
    const paths = pathsFor(state.target, directory);
    const result = {
      target: state.target,
      beforeVersionId: state.beforeVersionId,
      deployedVersionId: state.afterVersionId || null,
      status: 'pending',
    };
    report.results.push(result);

    if (skipTargets.has(state.target)) {
      result.status = 'skipped-schema-incompatible';
      result.error =
        'Automatic Worker rollback was skipped because its required schema rollback did not complete.';
      failed = true;
      continue;
    }

    const dependencyBlock = rollbackDependencyBlock(state.target, states, report.results);
    if (dependencyBlock) {
      result.status = 'skipped-dependent-worker-not-restored';
      result.error =
        `Automatic ${state.target} rollback was withheld because ` +
        `${dependencyBlock.dependency} recovery is ${dependencyBlock.dependencyStatus}; ` +
        `the newer ${state.target} Worker remains deployed to preserve cross-Worker compatibility.`;
      failed = true;
      continue;
    }

    try {
      const rollbackMessage =
        process.env.RELEASE_ROLLBACK_MESSAGE ||
        `rollback:${process.env.GITHUB_SHA || 'unknown'} run:${process.env.GITHUB_RUN_ID || 'local'}`;
      const rollbackAttempt = runRollbackWithRetry(state, rollbackMessage, {
        outputPath: paths.rollbackCurrent,
      });
      result.currentVersionId = rollbackAttempt.current.versionId;

      if (rollbackAttempt.status === 'already-restored') {
        result.status = 'already-restored';
        continue;
      }

      if (rollbackAttempt.status === 'conflict') {
        result.status = 'conflict';
        result.error =
          'Current production version is not owned by this release; automatic rollback was skipped.';
        failed = true;
        continue;
      }

      const restored = verifyProductionVersion(
        state.target,
        state.config,
        state.beforeVersionId,
        paths.rollback,
      );
      result.restoredVersionId = restored.versionId;
      result.status = 'restored';
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
  }

  report.completedAt = new Date().toISOString();
  if (failed) report.status = 'partial-failure';
  else if (report.results.length > 0) report.status = 'succeeded';
  writeJson(reportPath, report);
  console.log(`Rollback report: ${reportPath} (${report.status})`);
  if (failed) process.exitCode = 1;
}

function summary(directory) {
  const reportPath = resolve(directory, 'rollback-report.json');
  const lines = ['#### Automatic rollback'];
  if (!existsSync(reportPath)) {
    lines.push('- Not requested.');
  } else {
    const report = readJson(reportPath);
    lines.push(`- Result: \`${report.status}\``);
    for (const result of report.results || []) {
      let detail = `- \`${result.target}\`: \`${result.status}\``;
      if (result.beforeVersionId) detail += ` (previous: \`${result.beforeVersionId}\`)`;
      if (result.error) detail += `; ${result.error}`;
      lines.push(detail);
    }
  }
  const output = `${lines.join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, output, { encoding: 'utf8', flag: 'a' });
  } else {
    process.stdout.write(output);
  }
}

function main() {
  const [mode, targetArgument, directoryArgument] = process.argv.slice(2);
  const directory = resolve(
    mode === 'verify-current' || mode === 'rollback' || mode === 'summary'
      ? targetArgument || DEFAULT_DIRECTORY
      : directoryArgument || DEFAULT_DIRECTORY,
  );

  if (mode === 'prepare') prepare(targetArgument, directory);
  else if (mode === 'preflight') preflight(targetArgument, directory);
  else if (mode === 'attempt') markAttempt(targetArgument, directory);
  else if (mode === 'record') record(targetArgument, directory);
  else if (mode === 'version') recordedVersion(targetArgument, directory);
  else if (mode === 'verify-current') verifyCurrentRelease(directory);
  else if (mode === 'rollback') rollback(directory);
  else if (mode === 'summary') summary(directory);
  else {
    throw new Error(
      'Usage: node scripts/release-deployment-state.mjs <prepare|preflight|attempt|record|version> <target> [directory] | <verify-current|rollback|summary> [directory]',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

export {
  attemptedStates,
  deploymentMessage,
  preflight,
  productionVersion,
  queryCurrent,
  retrySync,
  rollbackDisposition,
  rollbackDependencyBlock,
  rollbackSkipTargets,
  runRollbackWithRetry,
  verifyCurrentRelease,
  verifyProductionVersion,
};
