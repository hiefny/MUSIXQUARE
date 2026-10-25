/**
 * Lab global setup: a local Standard signaling Worker under `wrangler dev --local`.
 *
 * The checked-in cloudflare/wrangler.signaling.toml binds ServiceControl from
 * the PRO Worker and a remote D1, which a single local process cannot serve.
 * The lab therefore generates, in the git-ignored .wrangler/ folder, a wrapper
 * that re-exports the unchanged signaling Worker and the ServiceControl object
 * from one local script, plus a config with only the two Durable Object
 * bindings a Standard room uses. No repository Worker input is modified. State
 * is wiped at every start so each run sees fresh rooms. The wrapper adds one
 * lab-only route (LAB_APP_BUILD_FLOOR_PATH) that sets the App build floor and
 * the live-App report on that ServiceControl, for the forced-update scenario.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB_APP_BUILD_FLOOR_PATH,
  LAB_HOST,
  LAB_INSPECTOR_PORT,
  LAB_SIGNALING_ORIGIN,
  LAB_SIGNALING_PORT,
} from './lab-env.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_DIR = resolve(ROOT, '.wrangler', 'lab-signaling');
const WRANGLER_BIN = resolve(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const READY_TIMEOUT_MS = 90_000;

// The forced-update lab route sets the App build floor through the same
// consumer calls the App Worker's setters use; every other request goes to the
// unchanged signaling Worker.
const LOCAL_WORKER = `import signaling, { MusixquareRoom } from '../../cloudflare/signaling-worker.ts';
import {
  readAppBuildFloor,
  reportLiveAppBuild,
  updateAppBuildFloor,
} from '../../cloudflare/service-maintenance.ts';
export { MusixquareRoom };
export { MusixquareServiceControl } from '../../cloudflare/service-control-object.ts';

async function setLabAppBuildFloor(request, env) {
  if (request.method !== 'POST') return Response.json({ error: 'METHOD' }, { status: 405 });
  const { minAppBuild, liveAppBuild } = await request.json();
  if (!(await reportLiveAppBuild(env, liveAppBuild))) {
    return Response.json({ error: 'REPORT_FAILED' }, { status: 503 });
  }
  let revision = (await readAppBuildFloor(env)).revision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await updateAppBuildFloor(env, {
      minAppBuild,
      expectedRevision: revision,
      requestId: crypto.randomUUID(),
      reason: 'C5-0 lab forced update scenario',
      liveAppBuild,
    });
    if (result.status === 'ok') return Response.json(result.floor);
    if (result.status !== 'conflict') return Response.json(result, { status: 503 });
    revision = result.floor.revision;
  }
  return Response.json({ error: 'CONFLICT' }, { status: 409 });
}

export default {
  fetch(request, env, context) {
    if (new URL(request.url).pathname === '${LAB_APP_BUILD_FLOOR_PATH}') {
      return setLabAppBuildFloor(request, env);
    }
    return signaling.fetch(request, env, context);
  },
};
`;

const LOCAL_CONFIG = `name = "mxqr-lab-signaling"
main = "local-worker.ts"
compatibility_date = "2026-05-04"
workers_dev = false
preview_urls = false

[[durable_objects.bindings]]
name = "MUSIXQUARE_ROOMS"
class_name = "MusixquareRoom"

[[durable_objects.bindings]]
name = "MUSIXQUARE_SERVICE_CONTROL"
class_name = "MusixquareServiceControl"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MusixquareRoom", "MusixquareServiceControl"]
`;

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = createConnection({ port, host: LAB_HOST });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolvePort(listening);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForWorker(child: ChildProcess, logPath: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited(child)) {
      throw new Error(`[Lab] wrangler dev exited early (${child.exitCode}); see ${logPath}`);
    }
    try {
      const response = await fetch(`${LAB_SIGNALING_ORIGIN}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      await response.arrayBuffer();
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`[Lab] signaling Worker not ready within ${READY_TIMEOUT_MS} ms; see ${logPath}`);
}

function stopTree(child: ChildProcess): void {
  if (child.pid === undefined || exited(child)) return;
  // wrangler runs its CLI and workerd as children; end the whole tree.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

async function labGlobalSetup(): Promise<() => Promise<void>> {
  for (const port of [LAB_SIGNALING_PORT, LAB_INSPECTOR_PORT]) {
    if (await isPortInUse(port)) {
      throw new Error(`[Lab] port ${port} is already in use; refusing an unverified listener`);
    }
  }

  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(resolve(RUN_DIR, 'local-worker.ts'), LOCAL_WORKER);
  writeFileSync(resolve(RUN_DIR, 'wrangler.toml'), LOCAL_CONFIG);

  const logPath = resolve(RUN_DIR, 'wrangler.log');
  const log = openSync(logPath, 'w');
  const child = spawn(
    process.execPath,
    [
      WRANGLER_BIN,
      'dev',
      '--local',
      '--ip',
      LAB_HOST,
      '--port',
      String(LAB_SIGNALING_PORT),
      '--inspector-port',
      String(LAB_INSPECTOR_PORT),
      '--config',
      resolve(RUN_DIR, 'wrangler.toml'),
      '--persist-to',
      resolve(RUN_DIR, 'state'),
    ],
    {
      cwd: RUN_DIR,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', log, log],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  );
  closeSync(log);

  try {
    await waitForWorker(child, logPath);
  } catch (error) {
    stopTree(child);
    throw error;
  }
  console.log(`[Lab] local signaling Worker ready at ${LAB_SIGNALING_ORIGIN} (log ${logPath})`);

  return async () => {
    stopTree(child);
    console.log('[Lab] local signaling Worker stopped');
  };
}

export default labGlobalSetup;
