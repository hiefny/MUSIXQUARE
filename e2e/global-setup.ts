/**
 * Playwright Global Setup — Start local PeerJS signaling server
 *
 * Runs PeerJS in a dedicated child process so Playwright can fully tear down
 * the server and its internal timers after the suite.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { E2E_PEER_PORT } from './config.ts';

const moduleRequire = createRequire(import.meta.url);

const PEER_HOST = '127.0.0.1';
const PEER_READY_TIMEOUT_MS = 30_000;
const PEER_TERMINATE_TIMEOUT_MS = 2_000;
const PEER_KILL_TIMEOUT_MS = 2_000;
const PEER_CLI_PATH = resolve(dirname(moduleRequire.resolve('peer')), 'bin', 'peerjs.js');

/** Check if something is already listening on host:port */
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(listening);
    };
    sock.setTimeout(250);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

function hasExited(peerProcess: ChildProcess): boolean {
  return peerProcess.exitCode !== null || peerProcess.signalCode !== null;
}

function describeExit(peerProcess: ChildProcess): string {
  if (peerProcess.exitCode !== null) return `exit code ${peerProcess.exitCode}`;
  if (peerProcess.signalCode !== null) return `signal ${peerProcess.signalCode}`;
  return 'unknown status';
}

async function waitForPort(
  peerProcess: ChildProcess,
  getProcessError: () => Error | undefined,
  port: number,
  host: string,
): Promise<void> {
  const deadline = Date.now() + PEER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const processError = getProcessError();
    if (processError) {
      throw new Error(`[E2E] Failed to start PeerJS server: ${processError.message}`, {
        cause: processError,
      });
    }
    if (hasExited(peerProcess)) {
      throw new Error(
        `[E2E] PeerJS server exited before listening on ${host}:${port} (${describeExit(peerProcess)})`,
      );
    }
    if (await isPortInUse(port, host)) {
      const errorAfterConnect = getProcessError();
      if (errorAfterConnect) {
        throw new Error(`[E2E] Failed to start PeerJS server: ${errorAfterConnect.message}`, {
          cause: errorAfterConnect,
        });
      }
      if (!hasExited(peerProcess)) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `PeerJS server did not listen on ${host}:${port} within ${PEER_READY_TIMEOUT_MS}ms`,
  );
}

function waitForProcessExit(peerProcess: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(peerProcess)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      peerProcess.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);

    peerProcess.once('exit', onExit);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    if (hasExited(peerProcess)) finish(true);
  });
}

async function terminatePeerProcess(peerProcess: ChildProcess): Promise<void> {
  if (peerProcess.pid === undefined || hasExited(peerProcess)) return;

  peerProcess.kill();
  if (await waitForProcessExit(peerProcess, PEER_TERMINATE_TIMEOUT_MS)) return;

  peerProcess.kill('SIGKILL');
  if (!(await waitForProcessExit(peerProcess, PEER_KILL_TIMEOUT_MS))) {
    throw new Error(
      `[E2E] PeerJS process ${peerProcess.pid} did not exit after forced termination`,
    );
  }
}

async function globalSetup(): Promise<() => Promise<void>> {
  if (await isPortInUse(E2E_PEER_PORT, PEER_HOST)) {
    throw new Error(
      `[E2E] Dedicated PeerJS port ${E2E_PEER_PORT} is already in use; refusing to reuse an unverified listener`,
    );
  }

  let processError: Error | undefined;
  const peerProcess = spawn(
    process.execPath,
    [PEER_CLI_PATH, '--host', PEER_HOST, '--port', String(E2E_PEER_PORT), '--path', '/'],
    {
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    },
  );
  peerProcess.on('error', (error) => {
    processError ??= error;
  });

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      await terminatePeerProcess(peerProcess);
      console.log('[E2E] PeerJS server cleanup complete');
    })();
    return cleanupPromise;
  };

  try {
    await waitForPort(peerProcess, () => processError, E2E_PEER_PORT, PEER_HOST);
  } catch (startupError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        '[E2E] PeerJS startup and cleanup both failed',
      );
    }
    throw startupError;
  }

  console.log(`[E2E] PeerJS signaling server started on port ${E2E_PEER_PORT}`);
  return cleanup;
}

export default globalSetup;
